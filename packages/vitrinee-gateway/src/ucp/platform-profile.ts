/**
 * Reads a platform's UCP profile, the document `UCP-Agent: profile="…"` points
 * to (T133, R-14). The URL comes from whoever sent the request, on routes with
 * no authentication, in the process that charges. So it is read as a hostile
 * one, and the reading itself is bounded:
 *
 * - `https` on port 443 to a name, never to an IP literal, no credentials;
 * - the name is resolved here, with a resolver of its own (c-ares, not the
 *   libuv threadpool that the facilitator and Horizon calls share), and refused
 *   unless every address is public: IPv4 outside the special-use ranges, IPv6
 *   only inside 2000::/3 and outside the ranges that embed or relay to IPv4;
 * - the connection goes to that same address (no second resolution), with TLS
 *   checked against the name;
 * - one deadline covers the whole read: resolving, connecting, TLS and body. A
 *   server that sends a byte every few seconds is cut at the deadline;
 * - a size cap counted in bytes, no redirects;
 * - one reader per process ({@link sharedPlatformProfileReader}), so every
 *   storefront of the platform shares its limits: at most a few reads at once
 *   and a steady rate; past that, no read, and the caller answers in its
 *   default version;
 * - a host that failed waits before it is read again, longer each time;
 * - it keeps only what a store uses (the version), never the whole document.
 *
 * T147 reads the order webhook URL from the same document, and delivers order
 * webhooks to it through {@link PlatformClient.send}: the same checks, the same
 * pinned connection, the same process-wide limits, a POST instead of a GET.
 */
import { Resolver } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { z } from "zod";

export const PROFILE_TIMEOUT_MS = 3_000;
/** UCP 2026-08-25: a profile size limit "SHOULD be no lower than 128 KiB". */
export const PROFILE_MAX_BYTES = 128 * 1024;
export const MAX_CONCURRENT_READS = 6;
/** Steady outbound rate: a burst of this many, refilled at {@link READS_PER_SECOND}. */
export const READ_BURST = 20;
export const READS_PER_SECOND = 5;
const OK_CACHE_MS = 5 * 60_000;
const FAIL_CACHE_MS = 60_000;
const HOST_BACKOFF_MS = 60_000;
const HOST_BACKOFF_MAX_MS = 10 * 60_000;
const CACHE_MAX = 1_000;

/** The part of a platform profile a store reads. Loose: the official schemas are the contract. */
const platformProfileSchema = z.looseObject({
  ucp: z.looseObject({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  }),
  keys: z.array(z.unknown()).optional(),
});
const p256Jwk = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().min(1).max(200).optional(),
});
const MAX_CAPABILITIES = 64;
const MAX_KEYS = 10;
/** A URL longer than this is not kept. */
const MAX_URL_LENGTH = 2_048;
/** UCP's order capability, as a platform declares it: `config.webhook_url` is where order events go (T147). */
const orderCapabilitySchema = z.array(z.looseObject({ config: z.looseObject({ webhook_url: z.string().min(1).max(MAX_URL_LENGTH) }).optional() })).min(1);
/** A webhook receiver must answer quickly (UCP); a delivery that takes longer is retried. */
export const SEND_TIMEOUT_MS = 5_000;

/** A platform's public P-256 key, as kept: the members needed to verify ES256 and nothing else. */
export interface PlatformP256Key {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid?: string;
}

/**
 * What is kept of a platform profile: only what a store uses. Its version, the
 * names of the capabilities it declares (for extension negotiation, T134), its
 * P-256 keys (to verify AP2 mandates it signs), each bounded, and where it
 * wants order events (T147), if it says.
 */
export interface PlatformProfileSummary {
  ucp: { version: string; capabilities: string[] };
  keys: PlatformP256Key[];
  /** `capabilities["dev.ucp.shopping.order"][0].config.webhook_url`, unvetted: it is vetted again on every delivery. */
  orderWebhookUrl?: string;
}

export type ProfileFailure = "not_https" | "bad_url" | "blocked_address" | "unreachable" | "too_large" | "bad_status" | "malformed" | "busy" | "backoff";

export type ProfileResult = { ok: true; profile: PlatformProfileSummary } | { ok: false; reason: ProfileFailure };

export interface PlatformProfileReader {
  read(url: string): Promise<ProfileResult>;
}

