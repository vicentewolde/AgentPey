/**
 * The merchant's response to an AgentResolve claim — T126, `E-20` to `E-22`.
 *
 * v0 heard one side (annex gap 15). Now the merchant answers: a position
 * (accept all, accept part, or contest), a statement and evidence. The
 * merchant's owner signs it with their **wallet** (SEP-53 `signMessage`,
 * Freighter), from the payout account the merchant itself wrote into the
 * receipt (`merchantAccount`). That is the key the owner logs into the
 * Vitrinee portal with (`VT-29`), and one AgentPey never holds.
 *
 * A wallet cannot sign a JWS (`@agentpass/core`'s `sep53.ts`), so this follows
 * the wallet-signed Mandate (`@agentpey/mandate`'s `wallet-sign.ts`): the
 * document's canonical JSON is hashed, and the wallet signs a short readable
 * message that carries that hash. The page that builds the message
 * (`apps/web/public/resolve/responder.js`) and this verifier must agree byte
 * for byte; a test holds them together.
 *
 * Everything in `statement` and `evidence` is the merchant's text, shown to
 * the arbiter as data and never trusted as instructions, exactly like the
 * claim (`E-17`).
 */
import { createHash } from "node:crypto";

import { AgentPassError, canonicalJson, didToStellarAddress, stellarDidSchema, verifyStellarMessage } from "@agentpass/core";
import type { ReceiptClaims } from "@vitrinee/core";
import { z } from "zod";

import { claimEvidenceSchema } from "./claim.js";

export const AGENTRESOLVE_RESPONSE_TYPE = "AgentResolveResponse";
export const RESPONSE_POSITIONS = ["accept_full", "accept_partial", "contest"] as const;
export type ResponsePosition = (typeof RESPONSE_POSITIONS)[number];

/** How long the merchant has to answer, from the dispute's `opened_at` on chain (`E-22`). */
export const RESPONSE_WINDOW_SECONDS = 48 * 60 * 60;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256");

export const agentResolveResponseSchema = z
  .strictObject({
    type: z.literal(AGENTRESOLVE_RESPONSE_TYPE),
    responseId: z.uuid(),
    /** The signer: must be the receipt's `merchantAccount`. */
    respondent: stellarDidSchema,
    receiptHash: hex64,
    /** `sha256` of the claim's JWS: the `claim_hash` stored on chain. */
    claimHash: hex64,
    claimId: z.uuid(),
    position: z.enum(RESPONSE_POSITIONS),
    /** What the merchant accepts to refund, in atomic units. Only for `accept_partial`; `null` otherwise. */
    acceptedAtomic: z.string().regex(/^[1-9]\d*$/, "expected a positive integer in atomic units").nullable(),
    statement: z.string().trim().min(1).max(2000),
    evidence: z.array(claimEvidenceSchema).max(5),
    createdAt: z.iso.datetime(),
  })
  .refine((response) => (response.position === "accept_partial") === (response.acceptedAtomic !== null), {
    message: "acceptedAtomic is required for accept_partial and must be null otherwise",
    path: ["acceptedAtomic"],
  });

export type AgentResolveResponse = z.infer<typeof agentResolveResponseSchema>;

/** The file the page hands the merchant, and the merchant hands the arbiter. */
export const signedResponseFileSchema = z.strictObject({
  response: z.unknown(),
  /** The wallet's SEP-53 signature over {@link responseChallengeMessage}, base64. */
  signature: z.string().min(1),
});

/** `sha256` of the response's canonical JSON, lowercase hex: what the message carries and the verdict records. */
export function responseHash(response: AgentResolveResponse): string {
  return createHash("sha256").update(canonicalJson(response), "utf8").digest("hex");
}

/** Atomic units of a 7-decimal asset as a decimal string: `5000000` → `0.5000000`. */
export function formatAtomic(atomic: string): string {
  const padded = atomic.padStart(8, "0");
  return `${padded.slice(0, -7)}.${padded.slice(-7)}`;
}

/**
 * What the wallet shows and signs: readable in Freighter's approval popup
 * (what is being answered, and the position), plus the document's hash so the
 * signature covers these exact bytes and no others.
 */
export function responseChallengeMessage(response: AgentResolveResponse): string {
  const position = response.acceptedAtomic === null ? response.position : `${response.position} ${formatAtomic(response.acceptedAtomic)} USDC`;
  return [
    "AgentResolve merchant response",
    `Receipt: ${response.receiptHash}`,
    `Claim: ${response.claimHash}`,
    `Position: ${position}`,
    `Hash: ${responseHash(response)}`,
  ].join("\n");
}

