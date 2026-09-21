import { AgentPassError, hasErrorCode } from "@agentpass/core";
import type { ApiKey } from "@agentpey/directory";
import { describe, expect, it, vi } from "vitest";

import { API_KEY_SECRET_PATTERN, authorizeRequest } from "./auth.js";

const VALID_SECRET = "ap_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function fakeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "apk_00000000000000000000000000",
    partnerId: "ptn_00000000000000000000000000",
    name: "test key",
    keyHash: "0".repeat(64),
    scopes: ["tenants:read"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

describe("API_KEY_SECRET_PATTERN", () => {
  it("matches the shape issueApiKey actually mints", () => {
    expect(API_KEY_SECRET_PATTERN.test(VALID_SECRET)).toBe(true);
    expect(API_KEY_SECRET_PATTERN.test("ap_live_whatever")).toBe(false);
    expect(API_KEY_SECRET_PATTERN.test("not-a-key")).toBe(false);
  });
});

describe("authorizeRequest", () => {
  it("throws MissingApiKey when there is no Authorization header", async () => {
    const authenticate = vi.fn();
    await expect(authorizeRequest(undefined, "tenants:read", authenticate)).rejects.toEqual(
      expect.objectContaining({ code: "MissingApiKey" }),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("throws InvalidApiKey when the header is not `Bearer <secret>`, without calling authenticate", async () => {
    const authenticate = vi.fn();
    await expect(authorizeRequest(`Basic ${VALID_SECRET}`, "tenants:read", authenticate)).rejects.toEqual(
      expect.objectContaining({ code: "InvalidApiKey" }),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("throws InvalidApiKey for a secret that does not match the minted shape, without a database round trip", async () => {
    const authenticate = vi.fn();
    await expect(authorizeRequest("Bearer ap_live_wrong-environment", "tenants:read", authenticate)).rejects.toEqual(
      expect.objectContaining({ code: "InvalidApiKey" }),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("throws InvalidApiKey when authenticate finds nothing — unknown and revoked look identical on purpose", async () => {
    const authenticate = vi.fn().mockResolvedValue(undefined);
    await expect(authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:read", authenticate)).rejects.toEqual(
      expect.objectContaining({ code: "InvalidApiKey" }),
    );
    expect(authenticate).toHaveBeenCalledWith(VALID_SECRET);
  });

  it("throws ScopeNotGranted, naming what was required and what was granted, when the key lacks the scope", async () => {
    const authenticate = vi.fn().mockResolvedValue(fakeApiKey({ scopes: ["agents:read"] }));
    await expect(authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:write", authenticate)).rejects.toEqual(
      expect.objectContaining({
        code: "ScopeNotGranted",
        details: { required: "tenants:write", granted: ["agents:read"] },
      }),
    );
  });

  it("resolves with the api key's id, partner and scopes when authenticated and in scope", async () => {
    const apiKey = fakeApiKey({ id: "apk_x", partnerId: "ptn_y", scopes: ["tenants:read", "agents:read"] });
    const authenticate = vi.fn().mockResolvedValue(apiKey);

    const result = await authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:read", authenticate);

    expect(result).toEqual({ apiKeyId: "apk_x", partnerId: "ptn_y", scopes: ["tenants:read", "agents:read"] });
  });

  it("lets a genuine AgentPassError from authenticate through unchanged", async () => {
    const authenticate = vi.fn().mockRejectedValue(new AgentPassError("ConfigError", "directory unreachable"));
    await expect(authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:read", authenticate)).rejects.toEqual(
      expect.objectContaining({ code: "ConfigError" }),
    );
  });

  it("wraps a non-AgentPassError failure from authenticate as InvalidApiKey, fail-closed", async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error("pool exploded"));
    await expect(authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:read", authenticate)).rejects.toEqual(
      expect.objectContaining({ code: "InvalidApiKey" }),
    );
  });
});

/** T95: where the limiter sits in authentication, which is what makes it unavoidable. */
describe("authorizeRequest — rate limiting", () => {
  const key = fakeApiKey({ id: "apk_counted", scopes: ["payments:authorize", "tenants:read"] });

  it("counts an authenticated, in-scope request against that key", async () => {
    const counted: string[] = [];
    await authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:read", vi.fn().mockResolvedValue(key), {
      count: async (input) => {
        counted.push(`${input.apiKeyId}/${input.tier}`);
        return 1;
      },
    });
    expect(counted).toEqual(["apk_counted/standard"]);
  });

  it("does not count a request the key has no permission for — fixing a scope mistake costs no budget", async () => {
    let calls = 0;
    await expect(
      authorizeRequest(`Bearer ${VALID_SECRET}`, "webhooks:write", vi.fn().mockResolvedValue(key), {
        count: async () => {
          calls += 1;
          return 1;
        },
      }),
    ).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "ScopeNotGranted"));
    expect(calls).toBe(0);
  });

  it("does not count an unknown key — there is no id to count it against", async () => {
    let calls = 0;
    await expect(
      authorizeRequest(`Bearer ${VALID_SECRET}`, "tenants:read", vi.fn().mockResolvedValue(undefined), {
        count: async () => {
          calls += 1;
          return 1;
        },
      }),
    ).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "InvalidApiKey"));
    expect(calls).toBe(0);
  });

  it("refuses a key over its limit, after authentication and scope both passed", async () => {
    await expect(
      authorizeRequest(`Bearer ${VALID_SECRET}`, "payments:authorize", vi.fn().mockResolvedValue(key), {
        count: async () => 11,
      }),
    ).rejects.toSatisfy((error: unknown) => hasErrorCode(error, "RateLimited"));
  });
});
