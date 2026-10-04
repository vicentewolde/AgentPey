import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROFILE_MAX_BYTES, createPlatformProfileReader, isBlockedAddress, pinnedGet, type PinnedGetOptions } from "./platform-profile.js";

const PROFILE = JSON.stringify({ ucp: { version: "2026-08-25", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }] } } });
const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };

function fakes(addresses: Array<{ address: string; family: number }> = [PUBLIC_V4], answer: { status: number; body: string } = { status: 200, body: PROFILE }) {
  const gets: Array<{ url: string; address: string }> = [];
  return {
    gets,
    resolve: async () => addresses,
    get: async (url: URL, address: string, _family: number, _options: PinnedGetOptions) => {
      gets.push({ url: url.href, address });
      return answer;
    },
  };
}

describe("which addresses a store may read a platform profile from (T133, R-14)", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.88.99.1",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:0:7f00:1",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "2002:7f00:1::",
    "2001::1",
    "2001:db8::1",
    "not-an-ip",
  ])("never %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4001:80b::200e"])("may read from the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("reading a platform's UCP profile (T133, R-14)", () => {
  it("reads a public HTTPS profile, connecting to the address it checked, and keeps only the version", async () => {
    const f = fakes();
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get });
    expect(await reader.read("https://platform.example/ucp/profile.json")).toEqual({ ok: true, profile: { ucp: { version: "2026-08-25" } } });
    expect(f.gets).toEqual([{ url: "https://platform.example/ucp/profile.json", address: "93.184.216.34" }]);
  });

  it("refuses a name that resolves to any address it may not read, without connecting (DNS that points inside)", async () => {
    const f = fakes([PUBLIC_V4, { address: "10.0.0.5", family: 4 }]);
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get });
    expect(await reader.read("https://internal.example/profile.json")).toEqual({ ok: false, reason: "blocked_address" });
    expect(f.gets).toEqual([]);
  });

  it.each([
    ["http://platform.example/profile.json", "not_https"],
    ["https://platform.example:8443/profile.json", "not_https"],
    ["https://user:pass@platform.example/profile.json", "bad_url"],
    ["not a url", "bad_url"],
    ["https://127.0.0.1/profile.json", "blocked_address"],
    ["https://93.184.216.34/profile.json", "blocked_address"],
    ["https://[::1]/profile.json", "blocked_address"],
    ["https://[::127.0.0.1]/profile.json", "blocked_address"],
    ["https://localhost/profile.json", "blocked_address"],
    ["https://LOCALHOST./profile.json", "blocked_address"],
    ["https://api.localhost/profile.json", "blocked_address"],
    ["http://localhost:8285/profile.json", "not_https"],
  ])("refuses %s (%s) without resolving or connecting", async (url, reason) => {
    const f = fakes();
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get });
    expect(await reader.read(url)).toEqual({ ok: false, reason });
    expect(f.gets).toEqual([]);
  });

  it.each([
    [{ status: 302, body: "" }, "bad_status"],
    [{ status: 404, body: "" }, "bad_status"],
    [{ status: 200, body: "<html>" }, "malformed"],
    [{ status: 200, body: JSON.stringify({ ucp: { version: "latest" } }) }, "malformed"],
  ] as const)("does not trust an answer like %o", async (answer, reason) => {
    const f = fakes([PUBLIC_V4], answer);
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get });
    expect(await reader.read("https://platform.example/profile.json")).toEqual({ ok: false, reason });
  });

  it("caches an answer, and asks once for concurrent reads of the same URL", async () => {
    const f = fakes();
    let clock = 0;
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get, now: () => clock });
    await Promise.all([reader.read("https://platform.example/p.json"), reader.read("https://platform.example/p.json")]);
    await reader.read("https://platform.example/p.json");
    expect(f.gets).toHaveLength(1);
    clock += 5 * 60_000 + 1;
    await reader.read("https://platform.example/p.json");
    expect(f.gets).toHaveLength(2);
  });

  it("cuts a name that never resolves at the deadline", async () => {
    const reader = createPlatformProfileReader({ resolve: () => new Promise(() => {}), get: fakes().get, timeoutMs: 50 });
    const started = Date.now();
    expect(await reader.read("https://slow-dns.example/p.json")).toEqual({ ok: false, reason: "unreachable" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reads at most a few at once: past that it does not read, and the store answers in its default version", async () => {
    const release: Array<() => void> = [];
    const get = () => new Promise<{ status: number; body: string }>((resolve) => release.push(() => resolve({ status: 200, body: PROFILE })));
    const reader = createPlatformProfileReader({ resolve: fakes().resolve, get, maxConcurrent: 2, burst: 100 });
    const reads = [reader.read("https://a.example/p.json"), reader.read("https://b.example/p.json"), reader.read("https://c.example/p.json")];
    expect(await reads[2]).toEqual({ ok: false, reason: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const go of release) go();
    expect((await reads[0]).ok).toBe(true);
  });

  it("reads at a steady rate: a burst of distinct URLs past the allowance is not read", async () => {
    const f = fakes();
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get, burst: 3, perSecond: 0.0001, now: () => 0 });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => reader.read(`https://p${n}.example/profile.json`)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(2);
    expect(f.gets).toHaveLength(3);
  });

  it("makes a host that failed wait, whatever path the next URL names", async () => {
    const f = fakes([PUBLIC_V4], { status: 500, body: "" });
    let clock = 0;
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get, now: () => clock });
    expect(await reader.read("https://down.example/a.json")).toEqual({ ok: false, reason: "bad_status" });
    expect(await reader.read("https://down.example/b.json")).toEqual({ ok: false, reason: "backoff" });
    expect(f.gets).toHaveLength(1);
    clock += 61_000;
    await reader.read("https://down.example/c.json");
    expect(f.gets).toHaveLength(2);
  });

  it("reads plain HTTP on loopback only when told to: the local conformance store", async () => {
    const strict = createPlatformProfileReader({ resolve: fakes().resolve, get: fakes().get });
    expect(await strict.read("http://127.0.0.1:1/profile.json")).toEqual({ ok: false, reason: "not_https" });
    const local = createPlatformProfileReader({ allowLoopbackHttp: true, timeoutMs: 500 });
    // Nothing listens on port 1: the read is attempted, and fails as unreachable, not as refused.
    expect(await local.read("http://127.0.0.1:1/profile.json")).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("the real pinned HTTPS read, against a local server (T133 review)", () => {
  const cert = readFileSync(new URL("../test/tls/profile-test.crt", import.meta.url), "utf8");
  const key = readFileSync(new URL("../test/tls/profile-test.key", import.meta.url), "utf8");
  let server: Server;
  let port = 0;
  let behaviour: "profile" | "trickle" | "huge" = "profile";

  beforeAll(async () => {
    server = createServer({ cert, key }, (_req, res) => {
      res.setHeader("content-type", "application/json");
      if (behaviour === "profile") return void res.end(PROFILE);
      if (behaviour === "huge") return void res.end("x".repeat(PROFILE_MAX_BYTES + 1));
      // One byte every 20 ms, forever: never idle long enough for a socket timeout.
      const timer = setInterval(() => res.write(" "), 20);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  const url = (host: string) => new URL(`https://${host}:${port}/profile.json`);

  it("connects to the pinned address under a name no DNS knows, and checks TLS against that name", async () => {
    behaviour = "profile";
    const res = await pinnedGet(url("profile.test"), "127.0.0.1", 4, { signal: AbortSignal.timeout(2_000), ca: cert });
    expect(res).toEqual({ status: 200, body: PROFILE });
  });

  it("refuses a certificate for another name", async () => {
    behaviour = "profile";
    await expect(pinnedGet(url("other.test"), "127.0.0.1", 4, { signal: AbortSignal.timeout(2_000), ca: cert })).rejects.toThrow();
  });

  it("cuts a server that trickles bytes at the deadline, not at a socket's idle timeout", async () => {
    behaviour = "trickle";
    const started = Date.now();
    await expect(pinnedGet(url("profile.test"), "127.0.0.1", 4, { signal: AbortSignal.timeout(300), ca: cert })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("stops reading a body past the size cap", async () => {
    behaviour = "huge";
    await expect(pinnedGet(url("profile.test"), "127.0.0.1", 4, { signal: AbortSignal.timeout(2_000), ca: cert })).rejects.toThrow("too_large");
  });
});
