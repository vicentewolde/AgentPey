import type { Product, StoreAdapter } from "@vitrinee/adapters";
import {
  USDC_TESTNET,
  localToUsdcAtomic,
  stellarDid,
  storefrontManifestSchema,
  usdcAtomicToDecimal,
  type ManifestProduct,
  type StorefrontManifest,
} from "@vitrinee/core";

import type { GatewayConfig } from "./config.js";

export function checkoutRoute(productId: string): string {
  return `/checkout/${encodeURIComponent(productId)}`;
}

/** Prices a platform product in USDC at the configured rate. */
export function toManifestProduct(product: Product, config: GatewayConfig): ManifestProduct {
  const atomic = localToUsdcAtomic(product.priceLocal, product.currency, config.fx);
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    priceLocal: product.priceLocal,
    currency: product.currency,
    priceUSDC: usdcAtomicToDecimal(atomic),
    priceUSDCAtomic: atomic.toString(),
    stock: product.stock,
    images: product.images,
    checkoutRoute: checkoutRoute(product.id),
  };
}

export interface BuildManifestInput {
  config: GatewayConfig;
  products: readonly Product[];
  baseUrl: string;
  now: Date;
}

export function buildManifest({ config, products, baseUrl, now }: BuildManifestInput): StorefrontManifest {
  const origin = baseUrl.replace(/\/+$/, "");
  const asOf = now.toISOString();
  return storefrontManifestSchema.parse({
    version: "0.1",
    generatedAt: asOf,
    merchant: {
      name: config.merchant.name,
      did: stellarDid(config.signing.account, "testnet"),
      stellarAccount: config.merchant.stellarAccount,
      country: config.merchant.country,
      currency: config.merchant.currency,
    },
    network: "stellar:testnet",
    settlement: {
      scheme: "exact",
      asset: "USDC",
      assetContract: USDC_TESTNET.contractId,
      decimals: USDC_TESTNET.decimals,
      facilitator: config.facilitator.url,
    },
    fx: { base: "USD", quote: config.fx.quote, rate: config.fx.rate, source: "demo-fixed", asOf },
    policies: config.policies,
    receipts: { format: "jws", alg: "EdDSA", anchoredValue: "sha256(compact-jws)", registry: config.receiptRegistryId },
    products: products.map((product) => toManifestProduct(product, config)),
    endpoints: {
      catalog: `${origin}/catalog`,
      product: `${origin}/products/{id}`,
      checkout: `${origin}/checkout/{productId}`,
      orders: `${origin}/orders/{orderId}`,
      verifyReceipt: `${origin}/receipts/{hash}/verify`,
      discovery: `${origin}/discovery/resources`,
    },
  } satisfies StorefrontManifest);
}

/** Caches the platform's product list for `ttlMs`, so a burst of agents does not hammer the store API. */
export function createCatalogCache(
  adapter: StoreAdapter,
  ttlMs: number,
  now: () => number = Date.now,
): { get(): Promise<Product[]>; invalidate(): void } {
  let cached: { at: number; products: Product[] } | undefined;
  let inflight: Promise<Product[]> | undefined;
  return {
    async get() {
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.products;
      inflight ??= adapter
        .listProducts()
        .then((products) => {
          cached = { at: now(), products };
          return products;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
