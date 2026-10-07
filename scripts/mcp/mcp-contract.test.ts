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
import { MOCK_CATALOG, MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { verifyReceipt } from "../../packages/vitrinee-anchor/src/index.js";
import { USDC_TESTNET } from "../../packages/vitrinee-core/src/index.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { FAKE_PAYER, fakeFacilitator, type FakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MERCHANT, fakeRegistry, testConfig, fakePlatformProfiles } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
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
const PRICES: Record<string, string> = { "gorro-andes": "13.6736842", "stickers-cordillera": "1.0421053" };
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
  // Plenty of hats: this file buys more than the mock catalog's eight.
  const catalog = MOCK_CATALOG.map((product) => (product.id === "gorro-andes" ? { ...product, stock: 1000 } : product));
  store = createApp({
    platformProfiles: fakePlatformProfiles(), config: testConfig(), adapter: new MockStoreAdapter({ catalog }), facilitator, anchorer: anchors.anchorer, registry: anchors.registry });
  storeServer = await listen(store);
});
afterAll(async () => {
  store.anchors.stop();
  await storeServer.close();
});

const venueId = () => makeVenueId("vitrinee", MERCHANT);
const venues = (payTo: string = MERCHANT) => loadVenueRegistry([{ slug: "vitrinee", address: payTo, baseUrl: storeServer.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] }]);
const storeName = () => new URL(storeServer.url).host;

const scope = (perTx = "50.00", perDay = "100.00"): Scope => ({
  actions: ["catalog:read", "intent:create"],
  venues: [venueId()],
  assets: [USDC],
  limits: { perTx, perDay, currency: "USDC" },
});

const units = (amount: string) => BigInt(Math.round(Number(amount) * 1e7));
const decimal = (atomic: bigint) => `${atomic / 10_000_000n}.${(atomic % 10_000_000n).toString().padStart(7, "0")}`;

/** Stands in for `create_purchase_intent` (one line) or the agent's cart signer (more): the intent the agent would sign. */
function signIntent({ lines }: { lines: ReadonlyArray<{ productId: string; quantity: number }> }): Promise<PurchaseIntent> {
  const [first] = lines;
  if (first === undefined) throw new Error("no lines");
  const priced = lines.map((line) => ({ ...line, unitAmount: PRICES[line.productId] ?? "1.0000000" }));
  const total = decimal(priced.reduce((sum, line) => sum + units(line.unitAmount) * BigInt(line.quantity), 0n));
  const purchase =
    lines.length === 1
      ? { productId: first.productId, quantity: first.quantity, unitAmount: priced[0]!.unitAmount, totalAmount: total, asset: USDC as PurchaseIntent["purchase"]["asset"] }
      : { lines: priced, totalAmount: total, asset: USDC as PurchaseIntent["purchase"]["asset"] };
  return Promise.resolve({
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    agent: AGENT_DID,
    principal: PRINCIPAL_DID,
    credential: { hash: "a".repeat(64), registry: AGENT_REGISTRY },
    venue: venueId(),
    purchase,
    authorisation: { perTx: "50.00", currency: "USDC" },
  });
}

