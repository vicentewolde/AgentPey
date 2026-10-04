import { readFileSync } from "node:fs";

import { checkoutJwtFrom, closeCheckoutMandate, disclosableArray, issueOpenMandatePair, issueSdJwt, verifyMerchantAuthorization, type Ap2Signer } from "@agentpey/ap2";
import { exportJWK, generateKeyPair } from "jose";

import { MockStoreAdapter, type MOCK_CATALOG } from "@vitrinee/adapters";
import type { DisputeReader, DisputeRecord } from "@vitrinee/anchor";
import { STELLAR_X402_HANDLER, UCP_REST_PREFIX, USDC_TESTNET } from "@vitrinee/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Anchorer } from "../anchoring.js";
import { createApp } from "../app.js";
import { OrderStore, type OrderPersistence } from "../orders.js";
import { FAKE_PAYER, fakeFacilitator, type FakeFacilitator } from "../test/fake-facilitator.js";
import { AGENTPEY_PLATFORM_PROFILE, MERCHANT, fakePlatformProfiles, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { UCP_SCHEMA_2026_08_25, addSchema, ucpErrors } from "../test/ucp-schemas.js";
import type { PlatformProfileReader } from "./platform-profile.js";
import { MemoryCheckoutSessions } from "./sessions.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { $id: string };
const HANDLER = read("../../../../apps/web/public/ucp/handlers/stellar-x402/schema.json");
const RECEIPT = read("../../../../apps/web/public/ucp/extensions/receipt/schema.json");
addSchema(HANDLER);
addSchema(RECEIPT);

const CHECKOUT_SCHEMA = "https://ucp.dev/schemas/shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout";
const ORDER_SCHEMA = "https://ucp.dev/schemas/shopping/order.json";
const ERROR_SCHEMA = "https://ucp.dev/schemas/shopping/types/error_response.json";

const DESTINATION = {
  first_name: "Ana",
  last_name: "Rojas",
  street_address: "Av. Providencia 1234",
  address_locality: "Santiago",
  address_region: "RM",
  address_country: "CL",
};

interface Checkout {
  id: string;
  status: string;
  currency: string;
  totals: Array<{ type: string; amount: number }>;
  messages: Array<{ code: string; severity: string }>;
  ucp: { payment_handlers: Record<string, Array<{ config: Record<string, unknown> & { payment_requirements?: Requirements } }>> };
  order?: { id: string; permalink_url: string };
  receipt?: { hash: string; anchor: { status: string } };
}
type Requirements = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra?: Record<string, unknown> };

const requirementsOf = (checkout: Checkout): Requirements => {
  const requirements = checkout.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0]?.config.payment_requirements;
  if (requirements === undefined) throw new TypeError("no payment requirements in the checkout");
  return requirements;
};

const instrument = (accepted: Requirements, transaction = Buffer.from(`fake-tx-${Math.random()}`).toString("base64")) => ({
  payment: {
    instruments: [
      {
        id: "instr_1",
        handler_id: "stellar_x402",
        type: "stellar_x402",
        selected: true,
        credential: { type: "x402_payment_payload", x402_version: 2, accepted, payload: { transaction } },
      },
    ],
  },
});

/** The fake facilitator, but every settlement gets its own transaction hash, as on the real network. */
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

