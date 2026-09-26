import { VitrineeError } from "@vitrinee/core";
import { describe, expect, it, vi } from "vitest";

import type { CreateOrderInput } from "../types.js";
import { ShopifyClient } from "./client.js";
import { ShopifyStoreAdapter } from "./index.js";
import { exactDecimal, numericId } from "./map.js";

const CREDENTIALS = { shop: "mi-tienda.myshopify.com", clientId: "cid", clientSecret: "csecret" };

const sticker = {
  id: "gid://shopify/Product/1",
  title: "Pack de stickers",
  status: "ACTIVE",
  description: "Cinco   stickers\nde la Cordillera.",
  media: { nodes: [{ image: { url: "https://cdn.shopify.com/s/stickers.jpg" } }, {}] },
  variants: {
    nodes: [
      { id: "gid://shopify/ProductVariant/11", title: "Default Title", sku: "STK-5", price: "2850.00", inventoryQuantity: 9, inventoryItem: { tracked: true } },
    ],
  },
};

const shirt = {
  id: "gid://shopify/Product/2",
  title: "Polera",
  status: "ACTIVE",
  description: "",
  media: { nodes: [] },
  variants: {
    nodes: [
      { id: "gid://shopify/ProductVariant/21", title: "M", sku: "POL-M", price: "9990", inventoryQuantity: 3, inventoryItem: { tracked: false } },
      { id: "gid://shopify/ProductVariant/22", title: "L", sku: "", price: "9990", inventoryQuantity: 3, inventoryItem: { tracked: true } },
    ],
  },
};

type Handler = (body: { query: string; variables: Record<string, unknown> }) => unknown;

/** A fetch stub: the token exchange answers by itself, GraphQL bodies go to `graphql`. */
function stubFetch(graphql: Handler, tokenStatus = 200) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? "");
    calls.push({ url, headers, body });
    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify(tokenStatus === 200 ? { access_token: "tok-1", scope: "read_products", expires_in: 86399 } : { error: "invalid_client" }), { status: tokenStatus });
    }
    return new Response(JSON.stringify(graphql(JSON.parse(body))), { status: 200 });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

const catalogue = (nodes: unknown[], currency = "CLP") => ({
  data: { shop: { currencyCode: currency }, products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
});

const paymentRef = { txHash: "abc123", network: "stellar:testnet", asset: "USDC", amountUSDCAtomic: "3000000", payerAccount: "GAGENT" };
const orderInput = (overrides: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  productId: "11",
  quantity: 2,
  buyer: { stellarAccount: "GAGENT", shipping: { name: "Vinny Wolde", address: "Av. Siempre Viva 1", city: "Ñuñoa", country: "CL" } },
  paymentRef,
  reference: "vtr_001",
  ...overrides,
});

const adapterWith = (graphql: Handler, extra: { onWarning?: (m: string, d: Record<string, unknown>) => void } = {}) => {
  const { impl, calls } = stubFetch(graphql);
  return { adapter: new ShopifyStoreAdapter({ credentials: CREDENTIALS, fetch: impl, ...extra }), calls };
};

describe("mapping", () => {
  it("reads the numeric tail of a GID", () => {
    expect(numericId("gid://shopify/ProductVariant/123")).toBe("123");
  });

  it("turns Shopify money into an exact decimal", () => {
    expect(exactDecimal("2850.00", 0, "price")).toBe("2850");
    expect(exactDecimal("12.5", 2, "price")).toBe("12.50");
  });

  it("refuses a fraction of a peso instead of rounding it", () => {
    expect(() => exactDecimal("2850.50", 0, "price")).toThrow(VitrineeError);
    expect(() => exactDecimal("abc", 0, "price")).toThrow(VitrineeError);
  });
});

