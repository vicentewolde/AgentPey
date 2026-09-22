/**
 * Discovery: one paid resource per product, in x402's own bazaar shape.
 *
 * The official bazaar catalogue lives on the *facilitator*: a resource server
 * declares itself in its 402 responses and clients query the facilitator with
 * `withBazaar(client).extensions.bazaar.listResources()`. There is no endpoint
 * in the spec for a store to list its own resources, so this one is a local
 * mirror, not an invented standard (docs/DECISIONES.md, V-17). It answers the
 * question an agent that already has the manifest actually asks — "what can I
 * buy here, and what would each cost?" — in the shape it already parses.
 */
import { STELLAR_TESTNET_CAIP2, USDC_TESTNET, localToUsdcAtomic } from "@vitrinee/core";
import type { Product } from "@vitrinee/adapters";

import type { GatewayConfig } from "./config.js";
import { checkoutRoute } from "./manifest.js";

/** `DiscoveryResource` from `@x402/extensions`, narrowed to the fields we can fill honestly. */
export interface DiscoveryResourceEntry {
  resource: string;
  type: "http";
  x402Version: number;
  accepts: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }[];
  lastUpdated: string;
  description: string;
  mimeType: string;
  serviceName: string;
  tags: string[];
}

export interface DiscoveryResponse {
  x402Version: number;
  items: DiscoveryResourceEntry[];
  pagination: { limit: number; offset: number; total: number };
}

export const X402_VERSION = 2;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListResourcesInput {
  config: GatewayConfig;
  products: readonly Product[];
  baseUrl: string;
  now: Date;
  limit?: number;
  offset?: number;
}

/**
 * Only products an agent could pay for right now. A sold-out product stays in
 * the manifest, where `stock: 0` is information; here it would be an offer the
 * checkout is going to refuse.
 */
const isPurchasable = (product: Product): boolean => product.stock === null || product.stock > 0;

export function listResources({
  config,
  products,
  baseUrl,
  now,
  limit = DEFAULT_LIMIT,
  offset = 0,
}: ListResourcesInput): DiscoveryResponse {
  const origin = baseUrl.replace(/\/+$/, "");
  const lastUpdated = now.toISOString();
  const purchasable = products.filter(isPurchasable);
  const page = purchasable.slice(offset, offset + limit);

  return {
    x402Version: X402_VERSION,
    items: page.map((product) => ({
      resource: `${origin}${checkoutRoute(product.id)}`,
      type: "http" as const,
      x402Version: X402_VERSION,
      accepts: [
        {
          scheme: "exact",
          network: STELLAR_TESTNET_CAIP2,
          asset: USDC_TESTNET.contractId,
          amount: localToUsdcAtomic(product.priceLocal, product.currency, config.fx).toString(),
          payTo: config.merchant.stellarAccount,
          maxTimeoutSeconds: config.checkout.maxTimeoutSeconds,
          // The price quoted here is for one unit; the checkout multiplies by
          // `quantity` and re-quotes, so an agent must not treat it as final.
          extra: { paymentFlow: "upfront", unitPrice: true, quantityParam: "quantity" },
        },
      ],
      lastUpdated,
      description: `${product.name} — ${product.description}`,
      mimeType: "application/json",
      serviceName: config.merchant.name,
      tags: ["ecommerce", "retail", config.merchant.country.toLowerCase()],
    })),
    pagination: { limit, offset, total: purchasable.length },
  };
}

/** Clamps a `?limit=`/`?offset=` pair; anything unparseable falls back to the default. */
export function paginationFrom(query: Record<string, unknown>): { limit: number; offset: number } {
  const read = (value: unknown, fallback: number): number => {
    const parsed = Number(typeof value === "string" ? value : NaN);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    limit: Math.min(read(query["limit"], DEFAULT_LIMIT), MAX_LIMIT),
    offset: read(query["offset"], 0),
  };
}
