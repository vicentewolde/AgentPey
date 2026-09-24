import { request as httpRequest } from "node:http";

import { Keypair } from "@stellar/stellar-sdk";
import { MANIFEST_PATH } from "@vitrinee/core";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrderPersistence, OrderRecord } from "../orders.js";
import { fakeFacilitator } from "../test/fake-facilitator.js";
import { REGISTRY_ID, fakeRegistry } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { MemoryComercioStore, sealComercio, type Comercio } from "./comercios.js";
import { createPlatformApp } from "./platform-app.js";
import { createSecretBox, generateMasterKey } from "./secret-box.js";
import { StorefrontPool } from "./storefronts.js";

const PLATFORM = "vitrinee.test";
const ENV = { RECEIPT_REGISTRY_ID: REGISTRY_ID, FX_RATE_CLP_USD: "950" };

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** `fetch` will not set `Host`; the platform routes on nothing else. */
function call(base: string, host: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const url = new URL(path, base);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: { host: host, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw === "" ? null : JSON.parse(raw) }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function paymentFor(challenge: Reply): Record<string, string> {
  const header = challenge.headers["payment-required"];
  if (typeof header !== "string") throw new Error(`no PAYMENT-REQUIRED header (status ${challenge.status})`);
  const required = decodePaymentRequiredHeader(header);
  return {
    "payment-signature": encodePaymentSignatureHeader({
      x402Version: required.x402Version,
      resource: required.resource,
      accepted: required.accepts[0]!,
      payload: { transaction: Buffer.from(`fake-tx-${Math.random()}`).toString("base64") },
    }),
  };
}

/** Stands in for the `vitrinee.orders` table: rows by comercio id, surviving a pool rebuild. */
class Table {
  readonly rows = new Map<string, { comercioId: string; record: OrderRecord }>();
  for(comercio: Comercio): OrderPersistence {
    return {
      load: async () => [...this.rows.values()].filter((r) => r.comercioId === comercio.id).map((r) => structuredClone(r.record)),
      save: async (order) => {
        const existing = this.rows.get(order.orderId);
        if (existing !== undefined && existing.comercioId !== comercio.id) throw new Error("order of another comercio");
        this.rows.set(order.orderId, { comercioId: comercio.id, record: structuredClone(order) });
      },
    };
  }
}

describe("the multi-merchant platform (T103, C-142)", () => {
  const box = createSecretBox(generateMasterKey());
  const comercios = new MemoryComercioStore();
  const table = new Table();
  const now = new Date("2026-09-24T12:00:00.000Z");
  const a = { payTo: Keypair.random().publicKey(), signer: Keypair.random() };
  const b = { payTo: Keypair.random().publicKey(), signer: Keypair.random() };
  let comercioA: Comercio;

  function pool(): StorefrontPool {
    return new StorefrontPool({
      comercios,
      box,
      env: ENV,
      ordersFor: (c) => table.for(c),
      appDeps: () => {
        const registry = fakeRegistry();
        return { facilitator: fakeFacilitator(), anchorer: registry.anchorer, registry: registry.registry, anchorRetryDelaysMs: [5], now: () => now };
      },
    });
  }

  let base = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    comercioA = sealComercio({ slug: "tienda-a", name: "Tienda A", payTo: a.payTo, signingSecret: a.signer.secret(), credentials: { kind: "mock" } }, box, now);
    await comercios.create(comercioA);
    await comercios.create(sealComercio({ slug: "tienda-b", name: "Tienda B", payTo: b.payTo, signingSecret: b.signer.secret(), credentials: { kind: "mock" } }, box, now));
    ({ url: base, close } = await listen(createPlatformApp({ platformHost: PLATFORM, pool: pool(), comercios, rootComercio: "tienda-a" })));
  });
  afterAll(() => close());

  it("serves each comercio's own manifest at its own subdomain", async () => {
    const ra = await call(base, "tienda-a.vitrinee.test", MANIFEST_PATH);
    const rb = await call(base, "tienda-b.vitrinee.test", MANIFEST_PATH);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body).toMatchObject({ merchant: { name: "Tienda A", stellarAccount: a.payTo, did: `did:stellar:testnet:${a.signer.publicKey()}` } });
    expect(rb.body).toMatchObject({ merchant: { name: "Tienda B", stellarAccount: b.payTo, did: `did:stellar:testnet:${b.signer.publicKey()}` } });
  });

  it("builds URLs from the host the request came to", async () => {
    const r = JSON.stringify((await call(base, "tienda-b.vitrinee.test", MANIFEST_PATH)).body);
    expect(r).toContain("http://tienda-b.vitrinee.test/checkout/{productId}");
    expect(r).not.toContain("tienda-a");
  });

  it("answers 404 for a slug with no comercio and for a host that is not the platform's", async () => {
    const unknown = await call(base, "nadie.vitrinee.test", MANIFEST_PATH);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: "ComercioNotFound" });
    expect((await call(base, "tienda-a.vitrinee.test.attacker.example", MANIFEST_PATH)).status).toBe(404);
    expect((await call(base, "x.tienda-a.vitrinee.test", MANIFEST_PATH)).status).toBe(404);
  });

  it("publishes the directory of active comercios on the portal, with nothing private in it (C-141)", async () => {
    const r = await call(base, PLATFORM, "/api/comercios");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      platformHost: PLATFORM,
      comercios: [
        { slug: "tienda-a", name: "Tienda A", url: "http://tienda-a.vitrinee.test", payTo: a.payTo, signingDid: `did:stellar:testnet:${a.signer.publicKey()}` },
        { slug: "tienda-b", name: "Tienda B", url: "http://tienda-b.vitrinee.test", payTo: b.payTo, signingDid: `did:stellar:testnet:${b.signer.publicKey()}` },
      ],
    });
    expect(JSON.stringify(r.body)).not.toContain(a.signer.secret());
    expect(JSON.stringify(r.body)).not.toContain("v1:");
    // Only the portal publishes it: a store's host has no such route.
    expect((await call(base, "tienda-a.vitrinee.test", "/api/comercios")).status).toBe(404);
  });

  it("keeps the portal host for the platform, still serving the transitional root comercio", async () => {
    const health = await call(base, PLATFORM, "/health");
    expect(health.body).toMatchObject({ status: "ok", mode: "platform", rootComercio: "tienda-a" });
    const root = await call(base, PLATFORM, MANIFEST_PATH);
    expect(root.body).toMatchObject({ merchant: { stellarAccount: a.payTo } });
  });

  it("charges to the comercio's own payTo and keeps its orders apart from every other comercio's", async () => {
    const path = "/checkout/stickers-cordillera";
    const body = { quantity: 1, buyer: { stellarAccount: Keypair.random().publicKey(), shipping: { name: "Test", address: "Calle 1", city: "Santiago", region: "RM", country: "CL" } } };
    const challenge = await call(base, "tienda-a.vitrinee.test", path, { method: "POST", body });
    expect(challenge.status).toBe(402);
    expect(decodePaymentRequiredHeader(challenge.headers["payment-required"] as string).accepts[0]?.payTo).toBe(a.payTo);
    const paid = await call(base, "tienda-a.vitrinee.test", path, { method: "POST", body, headers: paymentFor(challenge) });
    expect(paid.status).toBe(200);
    const orderId = (paid.body as { orderId: string }).orderId;

    const ordersA = (await call(base, "tienda-a.vitrinee.test", "/orders")).body as { orders: { orderId: string }[] };
    const ordersB = (await call(base, "tienda-b.vitrinee.test", "/orders")).body as { orders: unknown[] };
    expect(ordersA.orders.map((o) => o.orderId)).toEqual([orderId]);
    expect(ordersB.orders).toEqual([]);
    expect((await call(base, "tienda-b.vitrinee.test", `/orders/${orderId}`)).status).toBe(404);
    expect(table.rows.get(orderId)?.comercioId).toBe(comercioA.id);
  });

  it("finds the same orders after a restart, because they live in storage, not in the process", async () => {
    const fresh = await listen(createPlatformApp({ platformHost: PLATFORM, pool: pool(), comercios, rootComercio: undefined }));
    try {
      const orders = (await call(fresh.url, "tienda-a.vitrinee.test", "/orders")).body as { orders: unknown[] };
      expect(orders.orders).toHaveLength(1);
      expect((await call(fresh.url, PLATFORM, MANIFEST_PATH)).status).toBe(404);
    } finally {
      await fresh.close();
    }
  });
});
