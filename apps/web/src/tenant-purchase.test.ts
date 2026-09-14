/**
 * These tests cover the part of a purchase that decides *whether to go on* —
 * everything before the first byte leaves for a venue. That is deliberate,
 * and it is where the risk of T74 lives: moving enforcement out of a cookie
 * session is only safe if nothing that used to refuse stopped refusing.
 *
 * Anything past the point where a real 402 is fetched is network, and belongs
 * to the integration run against testnet, not here.
 */
import { AgentPassError, stellarAddressToDid } from "@agentpass/core";
import { loadVenueRegistry } from "@agentpey/agent";
import type { AgentInstance, CredentialRecord, MandateRecord } from "@agentpey/directory";
import { createMandate } from "@agentpey/mandate";
import { generateMasterMnemonic } from "@agentpey/tenancy";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  executeTenantPurchase,
  explainMissingMandate,
  selectMandateFor,
  withheldBecause,
  type AgentDocumentStates,
  type TenantPurchaseDeps,
  type TenantPurchaseDirectory,
} from "./tenant-purchase.js";

const TENANT = "ptn_00000000000000000000000001:00000000000000000000000001";
const VENUE_CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const REGISTERED_VENUE = `signaldesk:${VENUE_CONTRACT}`;
const UNREGISTERED_VENUE = `comercio-hostil:${VENUE_CONTRACT}`;

const registry = loadVenueRegistry([
  {
    slug: "signaldesk",
    address: VENUE_CONTRACT,
    baseUrl: "https://signaldesk.example",
    assets: [{ code: "USDC", issuer: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }],
  },
]);

const agentAddress = Keypair.random().publicKey();

function fakeAgentRow(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: "agt_00000000000000000000000001",
    tenantId: TENANT,
    keyIndex: 0,
    address: agentAddress,
    did: stellarAddressToDid(agentAddress, "testnet"),
    label: null,
    status: "active",
    onchainState: "derived",
    policyRailContractId: null,
    policyRailFundedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeCredential(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "crd_00000000000000000000000001",
    agentId: "agt_00000000000000000000000001",
    tenantId: TENANT,
    credentialHash: "a".repeat(64),
    issuerDid: stellarAddressToDid(Keypair.random().publicKey(), "testnet"),
    principalDid: stellarAddressToDid(Keypair.random().publicKey(), "testnet"),
    jws: "header.payload.signature",
    validFrom: new Date("2026-09-01T00:00:00.000Z"),
    validUntil: new Date("2026-12-01T00:00:00.000Z"),
    anchorTx: "b".repeat(64),
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeMandate(overrides: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: "mdt_00000000000000000000000001",
    tenantId: TENANT,
    agentId: "agt_00000000000000000000000001",
    principalId: "prc_00000000000000000000000001",
    mandateHash: "c".repeat(64),
    signatureKind: "wallet-sep53",
    document: { version: "not a mandate" },
    signature: "sig",
    jws: null,
    validFrom: new Date("2026-09-01T00:00:00.000Z"),
    validUntil: new Date("2026-12-01T00:00:00.000Z"),
    anchorTx: "d".repeat(64),
    supersedesId: null,
    revokedAt: null,
    revokeTx: null,
    createdAt: new Date(),
    ...overrides,
  };
}

interface FakeState {
  readonly credential?: CredentialRecord;
  /** What `listActiveMandates` returns. */
  readonly mandates?: readonly MandateRecord[];
  /** Every mandate of the tenant, any status, oldest first — what `listMandates` returns. Defaults to `mandates`. */
  readonly history?: readonly MandateRecord[];
}

/**
 * Counts every call that would reach the outside world, so a test can assert
 * "nothing was contacted" rather than only "the answer was no".
 */
function fakeDirectory(state: FakeState): TenantPurchaseDirectory & { reads: number } {
  const row = fakeAgentRow();
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async listAgents() {
      return [row];
    },
    async createAgent() {
      throw new Error("a purchase must never create an agent");
    },
    async setAgentPolicyRail() {
      throw new Error("no rail should be deployed in these tests");
    },
    async claimRailFunding() {
      throw new Error("no rail should be funded in these tests");
    },
    async releaseRailFunding() {
      throw new Error("no rail should be funded in these tests");
    },
    async countFundedRails() {
      return 0;
    },
    async findAgent() {
      return row;
    },
    async findLatestCredential() {
      reads += 1;
      return state.credential;
    },
    async listActiveMandates() {
      reads += 1;
      return [...(state.mandates ?? [])];
    },
    async listMandates() {
      reads += 1;
      return [...(state.history ?? state.mandates ?? [])];
    },
  } as TenantPurchaseDirectory & { reads: number };
}

function deps(state: FakeState): TenantPurchaseDeps {
  return {
    directory: fakeDirectory(state),
    // Never reached by any test here: every one of them refuses before the
    // registry, the credential or the mandate would let it get this far.
    agentpass: undefined as unknown as TenantPurchaseDeps["agentpass"],
    masterMnemonic: generateMasterMnemonic(),
    databaseUrl: "postgres://unused",
    reserve: Keypair.random(),
    policyRailWasmHash: "e".repeat(64),
    readUsdcBalance: async () => "100.0000000",
    registry,
  };
}

