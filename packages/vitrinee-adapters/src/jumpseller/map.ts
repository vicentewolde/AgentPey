/**
 * Jumpseller's wire shapes, and the rules for turning them into Vitrinee's.
 *
 * Two things this file refuses to do: invent fields Jumpseller does not have,
 * and let a JSON float become an amount. Prices arrive as numbers (`34990.0`)
 * because that is what the API sends; they are converted to an exact decimal
 * string here and never travel as numbers past this boundary (VT-7).
 */
import { VitrineeError, currencyDecimals, parseDecimal } from "@vitrinee/core";

import type { Product } from "../types.js";

export interface JumpsellerImage {
  id?: number;
  url?: string;
}

export interface JumpsellerProduct {
  id: number;
  name?: string;
  description?: string;
  sku?: string | null;
  price?: number;
  stock?: number | null;
  stock_unlimited?: boolean;
  status?: string;
  images?: JumpsellerImage[];
  shipping_required?: boolean;
  weight?: number | null;
}

export interface JumpsellerProductEnvelope {
  product: JumpsellerProduct;
}

export interface JumpsellerOrderProduct {
  id?: number;
  product_id?: number;
  sku?: string | null;
  qty?: number;
  price?: number;
  name?: string;
}

export interface JumpsellerOrder {
  id: number;
  status?: string;
  total?: number;
  currency?: string;
  created_at?: string;
  additional_information?: string | null;
  shipping_method_name?: string | null;
  products?: JumpsellerOrderProduct[];
  customer?: { email?: string | null } | null;
}

export interface JumpsellerOrderEnvelope {
  order: JumpsellerOrder;
}

/**
 * An exact decimal string from an API number.
 *
 * A JSON number is a float, so this is the one place a rounding decision is
 * made, and it is made loudly: anything that is not representable in the
 * currency's minor unit is a bug in the catalogue, not something to round
 * away silently.
 */
export function decimalFromApiNumber(value: number, decimals: number, field: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new VitrineeError("AdapterError", `Jumpseller sent a ${field} that is not a usable amount`, {
      details: { field, value: String(value) },
    });
  }
  const scale = 10 ** decimals;
  const scaled = value * scale;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-6) {
    throw new VitrineeError(
      "AdapterError",
      `Jumpseller sent a ${field} with more precision than ${decimals} decimal place${decimals === 1 ? "" : "s"}`,
      { details: { field, value: String(value), decimals } },
    );
  }
  const digits = String(rounded).padStart(decimals + 1, "0");
  return decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * The other direction, for a request body: Jumpseller's JSON wants a number
 * where Vitrinee holds a decimal string. The conversion is checked rather
 * than assumed, so an amount too large to survive a float fails loudly
 * instead of being sent wrong.
 */
export function apiNumberFromDecimal(value: string, decimals: number, field: string): number {
  const atomic = parseDecimal(value, decimals);
  const scale = 10n ** BigInt(decimals);
  const whole = Number(atomic / scale);
  const fraction = Number(atomic % scale) / Number(scale);
  const result = whole + fraction;
  if (!Number.isFinite(result) || !Number.isSafeInteger(Number(atomic))) {
    throw new VitrineeError("AdapterError", `${field} "${value}" is too large to send to Jumpseller`, {
      details: { field, value },
    });
  }
  return result;
}

const TAG_RE = /<[^>]*>/g;
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Jumpseller descriptions are rich text, so even a plain paragraph comes back
 * wrapped in HTML. The manifest is read by agents, not browsers; it gets text.
 */
export function toPlainText(html: string): string {
  const withBreaks = html.replace(/<\/?(?:br|p|div|li)[^>]*>/gi, " ");
  const stripped = withBreaks.replace(TAG_RE, "");
  const decoded = stripped.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
  return decoded.replace(/\s+/g, " ").trim();
}

/** A product an agent can actually buy: on sale, and referable by SKU. */
export function isSellable(product: JumpsellerProduct): boolean {
  return product.status === "available" && typeof product.sku === "string" && product.sku.trim() !== "";
}

export function toProduct(product: JumpsellerProduct, currency: string): Product {
  const decimals = currencyDecimals(currency);
  const sku = product.sku?.trim();
  if (sku === undefined || sku === "") {
    throw new VitrineeError("AdapterError", `Jumpseller product ${product.id} has no SKU`, {
      details: { productId: product.id },
    });
  }
  if (product.price === undefined) {
    throw new VitrineeError("AdapterError", `Jumpseller product ${product.id} has no price`, {
      details: { productId: product.id },
    });
  }
  return {
    id: String(product.id),
    sku,
    name: product.name ?? sku,
    description: toPlainText(product.description ?? ""),
    priceLocal: decimalFromApiNumber(product.price, decimals, "price"),
    currency,
    stock: product.stock_unlimited === true ? null : (product.stock ?? 0),
    images: (product.images ?? []).map((image) => image.url).filter((url): url is string => typeof url === "string"),
  };
}