/** The dispute a response must answer: what is on chain and in the verified receipt, never what the response says. */
export interface ResponseContext {
  readonly receipt: ReceiptClaims;
  readonly receiptHash: string;
  /** The `claim_hash` the contract holds for this receipt. */
  readonly claimHash: string;
  readonly claimId: string;
  readonly disputedAtomic: bigint;
}

export interface VerifiedResponse {
  readonly response: AgentResolveResponse;
  readonly hash: string;
  readonly signature: string;
}

function fail(
  code: "ResolveResponseInvalid" | "ResolveRespondentNotMerchant" | "ResolveResponseMismatch",
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): AgentPassError {
  return new AgentPassError(code, message, { details, cause });
}

/**
 * Verifies a signed response file against the dispute it claims to answer.
 * The signature is checked before anything about the content, so a forged
 * response never reports as merely "about another claim".
 *
 * @throws AgentPassError `ResolveResponseInvalid` — not a response file, off its schema, a bad signature, or a partial amount outside (0, disputed)
 * @throws AgentPassError `ResolveRespondentNotMerchant` — signed by an account other than the receipt's `merchantAccount`
 * @throws AgentPassError `ResolveResponseMismatch` — about another receipt or another claim than the dispute on chain
 */
export function verifyMerchantResponse(file: unknown, context: ResponseContext): VerifiedResponse {
  const envelope = signedResponseFileSchema.safeParse(file);
  if (!envelope.success) throw fail("ResolveResponseInvalid", "not a signed response file", { issues: envelope.error.issues.map((i) => i.message) }, envelope.error);
  const parsed = agentResolveResponseSchema.safeParse(envelope.data.response);
  if (!parsed.success) throw fail("ResolveResponseInvalid", "the response does not match its schema", { issues: parsed.error.issues.map((i) => i.message) }, parsed.error);
  const response = parsed.data;
  const { signature } = envelope.data;

  const signer = didToStellarAddress(response.respondent);
  if (!verifyStellarMessage(signer, responseChallengeMessage(response), signature)) {
    throw fail("ResolveResponseInvalid", "the wallet signature does not verify against the respondent", { respondent: response.respondent });
  }

  // A contract payout account could not have signed with a wallet; the
  // signer is held to the one account the merchant named in its own receipt.
  const merchant = context.receipt.merchantAccount;
  if (!merchant.startsWith("G") || signer !== merchant) {
    throw fail("ResolveRespondentNotMerchant", "the response is not signed by the receipt's payout account", { respondent: signer, merchantAccount: merchant });
  }

  if (response.receiptHash !== context.receiptHash || response.claimHash !== context.claimHash || response.claimId !== context.claimId) {
    throw fail("ResolveResponseMismatch", "the response answers another receipt or claim than the dispute on chain", {
      response: { receipt: response.receiptHash, claim: response.claimHash, claimId: response.claimId },
      dispute: { receipt: context.receiptHash, claim: context.claimHash, claimId: context.claimId },
    });
  }

  if (response.acceptedAtomic !== null) {
    const accepted = BigInt(response.acceptedAtomic);
    if (accepted >= context.disputedAtomic) {
      throw fail("ResolveResponseInvalid", "a partial acceptance must be less than the disputed amount", { accepted: response.acceptedAtomic, disputed: context.disputedAtomic.toString() });
    }
  }

  return { response, hash: responseHash(response), signature };
}

/** When a dispute opened at `openedAt` (seconds, the contract's ledger time) may be decided without a response. */
export function responseDeadline(openedAt: number): Date {
  return new Date((openedAt + RESPONSE_WINDOW_SECONDS) * 1000);
}

/**
 * A dispute is decided with the merchant's response, or, without one, only
 * after its 48 h (`E-22`). A response that arrives late but before the
 * decision still counts: the deadline only stops a one-sided decision.
 *
 * @throws AgentPassError `ResolveResponsePending` — no response, and the deadline has not passed
 */
export function assertMayDecide(input: { readonly openedAt: number; readonly hasResponse: boolean; readonly now?: Date }): void {
  if (input.hasResponse) return;
  const deadline = responseDeadline(input.openedAt);
  const now = input.now ?? new Date();
  if (now.getTime() < deadline.getTime()) {
    throw new AgentPassError("ResolveResponsePending", "the merchant has until the deadline to respond; decide with its response, or after the deadline", {
      details: { deadline: deadline.toISOString(), now: now.toISOString() },
    });
  }
}
