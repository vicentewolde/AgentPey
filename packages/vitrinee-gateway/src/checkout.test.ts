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

  it("renders the same verification as a page a person can read (T108)", async () => {
    const [order] = ((await (await fetch(`${env.url}/orders`)).json()) as { orders: Array<Record<string, any>> }).orders;
    const { hash } = order!["receipt"] as { hash: string };
    env.horizon.allow("36.8315789");

    const page = await fetch(`${env.url}/receipts/${hash}`);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await page.text();
    expect(html).toContain("Valid receipt: all three checks pass");
    expect(html.match(/class="check ok"/g)).toHaveLength(3);
    expect(html).toContain("36.8315789 USDC");
    expect(html).toContain(`/receipts/${hash}/verify`);
    expect(html).toContain(`stellar.expert/explorer/testnet/tx/${FAKE_TX_HASH}`);
    expect(html).not.toContain("—");

    const es = await (await fetch(`${env.url}/receipts/${hash}?lang=es`)).text();
    expect(es).toContain('<html lang="es">');
    expect(es).toContain("Recibo válido: pasan las tres comprobaciones");
    const byHeader = await (await fetch(`${env.url}/receipts/${hash}`, { headers: { "accept-language": "es-CL,es;q=0.9" } })).text();
    expect(byHeader).toContain("Recibo de venta");

    const unknown = await fetch(`${env.url}/receipts/${"0".repeat(64)}`);
    expect(unknown.status).toBe(404);
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

  describe("POST /orders/:orderId/fulfil (VT-26)", () => {
    /** An adapter that refuses until told to work, counting how many orders it really created. */
    function flaky() {
      const mock = new MockStoreAdapter();
      let works = false;
      let created = 0;
      const adapter: StoreAdapter = {
        name: "flaky",
        listProducts: () => mock.listProducts(),
        getProduct: (id) => mock.getProduct(id),
        getOrder: () => Promise.resolve(null),
        createOrder: async (input) => {
          if (!works) throw new VitrineeError("AdapterError", "Jumpseller responded 404 on /orders.json: Account not found.");
          created += 1;
          return mock.createOrder(input);
        },
      };
      return { adapter, fix: () => { works = true; }, created: () => created };
    }
    const fulfil = (url: string, orderId: string) => fetch(`${url}/orders/${orderId}/fulfil`, { method: "POST" });

    it("creates the platform order for a paid sale, keeps the receipt as anchored, and never charges again", async () => {
      const store = flaky();
      const env = await start({ adapter: store.adapter });
      try {
        const paid = (await (await buy(env.url, "/checkout/gorro-andes")).json()) as Record<string, any>;
        await env.app.anchors.idle();
        expect(paid["status"]).toBe("paid_unfulfilled");
        const receiptHash = paid["receipt"]["hash"];

        // Still refused: the order stays as it was, with the newer reason.
        const again = await fulfil(env.url, paid["orderId"]);
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ status: "paid_unfulfilled", platformOrderId: null });
        expect(store.created()).toBe(0);

        store.fix();
        const done = (await (await fulfil(env.url, paid["orderId"])).json()) as Record<string, any>;
        expect(done).toMatchObject({ status: "paid", platformError: null });
        expect(done["platformOrderId"]).not.toBeNull();
        expect(done["receipt"]["hash"]).toBe(receiptHash);
        expect(done["settlement"]).toEqual(paid["settlement"]);
        expect(store.created()).toBe(1);
      } finally {
        await env.close();
      }
    });

    it("refuses an order that is not waiting, and one that does not exist, without touching the platform", async () => {
      const store = flaky();
      store.fix();
      const env = await start({ adapter: store.adapter });
      try {
        const ok = (await (await buy(env.url, "/checkout/gorro-andes")).json()) as Record<string, any>;
        expect(ok["status"]).toBe("paid");
        const before = store.created();
        expect((await fulfil(env.url, ok["orderId"])).status).toBe(400);
        expect((await fulfil(env.url, "ord_nope")).status).toBe(404);
        expect(store.created()).toBe(before);
      } finally {
        await env.close();
      }
    });

    it("cannot create two platform orders when called twice at once", async () => {
      const store = flaky();
      const env = await start({ adapter: store.adapter });
      try {
        const paid = (await (await buy(env.url, "/checkout/gorro-andes")).json()) as Record<string, any>;
        store.fix();
        const [a, b] = await Promise.all([fulfil(env.url, paid["orderId"]), fulfil(env.url, paid["orderId"])]);
        expect([a.status, b.status].sort()).toEqual([200, 400]);
        expect(store.created()).toBe(1);
      } finally {
        await env.close();
      }
    });
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

describe("GET /checkout/:productId — the door x402 clients use (VT-23)", () => {
  // AgentPey's shared policy_rail: a smart account, the payer of T99's real settlement.
  const RAIL = "CANSQJH7KPQTBUXPA42BBWZGZRKLWQZUFVF3SLQOUWKHEX4L3JP7YEDA";
  const SHIPPING = "name=Ana%20P%C3%A9rez&address=Av.%20Irarr%C3%A1zaval%201234&city=%C3%91u%C3%B1oa&region=Metropolitana";

  /** Horizon's view of a policy_rail settlement: `contract_debited`, with the facilitator's channel as `account`. */
  function railHorizon(amount: string): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/transactions/${FAKE_TX_HASH}`)) return Response.json({ successful: true, ledger: 4_899_999, created_at: "2026-09-23T12:00:00Z" });
      if (url.includes(`/transactions/${FAKE_TX_HASH}/effects`)) {
        return Response.json({
          _embedded: {
            records: [
              { type: "contract_debited", account: "GDUUIFI46QEUYMC3D3GKNT6CRQFX4WZ3WZWYYD4O2GZZJ23Y3CP3VU3K", contract: RAIL, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
              { type: "account_credited", account: MERCHANT, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
            ],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  it("answers a bodyless GET with the 402 for the query's quantity, and nothing is cached", async () => {
    const env = await start();
    try {
      const two = await fetch(`${env.url}/checkout/hoodie-cordillera-m?quantity=2&${SHIPPING}`);
      expect(two.status).toBe(402);
      expect(two.headers.get("cache-control")).toBe("no-store");
      const required = decodePaymentRequiredHeader(two.headers.get("payment-required")!);
      expect(required.accepts[0]).toMatchObject({ scheme: "exact", amount: "736631578", payTo: MERCHANT, extra: { paymentFlow: "upfront" } });
      expect(await two.json()).toMatchObject({ error: "PaymentRequired", quote: { quantity: 2, amountUSDC: "73.6631578" } });

      // No query at all is one unit, exactly like an empty POST body.
      const bare = await fetch(`${env.url}/checkout/hoodie-cordillera-m`);
      expect(decodePaymentRequiredHeader(bare.headers.get("payment-required")!).accepts[0]!.amount).toBe("368315789");
    } finally {
      await env.close();
    }
  });

  it("keeps the buyer's address out of resource.url, the object a client forwards to the facilitator (VT-25)", async () => {
    const facilitator = fakeFacilitator();
    const env = await start({ facilitator });
    try {
      const resource = `${env.url}/checkout/hoodie-cordillera-m?quantity=2&${SHIPPING}`;
      const challenge = await fetch(resource);
      const required = decodePaymentRequiredHeader(challenge.headers.get("payment-required")!);
      expect(required.resource.url).toBe(`${env.url}/checkout/hoodie-cordillera-m`);
      // The query is still what the price is computed from.
      expect(required.accepts[0]!.amount).toBe("736631578");

      const paid = await fetch(resource, { headers: await payFor(challenge) });
      expect(paid.status).toBe(200);
      const sent = JSON.stringify([...facilitator.verifyCalls, ...facilitator.settleCalls]);
      expect(sent).not.toContain("Irarr");
      expect(sent).not.toContain("address=");
      expect(facilitator.settleCalls[0]!.payload.resource?.url).toBe(`${env.url}/checkout/hoodie-cordillera-m`);
      // The order still got the address: it only stopped travelling to the facilitator.
      const order = (await paid.json()) as { platformOrderId: string };
      expect(order.platformOrderId).toBe("mock-0001");
    } finally {
      await env.close();
    }
  });

  it("refuses a malformed query, an unknown product and missing stock before asking for money", async () => {
    const facilitator = fakeFacilitator();
    const env = await start({ facilitator });
    try {
      for (const query of ["quantity=0", "quantity=abc", "quantity=1.5", "quantity=101", "quantity=1&quantity=2", "city=a&city=b"]) {
        const bad = await fetch(`${env.url}/checkout/hoodie-cordillera-m?${query}`);
        expect({ query, status: bad.status }).toEqual({ query, status: 400 });
      }
      expect((await fetch(`${env.url}/checkout/does-not-exist?quantity=1`)).status).toBe(404);
      const tooMany = await fetch(`${env.url}/checkout/botella-patagonia-500?quantity=3`);
      expect(tooMany.status).toBe(409);
      expect(await tooMany.json()).toMatchObject({ error: "OutOfStock", details: { available: 2, requested: 3 } });
      expect(facilitator.settleCalls).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  it("settles a policy_rail (C...) payment and carries the payer into the order, the receipt and its verification", async () => {
    const facilitator = fakeFacilitator({ verify: { payer: RAIL }, settle: { payer: RAIL } });
    const adapter = new MockStoreAdapter();
    const env = await start({ facilitator, adapter, horizonFetch: railHorizon("21.0421053") });
    try {
      const resource = `${env.url}/checkout/botella-patagonia-500?quantity=1&${SHIPPING}`;
      const challenge = await fetch(resource);
      const paid = await fetch(resource, { headers: await payFor(challenge) });
      expect(paid.status).toBe(200);
      expect(paid.headers.get("cache-control")).toMatch(/\bno-store\b/);
      const order = (await paid.json()) as Record<string, any>;
      expect(order).toMatchObject({ status: "paid", quantity: 1, amountUSDCAtomic: "210421053", settlement: { payer: RAIL, payTo: MERCHANT } });

      // The platform order got the shipping address from the query, and the rail as the payer.
      const platformOrder = await adapter.getOrder(order["platformOrderId"] as string);
      expect(platformOrder).toMatchObject({
        quantity: 1,
        buyer: { stellarAccount: RAIL, shipping: { name: "Ana Pérez", address: "Av. Irarrázaval 1234", city: "Ñuñoa", region: "Metropolitana", country: "CL" } },
        paymentRef: { payerAccount: RAIL },
      });

      // Signing the receipt used to be where a C... payer failed, after the money had moved.
      const { jws, hash } = order["receipt"] as { jws: string; hash: string };
      expect(checkReceiptSignature(jws)).toMatchObject({ ok: true, claims: { payerAccount: RAIL } });
      await env.app.anchors.idle();
      const verified = (await (await fetch(`${env.url}/receipts/${hash}/verify`)).json()) as Record<string, any>;
      expect(verified).toMatchObject({ valid: true, checks: { signature: { ok: true }, anchored: { ok: true }, settlement: { ok: true } } });
    } finally {
      await env.close();
    }
  });

  it("a POST reads only its body: a query on it changes nothing", async () => {
    const env = await start();
    try {
      const posted = await post(`${env.url}/checkout/hoodie-cordillera-m?quantity=5`, {});
      expect(decodePaymentRequiredHeader(posted.headers.get("payment-required")!).accepts[0]!.amount).toBe("368315789");
    } finally {
      await env.close();
    }
  });

  it("refuses HEAD, which would otherwise slip past the payment middleware", async () => {
    const facilitator = fakeFacilitator();
    const env = await start({ facilitator });
    try {
      const head = await fetch(`${env.url}/checkout/hoodie-cordillera-m?quantity=1`, { method: "HEAD" });
      expect(head.status).toBe(405);
      expect(head.headers.get("allow")).toBe("GET, POST");
      expect(env.deps.orders!.list()).toHaveLength(0);
      expect(facilitator.settleCalls).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
});
