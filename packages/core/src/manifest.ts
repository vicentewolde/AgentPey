/**
 * `/.well-known/agent-storefront.json` — the document an agent reads to learn
 * what a store sells, how to pay, and where the receipt can be verified.
 * Normative description: docs/SPEC-agent-storefront.md (day 3).
 */
import { z } from "zod";

import { STELLAR_DID_RE, isStellarAccount, isStellarContractId } from "./did.js";

export const MANIFEST_VERSION = "0.1";
export const MANIFEST_PATH = "/.well-known/agent-storefront.json";
export const STELLAR_TESTNET_CAIP2 = "stellar:testnet";
export const OPENZEPPELIN_FACILITATOR_TESTNET = "https://channels.openzeppelin.com/x402/testnet";

/** Circle's testnet USDC: classic asset and its SEP-41 contract. */
export const USDC_TESTNET = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  decimals: 7,
} as const;

export const decimalStringSchema = z.string().regex(/^\d+(\.\d+)?$/, "decimal string expected");
export const atomicStringSchema = z.string().regex(/^\d+$/, "integer string expected");
export const stellarAccountSchema = z
  .string()
  .refine(isStellarAccount, { message: "not a Stellar account public key (G...)" });
export const stellarContractIdSchema = z
  .string()
  .refine(isStellarContractId, { message: "not a Stellar contract id (C...)" });
export const stellarDidSchema = z.string().regex(STELLAR_DID_RE, "did:stellar:<network>:G... expected");
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2 expected");
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code expected");

export const manifestProductSchema = z.strictObject({
  id: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Price as the store lists it, in `currency`. */
  priceLocal: decimalStringSchema,
  currency: currencyCodeSchema,
  /** The same price in USDC, human units, at the manifest's `fx` rate. */
  priceUSDC: decimalStringSchema,
  /** The same price in USDC atomic units (7 decimals): what x402 settles. */
  priceUSDCAtomic: atomicStringSchema,
  /** `null` means the store does not track stock for this product. */
  stock: z.int().nonnegative().nullable(),
  images: z.array(z.url()),
  /** Relative route the agent POSTs to; it answers 402 until paid. */
  checkoutRoute: z.string().startsWith("/"),
});

export const storefrontManifestSchema = z.strictObject({
  version: z.literal(MANIFEST_VERSION),
  generatedAt: z.iso.datetime(),
  merchant: z.strictObject({
    name: z.string().min(1),
    /** The merchant's receipt-signing key (V-8). Verifies receipts; cannot move funds. */
    did: stellarDidSchema,
    /** Where payments land (payTo). Vitrinee never holds this account's secret. */
    stellarAccount: stellarAccountSchema,
    country: countryCodeSchema,
    currency: currencyCodeSchema,
  }),
  network: z.literal(STELLAR_TESTNET_CAIP2),
  settlement: z.strictObject({
    scheme: z.literal("exact"),
    asset: z.literal("USDC"),
    assetContract: stellarContractIdSchema,
    decimals: z.literal(7),
    facilitator: z.url(),
  }),
  fx: z.strictObject({
    base: z.literal("USD"),
    quote: currencyCodeSchema,
    rate: decimalStringSchema,
    /** No oracle in this version — docs/DECISIONES.md, V-2. */
    source: z.literal("demo-fixed"),
    asOf: z.iso.datetime(),
  }),
  policies: z.strictObject({
    refundWindowSeconds: z.int().nonnegative(),
    shippingCountries: z.array(countryCodeSchema),
  }),
  /**
   * How purchases are proven. The receipt is a compact JWS signed by the key
   * in `merchant.did`; its SHA-256 is anchored in `registry` (Soroban).
   */
  receipts: z.strictObject({
    format: z.literal("jws"),
    alg: z.literal("EdDSA"),
    anchoredValue: z.literal("sha256(compact-jws)"),
    registry: stellarContractIdSchema,
  }),
  products: z.array(manifestProductSchema),
  endpoints: z.strictObject({
    catalog: z.url(),
    product: z.string().min(1),
    checkout: z.string().min(1),
    orders: z.string().min(1),
    verifyReceipt: z.string().min(1),
    discovery: z.url(),
  }),
});

export type ManifestProduct = z.infer<typeof manifestProductSchema>;
export type StorefrontManifest = z.infer<typeof storefrontManifestSchema>;
