/**
 * The receipt is a JWS signed by the merchant's signing key. Its SHA-256 is
 * what gets anchored in `receipt-registry`. Signing and verification arrive
 * on day 2; the claims shape is fixed here so the gateway and the agent agree
 * on it from the start.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { decodeJws, signJws, verifyJws, type JwsVerification } from "./jws.js";
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
  /**
   * The id the store platform assigned. `null` when the platform refused the
   * order after the payment settled: the receipt still proves the payment,
   * and the merchant fulfils by hand (V-10).
   */
  platformOrderId: z.string().min(1).nullable(),
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

/** Signs receipt claims as a compact JWS with the merchant's signing key. */
export function signReceipt(claims: ReceiptClaims, signingSecret: string): { jws: string; hash: string } {
  const parsed = receiptClaimsSchema.parse(claims);
  const jws = signJws(parsed, signingSecret, { typ: "JWT" });
  return { jws, hash: receiptHash(jws) };
}

export interface ReceiptSignatureCheck extends JwsVerification {
  /** `null` when the payload is not valid receipt claims. */
  claims: ReceiptClaims | null;
  hash: string;
}

/**
 * Check 1 of 3: the signature is the merchant's, and the content is a
 * receipt. Pure — no network. The registry and settlement checks live in
 * `@vitrinee/anchor`.
 */
export function checkReceiptSignature(jws: string): ReceiptSignatureCheck {
  const hash = receiptHash(jws.trim());
  let decoded;
  try {
    decoded = decodeJws(jws);
  } catch (error) {
    return { ok: false, signer: undefined, claims: null, hash, reason: error instanceof Error ? error.message : String(error) };
  }
  const claims = receiptClaimsSchema.safeParse(decoded.payload);
  if (!claims.success) {
    return { ok: false, signer: undefined, claims: null, hash, reason: "payload is not a vitrinee receipt" };
  }
  return { ...verifyJws(decoded, claims.data.merchantDid), claims: claims.data, hash };
}
