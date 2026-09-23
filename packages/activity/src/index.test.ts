/**
 * These cover the rules that must not drift now that two screens read them:
 * what counts as the active mandate, when a usage warning fires, and how a
 * refusal list is ordered. The `spentOn` call itself is deliberately faked —
 * this package's promise is that it *calls* the authorisation's own read, not
 * that it reimplements it, and a test that faked a sum would be testing the
 * fake.
 */
import type { AgentInstance, MandateRecord, Tenant } from "@agentpey/directory";
import { describe, expect, it } from "vitest";

import {
  PERDAY_WARNING_RATIO,
  SPONSORED_FUNDING_PER_TENANT,
  SPONSORED_RAILS_WARNING_HEADROOM,
  readSponsoredCreditStatus,
  activeMandate,
  readPerDayUsage,
  readRailBalances,
  recentRefusals,
  requireTenant,
  type ActivityDirectory,
} from "./index.js";

const TENANT = "ptn_00000000000000000000000001:00000000000000000000000001";
const RAIL = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const NOW = new Date("2026-09-12T12:00:00.000Z");

const tenant = {
  id: TENANT,
  partnerId: "ptn_00000000000000000000000001",
  externalRef: "rop_abc",
  label: null,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
} as Tenant;

function mandate(overrides: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: "mdt_00000000000000000000000001",
    tenantId: TENANT,
    agentId: "agt_00000000000000000000000001",
    principalId: "prc_00000000000000000000000001",
    mandateHash: "c".repeat(64),
    signatureKind: "wallet-sep53",
    document: {},
    signature: "sig",
    jws: null,
    validFrom: new Date("2026-09-01T00:00:00.000Z"),
    validUntil: new Date("2026-12-01T00:00:00.000Z"),
    anchorTx: "d".repeat(64),
    supersedesId: null,
    revokedAt: null,
    revokeTx: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function directoryWith(parts: { mandates?: readonly MandateRecord[]; agents?: readonly AgentInstance[] }): ActivityDirectory {
  return {
    async findTenant() {
      return tenant;
    },
    async listMandates() {
      return [...(parts.mandates ?? [])];
    },
    async listAgents() {
      return [...(parts.agents ?? [])];
    },
  };
}

describe("requireTenant", () => {
  it("refuses a tenant that does not exist, typed, rather than returning undefined", async () => {
    const directory = { ...directoryWith({}), findTenant: async () => undefined };
    await expect(requireTenant(directory, TENANT)).rejects.toMatchObject({ code: "TenantNotFound" });
  });
});

describe("activeMandate", () => {
  it("ignores a revoked one", () => {
    expect(activeMandate([mandate({ revokedAt: new Date("2026-09-11T00:00:00.000Z") })], NOW)).toBeUndefined();
  });

  it("ignores one whose window has closed", () => {
    expect(activeMandate([mandate({ validUntil: new Date("2026-09-01T00:00:00.000Z") })], NOW)).toBeUndefined();
  });

  it("picks the most recently created of several still in force", () => {
    const older = mandate({ id: "mdt_00000000000000000000000001", createdAt: new Date("2026-09-01T00:00:00.000Z") });
    const newer = mandate({ id: "mdt_00000000000000000000000002", createdAt: new Date("2026-09-10T00:00:00.000Z") });
    expect(activeMandate([older, newer], NOW)?.id).toBe("mdt_00000000000000000000000002");
  });
});

describe("readPerDayUsage", () => {
  const document = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentPayMandate"],
    mandateId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
    issuer: "did:stellar:testnet:GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
    validFrom: "2026-09-01T00:00:00.000Z",
    validUntil: "2026-12-01T00:00:00.000Z",
    credentialSubject: {
      id: "did:stellar:testnet:GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
      grant: {
        actions: ["intent:create"],
        venues: [],
        assets: [],
        limits: { perTx: "0.3000000", perDay: "0.6000000", currency: "USDC" },
      },
    },
    credentialStatus: { type: "AgentPassRegistry2026", registry: RAIL },
  };

  function vaultReturning(spent: string) {
    return async () => ({ list: () => [], verify: () => ({ ok: true }) as never, spentOn: async () => spent });
  }

  it("reads the limit from the signed document and the spend from the vault", async () => {
    const usage = await readPerDayUsage(directoryWith({ mandates: [mandate({ document })] }), vaultReturning("0.1000000"), TENANT, NOW);
    expect(usage).toMatchObject({ perDayLimit: "0.6000000", spentToday: "0.1000000", currency: "USDC" });
  });

  it("fires the warning at exactly the threshold, not past it", async () => {
    const atThreshold = await readPerDayUsage(directoryWith({ mandates: [mandate({ document })] }), vaultReturning("0.4800000"), TENANT, NOW);
    expect(atThreshold?.ratio).toBeCloseTo(PERDAY_WARNING_RATIO);
    expect(atThreshold?.nearLimit).toBe(true);
  });

  it("returns nothing measurable when the stored document is not a mandate", async () => {
    const usage = await readPerDayUsage(directoryWith({ mandates: [mandate({ document: { version: 1 } })] }), vaultReturning("0"), TENANT, NOW);
    expect(usage).toBeUndefined();
  });
});

