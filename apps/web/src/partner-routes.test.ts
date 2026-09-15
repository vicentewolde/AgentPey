import { createHash } from "node:crypto";

import { AgentPassError, stellarAddressToDid } from "@agentpass/core";
import {
  newId,
  newTenantId,
  type AgentInstance,
  type ApiKey,
  type ConsentSessionRecord,
  type IdempotencyRecord,
  type MandateRecord,
  type Tenant,
  type PurchaseRecord,
} from "@agentpey/directory";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { routePartnerRequest, statusForError, type ExecutePurchase, type PartnerRoutesDirectory } from "./partner-routes.js";

const PARTNER_A = newId("partner");
const PARTNER_B = newId("partner");
const SECRET_A = "ap_test_partner-a-secret";
const SECRET_B = "ap_test_partner-b-secret";

interface FakeDirectory extends PartnerRoutesDirectory {
  seedTenant(overrides?: Partial<Tenant>): Tenant;
  seedAgent(tenantId: string, overrides?: Partial<AgentInstance>): AgentInstance;
  seedMandate(tenantId: string, overrides?: Partial<MandateRecord>): MandateRecord;
  seedConsentSession(tenantId: string, overrides?: Partial<ConsentSessionRecord>): ConsentSessionRecord;
  revoke(secret: string): void;
  createTenantCalls: number;
  createConsentSessionCalls: number;
  /** T81: what this partner is allowed to redirect back to. */
  setReturnOrigins(origins: readonly string[]): void;
}

function fakeApiKeyRecord(partnerId: string, scopes: readonly string[]): ApiKey {
  return {
    id: newId("apiKey"),
    partnerId,
    name: "test key",
    keyHash: "0".repeat(64),
    scopes: [...scopes],
    createdAt: new Date(),
    revokedAt: null,
  };
}