function harness(options: { profiles?: PlatformProfileReader; createOrderDelayMs?: number; facilitator?: FakeFacilitator; catalog?: typeof MOCK_CATALOG; orders?: OrderStore; disputes?: DisputeReader | null; disputeTimeoutMs?: number; anchorer?: Anchorer } = {}) {
  const clock = { now: new Date("2026-09-30T12:00:00.000Z") };
  const facilitator = options.facilitator ?? uniqueFacilitator();
  const registry = fakeRegistry();
  const adapter = new MockStoreAdapter(options.catalog === undefined ? {} : { catalog: options.catalog });
  const platformOrders = { created: 0 };
  const sessions = new MemoryCheckoutSessions();
  const createOrder = adapter.createOrder.bind(adapter);
  adapter.createOrder = async (input) => {
    platformOrders.created += 1;
    // A store platform that takes a moment, as a real one does.
    if (options.createOrderDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.createOrderDelayMs));
    return createOrder(input);
  };
  const app = createApp({
    platformProfiles: options.profiles ?? fakePlatformProfiles(),
    config: testConfig(),
    adapter,
    facilitator,
    anchorer: options.anchorer ?? registry.anchorer,
    registry: registry.registry,
    sessions,
    ...(options.orders === undefined ? {} : { orders: options.orders }),
    ...(options.disputes === undefined ? {} : { disputes: options.disputes }),
    ...(options.disputeTimeoutMs === undefined ? {} : { disputeTimeoutMs: options.disputeTimeoutMs }),
    anchorRetryDelaysMs: [1],
    now: () => clock.now,
  });
  let url = "";
  let close: () => Promise<void> = async () => {};
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${UCP_REST_PREFIX}${path}`, {
      method,
      headers: { "content-type": "application/json", "UCP-Agent": 'profile="https://agentpey.com/ucp/platform/agentpey.json"', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Checkout & Record<string, unknown> };
  };
  return {
    clock,
    facilitator,
    registry,
    adapter,
    platformOrders,
    sessions,
    call,
    create: (body: unknown) => call("POST", "/checkout-sessions", body),
    url: () => url,
    start: async () => {
      ({ url, close } = await listen(app));
    },
    stop: () => close(),
  };
}

const ready = (productId = "hoodie-cordillera-m", quantity = 1) => ({
  line_items: [{ item: { id: productId }, quantity }],
  buyer: { email: "ana@example.com" },
  fulfillment: { methods: [{ type: "shipping", destinations: [DESTINATION] }] },
});

describe("UCP checkout sessions (T122)", () => {
  const h = harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("creates an incomplete session when no destination was given, valid against the official schema", async () => {
    const { status, body } = await h.create({ line_items: [{ item: { id: "hoodie-cordillera-m" }, quantity: 1 }] });
    expect(status).toBe(201);
    expect(ucpErrors(CHECKOUT_SCHEMA, body)).toEqual([]);
    expect(body.status).toBe("incomplete");
    expect(body.messages).toEqual([expect.objectContaining({ code: "missing", severity: "recoverable" })]);
    // Until it is ready, the handler carries only the business config: nothing to sign yet.
    expect(body.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0]?.config).not.toHaveProperty("payment_requirements");
  });

  it("is ready once it has a destination, prices in CLP and asks for the exact USDC amount", async () => {
    const { body } = await h.create(ready("hoodie-cordillera-m", 2));
    expect(ucpErrors(CHECKOUT_SCHEMA, body)).toEqual([]);
    expect(body.status).toBe("ready_for_complete");
    expect(body.currency).toBe("CLP");
    expect(body.totals.find((t) => t.type === "total")?.amount).toBe(69980);
    const config = body.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0]?.config;
    expect(ucpErrors(`${HANDLER.$id}#/$defs/response_config`, config)).toEqual([]);
    // 2 × 368315789, the same unit price the manifest shows.
    expect(requirementsOf(body)).toMatchObject({ scheme: "exact", network: "stellar:testnet", asset: USDC_TESTNET.contractId, amount: "736631578", payTo: MERCHANT });
    expect(config).toMatchObject({ pay_to: MERCHANT, binding: { checkout_id: body.id }, fx: { base: "USD", quote: "CLP", rate: "950" } });
  });

  it("completes: settles the stored requirements once, creates the order and returns the anchored receipt", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const settleBefore = h.facilitator.settleCalls.length;
    const { status, body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)), { "Idempotency-Key": "k-1" });
    expect(status).toBe(200);
    expect(ucpErrors(CHECKOUT_SCHEMA, body)).toEqual([]);
    expect(body.status).toBe("completed");
    expect(h.facilitator.settleCalls).toHaveLength(settleBefore + 1);
    expect(h.facilitator.settleCalls.at(-1)?.requirements).toMatchObject({ amount: requirementsOf(created).amount, payTo: MERCHANT });
    expect(body.order?.permalink_url).toMatch(/\/receipts\/[0-9a-f]{64}$/);
    expect(ucpErrors(`${RECEIPT.$id}#/$defs/receipt`, body.receipt)).toEqual([]);

    const order = await h.call("GET", `/orders/${body.order?.id}`);
    expect(order.status).toBe(200);
    expect(ucpErrors(ORDER_SCHEMA, order.body)).toEqual([]);
    expect(order.body).toMatchObject({ checkout_id: created.id, currency: "CLP", totals: expect.arrayContaining([{ type: "total", amount: 12990 }]) });
    expect(order.body["receipt"]).toMatchObject({ settlement_tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Country only: the order id is in the public receipt, so the address is not served here.
    expect(order.body["fulfillment"]).toEqual({ expectations: [expect.objectContaining({ method_type: "shipping", destination: { address_country: "CL" } })] });

    // The receipt anchors after the answer; the order shows it once it has.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = await h.call("GET", `/orders/${body.order?.id}`);
    expect((later.body["receipt"] as { anchor: { status: string } }).anchor.status).toBe("anchored");
  });

  it("never charges a completed checkout twice", async () => {
    const { body: created } = await h.create(ready("stickers-cordillera"));
    const first = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    const settled = h.facilitator.settleCalls.length;
    const again = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(first.body.status).toBe("completed");
    expect(again.body.status).toBe("completed");
    expect(again.body.order?.id).toBe(first.body.order?.id);
    expect(h.facilitator.settleCalls).toHaveLength(settled);
    // Each checkout got its own order, not one replayed from an earlier purchase.
    const order = await h.call("GET", `/orders/${first.body.order?.id}`);
    expect(order.body).toMatchObject({ checkout_id: created.id, line_items: [expect.objectContaining({ item: expect.objectContaining({ id: "stickers-cordillera" }) })] });
  });

  it("settles a checkout once even when two completes race", async () => {
    const { body: created } = await h.create(ready("polera-valpo-l"));
    const settled = h.facilitator.settleCalls.length;
    const [a, b] = await Promise.all([
      h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created))),
      h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created))),
    ]);
    expect(h.facilitator.settleCalls).toHaveLength(settled + 1);
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([200]));
    for (const reply of [a, b]) expect(reply.status === 409 || reply.body.status === "completed").toBe(true);
  });

  it("refuses a credential signed for other requirements, without settling anything", async () => {
    const { body: created } = await h.create(ready("polera-valpo-l"));
    const settled = h.facilitator.settleCalls.length;
    const tampered = { ...requirementsOf(created), amount: "1" };
    const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(tampered));
    expect(body.status).toBe("ready_for_complete");
    expect(body.messages).toEqual([expect.objectContaining({ code: "payment_failed", severity: "recoverable" })]);
    expect(h.facilitator.settleCalls).toHaveLength(settled);
  });

  it("refuses an old credential after the quantity changed, and asks for the new amount", async () => {
    const { body: created } = await h.create(ready("cafe-nunoa-250", 1));
    const old = requirementsOf(created);
    const updated = await h.call("PUT", `/checkout-sessions/${created.id}`, ready("cafe-nunoa-250", 3));
    expect(updated.body.status).toBe("ready_for_complete");
    expect(BigInt(requirementsOf(updated.body).amount)).toBe(BigInt(old.amount) * 3n);
    const settled = h.facilitator.settleCalls.length;
    const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(old));
    expect(body.messages).toEqual([expect.objectContaining({ code: "payment_failed" })]);
    expect(h.facilitator.settleCalls).toHaveLength(settled);
  });

  it("asks for a smaller quantity instead of quoting what it does not have", async () => {
    const { body } = await h.create(ready("botella-patagonia-500", 5));
    expect(ucpErrors(CHECKOUT_SCHEMA, body)).toEqual([]);
    expect(body.status).toBe("incomplete");
    expect(body.messages).toEqual([expect.objectContaining({ code: "out_of_stock", severity: "recoverable" })]);
  });

  it("cancels, and a canceled checkout can be neither changed nor completed", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const canceled = await h.call("POST", `/checkout-sessions/${created.id}/cancel`);
    expect(canceled.body.status).toBe("canceled");
    const complete = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(complete.status).toBe(409);
    expect(ucpErrors(ERROR_SCHEMA, complete.body)).toEqual([]);
    expect((await h.call("PUT", `/checkout-sessions/${created.id}`, ready("gorro-andes"))).status).toBe(409);
  });

  it("answers unknown sessions, unknown products and unsupported carts as UCP errors", async () => {
    const missing = await h.call("GET", "/checkout-sessions/cs_doesnotexist");
    expect(missing.status).toBe(404);
    expect(ucpErrors(ERROR_SCHEMA, missing.body)).toEqual([]);
    expect((await h.call("GET", "/checkout-sessions/..%2F..%2Fetc")).status).toBe(404);

    const product = await h.create(ready("nope"));
    expect(product.status).toBe(400);
    expect(ucpErrors(ERROR_SCHEMA, product.body)).toEqual([]);

    const two = await h.create({ ...ready(), line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }, { item: { id: "polera-valpo-l" }, quantity: 1 }] });
    expect(two.status).toBe(400);
    const pickup = await h.create({ ...ready(), fulfillment: { methods: [{ type: "pickup" }] } });
    expect(pickup.status).toBe(400);
    const bad = await h.create({ line_items: [{ item: { id: "gorro-andes" }, quantity: 0 }] });
    expect(bad.status).toBe(400);
    expect(ucpErrors(ERROR_SCHEMA, bad.body)).toEqual([]);
  });

  it("does not quote a destination the store does not ship to", async () => {
    const { body } = await h.create({ ...ready(), fulfillment: { methods: [{ type: "shipping", destinations: [{ ...DESTINATION, address_country: "PE" }] }] } });
    expect(body.status).toBe("incomplete");
    expect(body.messages).toEqual([expect.objectContaining({ code: "address_undeliverable" })]);
  });

  it("expires after six hours", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const saved = h.clock.now;
    h.clock.now = new Date(saved.getTime() + 6 * 60 * 60 * 1000 + 1);
    try {
      expect((await h.call("GET", `/checkout-sessions/${created.id}`)).body.status).toBe("canceled");
    } finally {
      h.clock.now = saved;
    }
  });

  it("only serves UCP orders at /ucp/v1/orders", async () => {
    const missing = await h.call("GET", "/orders/ord_nope");
    expect(missing.status).toBe(404);
    expect(ucpErrors(ERROR_SCHEMA, missing.body)).toEqual([]);
  });
});