/** Stands in for PolicyRailStellarScheme: records what it was asked to sign. */
function fakeScheme(): SchemeNetworkClient & { calls: PaymentRequirements[]; failNext: boolean } {
  const calls: PaymentRequirements[] = [];
  const scheme = {
    scheme: "exact",
    calls,
    failNext: false,
    async createPaymentPayload(_version: number, requirements: PaymentRequirements) {
      if (scheme.failNext) {
        scheme.failNext = false;
        // A signer that cannot build the payment: nothing leaves this process.
        throw new TypeError("the signer is unavailable");
      }
      calls.push(requirements);
      return { x402Version: 2, payload: { transaction: Buffer.from(`rail-tx-${calls.length}-${Math.random()}`).toString("base64") } };
    },
  };
  return scheme as unknown as SchemeNetworkClient & { calls: PaymentRequirements[]; failNext: boolean };
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

async function startMcp(overrides: Partial<ShopperDeps> & { perTx?: string; perDay?: string; payTo?: string } = {}): Promise<Mcp> {
  const grant = scope(overrides.perTx, overrides.perDay);
  const scheme = fakeScheme();
  const logs: string[] = [];
  const replies: string[] = [];
  const log = (message: string, fields?: Record<string, unknown>) => logs.push(JSON.stringify({ message, ...fields }));
  const shopper = new Shopper({
    venues: () => Promise.resolve(venues(overrides.payTo)),
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
  const server = await listen(createMcpApp({ shopper, log, auth: "none-for-tests" }));
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
    expect(quote).toMatchObject({
      product_id: "gorro-andes",
      quantity: 1,
      items: [{ product_id: "gorro-andes", quantity: 1 }],
      total: { amount: 12990, currency: "CLP" },
      pays: { amount_usdc: "13.6736842", to: MERCHANT, network: "stellar:testnet", asset: USDC_TESTNET.contractId, from: RAIL },
    });
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
      receipt: { valid: true, anchor: "anchored", checks: { order: { ok: true }, signature: { ok: true }, anchored: { ok: true }, settlement: { ok: true } } },
    });
    // T150: the chat gets the transaction's link from the server, not by composing it.
    const receipt = read.structuredContent!["receipt"];
    expect(receipt.explorer_url).toBe(`https://stellar.expert/explorer/testnet/tx/${receipt.settlement_tx_hash}`);

    const claimed = await mcp.call("open_claim", { store: storeName(), order_id: order["order_id"], reason: "not_delivered", description: "Never arrived" });
    expect(claimed.isError).toBeFalsy();
    const claim = await verifyClaim(claimed.structuredContent!["claim_jws"] as string);
    expect(claim.document).toMatchObject({ claimant: AGENT_DID, reason: "not_delivered", amountAtomic: "136736842", receipt: { hash: read.structuredContent!["receipt"].hash } });
    expect(claim.hash).toBe(claimed.structuredContent!["claim_hash"]);
  });

  it("quotes a cart of two products as one checkout and pays it with one payment (T150)", async () => {
    const quoted = await mcp.call("quote", {
      store: storeName(),
      items: [
        { product_id: "gorro-andes", quantity: 1 },
        { product_id: "stickers-cordillera", quantity: 2 },
      ],
      destination: DESTINATION,
    });
    expect(quoted.isError).toBeFalsy();
    const quote = quoted.structuredContent!;
    expect(quote).toMatchObject({
      product_id: null,
      quantity: null,
      items: [
        { product_id: "gorro-andes", quantity: 1 },
        { product_id: "stickers-cordillera", quantity: 2 },
      ],
      total: { amount: 14970, currency: "CLP" },
      pays: { amount_usdc: "15.7578948", to: MERCHANT },
    });

    const before = mcp.scheme.calls.length;
    const paid = await mcp.call("pay", { quote_id: quote["quote_id"], confirm: true });
    expect(paid.isError).toBeFalsy();
    expect(mcp.scheme.calls.slice(before)).toEqual([expect.objectContaining({ amount: "157578948", payTo: MERCHANT })]);

    await store.anchors.idle();
    const read = await mcp.call("get_order", { store: storeName(), order_id: paid.structuredContent!["order_id"] });
    // A UCP order line's quantity is { total, fulfilled, original }.
    expect(read.structuredContent!["items"].map((item: { id: string; quantity: { total: number } }) => [item.id, item.quantity.total])).toEqual([
      ["gorro-andes", 1],
      ["stickers-cordillera", 2],
    ]);
    // The receipt is this order's, signed and anchored. Settlement is not asserted: this file's fake Horizon
    // answers every transaction with the single hat's amount.
    expect(read.structuredContent!["receipt"]).toMatchObject({ checks: { order: { ok: true }, signature: { ok: true }, anchored: { ok: true } } });
  });

  it("refuses a quote that names both a product and a cart, or neither", async () => {
    const both = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", items: [{ product_id: "gorro-andes", quantity: 1 }], destination: DESTINATION });
    expect(both.isError).toBe(true);
    const neither = await mcp.call("quote", { store: storeName(), destination: DESTINATION });
    expect(neither.isError).toBe(true);
    const cartWithQuantity = await mcp.call("quote", { store: storeName(), quantity: 2, items: [{ product_id: "gorro-andes", quantity: 1 }], destination: DESTINATION });
    expect(cartWithQuantity.isError).toBe(true);
  });

  it("refuses to pay without the person's confirmation, false or missing, and the quote stays payable", async () => {
    const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
    const quoteId = quoted.structuredContent!["quote_id"];
    const settled = facilitator.settleCalls.length;
    const refused = await mcp.call("pay", { quote_id: quoteId, confirm: false });
    expect(refused.isError).toBe(true);
    expect(errorOf(refused)).toMatchObject({ error: "ConfirmationRequired", payment_may_have_been_sent: false });
    expect(facilitator.settleCalls).toHaveLength(settled);
    const missing = await mcp.call("pay", { quote_id: quoteId });
    expect(errorOf(missing)).toMatchObject({ error: "ConfirmationRequired", payment_may_have_been_sent: false });
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

  /**
   * Answers the quote honestly, then, once armed, rewrites what pay reads
   * again: the checkout's requirement and, when given, the profile's handler
   * declaration, so the two still agree with each other and only the
   * comparison against the quote can catch the change.
   */
  function shiftingStore(change: { requirement: Record<string, string>; declared?: (config: Record<string, any>) => void }) {
    const state = { armed: false };
    const fetchImpl: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const url = String(input);
      const method = init?.method ?? "GET";
      if (!state.armed || method !== "GET") return res;
      if (/\/checkout-sessions\/[^/]+$/.test(url)) {
        const body = (await res.json()) as { ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements: Record<string, string> } }>> } };
        const handler = body.ucp.payment_handlers["com.agentpey.stellar_x402"]?.[0];
        if (handler !== undefined) Object.assign(handler.config.payment_requirements, change.requirement);
        return Response.json(body, { status: res.status });
      }
      if (url.endsWith("/.well-known/ucp") && change.declared !== undefined) {
        const body = (await res.json()) as { ucp: { payment_handlers: Record<string, Array<{ config: Record<string, any> }>> } };
        const handler = body.ucp.payment_handlers["com.agentpey.stellar_x402"]?.[0];
        if (handler !== undefined) change.declared(handler.config);
        return Response.json(body, { status: res.status });
      }
      return res;
    };
    return { state, fetchImpl };
  }

  const OTHER_ACCOUNT = Keypair.random().publicKey();
  const OTHER_ASSET = "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5";
  const shifts: Array<[string, Parameters<typeof shiftingStore>[0]]> = [
    ["amount, in the checkout", { requirement: { amount: "1" } }],
    ["recipient, in the profile and the checkout alike", { requirement: { payTo: OTHER_ACCOUNT }, declared: (config) => (config["pay_to"] = OTHER_ACCOUNT) }],
    ["asset, in the profile and the checkout alike", { requirement: { asset: OTHER_ASSET }, declared: (config) => (config["asset"].contract = OTHER_ASSET) }],
    ["network, in the profile and the checkout alike", { requirement: { network: "stellar:pubnet" }, declared: (config) => (config["network"] = "stellar:pubnet") }],
  ];
  for (const [what, change] of shifts) {
    it(`refuses a quote whose ${what}, changed before payment, signing nothing`, async () => {
      const store = shiftingStore(change);
      const mcp = await startMcp({ fetchImpl: store.fetchImpl });
      try {
        const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
        expect(quoted.isError).toBeFalsy();
        store.state.armed = true;
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

  it("gives the day's budget back when the payment fails before anything is sent", async () => {
    // 13.67 USDC a hat and 20.00 a day: a failed attempt that kept its
    // reservation would leave no room for the retry.
    const mcp = await startMcp({ perDay: "20.00" });
    try {
      const first = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      mcp.scheme.failNext = true;
      const failed = await mcp.call("pay", { quote_id: first.structuredContent!["quote_id"], confirm: true });
      expect(errorOf(failed)).toMatchObject({ error: "PaymentNotCreated", payment_may_have_been_sent: false });
      const second = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      const paid = await mcp.call("pay", { quote_id: second.structuredContent!["quote_id"], confirm: true });
      expect(paid.isError).toBeFalsy();
    } finally {
      await mcp.close();
    }
  });

  it("keeps the day's budget spent when completing fails after the rail signed: the payment may have settled (T136 review)", async () => {
    // 13.67 USDC a hat and 20.00 a day: released, the reservation would leave room for a second hat.
    let completeFails = true;
    const failing: typeof fetch = async (input, init) => {
      if (completeFails && String(input).endsWith("/complete")) throw new TypeError("socket hang up");
      return fetch(input, init);
    };
    const mcp = await startMcp({ perDay: "20.00", fetchImpl: failing });
    try {
      const first = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      const failed = await mcp.call("pay", { quote_id: first.structuredContent!["quote_id"], confirm: true });
      expect(errorOf(failed)).toMatchObject({ error: "NetworkError", payment_may_have_been_sent: true });
      expect(mcp.scheme.calls).toHaveLength(1);
      completeFails = false;
      const second = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      const refused = await mcp.call("pay", { quote_id: second.structuredContent!["quote_id"], confirm: true });
      expect(errorOf(refused)).toMatchObject({ error: expect.stringMatching(/DailyLimitExceeded$/), payment_may_have_been_sent: false });
      expect(mcp.scheme.calls).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });

  it("leaves the quote payable when the directory cannot be read at payment time", async () => {
    let directoryUp = true;
    const mcp = await startMcp({ venues: () => (directoryUp ? Promise.resolve(venues()) : Promise.reject(new TypeError("directory unreachable"))) });
    try {
      const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      directoryUp = false;
      const failed = await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true });
      expect(errorOf(failed).payment_may_have_been_sent).toBe(false);
      expect(mcp.scheme.calls).toEqual([]);
      directoryUp = true;
      expect((await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true })).isError).toBeFalsy();
    } finally {
      await mcp.close();
    }
  });

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

describe("an order's receipt must be that order's, from that store (T128)", () => {
  it("does not call a genuine receipt valid when the store shows it under another order", async () => {
    let swap: { from: string; to: string } | undefined;
    // A store that answers order B with order A's receipt, which passes all three checks.
    const swapping: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (swap === undefined || !String(input).endsWith(`/ucp/v1/orders/${swap.to}`)) return res;
      const body = (await res.json()) as Record<string, unknown>;
      const other = (await (await fetch(String(input).replace(swap.to, swap.from))).json()) as Record<string, unknown>;
      return Response.json({ ...body, receipt: other["receipt"] }, { status: res.status });
    };
    const mcp = await startMcp({ fetchImpl: swapping });
    try {
      const buy = async () => {
        const quoted = await mcp.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
        return (await mcp.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true })).structuredContent!["order_id"] as string;
      };
      const a = await buy();
      const b = await buy();
      await store.anchors.idle();
      swap = { from: a, to: b };
      const read = await mcp.call("get_order", { store: storeName(), order_id: b });
      expect(read.structuredContent!["receipt"]).toMatchObject({
        valid: false,
        checks: { order: { ok: false, reason: expect.stringContaining(a) }, signature: { ok: true }, anchored: { ok: true }, settlement: { ok: true } },
      });
      const claim = await mcp.call("open_claim", { store: storeName(), order_id: b, reason: "not_delivered", description: "Never arrived" });
      expect(errorOf(claim)).toMatchObject({ error: "InvalidArguments" });
    } finally {
      await mcp.close();
    }
  });

  it("does not call a receipt valid when another merchant than the directory's store issued it", async () => {
    const buyer = await startMcp();
    // The same store, but the directory now pins another payout account for it.
    const reader = await startMcp({ payTo: Keypair.random().publicKey() });
    try {
      const quoted = await buyer.call("quote", { store: storeName(), product_id: "gorro-andes", destination: DESTINATION });
      const orderId = (await buyer.call("pay", { quote_id: quoted.structuredContent!["quote_id"], confirm: true })).structuredContent!["order_id"];
      await store.anchors.idle();
      const read = await reader.call("get_order", { store: storeName(), order_id: orderId });
      expect(read.structuredContent!["receipt"]).toMatchObject({ valid: false, checks: { order: { ok: false, reason: expect.stringMatching(/another merchant/) } } });
    } finally {
      await buyer.close();
      await reader.close();
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