function createFakeDirectory(): FakeDirectory {
  const apiKeys = new Map<string, { partnerId: string; scopes: readonly string[]; revoked: boolean }>();
  apiKeys.set(SECRET_A, { partnerId: PARTNER_A, scopes: ["tenants:read", "tenants:write", "agents:read", "mandates:read", "consent_sessions:read", "consent_sessions:write", "payments:authorize", "payments:read", "vault:read"], revoked: false });
  apiKeys.set(SECRET_B, { partnerId: PARTNER_B, scopes: ["tenants:read", "tenants:write", "agents:read", "mandates:read", "consent_sessions:read", "consent_sessions:write"], revoked: false });

  const tenants = new Map<string, Tenant>();
  const agentsByTenant = new Map<string, AgentInstance[]>();
  const mandatesById = new Map<string, MandateRecord>();
  const mandatesByTenant = new Map<string, MandateRecord[]>();
  const idempotency = new Map<string, IdempotencyRecord>();
  const consentSessions = new Map<string, ConsentSessionRecord>();
  const purchases = new Map<string, PurchaseRecord>();
  let createTenantCalls = 0;
  let createConsentSessionCalls = 0;
  let returnOrigins: readonly string[] = [];
  let purchaseSeq = 0;

  return {
    get createTenantCalls() {
      return createTenantCalls;
    },

    get createConsentSessionCalls() {
      return createConsentSessionCalls;
    },

    setReturnOrigins(origins) {
      returnOrigins = origins;
    },

    async findPartner(id) {
      return {
        id,
        name: "test partner",
        status: "active",
        returnOrigins: [...returnOrigins],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },

    async createPurchase(input) {
      purchaseSeq += 1;
      const record: PurchaseRecord = {
        id: `pur_0000000000000000000000000${purchaseSeq}`.slice(0, 30),
        tenantId: input.tenantId,
        agentId: input.agentId,
        mandateId: input.mandateId,
        partnerId: input.partnerId,
        outcome: input.outcome,
        code: input.code,
        reason: input.reason,
        venue: input.venue,
        productId: input.productId,
        quantity: input.quantity,
        intentId: input.intentId,
        total: input.total,
        asset: input.asset,
        payTo: input.payTo,
        transactionHash: input.transactionHash,
        delivery: input.delivery === null ? null : { ...input.delivery },
        createdAt: new Date("2026-09-12T00:00:00.000Z"),
      };
      purchases.set(record.id, record);
      return record;
    },

    async findPurchase(id) {
      return purchases.get(id);
    },

    revoke(secret) {
      const key = apiKeys.get(secret);
      if (key !== undefined) key.revoked = true;
    },

    seedTenant(overrides = {}) {
      const tenant: Tenant = {
        id: newTenantId(overrides.partnerId ?? PARTNER_A),
        partnerId: PARTNER_A,
        externalRef: `usr_${tenants.size}`,
        label: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
      tenants.set(tenant.id, tenant);
      return tenant;
    },

    seedAgent(tenantId, overrides = {}) {
      const keypair = Keypair.random();
      const agent: AgentInstance = {
        id: newId("agent"),
        tenantId,
        keyIndex: agentsByTenant.get(tenantId)?.length ?? 0,
        address: keypair.publicKey(),
        did: stellarAddressToDid(keypair.publicKey(), "testnet"),
        label: null,
        status: "active",
        onchainState: "derived",
        policyRailContractId: null,
        policyRailFundedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
      agentsByTenant.set(tenantId, [...(agentsByTenant.get(tenantId) ?? []), agent]);
      return agent;
    },

    seedMandate(tenantId, overrides = {}) {
      const mandate: MandateRecord = {
        id: newId("mandate"),
        tenantId,
        agentId: newId("agent"),
        principalId: newId("principal"),
        mandateHash: createHash("sha256").update(newId("mandate")).digest("hex"),
        signatureKind: "wallet-sep53",
        document: {},
        signature: "sig",
        jws: null,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-12-01T00:00:00.000Z"),
        anchorTx: "tx-1",
        supersedesId: null,
        revokedAt: null,
        revokeTx: null,
        createdAt: new Date(),
        ...overrides,
      };
      mandatesById.set(mandate.id, mandate);
      mandatesByTenant.set(tenantId, [...(mandatesByTenant.get(tenantId) ?? []), mandate]);
      return mandate;
    },

    seedConsentSession(tenantId, overrides = {}) {
      const now = new Date();
      const session: ConsentSessionRecord = {
        id: newId("consentSession"),
        tenantId,
        status: "pending",
        grant: { actions: ["catalog:read"], venues: [], assets: [], limits: { perTx: "1", perDay: "1", currency: "USDC" } },
        validFrom: now,
        validUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        returnUrl: null,
        mandateId: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        ...overrides,
      };
      consentSessions.set(session.id, session);
      return session;
    },

    async authenticate(secret) {
      const key = apiKeys.get(secret);
      if (key === undefined || key.revoked) return undefined;
      return fakeApiKeyRecord(key.partnerId, key.scopes);
    },

    async createTenant(input) {
      createTenantCalls += 1;
      const existing = [...tenants.values()].find((t) => t.partnerId === input.partnerId && t.externalRef === input.externalRef);
      if (existing !== undefined) {
        throw new AgentPassError("TenantAlreadyExists", "this partner already has a tenant for that external reference");
      }
      const tenant: Tenant = {
        id: newTenantId(input.partnerId),
        partnerId: input.partnerId,
        externalRef: input.externalRef,
        label: input.label ?? null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      tenants.set(tenant.id, tenant);
      return tenant;
    },

    async findTenant(id) {
      return tenants.get(id);
    },

    async findTenantByExternalRef(partnerId, externalRef) {
      return [...tenants.values()].find((t) => t.partnerId === partnerId && t.externalRef === externalRef);
    },

    async listAgents(tenantId) {
      return agentsByTenant.get(tenantId) ?? [];
    },

    async findMandateById(id) {
      return mandatesById.get(id);
    },

    async listMandates(tenantId) {
      return mandatesByTenant.get(tenantId) ?? [];
    },

    async findIdempotentResponse(partnerId, key) {
      return idempotency.get(`${partnerId}:${key}`);
    },

    async recordIdempotentResponse(input) {
      const record: IdempotencyRecord = {
        partnerId: input.partnerId,
        key: input.key,
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        createdAt: new Date(),
      };
      idempotency.set(`${input.partnerId}:${input.key}`, record);
      return record;
    },

    async createConsentSession(input) {
      createConsentSessionCalls += 1;
      const session: ConsentSessionRecord = {
        id: newId("consentSession"),
        tenantId: input.tenantId,
        status: "pending",
        grant: input.grant,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        returnUrl: input.returnUrl ?? null,
        mandateId: null,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
      };
      consentSessions.set(session.id, session);
      return session;
    },

    async findConsentSession(id) {
      return consentSessions.get(id);
    },
  };
}

let directory: FakeDirectory;

beforeEach(() => {
  directory = createFakeDirectory();
});

/** A purchase port that settles — the default for tests not about refusals. */
const settlingPurchase: ExecutePurchase = async (request) => ({
  kind: "settled",
  agentId: "agt_00000000000000000000000001",
  mandateId: request.mandateId ?? "mdt_00000000000000000000000001",
  intentId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
  total: "0.2500000",
  asset: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
  transactionHash: "b".repeat(64),
  resourceUrl: "https://signaldesk.example/api/x402/market-brief",
  // Shaped like the body SignalDesk releases: the delivery facts live inside it.
  resource: {
    ok: true,
    delivery_id: "01M2E2WZBRT9TVVWNRFX3D6Y2A",
    artifact_url: "https://signaldesk.example/deliveries/01M2E2WZBRT9TVVWNRFX3D6Y2A",
    receipt_hash: "c".repeat(64),
  },
});

function baseRequest(overrides: Partial<Parameters<typeof routePartnerRequest>[0]> = {}) {
  return {
    method: "GET",
    pathname: "/v1/tenants",
    searchParams: new URLSearchParams(),
    authorizationHeader: `Bearer ${SECRET_A}`,
    idempotencyKeyHeader: undefined,
    body: undefined,
    directory,
    baseUrl: "https://agentpay.example",
    // The default port settles. Tests that care about a refusal override it.
    executePurchase: settlingPurchase,
    readActivity: async (tenantId: string) => ({ tenant_id: tenantId, mandate: null, per_day: null, rail: null, purchases: [], refusals: [] }),
    ...overrides,
  };
}

describe("statusForError", () => {
  it("maps every code this route layer produces or passes through", () => {
    expect(statusForError(new AgentPassError("MissingApiKey", "x"))).toBe(401);
    expect(statusForError(new AgentPassError("InvalidApiKey", "x"))).toBe(401);
    expect(statusForError(new AgentPassError("ScopeNotGranted", "x"))).toBe(403);
    expect(statusForError(new AgentPassError("IdempotencyKeyRequired", "x"))).toBe(400);
    expect(statusForError(new AgentPassError("IdempotencyKeyConflict", "x"))).toBe(409);
    expect(statusForError(new AgentPassError("TenantNotFound", "x"))).toBe(404);
    expect(statusForError(new AgentPassError("NotImplemented", "x"))).toBe(501);
    expect(statusForError(new AgentPassError("PurchaseNotFound", "x"))).toBe(404);
    // A code this layer never anticipated must not masquerade as a client mistake.
    expect(statusForError(new AgentPassError("VaultCorrupted", "x"))).toBe(500);
    expect(statusForError(new Error("plain"))).toBe(500);
  });
});

describe("routePartnerRequest — auth", () => {
  it("401s with no Authorization header", async () => {
    const result = await routePartnerRequest(
      baseRequest({ pathname: `/v1/tenants/${newTenantId(PARTNER_A)}`, authorizationHeader: undefined }),
    );
    expect(result.status).toBe(401);
  });

  it("401s once the api key is revoked", async () => {
    directory.revoke(SECRET_A);
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/tenants/${newTenantId(PARTNER_A)}` }));
    expect(result.status).toBe(401);
  });

  it("404s for an unknown /v1 route", async () => {
    const result = await routePartnerRequest(baseRequest({ pathname: "/v1/nope" }));
    expect(result.status).toBe(404);
  });
});

describe("routePartnerRequest — POST /v1/tenants", () => {
  function createRequest(body: unknown, idempotencyKeyHeader?: string) {
    return baseRequest({ method: "POST", pathname: "/v1/tenants", body, idempotencyKeyHeader });
  }

  it("requires an Idempotency-Key", async () => {
    const result = await routePartnerRequest(createRequest({ external_ref: "usr_1" }));
    expect(result.status).toBe(400);
    expect(directory.createTenantCalls).toBe(0);
  });

  it("creates a tenant and returns 201", async () => {
    const result = await routePartnerRequest(createRequest({ external_ref: "usr_1" }, "key-1"));
    expect(result.status).toBe(201);
    expect((result.body as { data: { external_ref: string } }).data.external_ref).toBe("usr_1");
    expect(directory.createTenantCalls).toBe(1);
  });

  it("replays the same response for a repeated Idempotency-Key with the same body, without creating twice", async () => {
    const first = await routePartnerRequest(createRequest({ external_ref: "usr_2" }, "key-2"));
    const second = await routePartnerRequest(createRequest({ external_ref: "usr_2" }, "key-2"));
    expect(second).toEqual(first);
    expect(directory.createTenantCalls).toBe(1);
  });

  it("conflicts when the same Idempotency-Key repeats with a different body", async () => {
    await routePartnerRequest(createRequest({ external_ref: "usr_3" }, "key-3"));
    const result = await routePartnerRequest(createRequest({ external_ref: "usr_different" }, "key-3"));
    expect(result.status).toBe(409);
    expect(directory.createTenantCalls).toBe(1);
  });

  it("is idempotent on (partner, external_ref) at the business level too — a fresh Idempotency-Key still finds the existing tenant", async () => {
    const first = await routePartnerRequest(createRequest({ external_ref: "usr_4" }, "key-4a"));
    const second = await routePartnerRequest(createRequest({ external_ref: "usr_4" }, "key-4b"));
    expect(second.status).toBe(200);
    expect((second.body as { data: { id: string } }).data.id).toBe((first.body as { data: { id: string } }).data.id);
    expect(directory.createTenantCalls).toBe(2);
  });

  it("400s a malformed body without ever calling createTenant", async () => {
    const result = await routePartnerRequest(createRequest({}, "key-5"));
    expect(result.status).toBe(400);
    expect(directory.createTenantCalls).toBe(0);
  });

  it("403s a key that lacks tenants:write, without creating anything", async () => {
    const restricted = "ap_test_readonly-secret-key";
    const scopedDirectory = createFakeDirectory();
    // Reach into the fake to add a read-only key by authenticating through the normal seam.
    const original = scopedDirectory.authenticate.bind(scopedDirectory);
    scopedDirectory.authenticate = async (secret) => (secret === restricted ? fakeApiKeyRecord(PARTNER_A, ["tenants:read"]) : original(secret));

    const result = await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/tenants", body: { external_ref: "usr_x" }, idempotencyKeyHeader: "key-x", authorizationHeader: `Bearer ${restricted}`, directory: scopedDirectory }),
    );
    expect(result.status).toBe(403);
  });
});

describe("routePartnerRequest — GET /v1/tenants/{id}", () => {
  it("returns the tenant when it belongs to this partner", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A, externalRef: "usr_owned" });
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/tenants/${tenant.id}` }));
    expect(result.status).toBe(200);
    expect((result.body as { data: { id: string } }).data.id).toBe(tenant.id);
  });

  it("404s a tenant that belongs to a different partner, instead of 403 — never confirms it exists", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B, externalRef: "usr_not_mine" });
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/tenants/${tenant.id}` }));
    expect(result.status).toBe(404);
  });

  it("404s a tenant id that does not exist at all", async () => {
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/tenants/${newTenantId(PARTNER_A)}` }));
    expect(result.status).toBe(404);
  });
});

