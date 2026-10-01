import { readFileSync } from "node:fs";

import { MockStoreAdapter, type MOCK_CATALOG } from "@vitrinee/adapters";
import { STELLAR_X402_HANDLER, UCP_REST_PREFIX, USDC_TESTNET } from "@vitrinee/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { FAKE_PAYER, FAKE_TX_HASH, fakeFacilitator, type FakeFacilitator } from "../test/fake-facilitator.js";
import { MERCHANT, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { addSchema, ucpErrors } from "../test/ucp-schemas.js";
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

function harness(options: { facilitator?: FakeFacilitator; catalog?: typeof MOCK_CATALOG } = {}) {
  const clock = { now: new Date("2026-09-30T12:00:00.000Z") };
  const facilitator = options.facilitator ?? fakeFacilitator();
  const registry = fakeRegistry();
  const adapter = new MockStoreAdapter(options.catalog === undefined ? {} : { catalog: options.catalog });
  const app = createApp({
    config: testConfig(),
    adapter,
    facilitator,
    anchorer: registry.anchorer,
    registry: registry.registry,
    sessions: new MemoryCheckoutSessions(),
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
    call,
    create: (body: unknown) => call("POST", "/checkout-sessions", body),
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
    expect(order.body["receipt"]).toMatchObject({ settlement_tx_hash: FAKE_TX_HASH });
    expect(order.body["fulfillment"]).toMatchObject({ expectations: [{ method_type: "shipping", destination: { street_address: "Av. Providencia 1234", address_locality: "Santiago", address_country: "CL" } }] });

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
    expect(again.body.status).toBe("completed");
    expect(again.body.order?.id).toBe(first.body.order?.id);
    expect(h.facilitator.settleCalls).toHaveLength(settled);
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
