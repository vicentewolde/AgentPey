/**
 * The receipt is a JWS signed by the merchant's signing key. Its SHA-256 is
 * what gets anchored in `receipt-registry`. Signing and verification arrive
 * on day 2; the claims shape is fixed here so the gateway and the agent agree
 * on it from the start.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { VitrineeError } from "./errors.js";
import { decodeJws, signJws, verifyJws, type JwsVerification } from "./jws.js";
import {
  STELLAR_TESTNET_CAIP2,
  USDC_TESTNET,
  atomicStringSchema,
  decimalStringSchema,
  stellarAccountSchema,
  stellarContractIdSchema,
  stellarDidSchema,
  stellarPayerSchema,
} from "./manifest.js";
import { parseDecimal } from "./money.js";

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
   * and the merchant fulfils by hand (VT-10).
   */
  platformOrderId: z.string().min(1).nullable(),
  platform: z.string().min(1),
  merchantDid: stellarDidSchema,
  merchantAccount: stellarAccountSchema,
  /** G... or C...: a smart account such as AgentPey's `policy_rail` pays too (VT-22). */
  payerAccount: stellarPayerSchema,
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

/** Whether the decimal string is the same amount as the atomic one, at USDC's precision. */
function sameAmount(decimal: string, atomic: string): boolean {
  try {
    return parseDecimal(decimal, USDC_TESTNET.decimals) === BigInt(atomic);
  } catch {
    // More decimals than USDC has: it cannot be the same amount.
    return false;
  }
}

/**
 * What the schema cannot say: the receipt must not contradict itself (T132).
 * Every amount appears twice, as a decimal for people and in atomic units for
 * the registry and the settlement check, and only the atomic one is compared
 * against the chain. A receipt whose two amounts differ, or that names an
 * asset other than the USDC the settlement check looks for, would pass those
 * checks while showing a reader something else. Returns the reason, or `null`
 * when the claims are coherent.
 */
export function receiptIncoherence(claims: ReceiptClaims): string | null {
  if (claims.asset !== USDC_TESTNET.contractId) {
    return `asset ${claims.asset} is not the trusted USDC contract ${USDC_TESTNET.contractId}`;
  }
  if (!sameAmount(claims.amountUSDC, claims.amountUSDCAtomic)) {
    return `amountUSDC ${claims.amountUSDC} is not amountUSDCAtomic ${claims.amountUSDCAtomic}`;
  }
  for (const item of claims.items) {
    if (!sameAmount(item.unitPriceUSDC, item.unitPriceUSDCAtomic)) {
      return `unitPriceUSDC ${item.unitPriceUSDC} is not unitPriceUSDCAtomic ${item.unitPriceUSDCAtomic} for item ${item.productId}`;
    }
  }
  return null;
}

/**
 * Signs receipt claims as a compact JWS with the merchant's signing key.
 * Refuses claims that contradict themselves: a store never signs what its own
 * verifier would reject.
 */
export function signReceipt(claims: ReceiptClaims, signingSecret: string): { jws: string; hash: string } {
  const parsed = receiptClaimsSchema.parse(claims);
  const incoherence = receiptIncoherence(parsed);
  if (incoherence !== null) {
    throw new VitrineeError("ReceiptInvalid", `refusing to sign an incoherent receipt: ${incoherence}`, {
      details: { orderId: parsed.orderId },
    });
  }
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
 * receipt that does not contradict itself. Pure — no network. The registry and settlement checks live in
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
  const signature = verifyJws(decoded, claims.data.merchantDid);
  // The signature's own reason comes first: an unsigned edit is a forgery, not an incoherent receipt.
  const incoherence = signature.ok ? receiptIncoherence(claims.data) : null;
  if (incoherence !== null) {
    return { ok: false, signer: signature.signer, claims: claims.data, hash, reason: `incoherent receipt: ${incoherence}` };
  }
  return { ...signature, claims: claims.data, hash };
}