describe("routePartnerRequest — GET /v1/agents", () => {
  it("requires tenant_id", async () => {
    const result = await routePartnerRequest(baseRequest({ pathname: "/v1/agents" }));
    expect(result.status).toBe(400);
  });

  it("lists a tenant's agents, mapped to the public resource shape", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const agent = directory.seedAgent(tenant.id);
    const result = await routePartnerRequest(
      baseRequest({ pathname: "/v1/agents", searchParams: new URLSearchParams({ tenant_id: tenant.id }) }),
    );
    expect(result.status).toBe(200);
    expect((result.body as { data: Array<{ id: string }> }).data).toEqual([expect.objectContaining({ id: agent.id })]);
  });

  it("404s when the tenant belongs to a different partner", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    const result = await routePartnerRequest(
      baseRequest({ pathname: "/v1/agents", searchParams: new URLSearchParams({ tenant_id: tenant.id }) }),
    );
    expect(result.status).toBe(404);
  });
});

describe("routePartnerRequest — GET /v1/mandates/{id} and /v1/mandates", () => {
  it("computes status from validity/revocation the same way toMandateResource does", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const mandate = directory.seedMandate(tenant.id);
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/mandates/${mandate.id}`, now: new Date("2026-06-01T00:00:00.000Z") }));
    expect(result.status).toBe(200);
    expect((result.body as { data: { status: string } }).data.status).toBe("active");
  });

  it("404s a mandate whose tenant belongs to a different partner", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    const mandate = directory.seedMandate(tenant.id);
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/mandates/${mandate.id}` }));
    expect(result.status).toBe(404);
  });

  it("404s an unknown mandate id", async () => {
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/mandates/${newId("mandate")}` }));
    expect(result.status).toBe(404);
  });

  it("lists every mandate of a tenant regardless of status, not only active ones", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const active = directory.seedMandate(tenant.id);
    const revoked = directory.seedMandate(tenant.id, { revokedAt: new Date("2026-02-01T00:00:00.000Z") });
    const result = await routePartnerRequest(
      baseRequest({ pathname: "/v1/mandates", searchParams: new URLSearchParams({ tenant_id: tenant.id }) }),
    );
    expect(result.status).toBe(200);
    const ids = (result.body as { data: Array<{ id: string }> }).data.map((m) => m.id).sort();
    expect(ids).toEqual([active.id, revoked.id].sort());
  });
});

describe("routePartnerRequest — POST /v1/consent_sessions", () => {
  const validBody = {
    tenant_id: "",
    grant: { actions: ["catalog:read"], venues: [], assets: [], limits: { perTx: "1", perDay: "1", currency: "USDC" } },
    valid_until: "2026-12-01T00:00:00.000Z",
  };

  it("requires an Idempotency-Key", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/consent_sessions", body: { ...validBody, tenant_id: tenant.id } }),
    );
    expect(result.status).toBe(400);
    expect(directory.createConsentSessionCalls).toBe(0);
  });

  it("creates a pending consent session with a consent_url built from baseUrl", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/consent_sessions",
        body: { ...validBody, tenant_id: tenant.id },
        idempotencyKeyHeader: "cs-key-1",
        baseUrl: "https://agentpay.example",
      }),
    );
    expect(result.status).toBe(201);
    const data = (result.body as { data: { id: string; status: string; consent_url: string; tenant_id: string } }).data;
    expect(data.status).toBe("pending");
    expect(data.tenant_id).toBe(tenant.id);
    expect(data.consent_url).toBe(`https://agentpay.example/consent/${data.id}`);
    expect(directory.createConsentSessionCalls).toBe(1);
  });

  it("404s when the tenant belongs to a different partner, and never creates a session", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/consent_sessions",
        body: { ...validBody, tenant_id: tenant.id },
        idempotencyKeyHeader: "cs-key-2",
      }),
    );
    expect(result.status).toBe(404);
    expect(directory.createConsentSessionCalls).toBe(0);
  });

  it("400s a malformed grant without creating anything", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/consent_sessions",
        body: { tenant_id: tenant.id, grant: { actions: [] }, valid_until: "2026-12-01T00:00:00.000Z" },
        idempotencyKeyHeader: "cs-key-3",
      }),
    );
    expect(result.status).toBe(400);
    expect(directory.createConsentSessionCalls).toBe(0);
  });
});

