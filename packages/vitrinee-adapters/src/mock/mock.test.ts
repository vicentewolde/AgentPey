import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VitrineeError } from "@vitrinee/core";
import { afterEach, describe, expect, it } from "vitest";

import type { CreateOrderInput } from "../types.js";
import { MOCK_CATALOG, MockStoreAdapter } from "./index.js";

const PAYER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

function orderInput(productId: string, quantity = 1): CreateOrderInput {
  return {
    lines: [{ productId, quantity }],
    reference: `ord_${productId}_${quantity}`,
    buyer: { stellarAccount: PAYER, shipping: { country: "CL", city: "Ñuñoa" } },
    paymentRef: {
      txHash: "b".repeat(64),
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amountUSDCAtomic: "368315789",
      payerAccount: PAYER,
    },
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MockStoreAdapter", () => {
  it("lists six products and finds one by id", async () => {
    const adapter = new MockStoreAdapter();
    const products = await adapter.listProducts();
    expect(products).toHaveLength(6);
    expect(new Set(products.map((p) => p.currency))).toEqual(new Set(["CLP"]));
    expect(await adapter.getProduct("hoodie-cordillera-m")).toMatchObject({
      sku: "HOOD-CORD-M",
      priceLocal: "34990",
      stock: 12,
    });
    expect(await adapter.getProduct("nope")).toBeNull();
  });

  it("does not leak its internal state through returned objects", async () => {
    const adapter = new MockStoreAdapter();
    const product = await adapter.getProduct("gorro-andes");
    product!.stock = 0;
    expect((await adapter.getProduct("gorro-andes"))!.stock).toBe(8);
    expect(MOCK_CATALOG.find((p) => p.id === "gorro-andes")!.stock).toBe(8);
  });

  it("creates a paid order, totals in the local currency and decrements stock", async () => {
    const now = new Date("2026-09-22T15:00:00.000Z");
    const adapter = new MockStoreAdapter({ now: () => now });
    const order = await adapter.createOrder(orderInput("hoodie-cordillera-m", 2));
    expect(order).toMatchObject({
      platformOrderId: "mock-0001",
      platform: "mock",
      status: "paid",
      lines: [{ productId: "hoodie-cordillera-m", sku: expect.any(String), quantity: 2 }],
      totalLocal: "69980",
      currency: "CLP",
      createdAt: "2026-09-22T15:00:00.000Z",
    });
    expect((await adapter.getProduct("hoodie-cordillera-m"))!.stock).toBe(10);
    expect(await adapter.getOrder("mock-0001")).toEqual(order);
    expect(await adapter.getOrder("mock-9999")).toBeNull();
  });

  it("keeps the buyer's consent on its order, which is the store (T149)", async () => {
    const adapter = new MockStoreAdapter();
    expect(adapter.recordsBuyerConsent).toBe(true);
    const input = orderInput("gorro-andes");
    const order = await adapter.createOrder({ ...input, buyer: { ...input.buyer, email: "ana@example.com", consent: { marketing: true, analytics: false } } });
    expect((await adapter.getOrder(order.platformOrderId))!.buyer.consent).toEqual({ marketing: true, analytics: false });
  });

  it("refuses to sell what it does not have, before touching stock", async () => {
    const adapter = new MockStoreAdapter();
    await expect(adapter.createOrder(orderInput("botella-patagonia-500", 3))).rejects.toMatchObject({
      code: "OutOfStock",
      httpStatus: 409,
      details: { available: 2, requested: 3 },
    });
    expect((await adapter.getProduct("botella-patagonia-500"))!.stock).toBe(2);
    await expect(adapter.createOrder(orderInput("missing"))).rejects.toMatchObject({
      code: "ProductNotFound",
    });
    await expect(adapter.createOrder(orderInput("gorro-andes", 0))).rejects.toBeInstanceOf(
      VitrineeError,
    );
  });

  it("creates one order with several lines, and moves no stock when any line cannot be sold (T148)", async () => {
    const adapter = new MockStoreAdapter();
    const before = (await adapter.getProduct("hoodie-cordillera-m"))!.stock;
    const order = await adapter.createOrder({ ...orderInput("hoodie-cordillera-m"), lines: [{ productId: "hoodie-cordillera-m", quantity: 1 }, { productId: "cafe-nunoa-250", quantity: 2 }] });
    expect(order.lines.map((line) => [line.productId, line.quantity])).toEqual([
      ["hoodie-cordillera-m", 1],
      ["cafe-nunoa-250", 2],
    ]);
    expect(order.totalLocal).toBe("52970");
    expect((await adapter.getProduct("hoodie-cordillera-m"))!.stock).toBe(before! - 1);

    const hoodies = (await adapter.getProduct("hoodie-cordillera-m"))!.stock!;
    await expect(
      adapter.createOrder({ ...orderInput("hoodie-cordillera-m"), lines: [{ productId: "hoodie-cordillera-m", quantity: 1 }, { productId: "botella-patagonia-500", quantity: 99 }] }),
    ).rejects.toMatchObject({ code: "OutOfStock" });
    expect((await adapter.getProduct("hoodie-cordillera-m"))!.stock).toBe(hoodies);
  });

  it("reads back an orders file written before T148, with the product at the top level", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitrinee-mock-"));
    tempDirs.push(dir);
    const ordersFile = join(dir, "orders.json");
    const legacy = { ...(await new MockStoreAdapter().createOrder(orderInput("gorro-andes", 2))), lines: undefined, productId: "gorro-andes", sku: "GOR-AND", quantity: 2 };
    await writeFile(ordersFile, JSON.stringify({ seq: 1, stock: {}, orders: [legacy] }));
    expect((await new MockStoreAdapter({ ordersFile }).getOrder("mock-0001"))?.lines).toEqual([{ productId: "gorro-andes", sku: "GOR-AND", quantity: 2 }]);
  });

  it("treats null stock as unlimited", async () => {
    const adapter = new MockStoreAdapter({
      catalog: [{ ...MOCK_CATALOG[0]!, id: "digital", stock: null }],
    });
    await adapter.createOrder(orderInput("digital", 1000));
    expect((await adapter.getProduct("digital"))!.stock).toBeNull();
  });

  it("persists orders and stock to a file and restores them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitrinee-mock-"));
    tempDirs.push(dir);
    const ordersFile = join(dir, "nested", "orders.json");

    const first = new MockStoreAdapter({ ordersFile });
    await first.createOrder(orderInput("cafe-nunoa-250", 3));
    const raw = JSON.parse(await readFile(ordersFile, "utf8")) as { seq: number };
    expect(raw.seq).toBe(1);

    const second = new MockStoreAdapter({ ordersFile });
    expect((await second.getProduct("cafe-nunoa-250"))!.stock).toBe(27);
    expect(await second.getOrder("mock-0001")).toMatchObject({ lines: [{ productId: "cafe-nunoa-250", quantity: 3 }] });
    const next = await second.createOrder(orderInput("cafe-nunoa-250", 1));
    expect(next.platformOrderId).toBe("mock-0002");
  });
});
