import { Keypair } from "@stellar/stellar-sdk";
import { isVitrineeError, signDownloadLink } from "@vitrinee/core";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { isDigitalOrder, parseDigitalProducts, registerDownloads, type DigitalProduct } from "./digital.js";
import { OrderStore, type OrderRecord } from "./orders.js";
import { parseComercioDigitalProducts } from "./platform/config.js";
import { listen } from "./test/listen.js";

const RAIL = "CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L";
const NOW = new Date("2026-11-15T20:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const FILE = Buffer.from("%PDF-1.7 credencial");
const DIGITAL = "prod_credential";
const PHYSICAL = "prod_card";
const products = new Map<string, DigitalProduct>([[DIGITAL, { url: "https://cdn.shopify.com/s/files/credencial.pdf", name: "credencial evento.pdf", mediaType: "application/pdf" }]]);

const owner = Keypair.random();
const principal = Keypair.random();
const classic = Keypair.random();

const order = (orderId: string, payer: string, items: string[] = [DIGITAL], extra: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    orderId,
    status: "paid",
    createdAt: NOW.toISOString(),
    items: items.map((productId) => ({ productId, sku: productId, name: productId, quantity: 1, unitPriceUSDCAtomic: "1000000", unitPriceLocal: "950" })),
    settlement: { payer, txHash: "e".repeat(64), network: "stellar:testnet", payTo: "G", asset: "C", amountAtomic: "1", explorerUrl: "", settledAt: NOW.toISOString() },
    receipt: { jws: "r.jws", hash: "7".repeat(64) },
    ...extra,
  }) as OrderRecord;

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(options: { fetchImpl?: typeof fetch; orders?: OrderRecord[] } = {}) {
  const store = new OrderStore(undefined, options.orders ?? [order("ord_rail", RAIL), order("ord_classic", classic.publicKey()), order("ord_mixed", RAIL, [DIGITAL, PHYSICAL]), order("ord_unpaid", RAIL, [DIGITAL], { receipt: null })]);
  const delivered: string[] = [];
  const fetched: string[] = [];
  const app = express();
  registerDownloads(app, {
    orders: store,
    products,
    railKeysOf: async (rail) => {
      if (rail !== RAIL) throw new Error("unknown rail");
      return { owner: owner.publicKey(), principal: principal.publicKey() };
    },
    delivered: async (orderId) => {
      delivered.push(orderId);
      await store.update(orderId, (o) => {
        o.fulfillmentState = "fulfilled";
      });
    },
    fetchImpl:
      options.fetchImpl ??
      (async (url) => {
        fetched.push(String(url));
        return new Response(FILE, { headers: { "content-type": "application/octet-stream" } });
      }),
    now: () => NOW,
    log: () => {},
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isVitrineeError(error)) res.status(error.httpStatus).json(error.toJSON());
    else res.status(500).json({ error: String(error) });
  });
  const server = await listen(app);
  servers.push(server);
  const host = new URL(server.url).host;
  const download = (orderId: string, signer: Keypair, options: { expiresAt?: number; store?: string; line?: number } = {}) => {
    const query = signDownloadLink(signer, { store: options.store ?? host, orderId, expiresAt: options.expiresAt ?? nowSeconds + 600 });
    if (options.line !== undefined) query.set("line", String(options.line));
    return fetch(`${server.url}/orders/${orderId}/download?${query.toString()}`);
  };
  const forOther = (presented: string, signedFor: string, signer: Keypair) => {
    const query = signDownloadLink(signer, { store: host, orderId: signedFor, expiresAt: nowSeconds + 600 });
    return fetch(`${server.url}/orders/${presented}/download?${query.toString()}`);
  };
  // Lets the `finish` handler record the delivery before the test looks.
  const settle = () => new Promise((done) => setTimeout(done, 20));
  return { download, forOther, delivered, fetched, settle, store };
}

