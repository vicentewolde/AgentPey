import type { Product } from "@vitrinee/adapters";
import {
  STELLAR_X402_HANDLER,
  UCP_CATALOG_LOOKUP,
  UCP_CATALOG_SEARCH,
  UCP_LATEST_VERSION,
  USDC_TESTNET,
  localToUsdcAtomic,
  toMinorUnits,
  type UcpVersion,
} from "@vitrinee/core";
import { z } from "zod";

import type { GatewayConfig } from "../config.js";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
export const MAX_LOOKUP_IDS = 50;

/** UCP sends optional context, signals and attribution with every catalog call; this gateway reads none of them. */
const passthrough = { context: z.unknown().optional(), signals: z.unknown().optional(), attribution: z.unknown().optional() };

const filtersSchema = z
  .looseObject({
    categories: z.array(z.string()).optional(),
    price: z.looseObject({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }).optional(),
  })
  .optional();

export const searchRequestSchema = z.looseObject({
  query: z.string().max(200).optional(),
  filters: filtersSchema,
  pagination: z
    .looseObject({
      // The cursor is this gateway's own: the offset of the next page.
      cursor: z.string().regex(/^\d{1,6}$/).optional(),
      limit: z.number().int().min(1).optional(),
    })
    .optional(),
  ...passthrough,
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const lookupRequestSchema = z.looseObject({
  ids: z.array(z.string().min(1).max(200)).min(1).max(MAX_LOOKUP_IDS),
  filters: filtersSchema,
  ...passthrough,
});
export type LookupRequest = z.infer<typeof lookupRequestSchema>;

export const getProductRequestSchema = z.looseObject({ id: z.string().min(1).max(200), ...passthrough });

interface UcpPrice {
  amount: number;
  currency: string;
}

interface UcpVariant {
  id: string;
  sku: string;
  title: string;
  description: { plain: string };
  price: UcpPrice;
  availability: { available: boolean; status: "in_stock" | "out_of_stock" };
  media: Array<{ type: "image"; url: string }>;
  metadata: Record<string, unknown>;
  inputs?: Array<{ id: string; match: "exact" | "featured" }>;
}

interface UcpCatalogProduct {
  id: string;
  title: string;
  description: { plain: string };
  price_range: { min: UcpPrice; max: UcpPrice };
  media: Array<{ type: "image"; url: string }>;
  variants: [UcpVariant];
}

const envelope = (version: UcpVersion, capability: string, status: "success" | "error" = "success") => ({
  version,
  status,
  capabilities: { [capability]: [{ version }] },
});

/** `null` stock means the platform does not track it, which is the same as available. */
const isAvailable = (product: Product): boolean => product.stock === null || product.stock > 0;

/**
 * A Vitrinee product as a UCP product with a single variant, both under the
 * platform's product id: that id is what a checkout line item names. The price
 * is the store's own, in its currency (E-3). What the purchase settles for, in
 * USDC atomic units at today's rate, rides in the variant's metadata under the
 * handler's name, so an agent can check it against its limits before checkout.
 */
export function toUcpProduct(product: Product, config: GatewayConfig): UcpCatalogProduct {
  const price: UcpPrice = { amount: toMinorUnits(product.priceLocal, product.currency), currency: product.currency.toUpperCase() };
  const description = { plain: product.description === "" ? product.name : product.description };
  const media = product.images.map((url) => ({ type: "image" as const, url }));
  const available = isAvailable(product);
  return {
    id: product.id,
    title: product.name,
    description,
    price_range: { min: price, max: price },
    media,
    variants: [
      {
        id: product.id,
        sku: product.sku,
        title: product.name,
        description,
        price,
        availability: { available, status: available ? "in_stock" : "out_of_stock" },
        media,
        metadata: {
          [STELLAR_X402_HANDLER]: {
            asset: USDC_TESTNET.contractId,
            amount_atomic: localToUsdcAtomic(product.priceLocal, product.currency, config.fx).toString(),
            fx: { base: config.fx.base, quote: config.fx.quote, rate: config.fx.rate },
          },
        },
      },
    ],
  };
}

export interface SearchCatalogInput {
  config: GatewayConfig;
  /** The version the platform speaks (T133); the catalog's shape is the same in both. */
  version?: UcpVersion;
  products: readonly Product[];
  request: SearchRequest;
}

/**
 * `POST /catalog/search`. An absent, empty or `*` query lists everything;
 * otherwise a case-insensitive match on name and description, the same rule as
 * the ServiceCard feed. Out-of-stock products are listed and say so: UCP has a
 * field for it, and hiding them would make a lookup disagree with a search.
 */
export function searchCatalog({ config, products, request, version = UCP_LATEST_VERSION }: SearchCatalogInput) {
  const needle = request.query === undefined || request.query.trim() === "*" ? "" : request.query.trim().toLowerCase();
  // Vitrinee products carry no categories, so a category filter matches none of them (UCP: OR over listed categories).
  const byCategory = (request.filters?.categories ?? []).length > 0;
  const min = request.filters?.price?.min;
  const max = request.filters?.price?.max;

  const matched = products
    .filter(() => !byCategory)
    .filter((product) => needle === "" || `${product.name} ${product.description}`.toLowerCase().includes(needle))
    .map((product) => toUcpProduct(product, config))
    .filter((product) => {
      const amount = product.variants[0].price.amount;
      return (min === undefined || amount >= min) && (max === undefined || amount <= max);
    });

  const offset = request.pagination?.cursor === undefined ? 0 : Number(request.pagination.cursor);
  const limit = Math.min(request.pagination?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = matched.slice(offset, offset + limit);
  const next = offset + page.length;
  const hasNext = next < matched.length;

  return {
    ucp: envelope(version, UCP_CATALOG_SEARCH),
    products: page,
    pagination: { has_next_page: hasNext, ...(hasNext ? { cursor: String(next) } : {}), total_count: matched.length },
  };
}

export interface LookupCatalogInput {
  config: GatewayConfig;
  /** The version the platform speaks (T133); the catalog's shape is the same in both. */
  version?: UcpVersion;
  products: readonly Product[];
  ids: readonly string[];
}

/**
 * `POST /catalog/lookup`. An id resolves by product id or by SKU; both name the
 * one variant exactly. Ids that resolve to nothing are left out: a batch lookup
 * returns partial results by design.
 */
export function lookupCatalog({ config, products, ids, version = UCP_LATEST_VERSION }: LookupCatalogInput) {
  const found = new Map<string, { product: Product; inputs: Array<{ id: string; match: "exact" }> }>();
  for (const id of new Set(ids)) {
    const product = products.find((candidate) => candidate.id === id) ?? products.find((candidate) => candidate.sku === id);
    if (product === undefined) continue;
    const entry = found.get(product.id) ?? { product, inputs: [] };
    entry.inputs.push({ id, match: "exact" });
    found.set(product.id, entry);
  }
  return {
    ucp: envelope(version, UCP_CATALOG_LOOKUP),
    products: [...found.values()].map(({ product, inputs }) => {
      const ucpProduct = toUcpProduct(product, config);
      return { ...ucpProduct, variants: [{ ...ucpProduct.variants[0], inputs }] };
    }),
  };
}

export interface GetProductInput {
  config: GatewayConfig;
  /** The version the platform speaks (T133); the catalog's shape is the same in both. */
  version?: UcpVersion;
  products: readonly Product[];
  id: string;
}

/**
 * `POST /catalog/product`. A missing product is an application outcome, not a
 * transport error: HTTP 200 with `ucp.status: "error"` and a `not_found` message.
 */
export function getCatalogProduct({ config, products, id, version = UCP_LATEST_VERSION }: GetProductInput) {
  const product = products.find((candidate) => candidate.id === id) ?? products.find((candidate) => candidate.sku === id);
  if (product === undefined) {
    return {
      ucp: envelope(version, UCP_CATALOG_LOOKUP, "error"),
      messages: [{ type: "error" as const, code: "not_found", content: `Product not found: ${id}`, severity: "unrecoverable" as const }],
    };
  }
  return { ucp: envelope(version, UCP_CATALOG_LOOKUP), product: toUcpProduct(product, config) };
}
