import { VitrineeError } from "@vitrinee/core";
import { describe, expect, it, vi } from "vitest";

import type { CreateOrderInput } from "../types.js";
import { JumpsellerStoreAdapter } from "./index.js";
import { apiNumberFromDecimal, decimalFromApiNumber, isSellable, toPlainText, toProduct } from "./map.js";

const CREDENTIALS = { login: "test-login", authtoken: "test-token" };

const hoodie = {
  id: 37282902,
  name: "Hoodie Cordillera talla M",
  description: "Polerón con capucha de algodón orgánico.<br>",
  sku: "HOOD-CORD-M",
  price: 34990.0,
  stock: 12,
  stock_unlimited: false,
  status: "available",
  images: [{ id: 1, url: "https://images.jumpseller.com/hoodie.jpg" }],
  shipping_required: true,
};

/** A fetch stub that records calls and replays canned responses by path. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    // The client's base URL carries the API version; routes are keyed without it.
    const path = url.pathname.replace(/^\/v1/, "");
    const key = `${method} ${path}`;
    calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected request: ${key}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

const adapterWith = (routes: Parameters<typeof stubFetch>[0], onWarning?: () => void) => {
  const { impl, calls } = stubFetch(routes);
  const adapter = new JumpsellerStoreAdapter({
    credentials: CREDENTIALS,
    fetch: impl,
    ...(onWarning === undefined ? {} : { onWarning }),
  });
  return { adapter, calls };
};

const paymentRef = {
  txHash: "abc123",
  network: "stellar:testnet",
  asset: "USDC",
  amountUSDCAtomic: "368000000",
  payerAccount: "GAGENT",
};

const orderInput = (overrides: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  productId: "37282902",
  quantity: 1,
  buyer: { stellarAccount: "GAGENT", shipping: { name: "Vinny Wolde", city: "Ñuñoa", country: "CL" } },
  paymentRef,
  reference: "vtr_001",
  ...overrides,
});

describe("map", () => {
  it("turns an API float into an exact decimal string", () => {
    expect(decimalFromApiNumber(34990.0, 0, "price")).toBe("34990");
    expect(decimalFromApiNumber(990, 0, "price")).toBe("990");
    expect(decimalFromApiNumber(19.99, 2, "price")).toBe("19.99");
  });

  it("refuses an amount with more precision than the currency has", () => {
    expect(() => decimalFromApiNumber(34990.5, 0, "price")).toThrow(VitrineeError);
  });

  it("round-trips a decimal string through the wire number", () => {
    expect(apiNumberFromDecimal("34990", 0, "price")).toBe(34990);
    expect(apiNumberFromDecimal("19.99", 2, "price")).toBe(19.99);
  });

  it("strips the HTML a rich-text description arrives with", () => {
    expect(toPlainText("Polerón de algodón.<br>")).toBe("Polerón de algodón.");
    expect(toPlainText("<p>Uno</p><p>Dos</p>")).toBe("Uno Dos");
    expect(toPlainText("Caf&eacute; &amp; t&eacute;")).toBe("Caf&eacute; & t&eacute;");
  });

  it("treats unlimited stock as unknown rather than zero", () => {
    const product = toProduct({ ...hoodie, stock_unlimited: true, stock: 100 }, "CLP");
    expect(product.stock).toBeNull();
  });

  it("only counts an available product with a SKU as sellable", () => {
    expect(isSellable(hoodie)).toBe(true);
    expect(isSellable({ ...hoodie, status: "disabled" })).toBe(false);
    expect(isSellable({ ...hoodie, status: "not-available" })).toBe(false);
    expect(isSellable({ ...hoodie, sku: null })).toBe(false);
    expect(isSellable({ ...hoodie, sku: "  " })).toBe(false);
  });
});

describe("listProducts", () => {
  it("drops everything an agent cannot reference", async () => {
    const { adapter } = adapterWith({
      "GET /products.json": {
        body: [
          { product: hoodie },
          { product: { ...hoodie, id: 1, sku: "demo-product", status: "disabled" } },
          { product: { ...hoodie, id: 2, sku: null } },
          { product: { ...hoodie, id: 3, sku: "STK-CORD-5", status: "not-available" } },
        ],
      },
    });
    const products = await adapter.listProducts();
    expect(products.map((p) => p.sku)).toEqual(["HOOD-CORD-M"]);
    expect(products[0]).toMatchObject({ id: "37282902", priceLocal: "34990", currency: "CLP", stock: 12 });
  });

  it("stops at the first short page instead of paging forever", async () => {
    const { adapter, calls } = adapterWith({ "GET /products.json": { body: [{ product: hoodie }] } });
    await adapter.listProducts();
    expect(calls).toHaveLength(1);
  });
});

describe("getProduct", () => {
  it("returns null for a 404 rather than throwing", async () => {
    const { adapter } = adapterWith({
      "GET /products/999.json": { status: 404, body: { message: "Product not found" } },
    });
    expect(await adapter.getProduct("999")).toBeNull();
  });

  it("returns null for a product that exists but is disabled", async () => {
    const { adapter } = adapterWith({
      "GET /products/37282902.json": { body: { product: { ...hoodie, status: "disabled" } } },
    });
    expect(await adapter.getProduct("37282902")).toBeNull();
  });
});

describe("createOrder", () => {
  const happyRoutes = {
    "GET /products/37282902.json": { body: { product: hoodie } },
    "POST /orders.json": { body: { order: { id: 5001, created_at: "2026-09-22T12:00:00Z" } } },
    "PUT /orders/5001.json": { body: { order: { id: 5001 } } },
    "POST /orders/5001/history.json": { body: { order_history: {} } },
  };

  it("creates a paid order and writes the settlement hash onto it", async () => {
    const { adapter, calls } = adapterWith(happyRoutes);
    const order = await adapter.createOrder(orderInput());

    expect(order).toMatchObject({
      platformOrderId: "5001",
      platform: "jumpseller",
      status: "paid",
      sku: "HOOD-CORD-M",
      totalLocal: "34990",
      currency: "CLP",
      reference: "vtr_001",
    });

    const create = calls.find((c) => c.path === "/orders.json")?.body as { order: Record<string, unknown> };
    expect(create.order).toMatchObject({ status: "Paid", shipping_price: 0, shipping_required: true });
    expect(create.order.products).toEqual([{ id: 37282902, qty: 1, price: 34990 }]);

    const annotation = calls.find((c) => c.method === "PUT")?.body as { order: { additional_information: string } };
    expect(annotation.order.additional_information).toContain("tx abc123");
    expect(annotation.order.additional_information).toContain("payer GAGENT");
    expect(annotation.order.additional_information).toContain("vtr_001");
    expect(calls.some((c) => c.path === "/orders/5001/history.json")).toBe(true);
  });

  it("multiplies the total by quantity with integer arithmetic", async () => {
    const { adapter } = adapterWith({ ...happyRoutes, "GET /products/37282902.json": { body: { product: hoodie } } });
    const order = await adapter.createOrder(orderInput({ quantity: 3 }));
    expect(order.totalLocal).toBe("104970");
  });

  it("refuses to oversell", async () => {
    const { adapter } = adapterWith({
      "GET /products/37282902.json": { body: { product: { ...hoodie, stock: 2 } } },
    });
    await expect(adapter.createOrder(orderInput({ quantity: 3 }))).rejects.toMatchObject({ code: "OutOfStock" });
  });

  it("rejects a non-positive quantity before touching the network", async () => {
    const { adapter, calls } = adapterWith({});
    await expect(adapter.createOrder(orderInput({ quantity: 0 }))).rejects.toMatchObject({ code: "ValidationError" });
    expect(calls).toHaveLength(0);
  });

  it("still returns the order when the annotation fails", async () => {
    const warnings: string[] = [];
    const { adapter } = adapterWith(
      {
        ...happyRoutes,
        "PUT /orders/5001.json": { status: 500, body: { error: "boom" } },
        "POST /orders/5001/history.json": { status: 500, body: { error: "boom" } },
      },
      ((message: string) => warnings.push(message)) as unknown as () => void,
    );
    const order = await adapter.createOrder(orderInput());
    expect(order.platformOrderId).toBe("5001");
    expect(warnings).toHaveLength(2);
  });

  it("explains the trial block instead of leaking a raw 403", async () => {
    const { adapter } = adapterWith({
      "GET /products/37282902.json": { body: { product: hoodie } },
      "POST /orders.json": {
        status: 403,
        body: { message: "No puedes crear pedidos durante el período de prueba." },
      },
    });
    await expect(adapter.createOrder(orderInput())).rejects.toMatchObject({
      code: "AdapterError",
      details: { trialBlocked: true },
    });
  });
});

describe("credentials", () => {
  it("sends them as Basic auth, never in the URL, and keeps them out of errors", async () => {
    const seen: { url: string; auth: string }[] = [];
    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""),
      });
      return new Response("nope", { status: 500 });
    });
    const adapter = new JumpsellerStoreAdapter({
      credentials: CREDENTIALS,
      fetch: impl as unknown as typeof globalThis.fetch,
    });

    const error = await adapter.listProducts().catch((e: unknown) => e);
    const expected = Buffer.from("test-login:test-token", "utf8").toString("base64");
    expect(seen[0]?.auth).toBe(`Basic ${expected}`);
    expect(seen[0]?.url).not.toContain("test-token");
    expect(JSON.stringify(error)).not.toContain("test-token");
    expect((error as VitrineeError).message).not.toContain("test-token");
  });
});