function request(overrides: Partial<Parameters<typeof executeTenantPurchase>[1]> = {}) {
  return {
    tenantId: TENANT,
    venue: REGISTERED_VENUE,
    productId: "signaldesk:market-brief-xlm-usdc",
    quantity: 1,
    ...overrides,
  };
}

describe("the venue registry is the only thing that makes a venue payable", () => {
  it("refuses a venue the registry does not know, before reading anything about the tenant", async () => {
    const directory = fakeDirectory({});
    const outcome = await executeTenantPurchase(
      { ...deps({}), directory },
      request({ venue: UNREGISTERED_VENUE }),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("VenueNotRegistered");
    // The point of the ordering: a catalogue can advertise anything, and an
    // unregistered venue never even learns this platform was asked about it.
    expect(directory.reads).toBe(0);
  });

  it("refuses a malformed venue id without calling anything", async () => {
    const directory = fakeDirectory({});
    const outcome = await executeTenantPurchase({ ...deps({}), directory }, request({ venue: "signaldesk" }));
    expect(outcome.kind).toBe("refused");
    expect(directory.reads).toBe(0);
  });

  it("refuses a registered slug paired with a different contract id — B-3, byte for byte", async () => {
    const other = "CBDWMXZEE44NJ3RA6RS7K4EK36KDFW5S7KHP276HCMM4I52MIUUHEF5B";
    const outcome = await executeTenantPurchase(deps({}), request({ venue: `signaldesk:${other}` }));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("VenueNotRegistered");
  });
});

describe("a tenant with no documents cannot buy", () => {
  it("refuses when the tenant has no credential", async () => {
    const outcome = await executeTenantPurchase(deps({}), request());
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("CredentialNotFound");
  });

  it("refuses a revoked credential, and says which one", async () => {
    const outcome = await executeTenantPurchase(
      deps({ credential: fakeCredential({ revokedAt: new Date("2026-09-10T00:00:00.000Z") }) }),
      request(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("CredentialRevoked");
  });

  it("refuses when nothing the principal signed is still in force", async () => {
    const outcome = await executeTenantPurchase(deps({ credential: fakeCredential(), mandates: [] }), request());
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("MandateNotFound");
  });

  it("refuses when the only active mandate belongs to another of this tenant's agents", async () => {
    const outcome = await executeTenantPurchase(
      deps({ credential: fakeCredential(), mandates: [fakeMandate({ agentId: "agt_00000000000000000000000009" })] }),
      request(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("MandateNotFound");
    // Consent signed for one agent is not consent for another, and this
    // refuses rather than handing the wrong document to the enforcement layer.
    expect(outcome.details).toMatchObject({ otherActiveMandates: 1 });
  });
});

describe("a stored mandate is re-validated, never trusted for being stored", () => {
  it("refuses a mandate whose document no longer parses", async () => {
    const outcome = await executeTenantPurchase(
      deps({ credential: fakeCredential(), mandates: [fakeMandate()] }),
      request(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("ConfigError");
    expect(outcome.reason).toContain("does not match the expected shape");
  });

  it("refuses a wallet-signed mandate row that lost its signature", async () => {
    const outcome = await executeTenantPurchase(
      deps({
        credential: fakeCredential(),
        mandates: [fakeMandate({ signature: null, document: { version: "still not a mandate" } })],
      }),
      request(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("ConfigError");
  });
});

describe("the credential's own scope is what governs, not a file on disk", () => {
  /** A real compact JWS shape: header.payload.signature, payload base64url. */
  function jwsWith(payload: unknown): string {
    return `eyJhbGciOiJFZERTQSJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  }

  it("refuses a credential whose payload is not a credential at all", async () => {
    const outcome = await executeTenantPurchase(
      deps({
        credential: fakeCredential({ jws: jwsWith({ hello: "world" }) }),
        mandates: [fakeMandate({ document: { version: "not a mandate" } })],
      }),
      request(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("ConfigError");
  });

  it("refuses a credential that is not a compact JWS", async () => {
    const outcome = await executeTenantPurchase(
      deps({ credential: fakeCredential({ jws: "not-a-jws" }), mandates: [fakeMandate()] }),
      request(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.code).toBe("ConfigError");
  });
});

describe("refusals are values; failures still throw", () => {
  it("lets a non-typed error out rather than dressing it as a refusal", async () => {
    const directory = {
      ...fakeDirectory({ credential: fakeCredential() }),
      async listActiveMandates(): Promise<never> {
        throw new TypeError("the database connection died");
      },
    } as unknown as TenantPurchaseDirectory;
    await expect(executeTenantPurchase({ ...deps({}), directory }, request())).rejects.toThrow(TypeError);
  });
});

/**
 * All three found by running the acceptance suite against production (T85),
 * none by these tests, which only ever gave an agent a single Mandate and never
 * read what happened to one that stopped being active.
 */
describe("which Mandate a purchase goes through, and why there is none", () => {
  const BRIEF = "signaldesk:market-brief-xlm-usdc";
  const CREDITS = "signaldesk:ai-credits-1000";
  const AGENT = "agt_00000000000000000000000001";
  const NOW = new Date("2026-09-14T00:00:00.000Z");
  const principalDid = stellarAddressToDid(Keypair.random().publicKey(), "testnet");

  function signedFor(products: readonly string[], overrides: Partial<MandateRecord> = {}): MandateRecord {
    const document = createMandate({
      principal: principalDid,
      agent: stellarAddressToDid(agentAddress, "testnet"),
      grant: {
        actions: ["intent:create"],
        venues: [REGISTERED_VENUE],
        assets: ["USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
        products: [...products],
        limits: { perTx: "0.30", perDay: "0.60", currency: "USDC" },
      },
      registry: "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F",
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2026-12-01T00:00:00.000Z",
    });
    return fakeMandate({ document: { ...document }, ...overrides });
  }

  it("buys credits through the credits Mandate even when the report's was signed first", () => {
    const report = signedFor([BRIEF], { id: "mdt_00000000000000000000000001" });
    const credits = signedFor([CREDITS], { id: "mdt_00000000000000000000000002" });

    expect(selectMandateFor([report, credits], AGENT, CREDITS)?.id).toBe(credits.id);
    expect(selectMandateFor([report, credits], AGENT, BRIEF)?.id).toBe(report.id);
  });

  it("prefers the newest Mandate that names the product", () => {
    const older = signedFor([BRIEF], { id: "mdt_00000000000000000000000001" });
    const newer = signedFor([BRIEF], { id: "mdt_00000000000000000000000002" });

    expect(selectMandateFor([older, newer], AGENT, BRIEF)?.id).toBe(newer.id);
  });

  it("still hands a Mandate on when none names the product, so checkMandate is the one that refuses", () => {
    const report = signedFor([BRIEF]);

    expect(selectMandateFor([report], AGENT, CREDITS)?.id).toBe(report.id);
  });

  it("never chooses another agent's Mandate, even one that names the product", () => {
    const other = signedFor([CREDITS], { agentId: "agt_00000000000000000000000009" });

    expect(selectMandateFor([other], AGENT, CREDITS)).toBeUndefined();
  });

  it("says a revoked Mandate was revoked", async () => {
    const revoked = signedFor([BRIEF], { revokedAt: new Date("2026-09-10T00:00:00.000Z") });
    const outcome = await executeTenantPurchase(
      { ...deps({ credential: fakeCredential(), mandates: [], history: [revoked] }), now: NOW },
      request(),
    );

    expect(outcome).toMatchObject({ kind: "refused", code: "MandateRevoked", details: { mandateId: revoked.id } });
  });

  it("says an expired Mandate expired", async () => {
    const expired = signedFor([BRIEF], { validUntil: new Date("2026-09-10T00:00:00.000Z") });
    const outcome = await executeTenantPurchase(
      { ...deps({ credential: fakeCredential(), mandates: [], history: [expired] }), now: NOW },
      request(),
    );

    expect(outcome).toMatchObject({ kind: "refused", code: "MandateExpired" });
  });

  it("reads the newest Mandate for the product asked about, not a newer one for another product", () => {
    const expiredCredits = signedFor([CREDITS], {
      id: "mdt_00000000000000000000000001",
      validUntil: new Date("2026-09-10T00:00:00.000Z"),
    });
    const revokedReport = signedFor([BRIEF], {
      id: "mdt_00000000000000000000000002",
      revokedAt: new Date("2026-09-12T00:00:00.000Z"),
    });

    expect(explainMissingMandate([expiredCredits, revokedReport], CREDITS, NOW).code).toBe("MandateExpired");
    expect(explainMissingMandate([expiredCredits, revokedReport], BRIEF, NOW).code).toBe("MandateRevoked");
  });

  it("says nothing was signed when nothing was", () => {
    expect(explainMissingMandate([], BRIEF, NOW)).toMatchObject({ code: "MandateNotFound", mandateId: null });
  });

  it("reads out why the agent was not given the purchase tool, instead of calling it anyway", () => {
    const usable = { usable: true } as unknown as AgentDocumentStates["credential"];
    const revokedCredential: AgentDocumentStates["credential"] = {
      usable: false,
      problem: new AgentPassError("CredentialRevoked", "the registry reports this credential as revoked"),
      hash: "a".repeat(64),
      checkedAt: NOW,
    };
    const revokedMandate: NonNullable<AgentDocumentStates["mandate"]> = {
      usable: false,
      problem: new AgentPassError("MandateRevoked", "the registry reports this mandate as revoked"),
      hash: "b".repeat(64),
      checkedAt: NOW,
    };

    expect(withheldBecause({ credential: revokedCredential, mandate: undefined })?.code).toBe("CredentialRevoked");
    expect(withheldBecause({ credential: usable, mandate: revokedMandate })?.code).toBe("MandateRevoked");
    expect(withheldBecause({ credential: usable, mandate: undefined })).toBeUndefined();
  });
});
