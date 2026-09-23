import { MockStoreAdapter, type StoreAdapter } from "@vitrinee/adapters";
import { USDC_TESTNET, VitrineeError, checkReceiptSignature, receiptHash } from "@vitrinee/core";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, type AppDeps, type VitrineeApp } from "./app.js";
import { OrderStore } from "./orders.js";
import { FAKE_PAYER, FAKE_TX_HASH, fakeFacilitator } from "./test/fake-facilitator.js";
import { MERCHANT, REGISTRY_ID, SIGNER, fakeHorizon, fakeRegistry, testConfig } from "./test/fixtures.js";
import { listen } from "./test/listen.js";

const JSON_HEADERS = { "content-type": "application/json" };

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
}

/** What a real x402 client does with a 402: echo the accepted terms with its signed payload. */
async function payFor(challenge: Response): Promise<Record<string, string>> {
  const header = challenge.headers.get("payment-required");
  if (header === null) throw new Error(`no PAYMENT-REQUIRED header (status ${challenge.status})`);
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

async function buy(url: string, path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  const challenge = await post(`${url}${path}`, body, headers);
  return post(`${url}${path}`, body, { ...headers, ...(await payFor(challenge)) });
}

async function start(overrides: Partial<AppDeps> = {}) {
  const registry = fakeRegistry();
  const horizon = fakeHorizon() as typeof fetch & { allow(amount: string): void };
  const deps: AppDeps = {
    config: testConfig(),
    adapter: new MockStoreAdapter(),
    facilitator: fakeFacilitator(),
    orders: new OrderStore(),
    anchorer: registry.anchorer,
    registry: registry.registry,
    horizonFetch: horizon,
    anchorRetryDelaysMs: [5, 5],
    ...overrides,
  };
  const app = createApp(deps) as VitrineeApp;
  const server = await listen(app);
  return { ...server, app, deps, registry, horizon };
}

describe("POST /checkout/:productId — payment and order", () => {
  const facilitator = fakeFacilitator();
  const adapter = new MockStoreAdapter();
  let env: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    env = await start({ facilitator, adapter, now: () => new Date("2026-09-23T12:00:00.000Z") });
  });
  afterAll(() => env.close());

  it("refuses bad input, unknown products and missing stock before asking for money", async () => {
    const bad = await post(`${env.url}/checkout/hoodie-cordillera-m`, { quantity: 0 });
    expect(bad.status).toBe(400);
    const missing = await post(`${env.url}/checkout/does-not-exist`, {});
    expect(missing.status).toBe(404);
    const tooMany = await post(`${env.url}/checkout/botella-patagonia-500`, { quantity: 3 });
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toMatchObject({ error: "OutOfStock", details: { available: 2, requested: 3 } });
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("answers 402 with the exact USDC amount for the quantity, upfront flow, and a Spanish quote", async () => {
    const one = await post(`${env.url}/checkout/hoodie-cordillera-m`, {});
    expect(one.status).toBe(402);
    const required = decodePaymentRequiredHeader(one.headers.get("payment-required")!);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      asset: USDC_TESTNET.contractId,
      amount: "368315789",
      payTo: MERCHANT,
      maxTimeoutSeconds: 300,
      extra: { paymentFlow: "upfront", areFeesSponsored: true },
    });
    expect(await one.json()).toMatchObject({ error: "PaymentRequired", quote: { amountUSDC: "36.8315789", totalLocal: "34990" } });
    const two = await post(`${env.url}/checkout/hoodie-cordillera-m`, { quantity: 2 });
    expect(decodePaymentRequiredHeader(two.headers.get("payment-required")!).accepts[0]!.amount).toBe("736631578");
  });

  it("settles, creates the platform order, signs a receipt and anchors it", async () => {
    const before = (await adapter.getProduct("hoodie-cordillera-m"))!.stock!;
    const body = { quantity: 1, buyer: { email: "agente@example.com", shipping: { city: "Ñuñoa", country: "CL" } } };
    const paid = await buy(env.url, "/checkout/hoodie-cordillera-m", body);
    expect(paid.status).toBe(200);
    const order = (await paid.json()) as Record<string, any>;
    expect(order).toMatchObject({
      status: "paid",
      platform: "mock",
      platformOrderId: "mock-0001",
      amountUSDC: "36.8315789",
      settlement: { txHash: FAKE_TX_HASH, payer: FAKE_PAYER, payTo: MERCHANT, amountAtomic: "368315789" },
      anchor: { status: "pending", attempts: 0, registry: REGISTRY_ID },
    });
    expect(decodePaymentResponseHeader(paid.headers.get("payment-response")!)).toMatchObject({ success: true, transaction: FAKE_TX_HASH });
    expect(facilitator.settleCalls).toHaveLength(1);
    expect((await adapter.getProduct("hoodie-cordillera-m"))!.stock).toBe(before - 1);

    // The receipt: signed by the signing key, naming payTo and the on-chain payer.
    const { jws, hash, verifyPath } = order["receipt"] as { jws: string; hash: string; verifyPath: string };
    expect(hash).toBe(receiptHash(jws));
    expect(verifyPath).toBe(`/receipts/${hash}/verify`);
    const signature = checkReceiptSignature(jws);
    expect(signature).toMatchObject({ ok: true, signer: SIGNER.publicKey() });
    expect(signature.claims).toMatchObject({
      orderId: order["orderId"],
      platformOrderId: "mock-0001",
      merchantAccount: MERCHANT,
      payerAccount: FAKE_PAYER,
      amountUSDCAtomic: "368315789",
      settlementTxHash: FAKE_TX_HASH,
      items: [{ productId: "hoodie-cordillera-m", quantity: 1, unitPriceUSDCAtomic: "368315789" }],
      issuedAt: "2026-09-23T12:00:00.000Z",
      refundWindowEndsAt: "2026-10-03T12:00:00.000Z",
    });

    // The anchor lands after the response.
    await env.app.anchors.idle();
    expect(env.registry.calls).toEqual([{ hash, amount: 368315789n, orderRef: order["orderId"] }]);
    const later = (await (await fetch(`${env.url}/orders/${order["orderId"]}`)).json()) as Record<string, any>;
    expect(later["anchor"]).toMatchObject({ status: "anchored", attempts: 1, ledger: 4_900_001, registry: REGISTRY_ID });
    expect(later["anchor"]["explorerUrl"]).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\//);
  });

  it("verifies a receipt it issued: three green checks; and an edited copy: red", async () => {
    const [order] = ((await (await fetch(`${env.url}/orders`)).json()) as { orders: Array<Record<string, any>> }).orders;
    const { jws, hash } = order!["receipt"] as { jws: string; hash: string };
    env.horizon.allow("36.8315789");

    const good = (await (await fetch(`${env.url}/receipts/${hash}/verify`)).json()) as Record<string, any>;
    expect(good).toMatchObject({
      orderId: order!["orderId"],
      valid: true,
      hash,
      checks: { signature: { ok: true, signer: SIGNER.publicKey() }, anchored: { ok: true, registry: REGISTRY_ID }, settlement: { ok: true } },
    });

    const [h, p, s] = jws.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString("utf8")) as Record<string, unknown>;
    const edited = `${h}.${Buffer.from(JSON.stringify({ ...claims, amountUSDC: "0.3683158", amountUSDCAtomic: "3683158" })).toString("base64url")}.${s}`;
    const bad = (await (await post(`${env.url}/receipts/verify`, { receiptJws: edited })).json()) as Record<string, any>;
    expect(bad).toMatchObject({ valid: false, checks: { signature: { ok: false }, anchored: { ok: false }, settlement: { ok: false } } });

    const unknown = await fetch(`${env.url}/receipts/${"0".repeat(64)}/verify`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "ReceiptNotFound" });
  });
});

