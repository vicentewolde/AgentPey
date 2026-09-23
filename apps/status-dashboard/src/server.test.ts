import type { AddressInfo } from "node:net";

const RESERVE_ADDRESS = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

import { stellarAddressToDid } from "@agentpass/core";
import { SPONSORED_FUNDING_PER_TENANT } from "@agentpey/activity";
import type { AgentInstance, MandateRecord, Tenant } from "@agentpey/directory";
import type { VaultRecord } from "@agentpey/vault";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createStatusServer } from "./server.js";
import type { StellarDid } from "@agentpass/core";
import type { SponsoredCreditDirectory, StatusDirectory, VaultReader } from "./status.js";

const AGENT_DID = stellarAddressToDid(Keypair.random().publicKey(), "testnet");

const createdAt = new Date("2026-09-11T12:00:00.000Z");
const tenant: Tenant = {
  id: "tenant_01J7QW8VQEJPAXEPAYSTATUS01",
  partnerId: "partner_01J7QW8VQEJPAXEPAYSTATUS01",
  externalRef: "status-test",
  label: "Status test tenant",
  status: "active",
  createdAt,
  updatedAt: createdAt,
};

const mandate: MandateRecord = {
  id: "mandate_01J7QW8VQEJPAXEPAYSTATUS01",
  tenantId: tenant.id,
  agentId: "agent_01J7QW8VQEJPAXEPAYSTATUS01",
  principalId: "principal_01J7QW8VQEJPAXEPAYSTATUS01",
  mandateHash: "a".repeat(64),
  signatureKind: "platform-jws",
  document: { version: 1 },
  signature: null,
  jws: "test-jws",
  validFrom: createdAt,
  validUntil: new Date("2026-09-12T12:00:00.000Z"),
  anchorTx: "anchor-transaction",
  supersedesId: null,
  revokedAt: null,
  revokeTx: null,
  createdAt,
};

const records: readonly VaultRecord[] = [
  {
    seq: 0,
    prevHash: "",
    hash: "b".repeat(64),
    entry: {
      kind: "granted",
      subject: "did:stellar:testnet:GSTATUS",
      intentId: "intent-granted",
      currency: "USDC",
      amount: "1.25",
      at: "2026-09-11T12:00:00.000Z",
    },
  },
  {
    seq: 1,
    prevHash: "b".repeat(64),
    hash: "c".repeat(64),
    entry: {
      kind: "refused",
      subject: "did:stellar:testnet:GSTATUS",
      intentId: "intent-refused",
      code: "MandateAmountExceeded",
      reason: "amount exceeds per-transaction limit",
      details: {},
      at: "2026-09-11T12:01:00.000Z",
    },
  },
];

const vault: VaultReader = {
  list: () => records,
  verify: () => ({ ok: true }),
  spentOn: async () => "8.00",
};

/** A second, more recent Mandate — `document: { version: 1 }` above can't be parsed as an `AgentPayMandate`, so perDay usage needs one that can. */
const richMandate: MandateRecord = {
  ...mandate,
  id: "mandate_01J7QW8VQEJPAXEPAYSTATUS02",
  document: {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentPayMandate"],
    mandateId: "22222222-2222-4222-8222-222222222222",
    issuer: AGENT_DID,
    validFrom: "2026-09-11T12:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    credentialSubject: {
      id: AGENT_DID,
      grant: { actions: ["catalog:read"], venues: [], assets: [], limits: { perTx: "1.00", perDay: "10.00", currency: "USDC" } },
    },
    credentialStatus: { type: "AgentPassRegistry2026", registry: "CBDWMXZEE44NJ3RA6RS7K4EK36KDFW5S7KHP276HCMM4I52MIUUHEF5B" },
  },
  validUntil: new Date("2099-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-09-12T00:00:00.000Z"),
};

const railedAgent: AgentInstance = {
  id: "agent_01J7QW8VQEJPAXEPAYSTATUS02",
  tenantId: tenant.id,
  keyIndex: 0,
  address: "GDRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILR",
  did: "did:stellar:testnet:GDRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILRAILR" as StellarDid,
  label: null,
  status: "active",
  onchainState: "funded",
  policyRailContractId: "CRAILCONTRACTIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  policyRailFundedAt: new Date("2026-09-12T00:00:00.000Z"),
  createdAt,
  updatedAt: createdAt,
};