/**
 * T81. A consent session ends with a redirect, so an unchecked `return_url`
 * would make the consent page an open redirect hosted on AgentPey's own
 * domain — the most credible possible place for one, since it is exactly
 * where the person was told to go and sign.
 */
describe("routePartnerRequest — POST /v1/consent_sessions return_url allowlist", () => {
  const validBody = {
    tenant_id: "",
    grant: { actions: ["catalog:read"], venues: [], assets: [], limits: { perTx: "1", perDay: "1", currency: "USDC" } },
    valid_until: "2026-12-01T00:00:00.000Z",
  };

  async function create(returnUrl: string | undefined, key: string) {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    return routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/consent_sessions",
        body: { ...validBody, tenant_id: tenant.id, ...(returnUrl === undefined ? {} : { return_url: returnUrl }) },
        idempotencyKeyHeader: key,
        baseUrl: "https://agentpay.example",
      }),
    );
  }

  it("accepts a return_url whose origin the partner registered", async () => {
    directory.setReturnOrigins(["https://realops.example"]);
    const result = await create("https://realops.example/agentes/rag_1", "ru-1");

    expect(result.status).toBe(201);
    expect((result.body as { data: { return_url: string } }).data.return_url).toBe("https://realops.example/agentes/rag_1");
  });

  it("refuses an origin the partner never registered, without creating a session", async () => {
    directory.setReturnOrigins(["https://realops.example"]);
    const before = directory.createConsentSessionCalls;
    const result = await create("https://attacker.test/volver", "ru-2");

    expect(result.status).toBe(400);
    expect((result.body as { code: string }).code).toBe("ReturnUrlNotAllowed");
    expect(directory.createConsentSessionCalls).toBe(before);
  });

  it("refuses a lookalike host", async () => {
    directory.setReturnOrigins(["https://realops.example"]);
    const result = await create("https://realops.example.attacker.test/volver", "ru-3");

    expect(result.status).toBe(400);
  });

  it("refuses every return_url for a partner that registered none", async () => {
    directory.setReturnOrigins([]);
    const result = await create("https://realops.example/volver", "ru-4");

    expect(result.status).toBe(400);
  });

  it("still creates a session with no return_url at all — the redirect is optional", async () => {
    directory.setReturnOrigins([]);
    const result = await create(undefined, "ru-5");

    expect(result.status).toBe(201);
    expect((result.body as { data: { return_url: string | null } }).data.return_url).toBeNull();
  });
});

