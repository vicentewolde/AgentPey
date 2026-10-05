/**
 * The purchase intent: what the agent signs when it wants to buy something.
 *
 * It does not move money and it is not a payment. It is a statement, signed by
 * the agent's own key and traceable to the credential that authorised it: *this
 * agent, operating for this principal, wants this quantity of this product at
 * this venue for this total, and here is the credential you can check that
 * against.*
 *
 * The shape is meant to outlive this phase. Phase 3's Mandato is the other half
 * of the same conversation — the principal's signed consent — and checking an
 * intent against a mandate needs exactly these facts: who, for whom, where,
 * what, how much, in what asset, under what limit, and until when. Nothing here
 * is specific to the mock catalogue.
 *
 * What it deliberately does **not** carry: the product's name or description.
 * Those are the venue's text (B-5), and a signed document should not put the
 * agent's signature on a third party's prose — the `productId` is what the
 * venue is authoritative about, and it is enough to settle what was ordered.
 */
import { stellarContractIdSchema, stellarDidSchema, decimalAmountSchema } from "@agentpass/core";
import { z } from "zod";

import { assetIdSchema, venueIdSchema } from "../catalog/ids.js";
import { productIdSchema } from "../catalog/catalog.js";
import { fromScaledAmount, multiplyAmount } from "../scope/amount.js";

export const AGENTPAY_INTENT_TYPE = "PurchaseIntent";
export const AGENTPAY_INTENT_FAMILY = "AgentPayIntent";

/** How long an intent stays valid unless the caller says otherwise. */
export const DEFAULT_INTENT_TTL_SECONDS = 900;

/**
 * Which credential authorised this, and where its status can be checked.
 *
 * `hash` is `sha256` of the credential's compact JWS — the key the registry
 * answers about, and the same value the credential itself refuses to carry
 * (a document cannot contain its own hash). A verifier holding this intent can
 * ask the registry whether that credential is still active, which is what makes
 * the intent revocable after the fact rather than a bearer token.
 */
export const intentCredentialRefSchema = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256"),
  registry: stellarContractIdSchema,
});

/** One product: what every intent was before T148, and what a one-line purchase still is, byte for byte. */
export const intentSingleSchema = z.strictObject({
  productId: productIdSchema,
  quantity: z.int().min(1),
  /** Price of one unit, exactly as the venue quoted it. */
  unitAmount: decimalAmountSchema,
  /** `unitAmount x quantity`, computed in scaled integers, never a float. */
  totalAmount: decimalAmountSchema,
  asset: assetIdSchema,
});

/** The most lines one intent may carry: a store's checkout carries at most ten (T148). */
export const MAX_INTENT_LINES = 10;

/** One line of a cart: a product, how many, and the price of one unit as the venue quoted it. */
export const intentLineSchema = z.strictObject({
  productId: productIdSchema,
  quantity: z.int().min(1),
  unitAmount: decimalAmountSchema,
});

/**
 * A cart (T148): two to ten lines at the one venue the intent names, all
 * priced in one asset. `totalAmount` is Σ `unitAmount x quantity`, and like
 * the single form's it is never what a decision reads: every check derives
 * the total from the lines again. The same product may appear in two lines.
 */
export const intentCartSchema = z.strictObject({
  lines: z.array(intentLineSchema).min(2).max(MAX_INTENT_LINES),
  totalAmount: decimalAmountSchema,
  asset: assetIdSchema,
});

/** What the intent buys: one product, or a cart. */
export const intentPurchaseSchema = z.union([intentSingleSchema, intentCartSchema]);

/**
 * The limit the total was checked against, copied from the signed credential.
 *
 * Carried so a later verifier can see what the agent believed it was
 * authorised for without re-reading the credential — and so a mismatch between
 * the two is detectable rather than invisible.
 */
export const intentAuthorisationSchema = z.strictObject({
  perTx: decimalAmountSchema,
  currency: z.string().min(1),
});

export const purchaseIntentSchema = z.strictObject({
  type: z.tuple([z.literal(AGENTPAY_INTENT_FAMILY), z.literal(AGENTPAY_INTENT_TYPE)]),
  /** Unique per intent. Two identical orders are still two intents. */
  intentId: z.uuid(),
  issuedAt: z.iso.datetime(),
  /** An intent is not a standing authorisation; it goes stale on purpose. */
  expiresAt: z.iso.datetime(),
  /** The agent, and the key that signed this. Equals the credential's subject. */
  agent: stellarDidSchema,
  /** Who the agent acts for, copied from the credential. */
  principal: stellarDidSchema,
  credential: intentCredentialRefSchema,
  venue: venueIdSchema,
  purchase: intentPurchaseSchema,
  authorisation: intentAuthorisationSchema,
});

export type PurchaseIntent = z.infer<typeof purchaseIntentSchema>;
export type IntentCredentialRef = z.infer<typeof intentCredentialRefSchema>;
export type IntentPurchase = z.infer<typeof intentPurchaseSchema>;
export type IntentLine = z.infer<typeof intentLineSchema>;

/** The lines a purchase is for, in order: one for the single form. */
export function intentLines(purchase: IntentPurchase): readonly IntentLine[] {
  return "lines" in purchase ? purchase.lines : [{ productId: purchase.productId, quantity: purchase.quantity, unitAmount: purchase.unitAmount }];
}

/** Σ `unitAmount x quantity` over the lines, exact, in scaled integers: the total every check compares. */
export function intentTotal(purchase: IntentPurchase): bigint {
  return intentLines(purchase).reduce((sum, line) => sum + multiplyAmount(line.unitAmount, line.quantity), 0n);
}

/**
 * The four facts `checkScope` takes, for either form. A cart is presented as
 * one unit priced at its total, so `perTx` is compared against the whole cart
 * and `checkScope` itself stays exactly as it was (it is never given a
 * product, one or many).
 */
export function scopeRequestOf(intent: Pick<PurchaseIntent, "venue" | "purchase">): { venue: string; asset: string; unitAmount: string; quantity: number } {
  const { purchase } = intent;
  if ("lines" in purchase) return { venue: intent.venue, asset: purchase.asset, unitAmount: fromScaledAmount(intentTotal(purchase)), quantity: 1 };
  return { venue: intent.venue, asset: purchase.asset, unitAmount: purchase.unitAmount, quantity: purchase.quantity };
}
export type IntentAuthorisation = z.infer<typeof intentAuthorisationSchema>;
