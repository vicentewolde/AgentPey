import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VitrineeError } from "@vitrinee/core";
import { afterEach, describe, expect, it } from "vitest";

import type { CreateOrderInput } from "../types.js";
import { MOCK_CATALOG, MockStoreAdapter } from "./index.js";

const PAYER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

function orderInput(productId: string, quantity = 1): CreateOrderInput {
  return {
    productId,
    quantity,
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
  it("lists five products and finds one by id", async () => {
    const adapter = new MockStoreAdapter();
    const products = await adapter.listProducts();
    expect(products).toHaveLength(5);
    expect(products.map((p) => p.currency)).toEqual(["CLP", "CLP", "CLP", "CLP", "CLP"]);
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
      productId: "hoodie-cordillera-m",
      quantity: 2,
      totalLocal: "69980",
      currency: "CLP",
      createdAt: "2026-09-22T15:00:00.000Z",
    });
    expect((await adapter.getProduct("hoodie-cordillera-m"))!.stock).toBe(10);
    expect(await adapter.getOrder("mock-0001")).toEqual(order);
    expect(await adapter.getOrder("mock-9999")).toBeNull();
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
    expect(await second.getOrder("mock-0001")).toMatchObject({ quantity: 3 });
    const next = await second.createOrder(orderInput("cafe-nunoa-250", 1));
    expect(next.platformOrderId).toBe("mock-0002");
  });
});
