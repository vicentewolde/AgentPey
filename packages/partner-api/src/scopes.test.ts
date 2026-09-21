import { describe, expect, it } from "vitest";

import { API_SCOPES, apiScopeCovers, apiScopeSchema, areValidApiScopes } from "./scopes.js";

describe("apiScopeSchema", () => {
  it("accepts every frozen scope", () => {
    for (const scope of API_SCOPES) {
      expect(apiScopeSchema.safeParse(scope).success).toBe(true);
    }
  });

  it("rejects a scope from the credential/mandate Scope vocabulary, and anything else unknown", () => {
    expect(apiScopeSchema.safeParse("catalog:read").success).toBe(false);
    expect(apiScopeSchema.safeParse("intent:create").success).toBe(false);
    expect(apiScopeSchema.safeParse("").success).toBe(false);
  });

  it("still rejects a permission whose route nobody has implemented", () => {
    // The rule this file has followed since T45: a permission is added the
    // day its route exists, never before. T73 added the three F9 needs;
    // revocation is still the principal's own wallet-signed action, not
    // something a partner key can trigger.
    expect(apiScopeSchema.safeParse("mandates:revoke").success).toBe(false);
    expect(apiScopeSchema.safeParse("agents:write").success).toBe(false);
  });

  it("accepts the three T73 added, so a key can actually be granted them", () => {
    expect(apiScopeSchema.safeParse("payments:authorize").success).toBe(true);
    expect(apiScopeSchema.safeParse("payments:read").success).toBe(true);
    expect(apiScopeSchema.safeParse("vault:read").success).toBe(true);
  });
});

describe("areValidApiScopes", () => {
  it("is true only when every element is a known scope", () => {
    expect(areValidApiScopes(["tenants:read", "mandates:read"])).toBe(true);
    expect(areValidApiScopes([])).toBe(true);
    expect(areValidApiScopes(["tenants:read", "vault:read"])).toBe(true);
    expect(areValidApiScopes(["tenants:read", "mandates:revoke"])).toBe(false);
  });
});

describe("apiScopeCovers", () => {
  it("is true exactly when the required scope is among the granted ones", () => {
    expect(apiScopeCovers(["tenants:read", "agents:read"], "tenants:read")).toBe(true);
    expect(apiScopeCovers(["tenants:read"], "tenants:write")).toBe(false);
    expect(apiScopeCovers([], "mandates:read")).toBe(false);
  });
});

describe("payments:preview — T93", () => {
  it("is a permission a key can actually be granted", () => {
    expect(areValidApiScopes(["payments:preview"])).toBe(true);
  });

  it("is not implied by payments:authorize — this list is flat, and stays flat", () => {
    // Deliberate: a key that may spend is not thereby a key that may ask, and
    // inventing a hierarchy for one pair would leave every later reader
    // guessing which other pairs have one.
    expect(apiScopeCovers(["payments:authorize"], "payments:preview")).toBe(false);
  });

  it("does not let a preview-only key spend", () => {
    // The whole reason it is separate: a dashboard that shows people why a
    // purchase would be refused must not hold the power to make one.
    expect(apiScopeCovers(["payments:preview"], "payments:authorize")).toBe(false);
    expect(apiScopeCovers(["payments:preview"], "payments:preview")).toBe(true);
  });
});

describe("webhooks:read and webhooks:write — T94", () => {
  it("are both permissions a key can be granted", () => {
    expect(areValidApiScopes(["webhooks:read", "webhooks:write"])).toBe(true);
  });

  it("do not imply each other", () => {
    // Registering an endpoint is the one thing a partner can do that makes
    // this process open an outbound connection to an address they chose.
    // Listing endpoints is harmless, and should not carry that.
    expect(apiScopeCovers(["webhooks:read"], "webhooks:write")).toBe(false);
    expect(apiScopeCovers(["webhooks:write"], "webhooks:read")).toBe(false);
  });
});
