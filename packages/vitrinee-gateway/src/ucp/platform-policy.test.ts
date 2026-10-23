import { MockStoreAdapter } from "@vitrinee/adapters";
import { UCP_AP2_MANDATE, UCP_REST_PREFIX } from "@vitrinee/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { fakeFacilitator } from "../test/fake-facilitator.js";
import { AGENTPEY_PLATFORM_PROFILE, fakePlatformProfiles, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { MemoryCheckoutSessions } from "./sessions.js";
import { parseAllowedPlatforms, parseRequireAp2, platformRefusal } from "./platform-policy.js";

const AP2_PROFILE = "https://agentpey.com/ucp/platform/agentpey-ap2.json";
const STRANGER_PROFILE = "https://stranger.example/ucp/profile.json";
const profiles = {
  [AGENTPEY_PLATFORM_PROFILE]: "2026-04-08",
  [AP2_PROFILE]: { ucp: { version: "2026-08-25", capabilities: [UCP_AP2_MANDATE] }, keys: [] },
  [STRANGER_PROFILE]: { ucp: { version: "2026-08-25", capabilities: [UCP_AP2_MANDATE] }, keys: [] },
} as Parameters<typeof fakePlatformProfiles>[0];

const READY = { line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }] };

async function store(env: Record<string, string>) {
  const registry = fakeRegistry();
  const app = createApp({
    platformProfiles: fakePlatformProfiles(profiles),
    config: testConfig(env),
    adapter: new MockStoreAdapter(),
    facilitator: fakeFacilitator(),
    anchorer: registry.anchorer,
    registry: registry.registry,
    sessions: new MemoryCheckoutSessions(),
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  });
  const { url, close } = await listen(app);
  /** Opens a checkout as the platform whose profile is `profile` (none: no UCP-Agent header). */
  const open = async (profile?: string) => {
    const res = await fetch(`${url}${UCP_REST_PREFIX}/checkout-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(profile === undefined ? {} : { "UCP-Agent": `profile="${profile}"` }) },
      body: JSON.stringify(READY),
    });
    return { status: res.status, body: (await res.json()) as { status?: string; ucp?: { status?: string }; messages?: Array<{ code: string; severity: string }> } };
  };
  return { open, close };
}

describe("which platforms may open a checkout at a store (T172, VT-49)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("lets every platform open one when neither switch is set", async () => {
    const s = await store({});
    close = s.close;
    for (const profile of [undefined, AGENTPEY_PLATFORM_PROFILE, AP2_PROFILE, STRANGER_PROFILE]) expect((await s.open(profile)).status).toBe(201);
  });

  it("opens only for the platforms it names, and says so with a 403 and a UCP error", async () => {
    const s = await store({ ALLOWED_PLATFORMS: "https://agentpey.com" });
    close = s.close;
    expect((await s.open(AGENTPEY_PLATFORM_PROFILE)).status).toBe(201);
    expect((await s.open(AP2_PROFILE)).status).toBe(201);

    const refused = await s.open(STRANGER_PROFILE);
    expect(refused.status).toBe(403);
    expect(refused.body.ucp?.status).toBe("error");
    expect(refused.body.messages).toEqual([expect.objectContaining({ code: "platform_not_allowed", severity: "unrecoverable" })]);
    // A request that names no platform at all is not one of them either.
    expect((await s.open()).status).toBe(403);
  });

  it("requires AP2 when told to: a platform that did not negotiate it is refused", async () => {
    const s = await store({ REQUIRE_AP2: "true" });
    close = s.close;
    expect((await s.open(AP2_PROFILE)).status).toBe(201);
    const refused = await s.open(AGENTPEY_PLATFORM_PROFILE);
    expect(refused.status).toBe(403);
    expect(refused.body.messages).toEqual([expect.objectContaining({ code: "ap2_required", severity: "unrecoverable" })]);
    expect((await s.open()).status).toBe(403);
  });

  it("asks for both together: an approved platform that signs a mandate", async () => {
    const s = await store({ ALLOWED_PLATFORMS: "https://agentpey.com", REQUIRE_AP2: "true" });
    close = s.close;
    expect((await s.open(AP2_PROFILE)).status).toBe(201);
    expect((await s.open(AGENTPEY_PLATFORM_PROFILE)).body.messages?.[0]?.code).toBe("ap2_required");
    // AP2 is not enough on its own: a stranger that signs a mandate is still a stranger.
    expect((await s.open(STRANGER_PROFILE)).body.messages?.[0]?.code).toBe("platform_not_allowed");
  });
});

describe("platformRefusal and its settings", () => {
  const ap2 = { version: "2026-08-25", platform: { url: AP2_PROFILE, ap2: true } };

  it("answers nothing for an open policy", () => {
    expect(platformRefusal({ requireAp2: false, allowedPlatforms: [] }, { version: "2026-04-08", platform: null })).toBeUndefined();
  });

  it("does not take AP2 negotiated in the old version as AP2 (it is 2026-08-25 only)", () => {
    expect(platformRefusal({ requireAp2: true, allowedPlatforms: [] }, { ...ap2, version: "2026-04-08" })?.code).toBe("ap2_required");
    expect(platformRefusal({ requireAp2: true, allowedPlatforms: [] }, ap2)).toBeUndefined();
  });

  it("reads origins from URLs, once each, and only https", () => {
    expect(parseAllowedPlatforms(" https://a.example/x/profile.json, https://a.example , https://b.example")).toEqual(["https://a.example", "https://b.example"]);
    expect(parseAllowedPlatforms(undefined)).toEqual([]);
    for (const bad of ["http://a.example", "a.example", "https://ok.example, nope"]) expect(() => parseAllowedPlatforms(bad), bad).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });

  it("reads true and false, and refuses anything else", () => {
    expect(parseRequireAp2("true")).toBe(true);
    expect(parseRequireAp2(" FALSE ")).toBe(false);
    expect(parseRequireAp2(undefined)).toBe(false);
    expect(() => parseRequireAp2("yes")).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });
});
