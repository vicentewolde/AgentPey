/**
 * Shopify's wire shapes, and the rules for turning them into Vitrinee's.
 *
 * One Shopify product can have several variants, each with its own SKU, price
 * and stock; Vitrinee sells things with a SKU, so **each variant is a
 * Vitrinee product** and its id is the variant's (VT-34). Money arrives as an
 * exact decimal string ("2850.00"), never a float, and is checked against the
 * currency's decimals before it goes any further.
 */
import { VitrineeError, currencyDecimals, formatUnits, parseDecimal } from "@vitrinee/core";

import type { Product } from "../types.js";

export interface ShopifyVariantNode {
  id: string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  inventoryQuantity?: number | null;
  inventoryItem?: { tracked?: boolean | null } | null;
}

export interface ShopifyProductNode {
  id: string;
  title?: string | null;
  status?: string | null;
  description?: string | null;
  media?: { nodes?: ({ image?: { url?: string | null } | null } | null)[] } | null;
  variants?: { nodes?: ShopifyVariantNode[] } | null;
}

/** The id after the last slash of a GID: "gid://shopify/ProductVariant/123" -> "123". */
export function numericId(gid: string): string {
  const tail = gid.slice(gid.lastIndexOf("/") + 1);
  return /^\d+$/.test(tail) ? tail : gid;
}

export const variantGid = (id: string): string => `gid://shopify/ProductVariant/${id}`;
export const orderGid = (id: string): string => `gid://shopify/Order/${id}`;

/** An exact decimal in the currency's minor unit, or a loud error: a catalogue with fractions of a peso is a bug to report, not to round. */
export function exactDecimal(value: string, decimals: number, field: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new VitrineeError("AdapterError", `Shopify sent a ${field} that is not a usable amount`, { details: { field, value } });
  }
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) {
    throw new VitrineeError(
      "AdapterError",
      `Shopify sent a ${field} with more precision than ${decimals} decimal place${decimals === 1 ? "" : "s"}`,
      { details: { field, value, decimals } },
    );
  }
  const normalized = fraction === "" ? (match[1] ?? "0") : `${match[1] ?? "0"}.${fraction}`;
  return formatUnits(parseDecimal(normalized, decimals), decimals);
}

/** Shopify's description is already plain text; this only squeezes whitespace. */
const plain = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

export function isSellable(product: ShopifyProductNode, variant: ShopifyVariantNode): boolean {
  return product.status === "ACTIVE" && typeof variant.sku === "string" && variant.sku.trim() !== "";
}

export function toProduct(product: ShopifyProductNode, variant: ShopifyVariantNode, currency: string): Product {
  const decimals = currencyDecimals(currency);
  const sku = variant.sku?.trim();
  if (sku === undefined || sku === "") {
    throw new VitrineeError("AdapterError", `Shopify variant ${variant.id} has no SKU`, { details: { variantId: variant.id } });
  }
  if (variant.price === undefined || variant.price === null) {
    throw new VitrineeError("AdapterError", `Shopify variant ${variant.id} has no price`, { details: { variantId: variant.id } });
  }
  const title = plain(product.title) || sku;
  const variantTitle = plain(variant.title);
  return {
    id: numericId(variant.id),
    sku,
    name: variantTitle === "" || variantTitle === "Default Title" ? title : `${title} · ${variantTitle}`,
    description: plain(product.description),
    priceLocal: exactDecimal(variant.price, decimals, "price"),
    currency,
    // An untracked variant has no stock to run out of.
    stock: variant.inventoryItem?.tracked === true ? Math.max(0, variant.inventoryQuantity ?? 0) : null,
    images: (product.media?.nodes ?? [])
      .map((node) => node?.image?.url)
      .filter((url): url is string => typeof url === "string" && url !== ""),
  };
}
