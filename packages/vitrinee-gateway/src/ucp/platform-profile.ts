/**
 * Reads a platform's UCP profile, the document `UCP-Agent: profile="…"` points
 * to (T133, R-14). The URL comes from whoever sent the request, so it is read
 * as a hostile one:
 *
 * - `https` on port 443 only, no credentials in the URL;
 * - the name is resolved here, and refused if any address it resolves to is
 *   private, loopback, link-local, carrier-grade NAT, multicast or reserved;
 * - the connection goes to that same address (no second resolution between
 *   the check and the request), with the original name for TLS;
 * - no redirects, a size cap and a time cap;
 * - answers are cached, failures too (shorter), and one URL is fetched at most
 *   once at a time.
 *
 * T147 reads the order webhook URL from the same document, through this.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { z } from "zod";

export const PROFILE_TIMEOUT_MS = 3_000;
export const PROFILE_MAX_BYTES = 64 * 1024;
const OK_CACHE_MS = 5 * 60_000;
const FAIL_CACHE_MS = 60_000;
const CACHE_MAX = 500;

/** The part of a platform profile a store needs. Loose: the official schemas are the contract. */
export const platformProfileSchema = z.looseObject({
  ucp: z.looseObject({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    capabilities: z.record(z.string(), z.array(z.looseObject({ version: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() }))).optional(),
  }),
});
export type PlatformProfile = z.infer<typeof platformProfileSchema>;

export type ProfileFailure = "not_https" | "bad_url" | "blocked_address" | "unreachable" | "too_large" | "bad_status" | "malformed";

export type ProfileResult = { ok: true; profile: PlatformProfile } | { ok: false; reason: ProfileFailure };

export interface PlatformProfileReader {
  read(url: string): Promise<ProfileResult>;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** Whether a resolved address must never be fetched from a store. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) {
    // An IPv4-mapped address is checked as the IPv4 address it carries. (No `::ffff:0:0/96`
    // rule: Node's BlockList would then match every IPv4 address against it.)
    const v4 = address.slice(7);
    if (isIP(v4) === 4) return blocked.check(v4, "ipv4");
  }
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface PlatformProfileReaderOptions {
  now?: () => number;
  /** Name resolution; tests inject a fake. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** The HTTPS GET, pinned to `address`; tests inject a fake. */
  get?: (url: URL, address: string, family: number) => Promise<{ status: number; body: string }>;
  /** Only the local conformance store sets this: `http` to a loopback address on any port. Never in a deployed store. */
  allowLoopbackHttp?: boolean;
}

class ProfileError extends Error {
  constructor(readonly reason: ProfileFailure) {
    super(reason);
  }
}

/** HTTPS GET to one pinned address: TLS and Host use the name, the socket uses the address checked above. */
function pinnedGet(url: URL, address: string, family: number): Promise<{ status: number; body: string }> {
  const lookup: LookupFunction = (_host, options, callback) => {
    if ((options as { all?: boolean }).all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", headers: { accept: "application/json" }, lookup, timeout: PROFILE_TIMEOUT_MS, servername: url.hostname },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > PROFILE_MAX_BYTES) {
            req.destroy(new ProfileError("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new ProfileError("unreachable")));
    req.on("error", reject);
    req.end();
  });
}

/** Plain HTTP to loopback, for the local conformance store only. */
async function loopbackGet(url: URL): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), headers: { accept: "application/json" } });
  const body = await res.text();
  if (body.length > PROFILE_MAX_BYTES) throw new ProfileError("too_large");
  return { status: res.status, body };
}

export function createPlatformProfileReader(options: PlatformProfileReaderOptions = {}): PlatformProfileReader {
  const now = options.now ?? (() => Date.now());
  const resolve = options.resolve ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const get = options.get ?? pinnedGet;
  const cache = new Map<string, { result: ProfileResult; at: number }>();
  const inFlight = new Map<string, Promise<ProfileResult>>();

  async function fetchProfile(raw: string): Promise<ProfileResult> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "bad_url" };
    }
    if (url.username !== "" || url.password !== "") return { ok: false, reason: "bad_url" };
    const loopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    try {
      let response: { status: number; body: string };
      if (options.allowLoopbackHttp === true && url.protocol === "http:" && loopbackHost) {
        response = await loopbackGet(url);
      } else {
        if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) return { ok: false, reason: "not_https" };
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host) === 0 ? await resolve(host) : [{ address: host, family: isIP(host) }];
        if (addresses.length === 0) return { ok: false, reason: "unreachable" };
        if (addresses.some((a) => isBlockedAddress(a.address))) return { ok: false, reason: "blocked_address" };
        const first = addresses[0]!;
        response = await get(url, first.address, first.family);
      }
      if (response.status !== 200) return { ok: false, reason: "bad_status" };
      const parsed = platformProfileSchema.safeParse(JSON.parse(response.body));
      return parsed.success ? { ok: true, profile: parsed.data } : { ok: false, reason: "malformed" };
    } catch (error) {
      if (error instanceof ProfileError) return { ok: false, reason: error.reason };
      if (error instanceof SyntaxError) return { ok: false, reason: "malformed" };
      return { ok: false, reason: "unreachable" };
    }
  }

  return {
    async read(url: string): Promise<ProfileResult> {
      const hit = cache.get(url);
      if (hit !== undefined && now() - hit.at < (hit.result.ok ? OK_CACHE_MS : FAIL_CACHE_MS)) return hit.result;
      const pending = inFlight.get(url);
      if (pending !== undefined) return pending;
      const work = fetchProfile(url).then((result) => {
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(url, { result, at: now() });
        return result;
      });
      inFlight.set(url, work);
      try {
        return await work;
      } finally {
        inFlight.delete(url);
      }
    },
  };
}