export type SendFailure = "not_https" | "bad_url" | "blocked_address" | "unreachable" | "busy";

/** A delivery's outcome: the receiver's status, whatever it was, or why nothing was sent or answered. */
export type SendResult = { ok: true; status: number } | { ok: false; reason: SendFailure };

export interface OutboundRequest {
  body: string;
  headers: Readonly<Record<string, string>>;
}

/** POSTs to a URL a platform dictated, under the same rules as reading its profile (T147). */
export interface PlatformSender {
  send(url: string, request: OutboundRequest): Promise<SendResult>;
}

/** The process's one client for URLs that platforms dictate: it reads their profiles and delivers their webhooks. */
export type PlatformClient = PlatformProfileReader & PlatformSender;

// ---------------------------------------------------------------- addresses

const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
/** IPv6 is allowed only here: global unicast. Everything that embeds IPv4 (mapped, SIIT, NAT64, ::a.b.c.d) is outside it. */
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
/** Inside 2000::/3 but not to be fetched: IETF protocol assignments (Teredo among them), documentation, 6to4. */
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

/** Whether a resolved address must never be fetched from a store. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family === 6) return !globalV6.check(address, "ipv6") || blockedV6.check(address, "ipv6");
  return true;
}

// ---------------------------------------------------------------- one read

class ProfileError extends Error {
  constructor(readonly reason: ProfileFailure) {
    super(reason);
  }
}

export interface PinnedGetOptions {
  /** Aborts the whole read: the deadline. */
  signal: AbortSignal;
  maxBytes?: number;
  /** Tests only: the CA that signs a local test server's certificate. */
  ca?: string;
}

export interface PinnedPostOptions {
  /** Aborts the whole delivery: the deadline. */
  signal: AbortSignal;
  headers: Readonly<Record<string, string>>;
  body: string;
  /** Tests only: the CA that signs a local test server's certificate. */
  ca?: string;
}

function pinnedLookup(address: string, family: number): LookupFunction {
  return (_host, lookupOptions, callback) => {
    if ((lookupOptions as { all?: boolean }).all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * HTTPS POST to one pinned address, like {@link pinnedGet}. Only the status
 * matters: it resolves as soon as the status line arrives and drops the
 * response, so a receiver that answers slowly cannot hold the connection.
 * A redirect comes back as its status and is never followed.
 */
export function pinnedPost(url: URL, address: string, family: number, options: PinnedPostOptions): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(options.body, "utf8");
    const requestOptions: RequestOptions = {
      method: "POST",
      headers: { ...options.headers, "content-length": String(body.length) },
      lookup: pinnedLookup(address, family),
      servername: url.hostname,
      signal: options.signal,
      agent: false,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    };
    const req = request(url, requestOptions, (res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.destroy();
    });
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * HTTPS GET to one pinned address: TLS and Host use the URL's name, the socket
 * uses `address`. The body is read up to `maxBytes`, counted in bytes; the
 * signal cuts it wherever it is.
 */
export function pinnedGet(url: URL, address: string, family: number, options: PinnedGetOptions): Promise<{ status: number; body: string }> {
  const lookup = pinnedLookup(address, family);
  const maxBytes = options.maxBytes ?? PROFILE_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: "GET",
      headers: { accept: "application/json" },
      lookup,
      servername: url.hostname,
      signal: options.signal,
      agent: false,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    };
    const req = request(url, requestOptions, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new ProfileError("too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Plain HTTP to loopback, for the local conformance store only; the same cap, counted in bytes, and the same deadline. */
async function loopbackGet(url: URL, signal: AbortSignal): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { redirect: "manual", signal, headers: { accept: "application/json" } });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader?.read();
    if (next === undefined || next.done) break;
    size += next.value.byteLength;
    if (size > PROFILE_MAX_BYTES) {
      await reader?.cancel();
      throw new ProfileError("too_large");
    }
    chunks.push(next.value);
  }
  return { status: res.status, body: Buffer.concat(chunks).toString("utf8") };
}

/** Plain HTTP POST to loopback, for the local conformance store only. No redirects; the status is all that is read. */
async function loopbackPost(url: URL, request: OutboundRequest, signal: AbortSignal): Promise<{ status: number }> {
  const res = await fetch(url, { method: "POST", redirect: "manual", signal, headers: { ...request.headers }, body: request.body });
  await res.body?.cancel();
  return { status: res.status };
}

/** Both families, from c-ares (its own sockets, its own timeout), never from the libuv threadpool. */
function aresResolve(timeoutMs: number): (host: string) => Promise<Array<{ address: string; family: number }>> {
  return async (host) => {
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    return [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
  };
}

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ProfileError("unreachable"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new ProfileError("unreachable"));
      },
    );
  });
}

