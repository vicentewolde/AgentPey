import { describe, expect, it } from "vitest";

import { createPlatformProfileReader, isBlockedAddress } from "./platform-profile.js";

const PROFILE = JSON.stringify({ ucp: { version: "2026-08-25", capabilities: {} } });

function fakes(addresses: Array<{ address: string; family: number }>, answer: { status: number; body: string } = { status: 200, body: PROFILE }) {
  const gets: Array<{ url: string; address: string }> = [];
  const resolves: string[] = [];
  return {
    gets,
    resolves,
    resolve: async (host: string) => {
      resolves.push(host);
      return addresses;
    },
    get: async (url: URL, address: string) => {
      gets.push({ url: url.href, address });
      return answer;
    },
  };
}

describe("reading a platform's UCP profile (T133, R-14)", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"])(
    "never fetches from %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])("may fetch from the public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("reads a public HTTPS profile, connecting to the address it checked", async () => {
    const f = fakes([{ address: "93.184.216.34", family: 4 }]);
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get });
    const result = await reader.read("https://platform.example/ucp/profile.json");
    expect(result).toEqual({ ok: true, profile: { ucp: { version: "2026-08-25", capabilities: {} } } });
    expect(f.gets).toEqual([{ url: "https://platform.example/ucp/profile.json", address: "93.184.216.34" }]);
  });

  it("refuses a name that resolves to any private address, without connecting (DNS that points inside)", async () => {
    const f = fakes([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
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
    ["https://[::1]/profile.json", "blocked_address"],
    ["http://localhost:8285/profile.json", "not_https"],
  ])("refuses %s (%s) without connecting", async (url, reason) => {
    const f = fakes([{ address: "93.184.216.34", family: 4 }]);
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
    const f = fakes([{ address: "93.184.216.34", family: 4 }], answer);
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get });
    expect(await reader.read("https://platform.example/profile.json")).toEqual({ ok: false, reason });
  });

  it("caches an answer, and asks once for concurrent reads of the same URL", async () => {
    const f = fakes([{ address: "93.184.216.34", family: 4 }]);
    let clock = 0;
    const reader = createPlatformProfileReader({ resolve: f.resolve, get: f.get, now: () => clock });
    await Promise.all([reader.read("https://platform.example/p.json"), reader.read("https://platform.example/p.json")]);
    await reader.read("https://platform.example/p.json");
    expect(f.gets).toHaveLength(1);
    clock += 5 * 60_000 + 1;
    await reader.read("https://platform.example/p.json");
    expect(f.gets).toHaveLength(2);
  });

  it("reads plain HTTP on loopback only when told to: the local conformance store", async () => {
    const strict = createPlatformProfileReader({ resolve: fakes([]).resolve, get: fakes([]).get });
    expect(await strict.read("http://127.0.0.1:1/profile.json")).toEqual({ ok: false, reason: "not_https" });
    const local = createPlatformProfileReader({ allowLoopbackHttp: true });
    // Nothing listens on port 1: the read is attempted, and fails as unreachable, not as refused.
    expect(await local.read("http://127.0.0.1:1/profile.json")).toEqual({ ok: false, reason: "unreachable" });
  });
});