describe("one settlement backs one receipt (T132)", () => {
  // The plain fake facilitator answers every settlement with the same hash:
  // two checkouts that claim the same transaction.
  const h = harness({ facilitator: fakeFacilitator() });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("refuses a second checkout that settles with a transaction another order already used", async () => {
    const { body: one } = await h.create(ready("gorro-andes"));
    const { body: two } = await h.create(ready("stickers-cordillera"));
    const first = await h.call("POST", `/checkout-sessions/${one.id}/complete`, instrument(requirementsOf(one)));
    expect(first.body.status).toBe("completed");
    const second = await h.call("POST", `/checkout-sessions/${two.id}/complete`, instrument(requirementsOf(two)));
    expect(second.status).toBe(402);
    expect(second.body.order).toBeUndefined();
    expect(second.body.receipt).toBeUndefined();
    // The first order still stands, alone.
    const order = await h.call("GET", `/orders/${first.body.order?.id}`);
    expect(order.body).toMatchObject({ checkout_id: one.id });
  });
});

describe("one settlement backs one receipt when two checkouts complete at once (T132)", () => {
  const h = harness({ facilitator: fakeFacilitator(), createOrderDelayMs: 50 });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("creates one order: the checkout that arrives second waits, and is refused", async () => {
    const { body: one } = await h.create(ready("gorro-andes"));
    const { body: two } = await h.create(ready("stickers-cordillera"));
    const replies = await Promise.all([
      h.call("POST", `/checkout-sessions/${one.id}/complete`, instrument(requirementsOf(one))),
      h.call("POST", `/checkout-sessions/${two.id}/complete`, instrument(requirementsOf(two))),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(h.platformOrders.created).toBe(1);
    const won = replies.find((r) => r.status === 200)!;
    const lost = replies.find((r) => r.status === 402)!;
    expect(won.body.status).toBe("completed");
    expect(lost.body.order).toBeUndefined();
    expect(lost.body.receipt).toBeUndefined();
  });
});

describe("a store that fails after the payment settled", () => {
  // The first write of an order fails, as a database blip would; later writes work.
  let failures = 1;
  const saved: Array<{ orderId: string }> = [];
  const persistence: OrderPersistence = {
    load: async () => [],
    save: async (order) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("database unavailable");
      }
      saved.push({ orderId: order.orderId });
    },
  };
  const h = harness({ orders: new OrderStore(persistence, []) });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("keeps the settlement, never settles again, and finishes the order on the next complete", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const settled = h.facilitator.settleCalls.length;
    const first = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(first.status).toBe(500);
    expect(h.facilitator.settleCalls).toHaveLength(settled + 1);
    const between = await h.call("GET", `/checkout-sessions/${created.id}`);
    expect(between.body.status).toBe("complete_in_progress");
    // A changed cart or a cancel cannot slip in between the payment and its order.
    expect((await h.call("PUT", `/checkout-sessions/${created.id}`, ready("gorro-andes", 2))).status).toBe(409);
    expect((await h.call("POST", `/checkout-sessions/${created.id}/cancel`)).status).toBe(409);

    // The retry carries a brand-new signature, as a client does after a 500. It is not settled.
    const retry = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("completed");
    expect(h.facilitator.settleCalls).toHaveLength(settled + 1);
    const order = await h.call("GET", `/orders/${retry.body.order?.id}`);
    expect(order.body).toMatchObject({ checkout_id: created.id, totals: expect.arrayContaining([{ type: "total", amount: 12990 }]) });
    // The order the failed attempt left only in memory is written and its receipt anchored after all.
    expect(saved.map((o) => o.orderId)).toContain(retry.body.order?.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(((await h.call("GET", `/orders/${retry.body.order?.id}`)).body["receipt"] as { anchor: { status: string } }).anchor.status).toBe("anchored");
  });
});

describe("a payment whose outcome is unknown", () => {
  const base = fakeFacilitator();
  const flaky: FakeFacilitator = {
    ...base,
    async settle(payload, requirements) {
      base.settleCalls.push({ payload, requirements });
      throw new Error("timeout waiting for the facilitator");
    },
  };
  const h = harness({ facilitator: flaky });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("holds the checkout instead of letting it be paid again", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const first = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(ucpErrors(CHECKOUT_SCHEMA, first.body)).toEqual([]);
    expect(first.body.status).toBe("complete_in_progress");
    expect(first.body.messages).toEqual([expect.objectContaining({ code: "payment_pending", severity: "requires_buyer_review" })]);
    expect(first.body.order).toBeUndefined();

    const settled = h.facilitator.settleCalls.length;
    const retry = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(retry.body.status).toBe("complete_in_progress");
    expect(h.facilitator.settleCalls).toHaveLength(settled);
    expect((await h.call("POST", `/checkout-sessions/${created.id}/cancel`)).status).toBe(409);
  });
});

describe("a refusal after the transaction was broadcast", () => {
  const h = harness({ facilitator: fakeFacilitator({ settle: { success: false, transaction: "ab".repeat(32), errorReason: "settle_exact_stellar_transaction_failed" } }) });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("is treated as unknown, not as a refusal: the checkout is held", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(body.status).toBe("complete_in_progress");
    expect(body.messages).toEqual([expect.objectContaining({ code: "payment_pending" })]);
  });
});