describe("routePartnerRequest — GET /v1/consent_sessions/{id}", () => {
  it("returns a pending session with its consent_url", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const session = directory.seedConsentSession(tenant.id);
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/consent_sessions/${session.id}` }));
    expect(result.status).toBe(200);
    const data = (result.body as { data: { status: string; consent_url: string | null } }).data;
    expect(data.status).toBe("pending");
    expect(data.consent_url).toBe(`https://agentpay.example/consent/${session.id}`);
  });

  it("hides consent_url and shows the mandate_id once completed", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const mandateId = newId("mandate");
    const session = directory.seedConsentSession(tenant.id, { status: "completed", mandateId });
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/consent_sessions/${session.id}` }));
    const data = (result.body as { data: { consent_url: string | null; mandate_id: string | null } }).data;
    expect(data.consent_url).toBeNull();
    expect(data.mandate_id).toBe(mandateId);
  });

  it("shows status 'expired' once the invitation window passes, purely computed", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const past = new Date("2026-01-01T00:00:00.000Z");
    const session = directory.seedConsentSession(tenant.id, { expiresAt: past });
    const result = await routePartnerRequest(
      baseRequest({ pathname: `/v1/consent_sessions/${session.id}`, now: new Date("2026-06-01T00:00:00.000Z") }),
    );
    expect((result.body as { data: { status: string } }).data.status).toBe("expired");
  });

  it("404s a consent session belonging to a different partner", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    const session = directory.seedConsentSession(tenant.id);
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/consent_sessions/${session.id}` }));
    expect(result.status).toBe(404);
  });

  it("404s an id that does not exist", async () => {
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/consent_sessions/${newId("consentSession")}` }));
    expect(result.status).toBe(404);
  });
});

describe("routePartnerRequest — POST /v1/purchases", () => {
  const VENUE = "signaldesk:CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";

  function purchaseBody(tenantId: string, overrides: Record<string, unknown> = {}) {
    return { tenant_id: tenantId, venue: VENUE, product_id: "signaldesk:market-brief-xlm-usdc", quantity: 1, ...overrides };
  }

  const refusingPurchase: ExecutePurchase = async (request) => ({
    kind: "refused",
    agentId: "agt_00000000000000000000000001",
    mandateId: request.mandateId ?? "mdt_00000000000000000000000001",
    code: "MandateProductNotAllowed",
    reason: "tu Mandato no permite este producto",
    details: { productId: "otro" },
    intentId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
  });

  it("settles, and hands back the transaction plus a link the buyer can check themselves", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/purchases", body: purchaseBody(tenant.id), idempotencyKeyHeader: "pur-1" }),
    );
    expect(result.status).toBe(201);
    const data = (result.body as { data: { outcome: string; transaction_hash: string; explorer_url: string; delivery: unknown } }).data;
    expect(data.outcome).toBe("settled");
    expect(data.explorer_url).toBe(`https://stellar.expert/explorer/testnet/tx/${"b".repeat(64)}`);
    // T84: the link is the merchant's delivery, not the paid route — which
    // answers 402 and is what this assertion used to (wrongly) pin.
    expect(data.delivery).toMatchObject({
      delivery_id: "01M2E2WZBRT9TVVWNRFX3D6Y2A",
      artifact_url: "https://signaldesk.example/deliveries/01M2E2WZBRT9TVVWNRFX3D6Y2A",
      receipt_hash: "c".repeat(64),
    });
  });

  it("answers 201 for a refusal too — a Mandate saying no is this system working", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        body: purchaseBody(tenant.id),
        idempotencyKeyHeader: "pur-2",
        executePurchase: refusingPurchase,
      }),
    );
    expect(result.status).toBe(201);
    const data = (result.body as { data: { outcome: string; code: string; reason: string; total: string | null } }).data;
    expect(data.outcome).toBe("refused");
    expect(data.code).toBe("MandateProductNotAllowed");
    expect(data.reason).toContain("no permite este producto");
    expect(data.total).toBeNull();
  });

  it("records the refusal, so a rejected attempt is readable afterwards", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const created = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        body: purchaseBody(tenant.id),
        idempotencyKeyHeader: "pur-3",
        executePurchase: refusingPurchase,
      }),
    );
    const id = (created.body as { data: { id: string } }).data.id;
    const read = await routePartnerRequest(baseRequest({ pathname: `/v1/purchases/${id}` }));
    expect(read.status).toBe(200);
    expect((read.body as { data: { code: string } }).data.code).toBe("MandateProductNotAllowed");
  });

  it("replays the stored response for a repeated Idempotency-Key, without buying twice", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    let calls = 0;
    const counting: ExecutePurchase = async (request) => {
      calls += 1;
      return settlingPurchase(request);
    };
    const body = purchaseBody(tenant.id);
    const first = await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/purchases", body, idempotencyKeyHeader: "pur-4", executePurchase: counting }),
    );
    const second = await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/purchases", body, idempotencyKeyHeader: "pur-4", executePurchase: counting }),
    );
    expect(calls).toBe(1);
    expect(second.status).toBe(first.status);
    expect((second.body as { data: { id: string } }).data.id).toBe((first.body as { data: { id: string } }).data.id);
  });

  it("409s the same key with a different body, rather than answering for the wrong purchase", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/purchases", body: purchaseBody(tenant.id), idempotencyKeyHeader: "pur-5" }),
    );
    const second = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        body: purchaseBody(tenant.id, { quantity: 9 }),
        idempotencyKeyHeader: "pur-5",
      }),
    );
    expect(second.status).toBe(409);
  });

  it("refuses a key without payments:authorize before the purchase port is ever called", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    let called = false;
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        authorizationHeader: `Bearer ${SECRET_B}`,
        body: purchaseBody(tenant.id),
        idempotencyKeyHeader: "pur-6",
        executePurchase: async (request) => {
          called = true;
          return settlingPurchase(request);
        },
      }),
    );
    expect(result.status).toBe(403);
    expect(called).toBe(false);
  });

  it("still requires an Idempotency-Key — a purchase is never safe to replay blindly", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({ method: "POST", pathname: "/v1/purchases", body: purchaseBody(tenant.id) }),
    );
    expect(result.status).toBe(400);
    expect((result.body as { code: string }).code).toBe("IdempotencyKeyRequired");
  });

  it("404s another partner's tenant, and never reaches the purchase port", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    let called = false;
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        body: purchaseBody(tenant.id),
        idempotencyKeyHeader: "pur-7",
        executePurchase: async (request) => {
          called = true;
          return settlingPurchase(request);
        },
      }),
    );
    expect(result.status).toBe(404);
    expect(called).toBe(false);
  });

  it("400s a body carrying a field this route does not know", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        body: purchaseBody(tenant.id, { pay_to: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K" }),
        idempotencyKeyHeader: "pur-8",
      }),
    );
    expect(result.status).toBe(400);
  });

  it("passes route params through to the purchase port, verbatim", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    let seen: unknown;
    await routePartnerRequest(
      baseRequest({
        method: "POST",
        pathname: "/v1/purchases",
        body: purchaseBody(tenant.id, { route_params: { pair: "XLM/USDC", amount: 100 } }),
        idempotencyKeyHeader: "pur-9",
        executePurchase: async (request) => {
          seen = request.routeParams;
          return settlingPurchase(request);
        },
      }),
    );
    expect(seen).toEqual({ pair: "XLM/USDC", amount: 100 });
  });

  /**
   * T90: `mandate_id` chooses which of the tenant's Mandates a purchase goes
   * through. The route's whole job with it is to make sure it is this tenant's,
   * and to say nothing else about it when it is not.
   */
  describe("naming the Mandate to go through (T90)", () => {
    function post(body: unknown, key: string, executePurchase: ExecutePurchase = settlingPurchase) {
      return routePartnerRequest(
        baseRequest({ method: "POST", pathname: "/v1/purchases", body, idempotencyKeyHeader: key, executePurchase }),
      );
    }

    function spy() {
      const calls: Parameters<ExecutePurchase>[0][] = [];
      const port: ExecutePurchase = async (request) => {
        calls.push(request);
        return settlingPurchase(request);
      };
      return { calls, port };
    }

    it("passes one of this tenant's own Mandates to the purchase port, and records it on the purchase", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const mandate = directory.seedMandate(tenant.id);
      const { calls, port } = spy();

      const result = await post(purchaseBody(tenant.id, { mandate_id: mandate.id }), "pur-t90-1", port);

      expect(result.status).toBe(201);
      expect(calls.map((call) => call.mandateId)).toEqual([mandate.id]);
      expect((result.body as { data: { mandate_id: string } }).data.mandate_id).toBe(mandate.id);
    });

    it("records the Mandate a refusal went through, too", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const mandate = directory.seedMandate(tenant.id);

      const result = await post(purchaseBody(tenant.id, { mandate_id: mandate.id }), "pur-t90-2", refusingPurchase);

      expect((result.body as { data: { outcome: string; mandate_id: string } }).data).toMatchObject({
        outcome: "refused",
        mandate_id: mandate.id,
      });
    });

    it("leaves the choice to the platform when no Mandate is named, as before T90", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const { calls, port } = spy();

      await post(purchaseBody(tenant.id), "pur-t90-3", port);

      expect(calls).toHaveLength(1);
      expect("mandateId" in calls[0]!).toBe(false);
    });

    it("404s another partner's Mandate with the same body as one that does not exist, and never reaches the port", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const foreignTenant = directory.seedTenant({ partnerId: PARTNER_B });
      const foreign = directory.seedMandate(foreignTenant.id);
      const missing = newId("mandate");
      const { calls, port } = spy();

      const toForeign = await post(purchaseBody(tenant.id, { mandate_id: foreign.id }), "pur-t90-4", port);
      const toMissing = await post(purchaseBody(tenant.id, { mandate_id: missing }), "pur-t90-5", port);

      expect(toForeign.status).toBe(404);
      expect(toMissing.status).toBe(404);
      expect(toForeign.body).toMatchObject({ code: "MandateNotFound", details: { mandateId: foreign.id } });
      // Identical apart from the id the caller sent: nothing says the foreign one exists.
      expect(JSON.stringify(toForeign.body).replace(foreign.id, "ID")).toBe(JSON.stringify(toMissing.body).replace(missing, "ID"));
      expect(calls).toHaveLength(0);
    });

    it("404s a Mandate of another tenant of the same partner, since it is not consent for this one", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const sibling = directory.seedTenant({ partnerId: PARTNER_A });
      const siblings = directory.seedMandate(sibling.id);
      const { calls, port } = spy();

      const result = await post(purchaseBody(tenant.id, { mandate_id: siblings.id }), "pur-t90-6", port);

      expect(result.status).toBe(404);
      expect((result.body as { code: string }).code).toBe("MandateNotFound");
      expect(calls).toHaveLength(0);
    });

    it("still answers TenantNotFound for another partner's tenant, before looking at the Mandate at all", async () => {
      const foreignTenant = directory.seedTenant({ partnerId: PARTNER_B });
      const foreign = directory.seedMandate(foreignTenant.id);

      const result = await post(purchaseBody(foreignTenant.id, { mandate_id: foreign.id }), "pur-t90-7");

      expect(result.status).toBe(404);
      expect((result.body as { code: string }).code).toBe("TenantNotFound");
    });

    it("400s a mandate_id that is null or not a Mandate id, without reaching the port", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const { calls, port } = spy();

      const asNull = await post(purchaseBody(tenant.id, { mandate_id: null }), "pur-t90-8", port);
      const asTenant = await post(purchaseBody(tenant.id, { mandate_id: tenant.id }), "pur-t90-9", port);

      expect(asNull.status).toBe(400);
      expect(asTenant.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("409s the same Idempotency-Key sent again with another Mandate, instead of buying through the second", async () => {
      const tenant = directory.seedTenant({ partnerId: PARTNER_A });
      const first = directory.seedMandate(tenant.id);
      const second = directory.seedMandate(tenant.id);
      const { calls, port } = spy();

      await post(purchaseBody(tenant.id, { mandate_id: first.id }), "pur-t90-10", port);
      const again = await post(purchaseBody(tenant.id, { mandate_id: second.id }), "pur-t90-10", port);

      expect(again.status).toBe(409);
      expect(calls.map((call) => call.mandateId)).toEqual([first.id]);
    });
  });
});

