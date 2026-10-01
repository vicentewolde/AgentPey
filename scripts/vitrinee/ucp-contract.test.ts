/**
 * The UCP contract between AgentPey's buyer and a Vitrinee store (T122), with
 * each side's real code and no network: `executeUcpPayment` from apps/agent
 * against Vitrinee's own app, through the real `LocalPolicyRail`. Only the
 * Stellar scheme (which needs a network to build a transaction) and the
 * facilitator are fakes.
 *
 * Lives here, outside both packages, for the same reason as
 * `agentpey-contract.test.ts`: neither side depends on the other.
 */
import { stellarAddressToDid, type Scope } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeVenueId } from "../../apps/agent/src/catalog/ids.js";
import { loadVenueRegistry } from "../../apps/agent/src/catalog/registry.js";
import type { PurchaseIntent } from "../../apps/agent/src/intent/intent.js";
import { executeUcpPayment, type ExecuteUcpPaymentDeps } from "../../apps/agent/src/payment/ucp.js";
import { mayHaveBeenPaid } from "../../apps/agent/src/payment/x402.js";
import { createInMemorySpendLedger } from "../../apps/agent/src/ledger/spend-ledger.js";
import { createLocalPolicyRail } from "../../apps/agent/src/policy/policy-rail.js";
import { createMandate } from "../../packages/mandate/src/index.js";
import { MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { USDC_TESTNET, checkReceiptSignature } from "../../packages/vitrinee-core/src/index.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { FAKE_TX_HASH, fakeFacilitator, type FakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MERCHANT, fakeRegistry, testConfig } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../packages/vitrinee-gateway/src/test/listen.js";

type SchemeNetworkClient = NonNullable<ExecuteUcpPaymentDeps["schemeForTests"]>;
type PaymentRequirements = Parameters<SchemeNetworkClient["createPaymentPayload"]>[1];

const RAIL = "CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U";
const USDC = `USDC:${USDC_TESTNET.contractId}`;
const principal = Keypair.random();
const agent = Keypair.random();
const PRINCIPAL_DID = stellarAddressToDid(principal.publicKey(), "testnet");
const AGENT_DID = stellarAddressToDid(agent.publicKey(), "testnet");
const REGISTRY = "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";
const DESTINATION = { first_name: "Ana", last_name: "Pérez", street_address: "Av. Irarrázaval 1234", address_locality: "Ñuñoa", address_region: "Metropolitana", address_country: "CL" };

let server: { url: string; close: () => Promise<void> };
let app: VitrineeApp;
let facilitator: FakeFacilitator;
const adapter = new MockStoreAdapter();

beforeAll(async () => {
  const registry = fakeRegistry();
  facilitator = fakeFacilitator({ settle: { payer: RAIL } });
  app = createApp({ config: testConfig(), adapter, facilitator, anchorer: registry.anchorer, registry: registry.registry });
  server = await listen(app);
});
afterAll(async () => {
  app.anchors.stop();
  await server.close();
});

/**
 * The store as a venue, with its payee pinned the way `platforms.ts` pins every
 * Vitrinee merchant from the platform's directory (C-141).
 */
const venue = (pinnedPayTo: string = MERCHANT) => {
  const base = loadVenueRegistry([{ slug: "vitrinee", address: MERCHANT, baseUrl: server.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] }]);
  const venueId = makeVenueId("vitrinee", MERCHANT);
  const entry = base.venues.get(venueId);
  if (entry === undefined) throw new TypeError("venue not loaded");
  return { venueId, registry: { ...base, venues: new Map([[venueId, { ...entry, payTo: pinnedPayTo }]]) } };
};

const scope = (perTx = "50.00"): Scope => ({
  actions: ["catalog:read", "intent:create"],
  venues: [venue().venueId],
  assets: [USDC],
  limits: { perTx, perDay: "100.00", currency: "USDC" },
});