// ---------------------------------------------------------------- the reader

export interface PlatformProfileReaderOptions {
  now?: () => number;
  /** Name resolution; tests inject a fake. Defaults to c-ares with the deadline as its timeout. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** The pinned HTTPS GET; tests inject a fake or a local CA. */
  get?: (url: URL, address: string, family: number, options: PinnedGetOptions) => Promise<{ status: number; body: string }>;
  /** The pinned HTTPS POST of a webhook delivery (T147); tests inject a fake or a local CA. */
  post?: (url: URL, address: string, family: number, options: PinnedPostOptions) => Promise<{ status: number }>;
  timeoutMs?: number;
  /** The deadline of one delivery. Defaults to {@link SEND_TIMEOUT_MS}. */
  sendTimeoutMs?: number;
  maxConcurrent?: number;
  burst?: number;
  perSecond?: number;
  /** Only the local conformance store sets this: `http` to a loopback name on any port. Never in a deployed store. */
  allowLoopbackHttp?: boolean;
}

export function createPlatformProfileReader(options: PlatformProfileReaderOptions = {}): PlatformClient {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? PROFILE_TIMEOUT_MS;
  const sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const resolve = options.resolve ?? aresResolve(timeoutMs);
  const get = options.get ?? pinnedGet;
  const post = options.post ?? pinnedPost;
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_READS;
  const burst = options.burst ?? READ_BURST;
  const perSecond = options.perSecond ?? READS_PER_SECOND;

  const cache = new Map<string, { result: ProfileResult; at: number }>();
  const inFlight = new Map<string, Promise<ProfileResult>>();
  const hostBackoff = new Map<string, { until: number; wait: number }>();
  let running = 0;
  let tokens = burst;
  let refilledAt = now();

  function takeToken(): boolean {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - refilledAt) / 1000) * perSecond);
    refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function remember(key: string, result: ProfileResult): void {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { result, at: now() });
  }

  async function fetchProfile(url: URL, signal: AbortSignal): Promise<ProfileResult> {
    let response: { status: number; body: string };
    const loopbackName = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (options.allowLoopbackHttp === true && url.protocol === "http:" && loopbackName) {
      response = await loopbackGet(url, signal);
    } else {
      const addresses = await withDeadline(resolve(url.hostname), signal);
      if (addresses.length === 0) return { ok: false, reason: "unreachable" };
      if (addresses.some((a) => isBlockedAddress(a.address))) return { ok: false, reason: "blocked_address" };
      const first = addresses[0]!;
      response = await withDeadline(get(url, first.address, first.family, { signal }), signal);
    }
    if (response.status !== 200) return { ok: false, reason: "bad_status" };
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const parsed = platformProfileSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "malformed" };
    const capabilities = Object.keys(parsed.data.ucp.capabilities ?? {})
      .filter((name) => name.length <= 100)
      .slice(0, MAX_CAPABILITIES);
    const keys = (parsed.data.keys ?? [])
      .map((key) => p256Jwk.safeParse(key))
      .flatMap((key) => (key.success ? [{ kty: key.data.kty, crv: key.data.crv, x: key.data.x, y: key.data.y, ...(key.data.kid === undefined ? {} : { kid: key.data.kid }) }] : []))
      .slice(0, MAX_KEYS);
    const order = orderCapabilitySchema.safeParse(parsed.data.ucp.capabilities?.["dev.ucp.shopping.order"]);
    const orderWebhookUrl = order.success ? order.data[0]!.config?.webhook_url : undefined;
    return { ok: true, profile: { ucp: { version: parsed.data.ucp.version, capabilities }, keys, ...(orderWebhookUrl === undefined ? {} : { orderWebhookUrl }) } };
  }

  /** The checks that need no network, in order: a refusal here costs nothing and is not rate-limited. */
  function vet(raw: string): { ok: true; url: URL } | { ok: false; reason: ProfileFailure } {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "bad_url" };
    }
    if (url.username !== "" || url.password !== "") return { ok: false, reason: "bad_url" };
    const loopbackName = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (options.allowLoopbackHttp === true && url.protocol === "http:" && loopbackName) return { ok: true, url };
    if (url.protocol !== "https:" || url.port !== "") return { ok: false, reason: "not_https" };
    // An IP literal skips the name, and with it the point of TLS: never.
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return { ok: false, reason: "blocked_address" };
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "blocked_address" };
    return { ok: true, url };
  }

  async function readOnce(raw: string, url: URL): Promise<ProfileResult> {
    const host = url.hostname.toLowerCase();
    const back = hostBackoff.get(host);
    if (back !== undefined && now() < back.until) return { ok: false, reason: "backoff" };
    if (running >= maxConcurrent || !takeToken()) return { ok: false, reason: "busy" };
    running += 1;
    const deadline = AbortSignal.timeout(timeoutMs);
    let result: ProfileResult;
    try {
      result = await fetchProfile(url, deadline);
    } catch (error) {
      result = { ok: false, reason: error instanceof ProfileError ? error.reason : "unreachable" };
    } finally {
      running -= 1;
    }
    if (result.ok) {
      hostBackoff.delete(host);
    } else {
      const wait = Math.min((back?.wait ?? HOST_BACKOFF_MS / 2) * 2, HOST_BACKOFF_MAX_MS);
      hostBackoff.set(host, { until: now() + wait, wait });
      if (hostBackoff.size > CACHE_MAX) {
        const oldest = hostBackoff.keys().next().value;
        if (oldest !== undefined) hostBackoff.delete(oldest);
      }
    }
    remember(raw, result);
    return result;
  }

  async function deliver(url: URL, request: OutboundRequest, signal: AbortSignal): Promise<SendResult> {
    const loopbackName = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (options.allowLoopbackHttp === true && url.protocol === "http:" && loopbackName) {
      return { ok: true, status: (await loopbackPost(url, request, signal)).status };
    }
    const addresses = await withDeadline(resolve(url.hostname), signal);
    if (addresses.length === 0) return { ok: false, reason: "unreachable" };
    if (addresses.some((a) => isBlockedAddress(a.address))) return { ok: false, reason: "blocked_address" };
    const first = addresses[0]!;
    const { status } = await withDeadline(post(url, first.address, first.family, { signal, headers: request.headers, body: request.body }), signal);
    return { ok: true, status };
  }

  return {
    /**
     * Delivers one webhook. Shares the process's limits with the profile reads
     * (at most a few at once, a steady rate) but not their per-host backoff or
     * cache: when to try again is the caller's schedule, and every delivery is
     * vetted, resolved and pinned afresh, so a name that turned private since
     * the last one is refused.
     */
    async send(raw: string, request: OutboundRequest): Promise<SendResult> {
      if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "bad_url" };
      const vetted = vet(raw);
      if (!vetted.ok) return { ok: false, reason: vetted.reason === "not_https" || vetted.reason === "blocked_address" ? vetted.reason : "bad_url" };
      if (running >= maxConcurrent || !takeToken()) return { ok: false, reason: "busy" };
      running += 1;
      try {
        return await deliver(vetted.url, request, AbortSignal.timeout(sendTimeoutMs));
      } catch (error) {
        return { ok: false, reason: error instanceof ProfileError && error.reason === "blocked_address" ? "blocked_address" : "unreachable" };
      } finally {
        running -= 1;
      }
    },

    async read(raw: string): Promise<ProfileResult> {
      const vetted = vet(raw);
      if (!vetted.ok) return vetted;
      const hit = cache.get(raw);
      if (hit !== undefined && now() - hit.at < (hit.result.ok ? OK_CACHE_MS : FAIL_CACHE_MS)) return hit.result;
      const pending = inFlight.get(raw);
      if (pending !== undefined) return pending;
      const work = readOnce(raw, vetted.url);
      inFlight.set(raw, work);
      try {
        return await work;
      } finally {
        inFlight.delete(raw);
      }
    },
  };
}

let shared: PlatformClient | undefined;

/** The one reader of this process: every storefront the platform serves shares its limits (T133 review), for reads and deliveries. */
export function sharedPlatformProfileReader(): PlatformClient {
  shared ??= createPlatformProfileReader();
  return shared;
}