describe("routePartnerRequest — GET /v1/purchases/{id}", () => {
  it("404s a purchase belonging to another partner, never 403", async () => {
    const tenantB = directory.seedTenant({ partnerId: PARTNER_B });
    const record = await directory.createPurchase({
      tenantId: tenantB.id,
      agentId: null,
      mandateId: null,
      partnerId: PARTNER_B,
      outcome: "refused",
      code: "VenueNotRegistered",
      reason: "no",
      venue: "x:CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F",
      productId: "p",
      quantity: 1,
      intentId: null,
      total: null,
      asset: null,
      payTo: null,
      transactionHash: null,
      delivery: null,
    });
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/purchases/${record.id}` }));
    expect(result.status).toBe(404);
    expect((result.body as { code: string }).code).toBe("PurchaseNotFound");
  });

  it("404s an id that does not exist", async () => {
    const result = await routePartnerRequest(baseRequest({ pathname: "/v1/purchases/pur_01JB0000000000000000000003" }));
    expect(result.status).toBe(404);
  });
});

describe("routePartnerRequest — GET /v1/tenants/{id}/activity", () => {
  it("returns the tenant's activity behind vault:read", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/tenants/${tenant.id}/activity` }));
    expect(result.status).toBe(200);
    expect((result.body as { data: { tenant_id: string } }).data.tenant_id).toBe(tenant.id);
  });

  it("refuses a key without vault:read", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    const result = await routePartnerRequest(
      baseRequest({ pathname: `/v1/tenants/${tenant.id}/activity`, authorizationHeader: `Bearer ${SECRET_B}` }),
    );
    expect(result.status).toBe(403);
  });

  it("404s another partner's tenant, and never reads a figure about it", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_B });
    let called = false;
    const result = await routePartnerRequest(
      baseRequest({
        pathname: `/v1/tenants/${tenant.id}/activity`,
        readActivity: async (id: string) => {
          called = true;
          return { tenant_id: id, mandate: null, per_day: null, rail: null, purchases: [], refusals: [] };
        },
      }),
    );
    expect(result.status).toBe(404);
    expect(called).toBe(false);
  });

  it("rejects every write method on it — this route only ever reads", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await routePartnerRequest(
        baseRequest({ method, pathname: `/v1/tenants/${tenant.id}/activity`, body: {} }),
      );
      expect(result.status).toBe(404);
    }
  });

  it("does not shadow GET /v1/tenants/{id}, which still returns the tenant", async () => {
    const tenant = directory.seedTenant({ partnerId: PARTNER_A });
    const result = await routePartnerRequest(baseRequest({ pathname: `/v1/tenants/${tenant.id}` }));
    expect(result.status).toBe(200);
  });
});

describe("routePartnerRequest — never throws", () => {
  it("turns even an unexpected directory failure into a response, not a rejection", async () => {
    const explodingDirectory: PartnerRoutesDirectory = {
      ...directory,
      findTenant: async () => {
        throw new Error("connection reset (simulated)");
      },
    };
    const result = await routePartnerRequest(
      baseRequest({ pathname: `/v1/tenants/${newTenantId(PARTNER_A)}`, directory: explodingDirectory }),
    );
    expect(result.status).toBe(500);
  });
});