describe("a payment the network refuses", () => {
  const h = harness({ facilitator: fakeFacilitator({ settle: { success: false, transaction: "", errorReason: "insufficient_funds" } }) });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it("leaves the checkout ready, creates no order and says the buyer has to act", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(ucpErrors(CHECKOUT_SCHEMA, body)).toEqual([]);
    expect(body.status).toBe("ready_for_complete");
    expect(body.order).toBeUndefined();
    expect(body.messages).toEqual([expect.objectContaining({ code: "payment_failed", severity: "requires_buyer_input" })]);
  });
});

describe("a store that refuses the order after payment", () => {
  const h = harness();
  beforeAll(async () => {
    h.adapter.createOrder = async () => {
      throw new Error("store API down");
    };
    await h.start();
  });
  afterAll(() => h.stop());

  it("still completes the checkout, keeps the receipt, and flags the order for fulfilment", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(body.status).toBe("completed");
    expect(body.receipt?.hash).toMatch(/^[0-9a-f]{64}$/);
    const order = await h.call("GET", `/orders/${body.order?.id}`);
    expect(ucpErrors(ORDER_SCHEMA, order.body)).toEqual([]);
    expect(order.body["messages"]).toEqual([expect.objectContaining({ type: "warning", code: "fulfillment_pending" })]);
    expect(FAKE_PAYER).toMatch(/^G/);
  });
});

const AGENT_RESOLVE = "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F";
const ORDER_WITH_RECEIPT = `${RECEIPT.$id}#/$defs/dev.ucp.shopping.order`;

/** `agent-resolve` as the chain would answer, one dispute per receipt hash. */
function fakeDisputes() {
  const byReceipt = new Map<string, DisputeRecord>();
  const calls: string[] = [];
  let failure: Error | "hang" | null = null;
  const reader: DisputeReader = {
    contractId: AGENT_RESOLVE,
    get: (hash) => {
      calls.push(hash);
      if (failure === "hang") return new Promise(() => {});
      return failure === null ? Promise.resolve(byReceipt.get(hash) ?? null) : Promise.reject(failure);
    },
  };
  return { reader, byReceipt, calls, fail: (error: Error | "hang" | null) => (failure = error) };
}

function dispute(overrides: Partial<DisputeRecord> = {}): DisputeRecord {
  return {
    status: "open",
    merchant: "GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ",
    payer: FAKE_PAYER,
    claimHash: "12075d85a757b96394b63a52e19dc18842b335eb4f6a3d321b408202d9f7d37f",
    amountAtomic: 0n,
    openedAt: 1_791_000_000,
    verdictHash: null,
    refundAtomic: 0n,
    resolvedAt: null,
    ...overrides,
  };
}

describe("a UCP order shows the dispute over its receipt, read from agent-resolve (T127)", () => {
  const disputes = fakeDisputes();
  const h = harness({ disputes: disputes.reader, disputeTimeoutMs: 50 });
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  /** A completed purchase whose receipt is anchored: the only kind that can be disputed. */
  async function anchoredOrder() {
    const { body: created } = await h.create(ready("gorro-andes"));
    const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { orderId: body.order?.id ?? "", hash: body.receipt?.hash ?? "", paid: BigInt(requirementsOf(created).amount) };
  }

  async function order(orderId: string) {
    const { status, body } = await h.call("GET", `/orders/${orderId}`);
    expect(status).toBe(200);
    expect(ucpErrors(ORDER_SCHEMA, body)).toEqual([]);
    expect(ucpErrors(ORDER_WITH_RECEIPT, body)).toEqual([]);
    return body as Record<string, unknown> & { adjustments?: Array<Record<string, unknown>>; receipt: Record<string, unknown> & { dispute?: Record<string, unknown> }; messages: unknown[] };
  }

  it("says nothing about disputes when the receipt has none, as before", async () => {
    const { orderId, hash } = await anchoredOrder();
    const body = await order(orderId);
    expect(disputes.calls).toContain(hash);
    expect(body).not.toHaveProperty("adjustments");
    expect(body.receipt).not.toHaveProperty("dispute");
    expect(body.messages).toEqual([]);
  });

  it("shows an open dispute as a pending UCP adjustment, and its on-chain facts in the receipt", async () => {
    const { orderId, hash, paid } = await anchoredOrder();
    disputes.byReceipt.set(hash, dispute({ amountAtomic: paid }));
    const body = await order(orderId);
    expect(body.adjustments).toEqual([
      { id: "dispute_12075d85a757b963", type: "dispute", occurred_at: "2026-10-03T04:00:00.000Z", status: "pending", description: expect.stringContaining("open") },
    ]);
    expect(body.receipt.dispute).toEqual({
      contract: AGENT_RESOLVE,
      status: "open",
      claim_hash: "12075d85a757b96394b63a52e19dc18842b335eb4f6a3d321b408202d9f7d37f",
      asset: USDC_TESTNET.contractId,
      amount_atomic: paid.toString(),
      opened_at: "2026-10-03T04:00:00.000Z",
    });
  });

  it("shows a full refund as a completed adjustment of minus the order total", async () => {
    const { orderId, hash, paid } = await anchoredOrder();
    disputes.byReceipt.set(hash, dispute({ status: "resolved", amountAtomic: paid, refundAtomic: paid, verdictHash: "f".repeat(64), resolvedAt: 1_791_003_600 }));
    const body = await order(orderId);
    expect(body.adjustments?.[0]).toMatchObject({ status: "completed", occurred_at: "2026-10-03T05:00:00.000Z", totals: [{ type: "total", display_text: "Refunded", amount: -12990 }] });
    expect(body.receipt.dispute).toMatchObject({ status: "resolved", verdict_hash: "f".repeat(64), refund_atomic: paid.toString(), resolved_at: "2026-10-03T05:00:00.000Z" });
  });

  it("shows a partial refund as the same share of the order total, rounded down, and the exact USDC in the receipt", async () => {
    const { orderId, hash, paid } = await anchoredOrder();
    const refund = paid / 3n;
    disputes.byReceipt.set(hash, dispute({ status: "resolved", amountAtomic: paid, refundAtomic: refund, verdictHash: "e".repeat(64), resolvedAt: 1_791_003_600 }));
    const body = await order(orderId);
    expect(body.adjustments?.[0]?.["totals"]).toEqual([{ type: "total", display_text: "Refunded", amount: -Number((12990n * refund) / paid) }]);
    expect(body.receipt.dispute?.["refund_atomic"]).toBe(refund.toString());
  });

  it("shows a rejected claim as completed with nothing refunded", async () => {
    const { orderId, hash, paid } = await anchoredOrder();
    disputes.byReceipt.set(hash, dispute({ status: "resolved", amountAtomic: paid, refundAtomic: 0n, verdictHash: "d".repeat(64), resolvedAt: 1_791_003_600 }));
    const body = await order(orderId);
    expect(body.adjustments?.[0]).toMatchObject({ status: "completed", description: expect.stringContaining("rejected") });
    expect(body.adjustments?.[0]).not.toHaveProperty("totals");
    expect(body.receipt.dispute).toMatchObject({ status: "resolved", refund_atomic: "0" });
  });

  it.each([
    ["the read fails", new Error("rpc down")],
    ["the RPC never answers", "hang"],
  ] as const)("answers the order with a warning, never a 503, when %s", async (_name, failure) => {
    const { orderId } = await anchoredOrder();
    disputes.fail(failure);
    try {
      const body = await order(orderId);
      expect(body).not.toHaveProperty("adjustments");
      expect(body.messages).toEqual([expect.objectContaining({ type: "warning", code: "dispute_state_unavailable" })]);
    } finally {
      disputes.fail(null);
    }
  });
});