describe("ShopifyClient", () => {
  it("refuses a shop host that is not *.myshopify.com, before sending the secret anywhere", () => {
    for (const shop of ["evil.example.com", "mi-tienda.myshopify.com.evil.com", "https://mi-tienda.myshopify.com", ""]) {
      expect(() => new ShopifyClient({ credentials: { ...CREDENTIALS, shop } })).toThrow(VitrineeError);
    }
  });

  it("exchanges the client credentials once and reuses the token", async () => {
    const { adapter, calls } = adapterWith(() => catalogue([sticker]));
    await adapter.listProducts();
    await adapter.listProducts();
    const exchanges = calls.filter((c) => c.url.endsWith("/admin/oauth/access_token"));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.body).toContain("grant_type=client_credentials");
    expect(calls.find((c) => c.url.includes("graphql"))?.headers["X-Shopify-Access-Token"]).toBe("tok-1");
  });

  it("renews the token when it is about to expire", async () => {
    let clock = 0;
    const { impl, calls } = stubFetch(() => catalogue([]));
    const client = new ShopifyClient({ credentials: CREDENTIALS, fetch: impl, now: () => clock });
    await client.graphql("query { shop { name } }");
    clock = 86_399_000 - 30_000; // inside the one-minute margin
    await client.graphql("query { shop { name } }");
    expect(calls.filter((c) => c.url.endsWith("/admin/oauth/access_token"))).toHaveLength(2);
  });

  it("never carries the secret or the token in an error", async () => {
    const { impl } = stubFetch(() => ({}), 400);
    const adapter = new ShopifyStoreAdapter({ credentials: CREDENTIALS, fetch: impl });
    const error = await adapter.listProducts().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VitrineeError);
    expect(JSON.stringify(error)).not.toContain("csecret");
    expect((error as VitrineeError).details["credentialsRejected"]).toBe(true);
  });
});

describe("listProducts", () => {
  it("publishes each variant with a SKU as its own product, priced exactly", async () => {
    const { adapter } = adapterWith(() => catalogue([sticker, shirt]));
    const products = await adapter.listProducts();
    expect(products.map((p) => p.sku)).toEqual(["STK-5", "POL-M"]);
    expect(products[0]).toMatchObject({
      id: "11",
      name: "Pack de stickers",
      description: "Cinco stickers de la Cordillera.",
      priceLocal: "2850",
      currency: "CLP",
      stock: 9,
      images: ["https://cdn.shopify.com/s/stickers.jpg"],
    });
    expect(products[1]).toMatchObject({ id: "21", name: "Polera · M", stock: null });
  });

  it("leaves out drafts, archived products and variants without a SKU", async () => {
    const draft = { ...sticker, status: "DRAFT" };
    const { adapter } = adapterWith(() => catalogue([draft, shirt]));
    expect((await adapter.listProducts()).map((p) => p.sku)).toEqual(["POL-M"]);
  });

  it("publishes none of the products that share a SKU, and warns", async () => {
    const twin = { ...shirt, id: "gid://shopify/Product/3", variants: { nodes: [{ ...shirt.variants.nodes[0], id: "gid://shopify/ProductVariant/31", sku: "STK-5" }] } };
    const onWarning = vi.fn();
    const { adapter } = adapterWith(() => catalogue([sticker, twin]), { onWarning });
    expect(await adapter.listProducts()).toEqual([]);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("SKU"), { skus: ["STK-5"] });
  });

  it("follows the cursor across pages", async () => {
    const pages = [
      { data: { shop: { currencyCode: "CLP" }, products: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [sticker] } } },
      { data: { shop: { currencyCode: "CLP" }, products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [shirt] } } },
    ];
    let i = 0;
    const seen: unknown[] = [];
    const { adapter } = adapterWith((body) => {
      seen.push(body.variables["cursor"]);
      return pages[i++];
    });
    expect((await adapter.listProducts()).map((p) => p.sku)).toEqual(["STK-5", "POL-M"]);
    expect(seen).toEqual([null, "c1"]);
  });

  it("refuses a store that sells in another currency", async () => {
    const { adapter } = adapterWith(() => catalogue([sticker], "USD"));
    await expect(adapter.listProducts()).rejects.toMatchObject({ code: "AdapterError" });
  });
});