describe("recentRefusals", () => {
  it("keeps only refusals, newest first", () => {
    const records = [
      { entry: { kind: "refused", at: "2026-09-12T09:00:00.000Z", intentId: "i-1", code: "A", reason: "a" } },
      { entry: { kind: "granted", at: "2026-09-12T10:00:00.000Z", intentId: "i-2" } },
      { entry: { kind: "refused", at: "2026-09-12T11:00:00.000Z", intentId: "i-3", code: "B", reason: "b" } },
    ] as never;
    expect(recentRefusals(records).map((r) => r.code)).toEqual(["B", "A"]);
  });
});

describe("readRailBalances", () => {
  function agentRow(overrides: Partial<AgentInstance> = {}): AgentInstance {
    return {
      id: "agt_00000000000000000000000001",
      tenantId: TENANT,
      keyIndex: 0,
      address: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
      did: "did:stellar:testnet:GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K" as AgentInstance["did"],
      label: null,
      status: "active",
      onchainState: "funded",
      policyRailContractId: RAIL,
      policyRailFundedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("skips agents that have never paid and so own no rail", async () => {
    const balances = await readRailBalances(directoryWith({ agents: [agentRow({ policyRailContractId: null })] }), TENANT, async () => "1");
    expect(balances).toEqual([]);
  });

  it("flags a rail one or two purchases from failing", async () => {
    const balances = await readRailBalances(directoryWith({ agents: [agentRow()] }), TENANT, async () => "0.0010000");
    expect(balances[0]?.low).toBe(true);
  });

  it("reports a failed read as a value rather than taking the whole page down with it", async () => {
    const balances = await readRailBalances(directoryWith({ agents: [agentRow()] }), TENANT, async () => {
      throw new Error("rpc unreachable");
    });
    expect(balances[0]?.usdc).toContain("error");
    expect(balances[0]?.low).toBe(false);
  });
});

describe("readSponsoredCreditStatus", () => {
  it("reports what is left against both the cap and the balance, whichever binds first", async () => {
    const directory = { countFundedRails: async () => 4 };
    const status = await readSponsoredCreditStatus(directory, "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K", async () => "100.0000000");
    // The cap binds: 16 tenants left of 20, even though the balance affords 100.
    expect(status).toMatchObject({ funded: 4, cap: 20, remaining: 16, nearExhaustion: false });
  });

  it("reports the balance as the binding constraint when it is the smaller one", async () => {
    const directory = { countFundedRails: async () => 0 };
    // Enough for three tenants and a bit, whatever one tenant's funding is.
    const reserve = (Number(SPONSORED_FUNDING_PER_TENANT) * 3.5).toFixed(7);
    const status = await readSponsoredCreditStatus(directory, "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K", async () => reserve);
    expect(status.remaining).toBe(3);
    expect(status.nearExhaustion).toBe(true);
  });

  it("warns with headroom left, not at exhaustion", async () => {
    const directory = { countFundedRails: async () => 15 };
    const status = await readSponsoredCreditStatus(directory, "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K", async () => "100.0000000");
    expect(status.remaining).toBe(SPONSORED_RAILS_WARNING_HEADROOM);
    expect(status.nearExhaustion).toBe(true);
  });

  it("never reports a negative remainder", async () => {
    const directory = { countFundedRails: async () => 25 };
    const status = await readSponsoredCreditStatus(directory, "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K", async () => "100.0000000");
    expect(status.remaining).toBe(0);
  });
});
