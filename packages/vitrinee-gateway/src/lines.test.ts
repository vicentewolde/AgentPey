/**
 * T148: what a store saved before carts existed still reads back, and what a
 * cart holds while it settles is held whole or not at all.
 */
import { describe, expect, it } from "vitest";

import { orderRecordSchema, upgradeLegacyOrder } from "./orders.js";
import { Reservations } from "./reservations.js";
import { checkoutSessionSchema } from "./ucp/sessions.js";

const legacyOrder = {
  orderId: "ord_muv8xjmi1a53efae61",
  status: "paid",
  createdAt: "2026-10-05T12:40:00.000Z",
  idempotencyKey: null,
  product: { id: "67624104591666", sku: "IMAN-COBRE", name: "Imán de cobre Atacama" },
  quantity: 2,
  unitPriceUSDCAtomic: "15684211",
  amountUSDCAtomic: "31368422",
  amountUSDC: "3.1368422",
  totalLocal: "2980",
  currency: "CLP",
  buyer: { stellarAccount: "CA6P4KKV" },
  settlement: { txHash: "e".repeat(64), network: "stellar:testnet", payer: "CA6P4KKV", payTo: "GD2M", asset: "CBIE", amountAtomic: "31368422", explorerUrl: "https://x", settledAt: "2026-10-05T12:40:00.000Z" },
  platform: "shopify",
  platformOrderId: "19009954578738",
  platformError: null,
  receipt: null,
  anchor: null,
  ucpCheckoutId: "cs_abc",
};

describe("an order saved before T148", () => {
  it("reads back as one item, its unit price in the store's currency the total over the quantity", () => {
    const parsed = orderRecordSchema.parse(legacyOrder);
    expect(parsed.items).toEqual([{ productId: "67624104591666", sku: "IMAN-COBRE", name: "Imán de cobre Atacama", quantity: 2, unitPriceUSDCAtomic: "15684211", unitPriceLocal: "1490" }]);
    expect(parsed).not.toHaveProperty("product");
    expect(parsed).not.toHaveProperty("quantity");
  });

  it("leaves a record that already has items, or is not a legacy order, as it is", () => {
    const current = orderRecordSchema.parse(legacyOrder);
    expect(upgradeLegacyOrder(current)).toBe(current);
    expect(upgradeLegacyOrder("nope")).toBe("nope");
    expect(orderRecordSchema.safeParse({ ...legacyOrder, quantity: 0 }).success).toBe(false);
  });
});

describe("a checkout session saved before T148", () => {
  it("reads back as one line with a one-line quote", () => {
    const parsed = checkoutSessionSchema.parse({
      id: "cs_legacy1",
      status: "ready_for_complete",
      createdAt: "2026-10-05T12:00:00.000Z",
      updatedAt: "2026-10-05T12:00:00.000Z",
      expiresAt: "2026-10-05T18:00:00.000Z",
      productId: "67624104591666",
      quantity: 2,
      buyer: {},
      destination: null,
      quote: { unitAtomic: "15684211", totalAtomic: "31368422", totalLocal: "2980", currency: "CLP", fx: { base: "USD", quote: "CLP", rate: "950", asOf: "2026-10-05T12:00:00.000Z" }, productSku: "IMAN-COBRE", productName: "Imán" },
      requirements: null,
      paymentKey: null,
      completeIdempotencyKey: null,
      orderId: null,
    });
    expect(parsed.lines).toEqual([{ productId: "67624104591666", quantity: 2 }]);
    expect(parsed.quote).toMatchObject({ totalAtomic: "31368422", lines: [{ productId: "67624104591666", unitAtomic: "15684211", totalAtomic: "31368422", unitLocal: "1490", totalLocal: "2980", productSku: "IMAN-COBRE" }] });
  });
});

describe("Reservations.tryReserveAll", () => {
  it("holds every product of a cart, or none of them", () => {
    const r = new Reservations();
    expect(r.tryReserveAll([{ productId: "a", quantity: 1, stock: 5 }, { productId: "b", quantity: 2, stock: 1 }])).toBe("b");
    expect(r.reserved("a")).toBe(0);
    expect(r.tryReserveAll([{ productId: "a", quantity: 1, stock: 5 }, { productId: "b", quantity: 1, stock: 1 }])).toBeNull();
    expect([r.reserved("a"), r.reserved("b")]).toEqual([1, 1]);
    r.releaseAll([{ productId: "a", quantity: 1 }, { productId: "b", quantity: 1 }]);
    expect([r.reserved("a"), r.reserved("b")]).toEqual([0, 0]);
  });
});
