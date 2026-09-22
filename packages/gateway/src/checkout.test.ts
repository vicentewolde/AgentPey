import { MockStoreAdapter, type StoreAdapter } from "@vitrinee/adapters";
import { USDC_TESTNET, VitrineeError } from "@vitrinee/core";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { OrderStore } from "./orders.js";
import { FAKE_PAYER, FAKE_TX_HASH, fakeFacilitator } from "./test/fake-facilitator.js";
import { listen } from "./test/listen.js";

const MERCHANT = USDC_TESTNET.issuer;
const JSON_HEADERS = { "content-type": "application/json" };

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
}

/** What a real x402 client does with a 402: echo the accepted terms with its signed payload. */
async function payFor(challenge: Response): Promise<Record<string, string>> {
  const header = challenge.headers.get("payment-required");
  if (header === null) throw new Error("no PAYMENT-REQUIRED header");
  const required = decodePaymentRequiredHeader(header);
  const accepted = required.accepts[0]!;
  return {
    "payment-signature": encodePaymentSignatureHeader({
      x402Version: required.x402Version,
      resource: required.resource,
      accepted,
      payload: { transaction: Buffer.from(`fake-tx-${Date.now()}-${Math.random()}`).toString("base64") },
    }),
  };
}

describe("POST /checkout/:productId", () => {
  const config = loadConfig({ MERCHANT_STELLAR_ACCOUNT: MERCHANT, FX_RATE_CLP_USD: "950" });
  const adapter = new MockStoreAdapter();
  const facilitator = fakeFacilitator();
  const orders = new OrderStore();
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const app = createApp({
    config,
    adapter,
    facilitator,
    orders,
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    log: (message, fields) => logs.push({ message, fields }),
  });
  let url = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    ({ url, close } = await listen(app));
  });
  afterAll(() => close());

  it("refuses bad input, unknown products and missing stock before asking for money", async () => {
    const bad = await post(`${url}/checkout/hoodie-cordillera-m`, { quantity: 0 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "ValidationError" });

    const missing = await post(`${url}/checkout/does-not-exist`, {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "ProductNotFound" });

    const tooMany = await post(`${url}/checkout/botella-patagonia-500`, { quantity: 3 });
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toMatchObject({ error: "OutOfStock", details: { available: 2, requested: 3 } });

    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("answers 402 with the exact USDC amount for the quantity, upfront flow, and a Spanish quote", async () => {
    const one = await post(`${url}/checkout/hoodie-cordillera-m`, {});
    expect(one.status).toBe(402);
    const required = decodePaymentRequiredHeader(one.headers.get("payment-required")!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      asset: USDC_TESTNET.contractId,
      amount: "368315789",
      payTo: MERCHANT,
      maxTimeoutSeconds: 300,
      extra: { paymentFlow: "upfront", areFeesSponsored: true },
    });
    expect(required.resource.url).toBe(`${url}/checkout/hoodie-cordillera-m`);
    const body = (await one.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "PaymentRequired",
      quote: { name: "Hoodie Cordillera talla M", quantity: 1, amountUSDC: "36.8315789", amountUSDCAtomic: "368315789", totalLocal: "34990" },
    });
    expect(String(body["message"])).toMatch(/Pago requerido/);

    const two = await post(`${url}/checkout/hoodie-cordillera-m`, { quantity: 2 });
    const requiredTwo = decodePaymentRequiredHeader(two.headers.get("payment-required")!);
    expect(requiredTwo.accepts[0]!.amount).toBe("736631578");
  });

  it("settles before the handler, then creates the platform order and records the sale", async () => {
    const productBefore = (await adapter.getProduct("hoodie-cordillera-m"))!;
    const body = { quantity: 1, buyer: { email: "agente@example.com", shipping: { city: "Ñuñoa", country: "CL" } } };
    const challenge = await post(`${url}/checkout/hoodie-cordillera-m`, body);
    expect(challenge.status).toBe(402);

    const paid = await post(`${url}/checkout/hoodie-cordillera-m`, body, await payFor(challenge));
    expect(paid.status).toBe(200);
    const order = (await paid.json()) as Record<string, unknown>;
    expect(order).toMatchObject({
      status: "paid",
      platform: "mock",
      platformOrderId: "mock-0001",
      quantity: 1,
      amountUSDC: "36.8315789",
      amountUSDCAtomic: "368315789",
      totalLocal: "34990",
      currency: "CLP",
      product: { id: "hoodie-cordillera-m", sku: "HOOD-CORD-M" },
      settlement: {
        txHash: FAKE_TX_HASH,
        payer: FAKE_PAYER,
        payTo: MERCHANT,
        asset: USDC_TESTNET.contractId,
        amountAtomic: "368315789",
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${FAKE_TX_HASH}`,
      },
      receipt: null,
      anchor: null,
    });
    expect(String(order["orderId"])).toMatch(/^ord_[a-z0-9]+$/);

    // The SDK echoes the upfront settlement to the client.
    const echoed = decodePaymentResponseHeader(paid.headers.get("payment-response")!);
    expect(echoed).toMatchObject({ success: true, transaction: FAKE_TX_HASH });

    // Upfront flow: the SDK establishes validity through settle alone; verify is not called.
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.settleCalls[0]!.requirements.amount).toBe("368315789");

    // Platform side: order exists, stock went down, buyer is the on-chain payer.
    const platformOrder = await adapter.getOrder("mock-0001");
    expect(platformOrder).toMatchObject({
      status: "paid",
      reference: order["orderId"],
      buyer: { stellarAccount: FAKE_PAYER, email: "agente@example.com", shipping: { city: "Ñuñoa" } },
      paymentRef: { txHash: FAKE_TX_HASH, amountUSDCAtomic: "368315789" },
    });
    expect((await adapter.getProduct("hoodie-cordillera-m"))!.stock).toBe(productBefore.stock! - 1);

    // Gateway side: the record is readable back and listed.
    const fetched = await fetch(`${url}/orders/${String(order["orderId"])}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(order);
    const listed = (await (await fetch(`${url}/orders`)).json()) as { orders: unknown[] };
    expect(listed.orders).toHaveLength(1);
    expect(logs.some((l) => l.message === "checkout completed")).toBe(true);
  });

  it("never fails the request once money moved: a platform error is recorded as paid_unfulfilled", async () => {
    const broken: StoreAdapter = {
      name: "broken",
      listProducts: () => adapter.listProducts(),
      getProduct: (id) => adapter.getProduct(id),
      getOrder: () => Promise.resolve(null),
      createOrder: () => Promise.reject(new VitrineeError("AdapterError", "Jumpseller returned 503")),
    };
    const store = new OrderStore();
    const { url: brokenUrl, close: closeBroken } = await listen(
      createApp({ config, adapter: broken, facilitator: fakeFacilitator(), orders: store }),
    );
    try {
      const challenge = await post(`${brokenUrl}/checkout/gorro-andes`, {});
      const paid = await post(`${brokenUrl}/checkout/gorro-andes`, {}, await payFor(challenge));
      expect(paid.status).toBe(200);
      const order = (await paid.json()) as Record<string, unknown>;
      expect(order).toMatchObject({ status: "paid_unfulfilled", platformOrderId: null, platformError: "Jumpseller returned 503" });
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.settlement.txHash).toBe(FAKE_TX_HASH);
    } finally {
      await closeBroken();
    }
  });

  it("does not create an order when the facilitator refuses the payment", async () => {
    const refusing = fakeFacilitator({
      settle: { success: false, errorReason: "insufficient_funds", errorMessage: "sin saldo", transaction: "" },
    });
    const store = new OrderStore();
    const { url: refusingUrl, close: closeRefusing } = await listen(
      createApp({ config, adapter: new MockStoreAdapter(), facilitator: refusing, orders: store }),
    );
    try {
      const challenge = await post(`${refusingUrl}/checkout/gorro-andes`, {});
      const refused = await post(`${refusingUrl}/checkout/gorro-andes`, {}, await payFor(challenge));
      expect(refused.status).toBe(402);
      expect(refusing.settleCalls).toHaveLength(1);
      expect(store.list()).toHaveLength(0);
      expect(await adapter.getOrder("mock-0002")).toBeNull();
    } finally {
      await closeRefusing();
    }
  });
});
