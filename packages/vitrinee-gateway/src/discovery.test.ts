import type { Product } from "@vitrinee/adapters";
import { describe, expect, it } from "vitest";

import { listResources, paginationFrom, X402_VERSION } from "./discovery.js";
import { testConfig } from "./test/fixtures.js";

const config = testConfig();
const now = new Date("2026-09-22T12:00:00.000Z");

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "37282902",
  sku: "HOOD-CORD-M",
  name: "Hoodie Cordillera talla M",
  description: "Polerón con capucha de algodón orgánico.",
  priceLocal: "34990",
  currency: "CLP",
  stock: 12,
  images: [],
  ...overrides,
});

const list = (products: Product[], extra: { limit?: number; offset?: number } = {}) =>
  listResources({ config, products, baseUrl: "https://tienda.test/", now, ...extra });

describe("listResources", () => {
  it("offers one paid resource per product, priced in USDC atomic units", () => {
    const response = list([product()]);
    expect(response.x402Version).toBe(X402_VERSION);
    expect(response.items).toHaveLength(1);

    const item = response.items[0]!;
    expect(item.resource).toBe("https://tienda.test/checkout/37282902");
    expect(item.type).toBe("http");
    expect(item.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      payTo: config.merchant.stellarAccount,
      maxTimeoutSeconds: config.checkout.maxTimeoutSeconds,
    });
    // 34990 CLP at the demo rate of 950 CLP/USD, in 7-decimal USDC.
    expect(item.accepts[0]?.amount).toBe("368315789");
    expect(item.accepts[0]?.extra).toMatchObject({ unitPrice: true, quantityParam: "quantity" });
  });

  it("leaves out what the checkout would refuse to sell", () => {
    const response = list([product(), product({ id: "2", sku: "BOT-PAT-500", stock: 0 })]);
    expect(response.items.map((i) => i.resource)).toEqual(["https://tienda.test/checkout/37282902"]);
    expect(response.pagination.total).toBe(1);
  });

  it("keeps a product whose platform does not track stock", () => {
    expect(list([product({ stock: null })]).items).toHaveLength(1);
  });

  it("paginates over what is purchasable, not over the raw catalogue", () => {
    const products = [product({ id: "1" }), product({ id: "2", stock: 0 }), product({ id: "3" })];
    const response = list(products, { limit: 1, offset: 1 });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.resource).toContain("/checkout/3");
    expect(response.pagination).toEqual({ limit: 1, offset: 1, total: 2 });
  });

  it("does not repeat the origin's trailing slash", () => {
    expect(listResources({ config, products: [product()], baseUrl: "https://t.test///", now }).items[0]?.resource).toBe(
      "https://t.test/checkout/37282902",
    );
  });
});

describe("paginationFrom", () => {
  it("defaults, clamps and ignores nonsense", () => {
    expect(paginationFrom({})).toEqual({ limit: 50, offset: 0 });
    expect(paginationFrom({ limit: "10", offset: "5" })).toEqual({ limit: 10, offset: 5 });
    expect(paginationFrom({ limit: "9999" })).toEqual({ limit: 200, offset: 0 });
    expect(paginationFrom({ limit: "-1", offset: "abc" })).toEqual({ limit: 50, offset: 0 });
    expect(paginationFrom({ limit: ["10"] })).toEqual({ limit: 50, offset: 0 });
  });
});
