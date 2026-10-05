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
import { AGENTPEY_PLATFORM_PROFILE, AGENTPEY_PLATFORM_PROFILE_2026_08_25, AGENTPEY_PLATFORM_PROFILE_AP2, executeUcpPayment, payUcpQuote, quoteUcpCheckout, type ExecuteUcpPaymentDeps } from "../../apps/agent/src/payment/ucp.js";
import { deriveP256 } from "../../packages/ap2/src/keys.js";
import { mayHaveBeenPaid } from "../../apps/agent/src/payment/x402.js";
import { createInMemorySpendLedger } from "../../apps/agent/src/ledger/spend-ledger.js";
import { createLocalPolicyRail } from "../../apps/agent/src/policy/policy-rail.js";
import { createMandate } from "../../packages/mandate/src/index.js";
import { MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { USDC_TESTNET, checkReceiptSignature } from "../../packages/vitrinee-core/src/index.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { FAKE_TX_HASH, fakeFacilitator, type FakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MERCHANT, fakeRegistry, testConfig, fakePlatformProfiles } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
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
  app = createApp({
    platformProfiles: fakePlatformProfiles({ [AGENTPEY_PLATFORM_PROFILE]: "2026-04-08", [AGENTPEY_PLATFORM_PROFILE_2026_08_25]: "2026-08-25" }),
    config: testConfig(),
    adapter,
    facilitator,
    anchorer: registry.anchorer,
    registry: registry.registry,
  });
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

/** A verified intent for a cart (T148), as the agent's cart signer would sign it. */
function cartIntent(lines: Array<[string, number, string]>, total: string): PurchaseIntent {
  return { ...intent("unused", 1, "0", "0"), purchase: { lines: lines.map(([productId, quantity, unitAmount]) => ({ productId, quantity, unitAmount })), totalAmount: total, asset: USDC as PurchaseIntent["purchase"]["asset"] } };
}

// gorro-andes 12990 CLP and stickers-cordillera 990 CLP, at the test store's 950 CLP per USD.
const HAT = "13.6736842";
const STICKERS = "1.0421053";

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
    // Since T148 the lines are compared before the amount: the checkout is not the purchase the intent signed.
    expect(error).toMatchObject({ code: "InvalidProduct" });
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

describe("AgentPey pays a cart at a Vitrinee store over UCP (T148)", () => {
  it("opens a checkout of two lines, pays their sum once and gets an order and a receipt of two items", async () => {
    // A store of its own: the shared one already holds an order for the fake facilitator's one transaction hash (T132).
    const registry = fakeRegistry();
    const ownAdapter = new MockStoreAdapter();
    const ownFacilitator = fakeFacilitator({ settle: { payer: RAIL, transaction: "cd34".padEnd(64, "0") } });
    const own = createApp({ platformProfiles: fakePlatformProfiles({ [AGENTPEY_PLATFORM_PROFILE]: "2026-04-08" }), config: testConfig(), adapter: ownAdapter, facilitator: ownFacilitator, anchorer: registry.anchorer, registry: registry.registry });
    const ownServer = await listen(own);
    const ownVenue = loadVenueRegistry([{ slug: "vitrinee", address: MERCHANT, baseUrl: ownServer.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] }]);
    try {
      const scheme = fakeScheme();
      const grant = scope();
      const settled = ownFacilitator.settleCalls.length;
      const paid = await executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
        {
          storeUrl: ownServer.url,
          lines: [
            { productId: "gorro-andes", quantity: 1 },
            { productId: "stickers-cordillera", quantity: 2 },
          ],
          destination: DESTINATION,
          intent: cartIntent([["gorro-andes", 1, HAT], ["stickers-cordillera", 2, STICKERS]], "15.7578948"),
          scope: grant,
          mandate: mandate(grant),
          venueId: makeVenueId("vitrinee", MERCHANT),
          registry: ownVenue,
        },
      );
      expect(scheme.calls).toEqual([expect.objectContaining({ amount: "157578948", payTo: MERCHANT })]);
      expect(ownFacilitator.settleCalls).toHaveLength(settled + 1);
      expect(paid.total).toEqual({ amount: 14970, currency: "CLP" });
      const claims = checkReceiptSignature(paid.receipt?.jws ?? "").claims;
      expect(claims?.items.map((item) => [item.productId, item.quantity, item.unitPriceUSDCAtomic])).toEqual([
        ["gorro-andes", 1, "136736842"],
        ["stickers-cordillera", 2, "10421053"],
      ]);
      expect(claims?.amountUSDCAtomic).toBe("157578948");
      expect((await ownAdapter.getOrder(claims?.platformOrderId ?? ""))?.lines.map((line) => [line.productId, line.quantity])).toEqual([
        ["gorro-andes", 1],
        ["stickers-cordillera", 2],
      ]);
    } finally {
      own.anchors.stop();
      await ownServer.close();
    }
  });

  it("refuses before signing a checkout for other lines than the intent, even at the same total", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
        {
          storeUrl: server.url,
          // Two packs of stickers in two lines of one each: the same total as the intent's one line of two.
          lines: [
            { productId: "gorro-andes", quantity: 1 },
            { productId: "stickers-cordillera", quantity: 1 },
            { productId: "stickers-cordillera", quantity: 1 },
          ],
          destination: DESTINATION,
          intent: cartIntent([["gorro-andes", 1, HAT], ["stickers-cordillera", 2, STICKERS]], "15.7578948"),
          scope: grant,
          mandate: mandate(grant),
          ...venue(),
        },
      ),
    );
    expect(error).toMatchObject({ code: "InvalidProduct" });
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(scheme.calls).toEqual([]);
  });

  it("refuses a checkout whose store answers other lines than the ones asked for (T148 review)", async () => {
    const swap: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (init?.method !== "POST" || !String(input).endsWith("/checkout-sessions")) return res;
      const body = (await res.json()) as { line_items: Array<{ item: { id: string } }> };
      body.line_items[1]!.item.id = "polera-valpo-l";
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    };
    const error = await attempt(() =>
      quoteUcpCheckout({ fetchImpl: swap }, { storeUrl: server.url, lines: [{ productId: "gorro-andes", quantity: 1 }, { productId: "stickers-cordillera", quantity: 2 }], destination: DESTINATION }),
    );
    expect(error).toMatchObject({ code: "InvalidProduct", details: { opened: [["gorro-andes", 1], ["polera-valpo-l", 2]] } });
  });

  it("refuses, on re-reading a kept quote, a cart changed to other lines at the same total, before anything is authorised or signed (T148 review)", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const lines = [
      { productId: "gorro-andes", quantity: 1 },
      { productId: "stickers-cordillera", quantity: 2 },
    ];
    const quote = await quoteUcpCheckout({}, { storeUrl: server.url, lines, destination: DESTINATION });
    // Someone with the checkout's id splits the two packs into two lines: the same total, so the same requirements.
    const changed = await fetch(`${quote.endpoint}/checkout-sessions/${quote.checkoutId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "UCP-Agent": `profile="${AGENTPEY_PLATFORM_PROFILE}"` },
      body: JSON.stringify({ line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }, { item: { id: "stickers-cordillera" }, quantity: 1 }, { item: { id: "stickers-cordillera" }, quantity: 1 }] }),
    });
    expect(((await changed.json()) as { line_items: unknown[] }).line_items).toHaveLength(3);
    const ledger = createInMemorySpendLedger();
    const theIntent = cartIntent([["gorro-andes", 1, HAT], ["stickers-cordillera", 2, STICKERS]], "15.7578948");
    const error = await attempt(() =>
      payUcpQuote({ policyRail: createLocalPolicyRail({ ledger }), signerSecret: agent.secret(), schemeForTests: scheme }, quote, {
        intent: theIntent,
        scope: grant,
        mandate: mandate(grant),
        ...venue(),
        recheck: true,
      }),
    );
    expect(error).toMatchObject({ code: "InvalidProduct", details: { checkout: [["gorro-andes", 1], ["stickers-cordillera", 1], ["stickers-cordillera", 1]] } });
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(scheme.calls).toEqual([]);
    expect(await ledger.hasRecorded(theIntent.intentId)).toBe(false);
  });

  it("refuses before signing a cart above the per-transaction limit, though each line is under it", async () => {
    const scheme = fakeScheme();
    const grant = scope("15.00");
    const error = await attempt(() =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme },
        {
          storeUrl: server.url,
          lines: [
            { productId: "gorro-andes", quantity: 1 },
            { productId: "stickers-cordillera", quantity: 2 },
          ],
          destination: DESTINATION,
          intent: cartIntent([["gorro-andes", 1, HAT], ["stickers-cordillera", 2, STICKERS]], "15.7578948"),
          scope: grant,
          mandate: mandate(grant),
          ...venue(),
        },
      ),
    );
    expect((error as { code: string }).code).toBe("ScopeAmountExceeded");
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(scheme.calls).toEqual([]);
  });
});

describe("AgentPey pays a Vitrinee store over UCP 2026-08-25 (T133)", () => {
  it("pays the same way speaking UCP 2026-08-25: the store answers in that version and the receipt is the same kind (T133)", async () => {
    const scheme = fakeScheme();
    const grant = scope();
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const body = (await res.clone().json().catch(() => undefined)) as { ucp?: { version?: string } } | undefined;
      if (String(input).includes("/ucp/v1/") && body?.ucp?.version !== undefined) seen.push(body.ucp.version);
      return res;
    };
    // A store of its own: the main one already holds a receipt for the fake facilitator's one transaction (VT-40).
    const registry = fakeRegistry();
    const own = createApp({
      platformProfiles: fakePlatformProfiles({ [AGENTPEY_PLATFORM_PROFILE_2026_08_25]: "2026-08-25" }),
      config: testConfig(),
      adapter: new MockStoreAdapter(),
      facilitator: fakeFacilitator({ settle: { payer: RAIL, transaction: "beef".padEnd(64, "0") } }),
      anchorer: registry.anchorer,
      registry: registry.registry,
    });
    const ownServer = await listen(own);
    const ownVenue = () => {
      const base = loadVenueRegistry([{ slug: "vitrinee", address: MERCHANT, baseUrl: ownServer.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] }]);
      return { venueId: makeVenueId("vitrinee", MERCHANT), registry: base };
    };
    const paid = await executeUcpPayment(
      { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme, fetchImpl: spy, platformProfile: AGENTPEY_PLATFORM_PROFILE_2026_08_25 },
      {
        storeUrl: ownServer.url,
        productId: "gorro-andes",
        quantity: 1,
        buyer: { email: "ana@example.com" },
        destination: DESTINATION,
        intent: intent("gorro-andes", 1, "13.6736842", "13.6736842"),
        scope: grant,
        mandate: mandate(grant),
        ...ownVenue(),
        idempotencyKey: "ucp-contract-2026-08-25",
      },
    ).finally(async () => {
      own.anchors.stop();
      await ownServer.close();
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["2026-08-25"]));
    expect(paid.orderId).toMatch(/^ord_/);
    expect(paid.receipt).toMatchObject({ format: "jws" });
  });

});

describe("AgentPey pays a Vitrinee store with AP2 mandates (T134, R-15)", () => {
  const platformKey = deriveP256(new Uint8Array(32).fill(1), "test/platform", "agentpey#ap2");
  const holderKey = deriveP256(new Uint8Array(32).fill(2), "test/holder", "agent#ap2");
  const AP2_PROFILE_ENTRY = { ucp: { version: "2026-08-25", capabilities: ["dev.ucp.shopping.checkout", "dev.ucp.common.payment.ap2_mandate"] }, keys: [platformKey.publicJwk] };

  /** A store of its own, reading the platform profiles it is given; and an agent's AP2 options with a fresh intent memory. */
  async function setup(profiles: Parameters<typeof fakePlatformProfiles>[0]) {
    const registry = fakeRegistry();
    const store = new MockStoreAdapter();
    const own = createApp({
      platformProfiles: fakePlatformProfiles(profiles),
      config: testConfig(),
      adapter: store,
      facilitator: fakeFacilitator({ settle: { payer: RAIL, transaction: "ab12".padEnd(64, "0") } }),
      anchorer: registry.anchorer,
      registry: registry.registry,
    });
    const server = await listen(own);
    const venueRegistry = loadVenueRegistry([{ slug: "vitrinee", address: MERCHANT, baseUrl: server.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] }]);
    const grant = scope();
    const closed = new Set<string>();
    const ap2 = {
      issuer: "https://agentpey.com",
      platform: platformKey.signer,
      holder: { ...holderKey.signer, publicJwk: holderKey.publicJwk },
      source: { mandate_id: crypto.randomUUID(), hash: "b".repeat(64), registry: REGISTRY },
      closed,
    };
    const pay = (theIntent: PurchaseIntent, scheme = fakeScheme(), lines?: Array<{ productId: string; quantity: number }>, consent?: Record<string, unknown>) =>
      executeUcpPayment(
        { policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }), signerSecret: agent.secret(), schemeForTests: scheme, platformProfile: AGENTPEY_PLATFORM_PROFILE_AP2, ap2 },
        { storeUrl: server.url, ...(lines === undefined ? { productId: "gorro-andes", quantity: 1 } : { lines }), buyer: { email: "ana@example.com", ...(consent === undefined ? {} : { consent }) }, destination: DESTINATION, intent: theIntent, scope: grant, mandate: mandate(grant), venueId: makeVenueId("vitrinee", MERCHANT), registry: venueRegistry },
      );
    return {
      closed,
      pay,
      store,
      stop: async () => {
        own.anchors.stop();
        await server.close();
      },
    };
  }

  it("closes a mandate over the store's signed checkout, the store verifies it and charges once; the same intent never closes a second one", async () => {
    const { closed, pay, stop } = await setup({ [AGENTPEY_PLATFORM_PROFILE_AP2]: AP2_PROFILE_ENTRY });
    try {
      const theIntent = intent("gorro-andes", 1, "13.6736842", "13.6736842");
      const paid = await pay(theIntent);
      expect(paid.orderId).toMatch(/^ord_/);
      expect(paid.ap2Mandate?.split("~~")).toHaveLength(2);
      expect(closed.has(theIntent.intentId)).toBe(true);
      // Brecha 14: the same intent, a second time, is refused before the rail authorises or anything is signed.
      const scheme = fakeScheme();
      const again = await attempt(() => pay(theIntent, scheme));
      expect(again).toMatchObject({ code: "Ap2MandateInvalid" });
      expect(mayHaveBeenPaid(again)).toBe(false);
      expect(scheme.calls).toEqual([]);
    } finally {
      await stop();
    }
  });

  it("confirms the buyer's consent once the store advertised it, closes the mandate over it, and the store takes it to its order (T149)", async () => {
    const { pay, store, stop } = await setup({ [AGENTPEY_PLATFORM_PROFILE_AP2]: AP2_PROFILE_ENTRY });
    try {
      const consent = {
        "dev.ucp.consent.marketing": { granted: true, source: "platform" },
        "dev.ucp.consent.analytics": { granted: false, source: "business" },
        "dev.ucp.consent.preferences": { granted: false, source: "business" },
        "dev.ucp.consent.sale_or_sharing": { granted: false, source: "business" },
      };
      const paid = await pay(intent("gorro-andes", 1, "13.6736842", "13.6736842"), fakeScheme(), undefined, consent);
      expect(paid.orderId).toMatch(/^ord_/);
      expect(paid.ap2Mandate?.split("~~")).toHaveLength(2);
      const order = await store.getOrder("mock-0001");
      expect(order?.buyer).toMatchObject({ email: "ana@example.com", consent: { marketing: true } });
      expect(order?.buyer.consent).toEqual({ marketing: true });
    } finally {
      await stop();
    }
  });

  it("closes one mandate over a cart: the open mandate names every line, and the store verifies it and charges once (T148)", async () => {
    const { pay, stop } = await setup({ [AGENTPEY_PLATFORM_PROFILE_AP2]: AP2_PROFILE_ENTRY });
    try {
      const lines = [
        { productId: "gorro-andes", quantity: 1 },
        { productId: "stickers-cordillera", quantity: 2 },
      ];
      const paid = await pay(cartIntent([["gorro-andes", 1, HAT], ["stickers-cordillera", 2, STICKERS]], "15.7578948"), fakeScheme(), lines);
      expect(paid.orderId).toMatch(/^ord_/);
      // The open mandate (before `~~`) allows exactly the two lines, in the checkout's order.
      const open = paid.ap2Mandate!.split("~~")[0]!;
      const disclosed = open.split("~").slice(1).filter((d) => d !== "").map((d) => JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as [string, unknown]);
      const mandateClaims = disclosed.map(([, value]) => value).find((value): value is { constraints: Array<{ type: string; items?: Array<{ id: string; quantity: number }> }> } => typeof value === "object" && value !== null && "constraints" in value);
      expect(mandateClaims?.constraints.find((c) => c.type === "checkout.line_items")?.items?.map((item) => [item.id, item.quantity])).toEqual([
        ["line_1", 1],
        ["line_2", 2],
      ]);
    } finally {
      await stop();
    }
  });

  it("two payments of one intent at once close one mandate between them, never two (brecha 14)", async () => {
    const { pay, stop } = await setup({ [AGENTPEY_PLATFORM_PROFILE_AP2]: AP2_PROFILE_ENTRY });
    try {
      const theIntent = intent("gorro-andes", 1, "13.6736842", "13.6736842");
      const outcomes = await Promise.allSettled([pay(theIntent), pay(theIntent)]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
      expect(refused?.reason).toMatchObject({ code: "Ap2MandateInvalid" });
      expect(mayHaveBeenPaid(refused?.reason)).toBe(false);
    } finally {
      await stop();
    }
  });

  it("refuses, before the rail authorises or anything is signed, a store that did not sign its checkout", async () => {
    // The store cannot read the agent's profile, so it negotiates no AP2 and answers unsigned.
    const { pay, stop } = await setup({});
    try {
      const scheme = fakeScheme();
      const refused = await attempt(() => pay(intent("gorro-andes", 1, "13.6736842", "13.6736842"), scheme));
      expect(refused).toMatchObject({ code: "Ap2MerchantAuthorizationInvalid" });
      expect(mayHaveBeenPaid(refused)).toBe(false);
      expect(scheme.calls).toEqual([]);
    } finally {
      await stop();
    }
  });
});
