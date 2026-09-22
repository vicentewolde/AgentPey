/**
 * The receipt is a JWS signed by the merchant's signing key. Its SHA-256 is
 * what gets anchored in `receipt-registry`. Signing and verification arrive
 * on day 2; the claims shape is fixed here so the gateway and the agent agree
 * on it from the start.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  STELLAR_TESTNET_CAIP2,
  atomicStringSchema,
  decimalStringSchema,
  stellarAccountSchema,
  stellarContractIdSchema,
  stellarDidSchema,
} from "./manifest.js";

export const RECEIPT_TYPE = "vitrinee-receipt/0.1";

export const txHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex sha256 expected");

export const receiptItemSchema = z.strictObject({
  productId: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.int().positive(),
  unitPriceUSDC: decimalStringSchema,
  unitPriceUSDCAtomic: atomicStringSchema,
});

export const receiptClaimsSchema = z.strictObject({
  typ: z.literal(RECEIPT_TYPE),
  /** Vitrinee's own order id (ULID). */
  orderId: z.string().min(1),
  /** The id the store platform assigned. */
  platformOrderId: z.string().min(1),
  platform: z.string().min(1),
  merchantDid: stellarDidSchema,
  merchantAccount: stellarAccountSchema,
  payerAccount: stellarAccountSchema,
  network: z.literal(STELLAR_TESTNET_CAIP2),
  asset: stellarContractIdSchema,
  amountUSDC: decimalStringSchema,
  amountUSDCAtomic: atomicStringSchema,
  settlementTxHash: txHashSchema,
  items: z.array(receiptItemSchema).min(1),
  issuedAt: z.iso.datetime(),
  refundWindowEndsAt: z.iso.datetime(),
});

export type ReceiptItem = z.infer<typeof receiptItemSchema>;
export type ReceiptClaims = z.infer<typeof receiptClaimsSchema>;

/** The value anchored on chain: SHA-256 of the compact JWS, lowercase hex. */
export function receiptHash(compactJws: string): string {
  return createHash("sha256").update(compactJws, "utf8").digest("hex");
}
