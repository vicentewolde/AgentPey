/**
 * AgentPey's MCP server against a real Vitrinee store, in process and with no
 * network (T128): the six tools over Streamable HTTP, the way Claude or
 * ChatGPT call them, from search to a signed refund claim. The same pairing as
 * `scripts/vitrinee/ucp-contract.test.ts`, one layer up.
 */
import { stellarAddressToDid, type Scope } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeVenueId } from "../../apps/agent/src/catalog/ids.js";
import { loadVenueRegistry } from "../../apps/agent/src/catalog/registry.js";
import type { PurchaseIntent } from "../../apps/agent/src/intent/intent.js";
import { createInMemorySpendLedger } from "../../apps/agent/src/ledger/spend-ledger.js";
import type { ExecuteUcpPaymentDeps } from "../../apps/agent/src/payment/ucp.js";
import { createLocalPolicyRail } from "../../apps/agent/src/policy/policy-rail.js";
import { createMcpApp } from "../../apps/mcp/src/http.js";
import { QuoteBook } from "../../apps/mcp/src/quotes.js";
import { Shopper, type ShopperDeps } from "../../apps/mcp/src/shopper.js";
import { createMandate } from "../../packages/mandate/src/index.js";
import { verifyClaim } from "../../packages/resolve/src/index.js";
import { MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { verifyReceipt } from "../../packages/vitrinee-anchor/src/index.js";
import { USDC_TESTNET } from "../../packages/vitrinee-core/src/index.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { FAKE_PAYER, fakeFacilitator, type FakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MERCHANT, fakeRegistry, testConfig } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../packages/vitrinee-gateway/src/test/listen.js";

type SchemeNetworkClient = NonNullable<ExecuteUcpPaymentDeps["schemeForTests"]>;
type PaymentRequirements = Parameters<SchemeNetworkClient["createPaymentPayload"]>[1];

const RAIL = "CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U";
const principal = Keypair.random();
const agent = Keypair.random();
const PRINCIPAL_DID = stellarAddressToDid(principal.publicKey(), "testnet");
const AGENT_DID = stellarAddressToDid(agent.publicKey(), "testnet");
const AGENT_REGISTRY = "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";
const USDC = `USDC:${USDC_TESTNET.contractId}`;
/** USDC per unit, as the store's x402 catalog prices it (testConfig's exchange rate). */
const PRICES: Record<string, string> = { "gorro-andes": "13.6736842" };
const DESTINATION = { first_name: "Ana", last_name: "Pérez", street_address: "Av. Irarrázaval 1234", address_locality: "Ñuñoa", address_region: "Metropolitana", address_country: "CL" };

let store: VitrineeApp;
let storeServer: { url: string; close: () => Promise<void> };
let facilitator: FakeFacilitator;
const anchors = fakeRegistry();

/**
 * Every settlement gets its own transaction hash, as on the real network: the
 * store issues one receipt per settlement (T132), so a shared hash would make
 * the second purchase a replay of the first.
 */
function uniqueFacilitator(): FakeFacilitator {
  const base = fakeFacilitator();
  let n = 0;
  return {
    ...base,
    async settle(payload, requirements) {
      const result = await base.settle(payload, requirements);
      n += 1;
      return { ...result, transaction: n.toString(16).padStart(64, "0") };
    },
  };
}

/** A Horizon where every transaction moved `amount` USDC from the facilitator's payer to the merchant. */
function horizonFor(amount: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/transactions\/[0-9a-f]{64}$/.test(url)) return Response.json({ successful: true, ledger: 4_899_999, created_at: "2026-10-03T12:00:00Z" });
    if (/\/transactions\/[0-9a-f]{64}\/effects/.test(url)) {
      return Response.json({
        _embedded: {
          records: [
            { type: "account_debited", account: FAKE_PAYER, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
            { type: "account_credited", account: MERCHANT, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
          ],
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  facilitator = uniqueFacilitator();
  store = createApp({ config: testConfig(), adapter: new MockStoreAdapter(), facilitator, anchorer: anchors.anchorer, registry: anchors.registry });
  storeServer = await listen(store);
});
afterAll(async () => {
  store.anchors.stop();
  await storeServer.close();
});

const venueId = () => makeVenueId("vitrinee", MERCHANT);
const venues = () => loadVenueRegistry([{ slug: "vitrinee", address: MERCHANT, baseUrl: storeServer.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] }]);
const storeName = () => new URL(storeServer.url).host;

const scope = (perTx = "50.00"): Scope => ({
  actions: ["catalog:read", "intent:create"],
  venues: [venueId()],
  assets: [USDC],
  limits: { perTx, perDay: "100.00", currency: "USDC" },
});

/** Stands in for `create_purchase_intent`: the intent the agent would sign for this product. */
function signIntent({ productId, quantity }: { productId: string; quantity: number }): Promise<PurchaseIntent> {
  const unit = PRICES[productId] ?? "1.0000000";
  const total = (Number(unit) * quantity).toFixed(7);
  return Promise.resolve({
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    agent: AGENT_DID,
    principal: PRINCIPAL_DID,
    credential: { hash: "a".repeat(64), registry: AGENT_REGISTRY },
    venue: venueId(),
    purchase: { productId, quantity, unitAmount: unit, totalAmount: total, asset: USDC as PurchaseIntent["purchase"]["asset"] },
    authorisation: { perTx: "50.00", currency: "USDC" },
  });
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

interface Mcp {
  url: string;
  scheme: ReturnType<typeof fakeScheme>;
  logs: string[];
  replies: string[];
  call(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text: string }> }>;
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

async function startMcp(overrides: Partial<ShopperDeps> & { perTx?: string } = {}): Promise<Mcp> {
  const grant = scope(overrides.perTx);
  const scheme = fakeScheme();
  const logs: string[] = [];
  const replies: string[] = [];
  const log = (message: string, fields?: Record<string, unknown>) => logs.push(JSON.stringify({ message, ...fields }));
  const shopper = new Shopper({
    venues: () => Promise.resolve(venues()),
    fixedVenues: loadVenueRegistry([]),
    signIntent,
    scope: grant,
    mandate: createMandate({ principal: PRINCIPAL_DID, agent: AGENT_DID, grant, registry: AGENT_REGISTRY, validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2027-09-01T00:00:00.000Z" }),
    policyRail: createLocalPolicyRail({ ledger: createInMemorySpendLedger() }),
    payment: { signerSecret: agent.secret(), payer: { contractId: RAIL, ownerSecret: agent.secret() }, schemeForTests: scheme },
    agentKey: agent,
    verifyReceipt: (jws) => verifyReceipt(jws, { registry: anchors.registry, horizonUrl: "https://horizon.test", fetchImpl: horizonFor("13.6736842") }),
    quotes: new QuoteBook(),
    log,
    ...overrides,
  });
  const server = await listen(createMcpApp({ shopper, log }));
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    id += 1;
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    replies.push(text);
    const json = res.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("") || "null")
      : JSON.parse(text);
    if (json?.error !== undefined) throw new Error(`rpc ${method} failed: ${JSON.stringify(json.error)}`);
    return json.result;
  };
  return {
    url: server.url,
    scheme,
    logs,
    replies,
    rpc,
    call: (name, args) => rpc("tools/call", { name, arguments: args }),
    close: () => server.close(),
  };
}

const errorOf = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as { error: string; message: string; payment_may_have_been_sent: boolean };

describe("AgentPey's MCP server, tool by tool (T128)", () => {
  let mcp: Mcp;
  beforeAll(async () => {
    mcp = await startMcp();
  });
  afterAll(() => mcp.close());

  it("lists six tools; only pay is destructive, and only search, product and order are read-only", async () => {
    const { tools } = (await mcp.rpc("tools/list")) as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; outputSchema?: unknown }> };
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_order", "get_product", "open_claim", "pay", "quote", "search_products"]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of ["search_products", "get_product", "get_order"]) expect(byName[name]?.annotations?.readOnlyHint, name).toBe(true);
    for (const name of ["quote", "pay", "open_claim"]) expect(byName[name]?.annotations?.readOnlyHint, name).toBe(false);
    expect(byName["pay"]?.annotations?.destructiveHint).toBe(true);
    for (const tool of tools) expect(tool.outputSchema, tool.name).toBeDefined();
  });

  it("searches, quotes, pays from the rail, reads the order with three green checks, and signs a claim", async () => {
    const found = await mcp.call("search_products", { query: "gorro" });
    expect(found.isError).toBeFalsy();
    expect(found.structuredContent?.products).toEqual([expect.objectContaining({ store: storeName(), product_id: "gorro-andes", price: { amount: 12990, currency: "CLP" } })]);

    const product = await mcp.call("get_product", { store: storeName(), product_id: "gorro-andes" });
    expect(product.structuredContent).toMatchObject({ product_id: "gorro-andes", available: true });

    const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", quantity: 1, destination: DESTINATION, email: "ana@example.com" });
    expect(quoted.isError).toBeFalsy();
    const quote = quoted.structuredContent!;
    expect(quote).toMatchObject({ total: { amount: 12990, currency: "CLP" }, pays: { amount_usdc: "13.6736842", to: MERCHANT, network: "stellar:testnet", asset: USDC_TESTNET.contractId, from: RAIL } });
    // A quote signs nothing and settles nothing.
    expect(mcp.scheme.calls).toEqual([]);

    const settled = facilitator.settleCalls.length;
    const paid = await mcp.call("pay", { quote_id: quote["quote_id"], confirm: true });
    expect(paid.isError).toBeFalsy();
    expect(mcp.scheme.calls).toEqual([expect.objectContaining({ amount: "136736842", payTo: MERCHANT, asset: USDC_TESTNET.contractId })]);
    expect(facilitator.settleCalls).toHaveLength(settled + 1);
    const order = paid.structuredContent!;
    expect(order).toMatchObject({ store: storeName(), paid_usdc: "13.6736842", paid_to: MERCHANT, receipt: { hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });

    await store.anchors.idle();
    const read = await mcp.call("get_order", { store: storeName(), order_id: order["order_id"] });
    expect(read.structuredContent).toMatchObject({
      order_id: order["order_id"],
      total: { amount: 12990, currency: "CLP" },
      receipt: { valid: true, anchor: "anchored", checks: { signature: { ok: true }, anchored: { ok: true }, settlement: { ok: true } } },
    });

    const claimed = await mcp.call("open_claim", { store: storeName(), order_id: order["order_id"], reason: "not_delivered", description: "Never arrived" });
    expect(claimed.isError).toBeFalsy();
    const claim = await verifyClaim(claimed.structuredContent!["claim_jws"] as string);
    expect(claim.document).toMatchObject({ claimant: AGENT_DID, reason: "not_delivered", amountAtomic: "136736842", receipt: { hash: read.structuredContent!["receipt"].hash } });
    expect(claim.hash).toBe(claimed.structuredContent!["claim_hash"]);
  });

  it("refuses to pay without the person's confirmation, and the quote stays payable", async () => {
    const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
    const quoteId = quoted.structuredContent!["quote_id"];
    const settled = facilitator.settleCalls.length;
    const refused = await mcp.call("pay", { quote_id: quoteId, confirm: false });
    expect(refused.isError).toBe(true);
    expect(errorOf(refused)).toMatchObject({ error: "ConfirmationRequired", payment_may_have_been_sent: false });
    expect(facilitator.settleCalls).toHaveLength(settled);
    const paid = await mcp.call("pay", { quote_id: quoteId, confirm: true });
    expect(paid.isError).toBeFalsy();
  });

  it("pays a quote once, and refuses an id it never issued", async () => {
    const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
    const quoteId = quoted.structuredContent!["quote_id"];
    expect((await mcp.call("pay", { quote_id: quoteId, confirm: true })).isError).toBeFalsy();
    const again = await mcp.call("pay", { quote_id: quoteId, confirm: true });
    expect(errorOf(again)).toMatchObject({ error: "QuoteNotFound", payment_may_have_been_sent: false });
    expect(errorOf(await mcp.call("pay", { quote_id: "q_never", confirm: true }))).toMatchObject({ error: "QuoteNotFound" });
  });

  it("names the stores it knows when asked for one it does not", async () => {
    const result = await mcp.call("quote", { store: "otra-tienda", product_id: "gorro-andes", destination: DESTINATION });
    expect(errorOf(result)).toMatchObject({ error: "InvalidVenueId" });
  });
});

describe("pay refuses what changed or what the limits do not allow (T128)", () => {
  it("refuses an expired quote", async () => {
    const clock = { now: new Date() };
    const mcp = await startMcp({ quotes: new QuoteBook({ ttlMs: 60_000, now: () => clock.now }) });
    try {
      const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      clock.now = new Date(clock.now.getTime() + 61_000);
      const late = await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true });
      expect(errorOf(late)).toMatchObject({ error: "QuoteExpired", payment_may_have_been_sent: false });
      expect(mcp.scheme.calls).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  for (const [field, value] of [
    ["amount", "1"],
    ["payTo", Keypair.random().publicKey()],
    ["asset", "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5"],
  ] as const) {
    it(`refuses a quote whose ${field} the store changed before payment, signing nothing`, async () => {
      let armed = false;
      // The store answers the quote honestly, then says something else when pay reads the checkout again.
      const rewrite: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        if (!armed || (init?.method ?? "GET") !== "GET" || !/\/checkout-sessions\/[^/]+$/.test(String(input))) return res;
        const body = (await res.json()) as { ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements: Record<string, string> } }>> } };
        const handler = body.ucp.payment_handlers["com.agentpey.stellar_x402"]?.[0];
        if (handler !== undefined) handler.config.payment_requirements[field] = value;
        return Response.json(body, { status: res.status });
      };
      const mcp = await startMcp({ fetchImpl: rewrite });
      try {
        const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
        expect(quoted.isError).toBeFalsy();
        armed = true;
        const settled = facilitator.settleCalls.length;
        const refused = await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true });
        expect(errorOf(refused)).toMatchObject({ error: "QuoteChanged", payment_may_have_been_sent: false });
        expect(mcp.scheme.calls).toEqual([]);
        expect(facilitator.settleCalls).toHaveLength(settled);
      } finally {
        await mcp.close();
      }
    });
  }

  it("refuses above the limit before anything is signed", async () => {
    const mcp = await startMcp({ perTx: "10.00" });
    try {
      const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      const settled = facilitator.settleCalls.length;
      const refused = await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true });
      expect(refused.isError).toBe(true);
      expect(errorOf(refused).error).toMatch(/Exceeded/);
      expect(errorOf(refused).payment_may_have_been_sent).toBe(false);
      expect(mcp.scheme.calls).toEqual([]);
      expect(facilitator.settleCalls).toHaveLength(settled);
    } finally {
      await mcp.close();
    }
  });
});

describe("the MCP server never repeats a secret (T128)", () => {
  it("keeps the agent's key out of every reply and every log line, a failure included", async () => {
    const mcp = await startMcp();
    try {
      const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true });
      await mcp.call("pay", { quote_id: "q_never", confirm: true });
      await mcp.call("quote", { store: "otra-tienda", product_id: "x", destination: DESTINATION });
      const everything = [...mcp.replies, ...mcp.logs].join("\n");
      expect(everything.length).toBeGreaterThan(0);
      expect(everything).not.toContain(agent.secret());
      expect(everything).not.toContain(agent.secret().slice(1, 30));
    } finally {
      await mcp.close();
    }
  });
});