describe("createOrder", () => {
  const variantResponse = (variant = sticker.variants.nodes[0]) => ({
    data: { shop: { currencyCode: "CLP" }, productVariant: { ...variant, product: sticker } },
  });
  const created = { data: { orderCreate: { userErrors: [], order: { id: "gid://shopify/Order/555", createdAt: "2026-09-27T10:00:00Z" } } } };

  const handler: Handler = (body) => (body.query.includes("orderCreate") ? created : variantResponse());

  it("creates one PAID order carrying the settlement", async () => {
    const seen: { order?: Record<string, unknown>; options?: unknown }[] = [];
    const { adapter } = adapterWith((body) => {
      if (body.query.includes("orderCreate")) seen.push(body.variables as never);
      return handler(body);
    });
    const order = await adapter.createOrder(orderInput());
    expect(order).toMatchObject({
      platformOrderId: "555",
      platform: "shopify",
      status: "paid",
      productId: "11",
      sku: "STK-5",
      quantity: 2,
      totalLocal: "5700",
      currency: "CLP",
      adminUrl: "https://admin.shopify.com/store/mi-tienda/orders/555",
    });
    expect(seen).toHaveLength(1);
    const sent = seen[0]?.order as Record<string, unknown>;
    expect(sent["financialStatus"]).toBe("PAID");
    expect(sent["lineItems"]).toEqual([{ variantId: "gid://shopify/ProductVariant/11", quantity: 2, priceSet: { shopMoney: { amount: "2850", currencyCode: "CLP" } } }]);
    expect(sent["transactions"]).toEqual([{ kind: "SALE", status: "SUCCESS", gateway: "Vitrinee x402", amountSet: { shopMoney: { amount: "5700", currencyCode: "CLP" } } }]);
    expect(JSON.stringify(sent["customAttributes"])).toContain("abc123");
    expect(seen[0]?.options).toMatchObject({ inventoryBehaviour: "DECREMENT_IGNORING_POLICY", sendReceipt: false });
    expect(sent["shippingAddress"]).toMatchObject({ firstName: "Vinny", lastName: "Wolde", city: "Ñuñoa", countryCode: "CL" });
  });

  it("refuses more than the stock, before anything is written", async () => {
    const { adapter, calls } = adapterWith(handler);
    await expect(adapter.createOrder(orderInput({ quantity: 10 }))).rejects.toMatchObject({ code: "OutOfStock" });
    expect(calls.some((c) => c.body.includes("orderCreate("))).toBe(false);
  });

  it("refuses a product that does not exist", async () => {
    const { adapter } = adapterWith(() => ({ data: { shop: { currencyCode: "CLP" }, productVariant: null } }));
    await expect(adapter.createOrder(orderInput())).rejects.toMatchObject({ code: "ProductNotFound" });
  });

  it("rejects a quantity that is not a positive integer", async () => {
    const { adapter } = adapterWith(handler);
    for (const quantity of [0, -1, 1.5]) {
      await expect(adapter.createOrder(orderInput({ quantity }))).rejects.toMatchObject({ code: "ValidationError" });
    }
  });

  it("surfaces Shopify's userErrors as an AdapterError", async () => {
    const { adapter } = adapterWith((body) =>
      body.query.includes("orderCreate") ? { data: { orderCreate: { userErrors: [{ field: ["order"], message: "Invalid address" }], order: null } } } : variantResponse(),
    );
    await expect(adapter.createOrder(orderInput())).rejects.toMatchObject({ code: "AdapterError", message: expect.stringContaining("Invalid address") });
  });

  it("explains a missing permission", async () => {
    const { adapter } = adapterWith(() => ({ errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] }));
    const error = (await adapter.listProducts().catch((e: unknown) => e)) as VitrineeError;
    expect(error.message).toContain("write_orders");
    expect(error.details["credentialsRejected"]).toBe(true);
  });
});

describe("getOrder", () => {
  it("reads the settlement back from the order's attributes", async () => {
    const { adapter } = adapterWith(() => ({
      data: {
        order: {
          id: "gid://shopify/Order/555",
          createdAt: "2026-09-27T10:00:00Z",
          cancelledAt: null,
          displayFinancialStatus: "PAID",
          totalPriceSet: { shopMoney: { amount: "5700.00", currencyCode: "CLP" } },
          customAttributes: [
            { key: "vitrinee_reference", value: "vtr_001" },
            { key: "x402_tx", value: "abc123" },
            { key: "x402_network", value: "stellar:testnet" },
            { key: "x402_payer", value: "GAGENT" },
          ],
          lineItems: { nodes: [{ quantity: 2, sku: "STK-5", variant: { id: "gid://shopify/ProductVariant/11" } }] },
        },
      },
    }));
    const order = await adapter.getOrder("555");
    expect(order).toMatchObject({ status: "paid", reference: "vtr_001", productId: "11", sku: "STK-5", quantity: 2, totalLocal: "5700" });
    expect(order?.paymentRef).toMatchObject({ txHash: "abc123", network: "stellar:testnet", payerAccount: "GAGENT" });
  });

  it("answers null for a missing order and for an id that is not numeric", async () => {
    const { adapter, calls } = adapterWith(() => ({ data: { order: null } }));
    expect(await adapter.getOrder("999")).toBeNull();
    expect(await adapter.getOrder("../etc")).toBeNull();
    expect(calls.filter((c) => c.url.includes("graphql"))).toHaveLength(1);
  });

  it("reports a cancelled order as canceled", async () => {
    const { adapter } = adapterWith(() => ({ data: { order: { id: "gid://shopify/Order/1", cancelledAt: "2026-09-27T00:00:00Z", displayFinancialStatus: "REFUNDED" } } }));
    expect((await adapter.getOrder("1"))?.status).toBe("canceled");
  });
});
