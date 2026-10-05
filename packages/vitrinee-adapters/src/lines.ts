/**
 * The checks every adapter makes on the lines of an order before it asks its
 * platform to create it (T148): the same rules in the mock, Jumpseller and
 * Shopify, so no platform sees a request another would refuse.
 */
import { VitrineeError, currencyDecimals, formatUnits, parseDecimal } from "@vitrinee/core";

import type { OrderLineInput, PlatformOrderLine, Product } from "./types.js";

/** The most lines one order may carry: the UCP checkout's own limit. */
export const MAX_ORDER_LINES = 10;

/** @throws VitrineeError `ValidationError` for no lines, too many, or a quantity that is not a positive integer. */
export function assertOrderLines(lines: readonly OrderLineInput[]): void {
  if (lines.length === 0 || lines.length > MAX_ORDER_LINES) {
    throw new VitrineeError("ValidationError", `an order needs 1 to ${MAX_ORDER_LINES} lines`, { details: { lines: lines.length } });
  }
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new VitrineeError("ValidationError", "quantity must be a positive integer", { details: { quantity: line.quantity } });
    }
  }
}

/** How many units of each product the lines ask for, summed across lines naming the same one. */
export function unitsByProduct(lines: readonly OrderLineInput[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const line of lines) units.set(line.productId, (units.get(line.productId) ?? 0) + line.quantity);
  return units;
}

/**
 * Resolves every product the lines name and checks its stock against the sum
 * the lines ask for, before anything is created. Returns the products by id.
 *
 * @throws VitrineeError `ProductNotFound`, `OutOfStock`
 */
export async function resolveOrderLines(lines: readonly OrderLineInput[], getProduct: (id: string) => Promise<Product | null>): Promise<Map<string, Product>> {
  assertOrderLines(lines);
  const products = new Map<string, Product>();
  for (const [productId, requested] of unitsByProduct(lines)) {
    const product = await getProduct(productId);
    if (product === null) {
      throw new VitrineeError("ProductNotFound", `no product with id "${productId}"`, { details: { productId } });
    }
    if (product.stock !== null && product.stock < requested) {
      throw new VitrineeError("OutOfStock", `only ${product.stock} left of "${product.name}"`, {
        details: { productId: product.id, available: product.stock, requested },
      });
    }
    products.set(productId, product);
  }
  return products;
}

/** The order's total in the store's currency, Σ unit × quantity, exact (VT-7). */
export function orderTotalLocal(lines: readonly OrderLineInput[], products: ReadonlyMap<string, Product>, currency: string): string {
  const decimals = currencyDecimals(currency);
  let total = 0n;
  for (const line of lines) total += parseDecimal(products.get(line.productId)!.priceLocal, decimals) * BigInt(line.quantity);
  return formatUnits(total, decimals);
}

/** The lines as a platform order reports them. */
export function platformLines(lines: readonly OrderLineInput[], products: ReadonlyMap<string, Product>): PlatformOrderLine[] {
  return lines.map((line) => ({ productId: line.productId, sku: products.get(line.productId)!.sku, quantity: line.quantity }));
}