describe("POST /checkout/:productId — idempotency, duplicates, stock", () => {
  it("replays the same order for a repeated Idempotency-Key, and refuses reuse for another purchase", async () => {
    const env = await start();
    try {
      const key = { "idempotency-key": "agent-run-42" };
      const first = (await (await buy(env.url, "/checkout/gorro-andes", {}, key)).json()) as Record<string, unknown>;
      const replay = await post(`${env.url}/checkout/gorro-andes`, {}, key);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(((await replay.json()) as Record<string, unknown>)["orderId"]).toBe(first["orderId"]);
      expect(env.deps.orders!.list()).toHaveLength(1);

      const reuse = await post(`${env.url}/checkout/cafe-nunoa-250`, {}, key);
      expect(reuse.status).toBe(409);
      expect(await reuse.json()).toMatchObject({ error: "IdempotencyConflict" });
      const malformed = await post(`${env.url}/checkout/gorro-andes`, {}, { "idempotency-key": "has spaces" });
      expect(malformed.status).toBe(400);
    } finally {
      await env.close();
    }
  });

  it("never creates two orders for one settlement transaction", async () => {
    const env = await start();
    try {
      const a = (await (await buy(env.url, "/checkout/gorro-andes")).json()) as Record<string, unknown>;
      // The fake facilitator settles everything with the same tx hash: a replayed settlement.
      const b = await buy(env.url, "/checkout/gorro-andes");
      expect(b.status).toBe(200);
      expect(b.headers.get("idempotent-replayed")).toBe("true");
      expect(((await b.json()) as Record<string, unknown>)["orderId"]).toBe(a["orderId"]);
      expect(env.deps.orders!.list()).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  it("holds stock while a payment settles, so two buyers cannot pay for the last unit", async () => {
    let releaseSettle!: () => void;
    const gate = new Promise<void>((resolve) => (releaseSettle = resolve));
    const base = fakeFacilitator();
    const slow = { ...base, settle: async (...args: Parameters<typeof base.settle>) => { await gate; return base.settle(...args); } };
    const adapter = new MockStoreAdapter();
    const env = await start({ facilitator: slow, adapter });
    try {
      const firstChallenge = await post(`${env.url}/checkout/botella-patagonia-500`, { quantity: 2 });
      const firstPaid = post(`${env.url}/checkout/botella-patagonia-500`, { quantity: 2 }, await payFor(firstChallenge));
      await new Promise((r) => setTimeout(r, 50)); // first payment is now in flight, holding both units

      const second = await post(`${env.url}/checkout/botella-patagonia-500`, { quantity: 1 });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: "OutOfStock" });

      releaseSettle();
      expect((await firstPaid).status).toBe(200);
      expect((await adapter.getProduct("botella-patagonia-500"))!.stock).toBe(0);
    } finally {
      await env.close();
    }
  });
});

describe("POST /checkout/:productId — failures after the money moved", () => {
  it("records a platform failure as paid_unfulfilled, still signs and anchors the receipt", async () => {
    const mock = new MockStoreAdapter();
    const broken: StoreAdapter = {
      name: "broken",
      listProducts: () => mock.listProducts(),
      getProduct: (id) => mock.getProduct(id),
      getOrder: () => Promise.resolve(null),
      createOrder: () => Promise.reject(new VitrineeError("AdapterError", "Jumpseller returned 503")),
    };
    const env = await start({ adapter: broken });
    try {
      const paid = await buy(env.url, "/checkout/gorro-andes");
      expect(paid.status).toBe(200);
      const order = (await paid.json()) as Record<string, any>;
      expect(order).toMatchObject({ status: "paid_unfulfilled", platformOrderId: null, platformError: "Jumpseller returned 503" });
      expect(checkReceiptSignature(order["receipt"]["jws"]).claims?.platformOrderId).toBeNull();
      await env.app.anchors.idle();
      expect(env.deps.orders!.list()[0]!.anchor?.status).toBe("anchored");
    } finally {
      await env.close();
    }
  });

  it("retries a failed anchor and then gives up with the reason recorded", async () => {
    const flaky = fakeRegistry({ failTimes: 1 });
    const env = await start({ anchorer: flaky.anchorer, registry: flaky.registry });
    try {
      const order = (await (await buy(env.url, "/checkout/gorro-andes")).json()) as Record<string, any>;
      await env.app.anchors.idle();
      await new Promise((r) => setTimeout(r, 30));
      await env.app.anchors.idle();
      expect(env.deps.orders!.get(order["orderId"])!.anchor).toMatchObject({ status: "anchored", attempts: 2 });

      const dead = fakeRegistry({ failTimes: 10 });
      const env2 = await start({ anchorer: dead.anchorer, registry: dead.registry });
      try {
        const o2 = (await (await buy(env2.url, "/checkout/gorro-andes")).json()) as Record<string, any>;
        for (let i = 0; i < 5; i += 1) {
          await env2.app.anchors.idle();
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(env2.deps.orders!.get(o2["orderId"])!.anchor).toMatchObject({ status: "failed", attempts: 3, lastError: "rpc: txBadSeq" });
      } finally {
        env2.app.anchors.stop();
        await env2.close();
      }
    } finally {
      await env.close();
    }
  });

  it("does not create an order when the facilitator refuses the settlement", async () => {
    const refusing = fakeFacilitator({ settle: { success: false, errorReason: "insufficient_funds", errorMessage: "sin saldo", transaction: "" } });
    const env = await start({ facilitator: refusing });
    try {
      const refused = await buy(env.url, "/checkout/gorro-andes");
      expect(refused.status).toBe(402);
      expect(env.deps.orders!.list()).toHaveLength(0);
      expect(env.registry.calls).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
});
