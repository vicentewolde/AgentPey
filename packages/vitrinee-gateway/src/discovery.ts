/**
 * Discovery: one paid resource per product, in x402's own bazaar shape.
 *
 * The official bazaar catalogue lives on the *facilitator*: a resource server
 * declares itself in its 402 responses and clients query the facilitator with
 * `withBazaar(client).extensions.bazaar.listResources()`. There is no endpoint
 * in the spec for a store to list its own resources, so this one is a local
 * mirror, not an invented standard (docs/fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md, VT-17). It answers the
 * question an agent that already has the manifest actually asks — "what can I
 * buy here, and what would each cost?" — in the shape it already parses.
 */
import { STELLAR_TESTNET_CAIP2, USDC_TESTNET, localToUsdcAtomic, usdcAtomicToDecimal } from "@vitrinee/core";
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

/**
 * `GET /api/discovery/search`: the same purchasable products, as the
 * `ServiceCard` feed (`bazaar.service-card/v0`) that AgentPey's catalogue
 * adapter reads from every x402 venue (`apps/agent/src/catalog/x402-catalog.ts`).
 *
 * Why a second discovery shape instead of teaching AgentPey the first: with
 * this one, adding a Vitrinee store to AgentPey is a row in `venues.json` and
 * no code on either side (F7, C-130, VT-24). `/discovery/resources` stays, for
 * clients that speak `@x402/extensions`.
 */
export const SERVICE_CARD_PATH = "/api/discovery/search";

/**
 * What a physical order needs from the buyer, declared as the card's `input`.
 * RealOps turns these into a form per product and AgentPey sends them back as
 * `route_params`, filled into `routeTemplate` (T96). Every one is required
 * because `routeTemplate` names every one: a placeholder the caller does not
 * fill is refused before anything is asked of this gateway. `quantity` must
 * match the purchase's own quantity, or AgentPey's `reconcileTerms` refuses
 * the challenge before signing: the price here is per unit.
 */
export const SERVICE_CARD_INPUT = [
  { name: "quantity", type: "number", required: true },
  { name: "name", type: "string", required: true },
  { name: "address", type: "string", required: true },
  { name: "city", type: "string", required: true },
  { name: "region", type: "string", required: true },
] as const;

export interface ServiceCard {
  id: string;
  name: string;
  description: string;
  /** The unit price, in decimal USDC; `destination` is the checkout's `payTo`. */
  payment: { asset: "USDC"; amount: string; destination: string };
  /** Relative to the store's origin, with `{name}` placeholders for every `input`. */
  routeTemplate: string;
  input: readonly { name: string; type: string; required: boolean }[];
}

export interface ServiceCardSearchResponse {
  ok: true;
  results: { resource: ServiceCard }[];
}

// AgentPey parses the whole feed or none of it: one name over 200 characters
// or with a control character would take every product of the store off its
// catalogue. The card is a summary; the manifest keeps the full text.
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
// Matching control characters is the point of these two patterns.
// eslint-disable-next-line no-control-regex
const fitName = (text: string): string => text.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, NAME_MAX);
const fitDescription = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ").slice(0, DESCRIPTION_MAX);

const routeTemplateFor = (productId: string): string =>
  `${checkoutRoute(productId)}?${SERVICE_CARD_INPUT.map(({ name }) => `${name}={${name}}`).join("&")}`;

export interface ListServiceCardsInput {
  config: GatewayConfig;
  products: readonly Product[];
  /** The bazaar's free-text `?query=`. `*` or empty lists everything; otherwise a case-insensitive match on name and description. */
  query?: string;
}

export function listServiceCards({ config, products, query }: ListServiceCardsInput): ServiceCardSearchResponse {
  const needle = query === undefined || query.trim() === "*" ? "" : query.trim().toLowerCase();
  const matches = (product: Product): boolean =>
    needle === "" || `${product.name} ${product.description}`.toLowerCase().includes(needle);

  return {
    ok: true,
    results: products
      .filter(isPurchasable)
      .filter(matches)
      .flatMap((product) => {
        const name = fitName(product.name);
        if (name === "") return [];
        return [
          {
            resource: {
              id: product.id,
              name,
              description: fitDescription(product.description),
              payment: {
                asset: "USDC" as const,
                amount: usdcAtomicToDecimal(localToUsdcAtomic(product.priceLocal, product.currency, config.fx)),
                destination: config.merchant.stellarAccount,
              },
              routeTemplate: routeTemplateFor(product.id),
              input: SERVICE_CARD_INPUT,
            },
          },
        ];
      }),
  };
}