describe("a UCP order whose receipt is not anchored yet is never looked up (T127)", () => {
  it("reads no dispute before the anchor, since the contract refuses one", async () => {
    const disputes = fakeDisputes();
    // An anchor that never lands: the receipt stays `pending`.
    const h = harness({ disputes: disputes.reader, anchorer: { anchor: () => new Promise(() => {}) } });
    await h.start();
    try {
      const { body: created } = await h.create(ready("gorro-andes"));
      const { body } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
      const { body: orderBody } = await h.call("GET", `/orders/${body.order?.id}`);
      expect((orderBody["receipt"] as { anchor: { status: string } }).anchor.status).toBe("pending");
      expect(disputes.calls).toEqual([]);
    } finally {
      await h.stop();
    }
  });
});


describe("UCP conformance fixes (T131)", () => {
  const h = harness();
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  const key = (k: string) => ({ "Idempotency-Key": k });

  it("returns a payment object, without echoing any instrument, valid against the official schema", async () => {
    const { body } = await h.create(ready("gorro-andes"));
    expect(ucpErrors(CHECKOUT_SCHEMA, body)).toEqual([]);
    expect(body["payment"]).toEqual({ instruments: [] });
  });

  it("refuses a UCP version it does not serve with 422 version_unsupported, on checkout and catalog alike", async () => {
    for (const [method, path, body] of [
      ["POST", "/checkout-sessions", ready("gorro-andes")],
      ["POST", "/catalog/search", { query: "gorro" }],
    ] as const) {
      const res = await h.call(method, path, body, { "UCP-Agent": 'profile="https://agentpey.com/ucp/platform/agentpey.json"; version="2099-01-01"' });
      expect(res.status).toBe(422);
      expect(ucpErrors(ERROR_SCHEMA, res.body)).toEqual([]);
      expect(res.body.messages).toEqual([expect.objectContaining({ code: "version_unsupported", severity: "unrecoverable" })]);
    }
    const served = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), { "UCP-Agent": 'profile="https://agentpey.com/ucp/platform/agentpey.json"; version="2026-04-08"' });
    expect(served.status).toBe(201);
  });

  it("says a product does not exist in words a platform can match", async () => {
    const { status, body } = await h.create(ready("no-such-product"));
    expect(status).toBe(400);
    expect(body.messages).toEqual([expect.objectContaining({ code: "item_unavailable", content: expect.stringContaining("not found") })]);
  });

  it("describes the order's shipping with the option the checkout offered", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const { body: done } = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    const order = await h.call("GET", `/orders/${done.order?.id}`);
    expect(ucpErrors(ORDER_SCHEMA, order.body)).toEqual([]);
    expect(order.body["fulfillment"]).toEqual({ expectations: [expect.objectContaining({ description: "Envío coordinado por la tienda" })] });
  });

  it("create: the same key and body answer the same session; the same key with another body is a 409 and creates nothing", async () => {
    const first = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), key("create-1"));
    const again = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), key("create-1"));
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    const other = await h.call("POST", "/checkout-sessions", ready("polera-valpo-l"), key("create-1"));
    expect(other.status).toBe(409);
    expect(other.body.messages).toEqual([expect.objectContaining({ code: "idempotency_conflict" })]);
    // Without a key, every create is a new session, as before.
    const a = await h.create(ready("gorro-andes"));
    const b = await h.create(ready("gorro-andes"));
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("update: the same key and body answer the same; another body under that key is a 409 and changes nothing", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const first = await h.call("PUT", `/checkout-sessions/${created.id}`, ready("gorro-andes", 2), key("update-1"));
    const again = await h.call("PUT", `/checkout-sessions/${created.id}`, ready("gorro-andes", 2), key("update-1"));
    expect(again.body).toEqual(first.body);
    const other = await h.call("PUT", `/checkout-sessions/${created.id}`, ready("gorro-andes", 3), key("update-1"));
    expect(other.status).toBe(409);
    const read = await h.call("GET", `/checkout-sessions/${created.id}`);
    expect(read.body.totals.find((t) => t.type === "total")?.amount).toBe(2 * 12990);
  });

  it("complete: a retry with the same key answers the same and settles once; another body under that key is a 409", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const pay = instrument(requirementsOf(created));
    const before = h.facilitator.settleCalls.length;
    const first = await h.call("POST", `/checkout-sessions/${created.id}/complete`, pay, key("complete-1"));
    const again = await h.call("POST", `/checkout-sessions/${created.id}/complete`, pay, key("complete-1"));
    expect(first.body.status).toBe("completed");
    expect(again.body).toEqual(first.body);
    expect(h.facilitator.settleCalls).toHaveLength(before + 1);
    const other = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)), key("complete-1"));
    expect(other.status).toBe(409);
    expect(h.facilitator.settleCalls).toHaveLength(before + 1);
  });

  it("keeps each platform's keys apart: the same key from another profile is a new request, not a conflict", async () => {
    const other = { "UCP-Agent": 'profile="https://other.example/ucp/profile.json"' };
    const first = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), key("shared-key"));
    const second = await h.call("POST", "/checkout-sessions", ready("polera-valpo-l"), { ...key("shared-key"), ...other });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it("complete: a recoverable answer is not replayed; the same key retried after the cause passed completes for real", async () => {
    const refusing = harness({ facilitator: fakeFacilitator({ settle: { success: false, errorReason: "insufficient_funds", transaction: "" } }) });
    await refusing.start();
    try {
      const { body: created } = await refusing.create(ready("gorro-andes"));
      const pay = instrument(requirementsOf(created));
      const refused = await refusing.call("POST", `/checkout-sessions/${created.id}/complete`, pay, key("complete-retry"));
      expect(refused.body.status).not.toBe("completed");
      expect(refused.body.messages).toEqual([expect.objectContaining({ code: "payment_failed" })]);
      // The cause passes: the facilitator settles now.
      refusing.facilitator.settle = fakeFacilitator().settle;
      const again = await refusing.call("POST", `/checkout-sessions/${created.id}/complete`, pay, key("complete-retry"));
      expect(again.body.status).toBe("completed");
    } finally {
      await refusing.stop();
    }
  });

  it("complete: a completed checkout refuses a new key with 409 and never settles again; without a key it reads back as before", async () => {
    const { body: created } = await h.create(ready("gorro-andes"));
    const first = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)), key("complete-2"));
    expect(first.body.status).toBe("completed");
    const settled = h.facilitator.settleCalls.length;
    const fresh = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)), key("complete-3"));
    expect(fresh.status).toBe(409);
    expect(fresh.body.messages).toEqual([expect.objectContaining({ code: "invalid_state" })]);
    const keyless = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)));
    expect(keyless.body.status).toBe("completed");
    expect(keyless.body.order?.id).toBe(first.body.order?.id);
    expect(h.facilitator.settleCalls).toHaveLength(settled);
  });
});

