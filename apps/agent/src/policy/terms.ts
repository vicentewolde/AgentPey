/**
 * Reconciling what the venue is asking to be paid against what was signed.
 *
 * Every other check in this phase answers *is this purchase permitted*. This
 * one answers *which purchase is this*, and that is why `authorise()` runs it
 * first (`M-14`): a limit satisfied by the intent says nothing if the payment
 * about to be signed is for a different venue, a different asset or a
 * different amount. Answering "permitted" about the wrong purchase is not a
 * weak check — it is a check about something else.
 *
 * The shape below is deliberately **ours**, not x402's. The real bazaar's 402
 * challenge carries a `PaymentRequirements` with `scheme`, `network`, `payTo`,
 * `asset`, `amount`, `maxTimeoutSeconds` and an `extra` block; mapping that
 * onto these three fields is an adapter's job (T15), so nothing in phase 3
 * ends up importing a third party's types into its policy layer.
 *
 * **`payTo` — the account that collects the money, and the most sensitive
 * field of the challenge.** `M-14` originally left it unchecked: neither the
 * credential's `scope` nor the mandate's `grant` carried a list of permitted
 * payees, so comparing it against anything would have been the illusion of a
 * check. The mandate's `grant.payTo` (optional — see `mandate.ts`) closes
 * that gap when a mandate sets it; a mandate that leaves it unset gets the
 * old, honest behaviour back: `payTo` unchecked, not faked.
 */
import { AgentPassError } from "@agentpass/core";

import { intentTotal, type PurchaseIntent } from "../intent/intent.js";
import { fromScaledAmount, toScaledAmount } from "../scope/amount.js";

/**
 * What a venue is asking to be paid, reduced to the facts a signed document
 * can be compared against.
 *
 * Three scalars, and — as with {@link ScopeRequest} — no field here through
 * which a venue's prose could travel.
 */
export interface PaymentTerms {
  /** The venue asking for payment, canonical form (`B-3`). */
  readonly venue: string;
  /** The asset it wants to be paid in, canonical form (`B-3`). */
  readonly asset: string;
  /** The total it is asking for, as a decimal string. */
  readonly amount: string;
  /**
   * Who collects the payment, when the challenge names one. Checked only
   * when the mandate's `grant.payTo` is also present (`M-14`) — see
   * {@link reconcileTerms}.
   */
  readonly payTo?: string;
}

export type TermsRejectionCode =
  | "TermsVenueMismatch"
  | "TermsAssetMismatch"
  | "TermsAmountMismatch"
  | "TermsPayeeNotAllowed";

export interface TermsAllowed {
  readonly allowed: true;
}

export interface TermsDenied {
  readonly allowed: false;
  readonly code: TermsRejectionCode;
  readonly reason: string;
  /** Structured context — what was asked for, and what the intent says. */
  readonly details: Readonly<Record<string, unknown>>;
}

export type TermsDecision = TermsAllowed | TermsDenied;

function deny(
  code: TermsRejectionCode,
  reason: string,
  details: Readonly<Record<string, unknown>>,
): TermsDenied {
  return { allowed: false, code, reason, details };
}

/**
 * Decides whether the venue's terms describe the same purchase the intent does.
 *
 * Pure: no network, no clock, no I/O. The amount comparison goes through
 * `toScaledAmount` rather than comparing strings, so `"18.5"` and `"18.5000000"`
 * are the same amount — a venue that formats its numbers differently is not
 * asking for something different, and a string comparison would say it was.
 *
 * `allowedPayTo` is the mandate's `grant.payTo` (`M-14`), passed in rather
 * than read from a `Mandate` here: this function does not otherwise know
 * about mandates, and a fourth scalar keeps that true. `undefined` (no list
 * on the mandate) or `terms.payTo` absent (a challenge this adapter maps
 * without one) both mean "nothing signed to check against" — the check is
 * skipped, not vacuously satisfied. A list that is present and empty follows
 * `B-1`: it permits no payee.
 */
export function reconcileTerms(
  intent: PurchaseIntent,
  terms: PaymentTerms,
  allowedPayTo?: readonly string[],
): TermsDecision {
  // 1. Is this even the venue the intent names? Byte-for-byte (B-3).
  if (terms.venue !== intent.venue) {
    return deny("TermsVenueMismatch", "the payment terms name a different venue than the intent", {
      termsVenue: terms.venue,
      intentVenue: intent.venue,
    });
  }

  // 2. In the asset the intent was checked in? A total cleared against a limit
  //    in USDC says nothing about the same number of EURC.
  if (terms.asset !== intent.purchase.asset) {
    return deny("TermsAssetMismatch", "the payment terms name a different asset than the intent", {
      termsAsset: terms.asset,
      intentAsset: intent.purchase.asset,
    });
  }

  // 3. For the amount that was actually authorised? Exact integer comparison,
  //    never a float and never a string (`B-14`).
  //
  //    The total is **derived** here — `unitAmount x quantity`, the same
  //    arithmetic every limit check does — rather than read from the intent's
  //    own `totalAmount`. Two reasons, and the second is the one that matters:
  //    the rail would otherwise reconcile against one number and charge the
  //    day's budget another; and an intent whose `totalAmount` disagrees with
  //    its own price and quantity cannot influence any decision, because no
  //    decision ever reads that field.
  const asked = toScaledAmount(terms.amount);
  //    A cart's (T148) is the sum over its lines: one payment for all of them.
  const authorised = intentTotal(intent.purchase);

  // Not `asked > authorised`: a venue asking for *less* is also not the
  // purchase that was authorised, and quietly accepting it would mean the
  // signed price stopped being the thing being paid.
  if (asked !== authorised) {
    return deny("TermsAmountMismatch", "the payment terms ask for a different amount than the intent", {
      termsAmount: terms.amount,
      intentTotal: fromScaledAmount(authorised),
      asset: intent.purchase.asset,
    });
  }

  // 4. Is this a payee the mandate consented to? Only when there is
  //    something signed to check it against (M-14) — see the doc comment.
  if (allowedPayTo !== undefined && terms.payTo !== undefined) {
    if (!allowedPayTo.includes(terms.payTo)) {
      return deny("TermsPayeeNotAllowed", "the mandate does not permit paying this account", {
        payTo: terms.payTo,
        permitted: allowedPayTo,
        permitsNothing: allowedPayTo.length === 0,
      });
    }
  }

  return { allowed: true };
}

/** Turns a denial into the typed error the tool boundary raises. */
export function termsError(denied: TermsDenied): AgentPassError {
  return new AgentPassError(denied.code, denied.reason, { details: denied.details });
}
