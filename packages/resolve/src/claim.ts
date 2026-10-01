/**
 * An AgentResolve claim — T124, `E-14` to `E-19`.
 *
 * Whoever paid a Vitrinee receipt asks for money back: the receipt itself
 * (embedded whole, so the claim stands on its own), what went wrong, the
 * evidence, and how much. Signed as a compact JWS by the claimant's
 * `did:stellar`, with the same machinery as every other signed document in
 * this codebase (`jws-document.ts`): the key comes from the payload, never
 * from `kid`, and the signature is checked before anything about the content.
 *
 * Who may claim is decided by the receipt, not by the claim: the payer
 * account itself, or — when the payer is a contract such as a `policy_rail` —
 * the key that contract says controls it (`owner()`, read on chain by the
 * caller and passed in as `controllerOf`).
 *
 * Everything in `description` and `evidence` is the claimant's text. It is
 * shown to the arbiter as data and never trusted as instructions (`E-17`).
 */
import { AgentPassError, didToStellarAddress, jwsDocumentHash, signJwsDocument, stellarDidSchema, verifyJwsDocument } from "@agentpass/core";
import type { JwsDocumentProfile, SignedJwsDocument, StellarDid } from "@agentpass/core";
import type { ReceiptClaims } from "@vitrinee/core";
import { receiptHash } from "@vitrinee/core";
import type { Keypair } from "@stellar/stellar-sdk/base";
import { z } from "zod";

export const AGENTRESOLVE_CLAIM_TYP = "agentresolve-claim+jwt";
export const AGENTRESOLVE_CLAIM_TYPE = "AgentResolveClaim";

export const CLAIM_REASONS = ["not_delivered", "not_as_described", "damaged", "unauthorized", "other"] as const;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256");

export const claimEvidenceSchema = z.strictObject({
  kind: z.enum(["text", "url"]),
  content: z.string().trim().min(1).max(2000),
});

export const agentResolveClaimSchema = z.strictObject({
  type: z.literal(AGENTRESOLVE_CLAIM_TYPE),
  claimId: z.uuid(),
  /** The signer. Must be the receipt's payer, or the key that controls it. */
  claimant: stellarDidSchema,
  /** The receipt, whole: `hash` is `sha256(jws)`, the value anchored on chain. */
  receipt: z.strictObject({ hash: hex64, jws: z.string().min(1) }),
  reason: z.enum(CLAIM_REASONS),
  description: z.string().trim().min(1).max(2000),
  evidence: z.array(claimEvidenceSchema).max(5),
  /** How much is asked back, in the receipt asset's atomic units. */
  amountAtomic: z.string().regex(/^[1-9]\d*$/, "expected a positive integer in atomic units"),
  createdAt: z.iso.datetime(),
});

export type AgentResolveClaim = z.infer<typeof agentResolveClaimSchema>;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

const claimProfile: JwsDocumentProfile<AgentResolveClaim> = {
  typ: AGENTRESOLVE_CLAIM_TYP,
  schema: agentResolveClaimSchema,
  signerField: "claimant",
  signerDid: (claim) => claim.claimant as StellarDid,
  invalidCode: "ResolveClaimInvalid",
};

/** Signs a claim with the claimant's key. `SignerMismatch` if the key is not `claimant`. */
export function signClaim(claim: AgentResolveClaim, keypair: Keypair): Promise<SignedJwsDocument<AgentResolveClaim>> {
  return signJwsDocument(claimProfile, claim, keypair);
}

/** Verifies a claim's signature and schema, offline. Nothing about the receipt yet: that is {@link checkClaim}. */
export async function verifyClaim(jws: string): Promise<SignedJwsDocument<AgentResolveClaim>> {
  return verifyJwsDocument(claimProfile, jws);
}

/** `sha256(jws)`, lowercase hex: what the contract stores as `claim_hash`. */
export function claimHash(jws: string): string {
  return jwsDocumentHash(jws);
}

/** A receipt whose three checks passed (`verifyReceipt` in `@vitrinee/anchor`): signature, anchored, settled. */
export interface VerifiedReceipt {
  readonly valid: true;
  readonly hash: string;
  readonly receipt: ReceiptClaims;
}

export interface CheckClaimOptions {
  /**
   * For a contract payer (`C...`): the `G...` account that controls it, read
   * on chain. A `policy_rail` answers with its `owner()`. Not called for a
   * classic payer.
   */
  readonly controllerOf: (payer: string) => Promise<string>;
  readonly now?: Date;
}

export interface CheckedClaim {
  readonly claim: AgentResolveClaim;
  readonly receipt: ReceiptClaims;
  /** The amount the dispute locks: what the claim asks, never more than the receipt. */
  readonly disputedAtomic: bigint;
  /** Where any refund goes: the receipt's payer. */
  readonly payer: string;
}

function fail(code: "ResolveReceiptInvalid" | "ResolveClaimantNotPayer" | "ResolveClaimWindowClosed" | "ResolveAmountExceeded", message: string, details: Readonly<Record<string, unknown>>): AgentPassError {
  return new AgentPassError(code, message, { details });
}

/**
 * Whether a verified claim may open a dispute over a verified receipt.
 *
 * @throws AgentPassError `ResolveReceiptInvalid` — the receipt did not verify, or is not the one the claim embeds
 * @throws AgentPassError `ResolveClaimWindowClosed` — past the receipt's `refundWindowEndsAt`
 * @throws AgentPassError `ResolveAmountExceeded` — more than the receipt paid
 * @throws AgentPassError `ResolveClaimantNotPayer` — the signer is not the payer nor its controller
 */
export async function checkClaim(claim: AgentResolveClaim, verified: VerifiedReceipt, options: CheckClaimOptions): Promise<CheckedClaim> {
  if (!verified.valid) throw fail("ResolveReceiptInvalid", "the receipt did not pass its three checks", { hash: verified.hash });
  if (receiptHash(claim.receipt.jws) !== claim.receipt.hash || claim.receipt.hash !== verified.hash) {
    throw fail("ResolveReceiptInvalid", "the claim embeds a different receipt than the one verified", { claimed: claim.receipt.hash, verified: verified.hash });
  }
  const { receipt } = verified;

  const now = options.now ?? new Date();
  if (now.getTime() > Date.parse(receipt.refundWindowEndsAt)) {
    throw fail("ResolveClaimWindowClosed", "the receipt's refund window has closed", { refundWindowEndsAt: receipt.refundWindowEndsAt });
  }

  const disputedAtomic = BigInt(claim.amountAtomic);
  if (disputedAtomic > BigInt(receipt.amountUSDCAtomic)) {
    throw fail("ResolveAmountExceeded", "the claim asks for more than the receipt paid", { claimed: claim.amountAtomic, paid: receipt.amountUSDCAtomic });
  }

  const signer = didToStellarAddress(claim.claimant);
  const payer = receipt.payerAccount;
  const allowed = payer.startsWith("C") ? await options.controllerOf(payer) : payer;
  if (signer !== allowed) {
    throw fail("ResolveClaimantNotPayer", "the claimant is not the receipt's payer, nor the key that controls it", { claimant: signer, payer, controller: allowed });
  }

  return { claim, receipt, disputedAtomic, payer };
}