describe("UCP 2026-08-25 next to 2026-04-08 (T133, R-6, R-14)", () => {
  const NEW = "https://platform.example/ucp/profile-2026-08-25.json";
  const FUTURE = "https://platform.example/ucp/profile-2099.json";
  const profiles = fakePlatformProfiles({ [AGENTPEY_PLATFORM_PROFILE]: "2026-04-08", [NEW]: "2026-08-25", [FUTURE]: "2099-01-01" });
  const h = harness({ profiles });
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  const as = (profile: string) => ({ "UCP-Agent": `profile="${profile}"` });

  it("a platform whose profile says 2026-08-25 gets a checkout and an order in 2026-08-25, valid against that version's schemas", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(NEW));
    expect(created.status).toBe("ready_for_complete");
    expect((created as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-08-25");
    expect(ucpErrors(UCP_SCHEMA_2026_08_25.checkout, created, "2026-08-25")).toEqual([]);
    const done = await h.call("POST", `/checkout-sessions/${created.id}/complete`, instrument(requirementsOf(created)), as(NEW));
    expect(done.body.status).toBe("completed");
    expect(ucpErrors(UCP_SCHEMA_2026_08_25.checkout, done.body, "2026-08-25")).toEqual([]);
    const order = await h.call("GET", `/orders/${done.body.order?.id}`, undefined, as(NEW));
    expect(ucpErrors(UCP_SCHEMA_2026_08_25.order, order.body, "2026-08-25")).toEqual([]);
    expect((order.body as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-08-25");
  });

  it("is checked for real: a 2026-08-25 checkout without the destination's kind fails that version's schema (negative control)", async () => {
    const { body } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(NEW));
    const broken = structuredClone(body) as unknown as { fulfillment: { methods: Array<{ destinations: Array<Record<string, unknown>> }> } };
    delete broken.fulfillment.methods[0]!.destinations[0]!["type"];
    expect(ucpErrors(UCP_SCHEMA_2026_08_25.checkout, broken, "2026-08-25")).not.toEqual([]);
  });

  it("names the destination's kind in 2026-08-25 and not in 2026-04-08", async () => {
    const fresh = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(NEW));
    const old = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AGENTPEY_PLATFORM_PROFILE));
    const destinationOf = (body: unknown) => (body as { fulfillment: { methods: Array<{ destinations: Array<Record<string, unknown>> }> } }).fulfillment.methods[0]?.destinations[0];
    expect(destinationOf(fresh.body)).toMatchObject({ type: "shipping_address", address_country: "CL" });
    expect(destinationOf(old.body)).not.toHaveProperty("type");
    expect(ucpErrors(CHECKOUT_SCHEMA, old.body)).toEqual([]);
  });

  it("the same session reads back in the version each platform speaks", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(NEW));
    const asOld = await h.call("GET", `/checkout-sessions/${created.id}`, undefined, as(AGENTPEY_PLATFORM_PROFILE));
    expect((asOld.body as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-04-08");
    expect(ucpErrors(CHECKOUT_SCHEMA, asOld.body)).toEqual([]);
  });

  it("a platform that cannot be read, or sends no UCP-Agent, gets 2026-08-25", async () => {
    const unknown = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as("https://nobody.example/profile.json"));
    expect((unknown.body as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-08-25");
    const res = await fetch(`${h.url()}${UCP_REST_PREFIX}/checkout-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ready("gorro-andes")) });
    expect(((await res.json()) as { ucp: { version: string } }).ucp.version).toBe("2026-08-25");
  });

  it("a platform whose profile declares a version this store does not serve gets 422 version_unsupported, and nothing is created", async () => {
    const res = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(FUTURE));
    expect(res.status).toBe(422);
    expect(res.body.messages).toEqual([expect.objectContaining({ code: "version_unsupported" })]);
    expect(ucpErrors(UCP_SCHEMA_2026_08_25.errorResponse, res.body, "2026-08-25")).toEqual([]);
  });

  it("an Idempotency-Key never replays an answer in a version the request did not negotiate", async () => {
    const first = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), { ...as(NEW), "Idempotency-Key": "versioned-1" });
    expect((first.body as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-08-25");
    const other = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), { "UCP-Agent": `profile="${NEW}"; version="2026-04-08"`, "Idempotency-Key": "versioned-1" });
    expect(other.status).toBe(201);
    expect((other.body as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-04-08");
    const again = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), { ...as(NEW), "Idempotency-Key": "versioned-1" });
    expect(again.body).toEqual(first.body);
  });

  it("an explicit version parameter on UCP-Agent wins over the profile (the conformance suite sends one)", async () => {
    const res = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), { "UCP-Agent": `profile="${NEW}"; version="2026-04-08"` });
    expect((res.body as unknown as { ucp: { version: string } }).ucp.version).toBe("2026-04-08");
  });
});


describe("AP2 in the UCP checkout, the store's side (T134, R-15)", () => {
  type P256 = { signer: Ap2Signer; public: { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string } };
  const p256 = async (kid: string): Promise<P256> => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pub = (await exportJWK(publicKey)) as { x: string; y: string };
    return { signer: { alg: "ES256", privateJwk: await exportJWK(privateKey), kid }, public: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, kid } };
  };
  const AP2_PLATFORM = "https://platform.example/ucp/agentpey-ap2.json";
  const NO_KEYS = "https://platform.example/ucp/ap2-without-keys.json";
  const PLAIN_0825 = "https://platform.example/ucp/plain-2026-08-25.json";
  let platform: P256;
  let agent: P256;
  let stranger: P256;
  const profiles = { read: async () => ({ ok: false as const, reason: "unreachable" as const }) } as PlatformProfileReader;
  const h = harness({ profiles });
  const as = (profile: string) => ({ "UCP-Agent": `profile="${profile}"` });

  beforeAll(async () => {
    [platform, agent, stranger] = await Promise.all([p256("agentpey#ap2"), p256("agent#ap2"), p256("stranger#ap2")]);
    const table = fakePlatformProfiles({
      [AP2_PLATFORM]: { ucp: { version: "2026-08-25", capabilities: ["dev.ucp.shopping.checkout", "dev.ucp.common.payment.ap2_mandate"] }, keys: [platform.public] },
      [NO_KEYS]: { ucp: { version: "2026-08-25", capabilities: ["dev.ucp.shopping.checkout", "dev.ucp.common.payment.ap2_mandate"] }, keys: [] },
      [PLAIN_0825]: "2026-08-25",
    });
    profiles.read = table.read;
    await h.start();
  });
  afterAll(() => h.stop());

  const storeKey = async () => {
    const profile = (await (await fetch(`${h.url()}/.well-known/ucp`)).json()) as { keys: Array<{ kid: string; kty: string; crv?: string; x: string; y?: string }> };
    const key = profile.keys.find((k) => k.kid.endsWith("#ap2-p256"));
    if (key === undefined || key.y === undefined) throw new TypeError("the profile publishes no AP2 key");
    return { kty: "EC" as const, crv: "P-256" as const, x: key.x, y: key.y, kid: key.kid };
  };

  /** What AgentPey's agent does: an open mandate the platform signs in its own name, closed over the signed checkout. */
  const mandateFor = async (
    checkout: Record<string, unknown>,
    o: { issuer?: P256; iss?: string; holder?: P256; nonce?: string; aud?: string; quantity?: number; expiresAt?: Date; hopIssuedAt?: Date; checkoutJwt?: string; open?: string } = {},
  ) => {
    const origin = new URL(h.url()).origin;
    const open = o.open ?? (
      await issueOpenMandatePair(
        {
          issuer: o.iss ?? new URL(AP2_PLATFORM).origin,
          source: { mandate_id: crypto.randomUUID(), hash: "a".repeat(64), registry: "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F" },
          agentKey: agent.public,
          merchant: { id: origin, name: "Bazar Cordillera", website: origin },
          item: { id: "gorro-andes", title: "Gorro Andes" },
          quantity: o.quantity ?? 1,
          maxAmount: 300n,
          currency: "USD",
          paymentInstrument: { id: "stellar_x402", type: "stellar_x402" },
          issuedAt: new Date(h.clock.now.getTime() - 60_000),
          expiresAt: o.expiresAt ?? new Date(h.clock.now.getTime() + 15 * 60_000),
        },
        (o.issuer ?? platform).signer,
      )
    ).checkout;
    return closeCheckoutMandate({ open, holder: (o.holder ?? agent).signer, checkoutJwt: o.checkoutJwt ?? checkoutJwtFrom(checkout), aud: o.aud ?? origin, nonce: o.nonce ?? String(checkout.id), issuedAt: o.hopIssuedAt ?? h.clock.now });
  };
  /** An open mandate with a constraint type no verifier here knows (AP2: it must fail). */
  const openWithUnknownConstraint = async () => {
    const origin = new URL(h.url()).origin;
    const disclosures: string[] = [];
    const iat = Math.floor(h.clock.now.getTime() / 1000) - 60;
    const mandate = {
      vct: "mandate.checkout.open.1",
      constraints: [
        { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [{ id: "gorro-andes", title: "Gorro Andes" }], quantity: 1 }] },
        { type: "checkout.allowed_merchants", allowed: [{ id: origin, name: "Bazar Cordillera", website: origin }] },
        { type: "checkout.price_cap", max: 1 },
      ],
      cnf: { jwk: agent.public },
      iat,
      exp: iat + 15 * 60,
    };
    return issueSdJwt({ iss: new URL(AP2_PLATFORM).origin, iat, delegate_payload: disclosableArray([mandate], disclosures) }, disclosures, platform.signer);
  };
  const completeWith = (created: Checkout, mandate: string | undefined, profile = AP2_PLATFORM) =>
    h.call("POST", `/checkout-sessions/${created.id}/complete`, { ...instrument(requirementsOf(created)), ...(mandate === undefined ? {} : { ap2: { checkout_mandate: mandate } }) }, as(profile));

  it("with AP2 negotiated, signs every checkout response, names itself by its origin, and the signature checks against its published key", async () => {
    const created = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const body = created.body as unknown as Record<string, unknown> & { ucp: { capabilities: Record<string, unknown> } };
    expect(body.ucp.capabilities["dev.ucp.common.payment.ap2_mandate"]).toEqual([{ version: "2026-08-25" }]);
    expect(body["merchant"]).toEqual({ id: new URL(h.url()).origin, name: expect.any(String), website: new URL(h.url()).origin });
    expect(ucpErrors("https://ucp.dev/schemas/common/payment_ap2_mandate.json#/$defs/dev.ucp.shopping.checkout", body, "2026-08-25")).toEqual([]);
    await expect(verifyMerchantAuthorization(body, await storeKey())).resolves.toBeUndefined();
    const read = await h.call("GET", `/checkout-sessions/${created.body.id}`, undefined, as(AP2_PLATFORM));
    await expect(verifyMerchantAuthorization(read.body as unknown as Record<string, unknown>, await storeKey())).resolves.toBeUndefined();
  });

  it("refuses to complete without a mandate (mandate_required), and charges nothing", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const before = h.facilitator.settleCalls.length;
    const done = await completeWith(created, undefined);
    expect(done.body.status).not.toBe("completed");
    expect(done.body.messages).toEqual([expect.objectContaining({ code: "mandate_required" })]);
    expect(h.facilitator.settleCalls).toHaveLength(before);
  });

  it("completes with a valid closed mandate, settling once", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const before = h.facilitator.settleCalls.length;
    const done = await completeWith(created, await mandateFor(created as unknown as Record<string, unknown>));
    expect(done.body.messages).toEqual([]);
    expect(done.body.status).toBe("completed");
    expect(h.facilitator.settleCalls).toHaveLength(before + 1);
    await expect(verifyMerchantAuthorization(done.body as unknown as Record<string, unknown>, await storeKey())).resolves.toBeUndefined();
  });

  it.each([
    ["an open mandate the platform did not sign", { issuer: "stranger" }, "mandate_invalid_signature"],
    ["a hop the bound agent did not sign", { holder: "stranger" }, "mandate_invalid_signature"],
    ["an expired open mandate", { expired: true }, "mandate_expired"],
    ["a mandate closed for another checkout", { nonce: "cs_other" }, "mandate_scope_mismatch"],
    ["an open mandate for another quantity", { quantity: 2 }, "mandate_scope_mismatch"],
    ["a checkout this store never signed", { forged: true }, "merchant_authorization_invalid"],
    ["a mandate closed for another store", { aud: "https://other-store.example" }, "mandate_invalid_signature"],
    ["a closing hop signed long ago", { stale: true }, "mandate_expired"],
    ["an open mandate signed in another platform's name", { iss: "https://agentpey.com" }, "mandate_invalid_signature"],
    ["an open mandate with a constraint type it does not know", { unknown: true }, "mandate_scope_mismatch"],
  ] as const)("refuses %s (%s → %s), and charges nothing", async (_label, o, code) => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const checkout = created as unknown as Record<string, unknown>;
    const before = h.facilitator.settleCalls.length;
    const forged = "forged" in o ? checkoutJwtFrom({ ...checkout, totals: [{ type: "total", amount: 1 }] }) : undefined;
    const mandate = await mandateFor(checkout, {
      ...("issuer" in o ? { issuer: stranger } : {}),
      ...("holder" in o ? { holder: stranger } : {}),
      ...("expired" in o ? { expiresAt: new Date(h.clock.now.getTime() - 1_000) } : {}),
      ...("nonce" in o ? { nonce: o.nonce } : {}),
      ...("quantity" in o ? { quantity: o.quantity } : {}),
      ...(forged === undefined ? {} : { checkoutJwt: forged }),
      ...("aud" in o ? { aud: o.aud } : {}),
      ...("stale" in o ? { hopIssuedAt: new Date(h.clock.now.getTime() - 10 * 60_000) } : {}),
      ...("iss" in o ? { iss: o.iss } : {}),
      ...("unknown" in o ? { open: await openWithUnknownConstraint() } : {}),
    });
    const done = await completeWith(created, mandate);
    expect(done.body.status).not.toBe("completed");
    expect(done.body.messages).toEqual([expect.objectContaining({ code })]);
    expect(h.facilitator.settleCalls).toHaveLength(before);
  });

  it("refuses a mandate from a platform whose profile publishes no key (agent_missing_key)", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(NO_KEYS));
    const done = await completeWith(created, await mandateFor(created as unknown as Record<string, unknown>), NO_KEYS);
    expect(done.body.messages).toEqual([expect.objectContaining({ code: "agent_missing_key" })]);
  });

  it("refuses a mandate over terms that changed since (mandate_scope_mismatch)", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const mandate = await mandateFor(created as unknown as Record<string, unknown>);
    const { body: updated } = await h.call("PUT", `/checkout-sessions/${created.id}`, ready("gorro-andes", 2), as(AP2_PLATFORM));
    const done = await completeWith(updated, mandate);
    expect(done.body.messages).toEqual([expect.objectContaining({ code: "mandate_scope_mismatch" })]);
  });

  it("refuses a mandate larger than it reads, and charges nothing", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const before = h.facilitator.settleCalls.length;
    const done = await completeWith(created, "a".repeat(32_001));
    expect(done.body.messages).toEqual([expect.objectContaining({ code: "mandate_invalid_signature" })]);
    expect(h.facilitator.settleCalls).toHaveLength(before);
  });

  it("refuses a mandate after the destination changed, though the total did not (mandate_scope_mismatch)", async () => {
    const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
    const mandate = await mandateFor(created as unknown as Record<string, unknown>);
    const elsewhere = { ...ready("gorro-andes"), fulfillment: { methods: [{ type: "shipping", destinations: [{ ...DESTINATION, street_address: "Calle Falsa 123" }] }] } };
    const { body: updated } = await h.call("PUT", `/checkout-sessions/${created.id}`, elsewhere, as(AP2_PLATFORM));
    expect(updated.totals).toEqual(created.totals);
    const before = h.facilitator.settleCalls.length;
    const done = await completeWith(updated, mandate);
    expect(done.body.messages).toEqual([expect.objectContaining({ code: "mandate_scope_mismatch" })]);
    expect(h.facilitator.settleCalls).toHaveLength(before);
  });

  describe("the lock is the session's, not the request's (UCP: neither party may revert)", () => {
    const UNREACHABLE = "https://platform.example/ucp/down.json";
    it.each([
      ["a profile that does not declare AP2", as(PLAIN_0825)],
      ["a version in the header, so no profile is read", { "UCP-Agent": `profile="${AP2_PLATFORM}"; version="2026-08-25"` }],
      ["a profile that cannot be read right now", as(UNREACHABLE)],
      ["an empty UCP-Agent", { "UCP-Agent": "" }],
    ] as const)("a checkout created with AP2 is not completed through %s, with or without a mandate", async (_label, headers) => {
      const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
      const mandate = await mandateFor(created as unknown as Record<string, unknown>);
      const before = h.facilitator.settleCalls.length;
      for (const body of [instrument(requirementsOf(created)), { ...instrument(requirementsOf(created)), ap2: { checkout_mandate: mandate } }]) {
        const done = await h.call("POST", `/checkout-sessions/${created.id}/complete`, body, headers);
        expect(done.body.status).not.toBe("completed");
        expect(done.body.messages).toEqual([expect.objectContaining({ code: expect.stringMatching(/^(mandate_required|agent_missing_key|mandate_invalid_signature)$/) })]);
      }
      expect(h.facilitator.settleCalls).toHaveLength(before);
    });

    it("keeps signing a locked checkout for a request that did not negotiate AP2, and keeps the mandate it charged under", async () => {
      const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(AP2_PLATFORM));
      const read = await h.call("GET", `/checkout-sessions/${created.id}`, undefined, as(PLAIN_0825));
      await expect(verifyMerchantAuthorization(read.body as unknown as Record<string, unknown>, await storeKey())).resolves.toBeUndefined();
      const mandate = await mandateFor(created as unknown as Record<string, unknown>);
      const done = await completeWith(created, mandate);
      expect(done.body.status).toBe("completed");
      expect((await h.sessions.get(String(created.id)))?.ap2).toEqual({ platformProfile: AP2_PLATFORM, mandate });
    });
  });

  it("without AP2 negotiated, nothing changes: no ap2 field, no merchant, and complete needs no mandate", async () => {
    for (const profile of [PLAIN_0825, AGENTPEY_PLATFORM_PROFILE]) {
      const { body: created } = await h.call("POST", "/checkout-sessions", ready("gorro-andes"), as(profile));
      expect(created).not.toHaveProperty("ap2");
      expect(created).not.toHaveProperty("merchant");
      const done = await completeWith(created, undefined, profile);
      expect(done.body.status).toBe("completed");
    }
  });
});
