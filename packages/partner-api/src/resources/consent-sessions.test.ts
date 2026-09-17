import { newId, newTenantId, type ConsentSessionRecord } from "@agentpey/directory";
import { describe, expect, it } from "vitest";

import {
  computeConsentSessionStatus,
  consentSessionIdSchema,
  consentSessionResourceSchema,
  createConsentSessionRequestSchema,
  toConsentSessionResource,
} from "./consent-sessions.js";

const tenantId = newTenantId(newId("partner"));

const validGrant = {
  actions: ["catalog:read", "intent:create"],
  venues: ["mock-bazaar:CCL57L4ZQVQCGTQKGQMOAX7QDPEDW4LX2QSPBQMTMLB7BFQ7I3TM7F4A"],
  assets: ["USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
  limits: { perTx: "50.0000000", perDay: "200.0000000", currency: "USDC" },
  payTo: ["GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ"],
};

describe("createConsentSessionRequestSchema", () => {
  it("accepts a tenant, a grant reusing @agentpey/mandate's shape, and a validUntil", () => {
    const result = createConsentSessionRequestSchema.safeParse({
      tenant_id: tenantId,
      grant: validGrant,
      valid_until: "2026-12-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a grant with an empty payee-less venues array element removed — actions must be non-empty, same rule as a Mandate's grant", () => {
    const result = createConsentSessionRequestSchema.safeParse({
      tenant_id: tenantId,
      grant: { ...validGrant, actions: [] },
      valid_until: "2026-12-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  // C-123: without payTo, reconcileTerms skips the payee check entirely.
  it("rejects a grant without payTo", () => {
    const { payTo: _payTo, ...grant } = validGrant;
    const result = createConsentSessionRequestSchema.safeParse({
      tenant_id: tenantId,
      grant,
      valid_until: "2026-12-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["grant", "payTo"]);
  });

  it("rejects an empty payTo", () => {
    const result = createConsentSessionRequestSchema.safeParse({
      tenant_id: tenantId,
      grant: { ...validGrant, payTo: [] },
      valid_until: "2026-12-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("still rejects a payee that is not a Stellar account or contract", () => {
    const result = createConsentSessionRequestSchema.safeParse({
      tenant_id: tenantId,
      grant: { ...validGrant, payTo: ["not-an-address"] },
      valid_until: "2026-12-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("requires valid_until", () => {
    const result = createConsentSessionRequestSchema.safeParse({ tenant_id: tenantId, grant: validGrant });
    expect(result.success).toBe(false);
  });
});

describe("consentSessionIdSchema", () => {
  it("accepts the cns_ prefix in the same ULID shape @agentpey/directory uses for its own ids", () => {
    expect(consentSessionIdSchema.safeParse(`cns_${newId("agent").slice(4)}`).success).toBe(true);
  });

  it("rejects another entity's prefix", () => {
    expect(consentSessionIdSchema.safeParse(newId("agent")).success).toBe(false);
  });
});

describe("consentSessionResourceSchema", () => {
  it("allows consent_url and mandate_id to be null — the two states of a session that is not yet completed", () => {
    const result = consentSessionResourceSchema.safeParse({
      id: `cns_${newId("agent").slice(4)}`,
      tenant_id: tenantId,
      status: "pending",
      consent_url: "https://agentpay.example/consent/abc",
      // T81: always present in a response, null when the partner asked for no
      // redirect — the same required-but-nullable shape the two fields around
      // it already use.
      return_url: null,
      mandate_id: null,
      created_at: "2026-09-10T00:00:00.000Z",
      expires_at: "2026-09-10T01:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

function fakeSession(overrides: Partial<ConsentSessionRecord> = {}): ConsentSessionRecord {
  return {
    id: newId("consentSession"),
    tenantId,
    status: "pending",
    grant: validGrant,
    validFrom: new Date("2026-09-10T00:00:00.000Z"),
    validUntil: new Date("2026-12-01T00:00:00.000Z"),
    returnUrl: null,
    mandateId: null,
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    expiresAt: new Date("2026-09-10T01:00:00.000Z"),
    ...overrides,
  };
}

describe("computeConsentSessionStatus", () => {
  it("is 'pending' before the invitation expires", () => {
    expect(computeConsentSessionStatus(fakeSession(), new Date("2026-09-10T00:30:00.000Z"))).toBe("pending");
  });

  it("is 'expired' once the invitation window passes, even though nothing stored the transition", () => {
    expect(computeConsentSessionStatus(fakeSession(), new Date("2026-09-10T02:00:00.000Z"))).toBe("expired");
  });

  it("stays 'completed' regardless of the invitation window — a signed session does not expire retroactively", () => {
    expect(computeConsentSessionStatus(fakeSession({ status: "completed" }), new Date("2026-09-10T02:00:00.000Z"))).toBe(
      "completed",
    );
  });
});

describe("toConsentSessionResource", () => {
  it("shows consent_url only while pending", () => {
    const resource = toConsentSessionResource(fakeSession(), new Date("2026-09-10T00:30:00.000Z"), "https://agentpay.example/consent/abc");
    expect(resource.status).toBe("pending");
    expect(resource.consent_url).toBe("https://agentpay.example/consent/abc");
  });

  it("hides consent_url once expired — nothing left to redirect anyone to", () => {
    const resource = toConsentSessionResource(fakeSession(), new Date("2026-09-10T02:00:00.000Z"), "https://agentpay.example/consent/abc");
    expect(resource.status).toBe("expired");
    expect(resource.consent_url).toBeNull();
  });

  it("hides consent_url once completed, and carries the resulting mandate_id", () => {
    const mandateId = newId("mandate");
    const resource = toConsentSessionResource(
      fakeSession({ status: "completed", mandateId }),
      new Date("2026-09-10T00:30:00.000Z"),
      "https://agentpay.example/consent/abc",
    );
    expect(resource.consent_url).toBeNull();
    expect(resource.mandate_id).toBe(mandateId);
  });
});