const mandate = (grant: Scope) =>
  createMandate({ principal: PRINCIPAL_DID, agent: AGENT_DID, grant, registry: REGISTRY, validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2027-09-01T00:00:00.000Z" });

/** A verified intent for `quantity` × `unit` USDC of `productId`, as `create_purchase_intent` would sign it. */
function intent(productId: string, quantity: number, unit: string, total: string): PurchaseIntent {
  return {
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    agent: AGENT_DID,
    principal: PRINCIPAL_DID,
    credential: { hash: "a".repeat(64), registry: REGISTRY },
    venue: venue().venueId,
    purchase: { productId, quantity, unitAmount: unit, totalAmount: total, asset: USDC as PurchaseIntent["purchase"]["asset"] },
    authorisation: { perTx: "50.00", currency: "USDC" },
  };
}

/** Stands in for PolicyRailStellarScheme: records what it was asked to sign. */
function fakeScheme(): SchemeNetworkClient & { calls: PaymentRequirements[] } {
  const calls: PaymentRequirements[] = [];
  return {
    scheme: "exact",
    calls,
    async createPaymentPayload(_version: number, requirements: PaymentRequirements) {
      calls.push(requirements);
      return { x402Version: 2, payload: { transaction: Buffer.from(`rail-tx-${calls.length}-${Math.random()}`).toString("base64") } };
    },
  } as SchemeNetworkClient & { calls: PaymentRequirements[] };
}

async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable("expected the payment to be refused");
}

describe("AgentPey pays a Vitrinee store over UCP (T122)", () => {
  it("opens a checkout, reconciles it against the Mandate, pays from the rail and gets the order and its receipt", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const settled = facilitator.settleCalls.length;
    const paid = await executeUcpPayment(
      { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
      {
        storeUrl: server.url,
        productId: "gorro-andes",
        quantity: 1,
        buyer: { email: "ana@example.com" },
        destination: DESTINATION,
        intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"),
        scope: grant,
        mandate: mandate(grant),
        ...venue(),
        idempotencyKey: "ucp-contract-1",
      },
    );
    expect(scheme.calls).toEqual([expect.objectContaining({ amount: "136736842", payTo: MERCHANT, asset: USDC_TESTNET.contractId })]);
    expect(facilitator.settleCalls).toHaveLength(settled + 1);
    expect(paid).toMatchObject({ total: { amount: 12990, currency: "CLP" }, paid: { amount: "136736842", payTo: MERCHANT }, transaction: FAKE_TX_HASH });
    expect(paid.receipt?.anchor.status).toMatch(/^(pending|anchored)$/);
    // The receipt names the rail as the payer, and the store has the real order, with the address.
    expect(checkReceiptSignature(paid.receipt?.jws ?? "").claims?.payerAccount).toBe(RAIL);
    const platformOrderId = checkReceiptSignature(paid.receipt?.jws ?? "").claims?.platformOrderId;
    const platformOrder = await adapter.getOrder(platformOrderId ?? "");
    expect(platformOrder?.buyer.shipping).toMatchObject({ name: "Ana Pérez", address: "Av. Irarrázaval 1234", city: "Ñuñoa", country: "CL" });
  });

  it("refuses before signing when the checkout asks for more than the signed intent", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const settled = facilitator.settleCalls.length;
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
        // The intent is for one hat; the checkout is for two.
        { storeUrl: server.url, productId: "gorro-andes", quantity: 2, destination: DESTINATION, intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"), scope: grant, mandate: mandate(grant), ...venue() },
      ),
    );
    expect(error).toMatchObject({ code: "TermsAmountMismatch" });
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(scheme.calls).toEqual([]);
    expect(facilitator.settleCalls).toHaveLength(settled);
  });

  it("refuses before signing when the purchase is above the Mandate's per-transaction limit", async () => {
    const scheme = fakeScheme();
    const grant = scope("10.00");
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
        { storeUrl: server.url, productId: "gorro-andes", quantity: 1, destination: DESTINATION, intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"), scope: grant, mandate: mandate(grant), ...venue() },
      ),
    );
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(scheme.calls).toEqual([]);
    expect((error as { code: string }).code).toMatch(/Exceeded|Limit/);
  });

  it("refuses a checkout that names a payee other than the handler the store declares", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const other = Keypair.random().publicKey();
    const rewrite: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith("/checkout-sessions") || init?.method !== "POST") return res;
      const body = (await res.json()) as { ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements: { payTo: string } } }>> } };
      const handler = body.ucp.payment_handlers["com.agentpey.stellar_x402"]?.[0];
      if (handler !== undefined) handler.config.payment_requirements.payTo = other;
      return Response.json(body, { status: res.status });
    };
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme, fetchImpl: rewrite },
        { storeUrl: server.url, productId: "gorro-andes", quantity: 1, destination: DESTINATION, intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"), scope: grant, mandate: mandate(grant), ...venue() },
      ),
    );
    expect(error).toMatchObject({ code: "InvalidProduct" });
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(scheme.calls).toEqual([]);
  });

  it("refuses a store whose declared account is not the one the venue pins", async () => {
    const scheme = fakeScheme();
    const pinned = venue(Keypair.random().publicKey());
    const grant = scope();
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
        { storeUrl: server.url, productId: "gorro-andes", quantity: 1, destination: DESTINATION, intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"), scope: grant, mandate: mandate(grant), ...pinned },
      ),
    );
    expect(error).toMatchObject({ code: "InvalidProduct" });
    expect(scheme.calls).toEqual([]);
  });

  it("refuses a store that does not declare the handler on agentpey.com", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const hijacked: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith("/.well-known/ucp")) return res;
      const body = (await res.json()) as { ucp: { payment_handlers: Record<string, Array<{ spec: string }>> } };
      const handler = body.ucp.payment_handlers["com.agentpey.stellar_x402"]?.[0];
      if (handler !== undefined) handler.spec = "https://evil.example/stellar-x402/spec";
      return Response.json(body);
    };
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme, fetchImpl: hijacked },
        { storeUrl: server.url, productId: "gorro-andes", quantity: 1, destination: DESTINATION, intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"), scope: grant, mandate: mandate(grant), ...venue() },
      ),
    );
    expect(error).toMatchObject({ code: "MerchantRejectedRequest" });
    expect(scheme.calls).toEqual([]);
  });
});