function readOnlyDirectory(): StatusDirectory & SponsoredCreditDirectory {
  return {
    async countFundedRails() {
      return 3;
    },
    findTenant: async (id) => (id === tenant.id ? tenant : undefined),
    listMandates: async (id) => (id === tenant.id ? [mandate, richMandate] : []),
    listAgents: async (id) => (id === tenant.id ? [railedAgent] : []),
  };
}

const servers: ReturnType<typeof createStatusServer>[] = [];

async function start() {
  const server = createStatusServer({
    directory: readOnlyDirectory(),
    vaultFactory: async () => vault,
    // Anything that is not the tenant's rail is the reserve: it holds exactly one tenant's funding.
    readRailBalance: async (contractId) => (contractId === railedAgent.policyRailContractId ? "0.0010000" : SPONSORED_FUNDING_PER_TENANT),
    reserveAddress: RESERVE_ADDRESS,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

describe("status dashboard HTTP server", () => {
  it("shows a seeded mandate and a healthy, readable vault chain", async () => {
    const baseUrl = await start();

    const mandates = await fetch(`${baseUrl}/api/status/mandates?tenantId=${tenant.id}`);
    expect(mandates.status).toBe(200);
    await expect(mandates.json()).resolves.toMatchObject({
      tenant: { id: tenant.id },
      mandates: [{ id: richMandate.id, hash: richMandate.mandateHash }, { id: mandate.id, hash: mandate.mandateHash }],
    });

    const vaultResponse = await fetch(`${baseUrl}/api/status/vault/${tenant.id}`);
    expect(vaultResponse.status).toBe(200);
    await expect(vaultResponse.json()).resolves.toMatchObject({
      verification: { ok: true, brokenAtSeq: null },
      records: [
        { kind: "refused", detail: "MandateAmountExceeded: amount exceeds per-transaction limit" },
        { kind: "granted", amount: "1.25 USDC" },
      ],
    });

    const page = await fetch(`${baseUrl}/?tenantId=${tenant.id}`);
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain("Vault chain: <span class=\"ok\">healthy</span>");
  });

  it("T71: reports perDay usage, recent rejections, and rail balances for a tenant", async () => {
    const baseUrl = await start();

    const response = await fetch(`${baseUrl}/api/status/metrics/${tenant.id}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tenant: { id: tenant.id, label: tenant.label, status: tenant.status },
      perDay: {
        subject: AGENT_DID,
        currency: "USDC",
        perDayLimit: "10.00",
        spentToday: "8.00",
        ratio: 0.8,
        nearLimit: true,
      },
      rejections: [{ at: "2026-09-11T12:01:00.000Z", intentId: "intent-refused", code: "MandateAmountExceeded", reason: "amount exceeds per-transaction limit" }],
      railBalances: [{ agentId: railedAgent.id, contractId: railedAgent.policyRailContractId, usdc: "0.0010000", low: true }],
      // T77: the pilot's own reserve, not this tenant's. Three rails already
      // sponsored, and the fake reserve holds one tenant's funding — enough
      // for exactly one more tenant, so the cap is not what binds here.
      sponsoredCredit: { funded: 3, cap: 20, remaining: 1, reserveUsdc: SPONSORED_FUNDING_PER_TENANT, nearExhaustion: true },
    });

    const page = await fetch(`${baseUrl}/?tenantId=${tenant.id}`);
    const html = await page.text();
    expect(html).toContain("near the daily limit");
    expect(html).toContain("MandateAmountExceeded");
    expect(html).toContain("0.0010000");
    expect(html).toContain("— low");
  });

  it("rejects every non-GET method on every dashboard route", async () => {
    const baseUrl = await start();
    const routes = ["/", `/api/status/mandates?tenantId=${tenant.id}`, `/api/status/vault/${tenant.id}`, `/api/status/metrics/${tenant.id}`];
    const methods = ["POST", "PUT", "PATCH", "DELETE"] as const;

    for (const route of routes) {
      for (const method of methods) {
        const response = await fetch(`${baseUrl}${route}`, { method });
        expect(response.status, `${method} ${route}`).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
      }
    }
  });

  it("requires a tenant ID for the mandates API and never turns it into a write", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/api/status/mandates`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });
});