describe("digital delivery: the first download is the delivery (T188, Y-5)", () => {
  it("hands the file to the rail's agent, and records the delivery once it left", async () => {
    const s = await start();
    const res = await s.download("ord_rail", owner);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FILE);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''credencial%20evento.pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await s.settle();
    expect(s.delivered).toEqual(["ord_rail"]);
    expect(s.store.get("ord_rail")?.fulfillmentState).toBe("fulfilled");
  });

  it("lets the rail's principal, and a classic payer, download what they paid", async () => {
    const s = await start();
    expect((await s.download("ord_rail", principal)).status).toBe(200);
    expect((await s.download("ord_classic", classic)).status).toBe(200);
  });

  it("refuses anyone who did not pay, before fetching the file", async () => {
    const s = await start();
    for (const stranger of [Keypair.random(), classic]) {
      const res = await s.download("ord_rail", stranger);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("DownloadDenied");
    }
    expect((await s.download("ord_classic", owner)).status).toBe(401);
    expect(s.fetched).toEqual([]);
    expect(s.delivered).toEqual([]);
  });

  it("refuses an expired link, one that lasts too long, and one signed for another store or order", async () => {
    const s = await start();
    expect((await s.download("ord_rail", owner, { expiresAt: nowSeconds - 1 })).status).toBe(401);
    expect((await s.download("ord_rail", owner, { expiresAt: nowSeconds + 3600 })).status).toBe(401);
    expect((await s.download("ord_rail", owner, { store: "other.vitrinee.agentpey.com" })).status).toBe(401);
    // A valid link for another order of the same payer, presented for this one.
    expect((await s.forOther("ord_rail", "ord_mixed", owner)).status).toBe(401);
    expect(s.fetched).toEqual([]);
  });

  it("has no file for an order with a physical product, nor for one not paid", async () => {
    const s = await start();
    expect((await s.download("ord_mixed", owner)).status).toBe(404);
    expect((await s.download("ord_unpaid", owner)).status).toBe(404);
    expect((await s.download("ord_nope", owner)).status).toBe(404);
    expect(s.delivered).toEqual([]);
  });

  it("downloads again without changing anything: the delivery is recorded by the first", async () => {
    const s = await start();
    expect((await s.download("ord_rail", owner)).status).toBe(200);
    await s.settle();
    expect((await s.download("ord_rail", owner)).status).toBe(200);
    await s.settle();
    // The delivery hook is idempotent in the app (`recordShipment` keeps one `download` event); here it is called each time.
    expect(s.store.get("ord_rail")?.fulfillmentState).toBe("fulfilled");
  });

  it("records nothing when the file host fails, and says so", async () => {
    const s = await start({ fetchImpl: async () => new Response("gone", { status: 404 }) });
    const res = await s.download("ord_rail", owner);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("DownloadUnavailable");
    await s.settle();
    expect(s.delivered).toEqual([]);
  });

  it("refuses a file larger than a store may hand over", async () => {
    const s = await start({ fetchImpl: async () => new Response("x", { headers: { "content-length": String(26 * 1024 * 1024) } }) });
    expect((await s.download("ord_rail", owner)).status).toBe(502);
  });
});

describe("which products are digital (T188)", () => {
  it("reads DIGITAL_PRODUCTS, and refuses a URL that is not https or carries credentials", () => {
    expect(parseDigitalProducts(undefined).size).toBe(0);
    const parsed = parseDigitalProducts(JSON.stringify({ [DIGITAL]: { url: "https://cdn.shopify.com/a.pdf", name: "a.pdf" } }));
    expect(parsed.get(DIGITAL)?.name).toBe("a.pdf");
    for (const url of ["http://cdn.shopify.com/a.pdf", "https://user:pass@cdn.shopify.com/a.pdf", "file:///etc/passwd"]) {
      expect(() => parseDigitalProducts(JSON.stringify({ [DIGITAL]: { url, name: "a" } }))).toThrow(expect.objectContaining({ code: "ConfigError" }));
    }
    expect(() => parseDigitalProducts("{")).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });

  it("calls an order digital only when every product in it is", () => {
    expect(isDigitalOrder(order("a", RAIL), products)).toBe(true);
    expect(isDigitalOrder(order("b", RAIL, [DIGITAL, PHYSICAL]), products)).toBe(false);
    expect(isDigitalOrder(order("c", RAIL), new Map())).toBe(false);
  });

  it("gives each platform store only its own entry of COMERCIO_DIGITAL_PRODUCTS, checked at startup", () => {
    const value = JSON.stringify({ tapline: { [DIGITAL]: { url: "https://cdn.shopify.com/a.pdf", name: "a.pdf" } } });
    const bySlug = parseComercioDigitalProducts(value);
    expect([...bySlug.keys()]).toEqual(["tapline"]);
    expect(parseDigitalProducts(bySlug.get("tapline")).has(DIGITAL)).toBe(true);
    expect(() => parseComercioDigitalProducts(JSON.stringify({ tapline: { [DIGITAL]: { url: "http://x", name: "a" } } }))).toThrow(expect.objectContaining({ code: "ConfigError" }));
    expect(() => parseComercioDigitalProducts(JSON.stringify({ "Not A Slug": {} }))).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });
});
