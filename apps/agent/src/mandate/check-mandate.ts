/**
 * The mandate check: does the principal's own consent cover this purchase?
 *
 * Same discipline as `checkScope` (T12): pure, no network, no clock. It takes
 * a verified `AgentPayMandate` and a verified `PurchaseIntent` — never a
 * `Product` and never a venue's prose. That is automatic here rather than
 * enforced by a narrow request type, because a `PurchaseIntent` never carries
 * one in the first place (`B-19`): there is no field in either input for
 * third-party text to travel in.
 *
 * `M-4`: this is one of the two authorities an intent has to satisfy, not the
 * only one. `checkScope` (the credential's `scope.limits`) and `checkMandate`
 * (the mandate's `grant`) are both run, and both must allow — neither can
 * widen what the other permits, only narrow it. Composing the two is a later
 * hito's job (T19); this function only answers for the mandate.
 *
 * `grant` is `scopeSchema` plus the two fields only a principal's consent has
 * (`payTo`, `M-14`; `products`, T73), so most of these checks mirror
 * `checkScope`'s exactly. What is new here, because a mandate names two
 * identities where a credential's scope names none, are the two identity
 * checks — the window check, because a mandate (unlike `scope.limits`) has
 * its own validity period that an intent can be compared against directly —
 * and the product check, which has no counterpart in a credential's scope at
 * all and is skipped when the grant does not carry one.
 *
 * What this does **not** do: `grant.limits.perDay`. A daily total needs memory
 * of past spending — enforcement with state, which is T18's job, exactly the
 * boundary `B-16` already drew for the credential's own `perTx`/`perDay` split.
 */
import type { AgentPayMandate } from "@agentpey/mandate";
import { AgentPassError } from "@agentpass/core";

import { parseAssetId } from "../catalog/ids.js";
import { intentLines, intentTotal, type PurchaseIntent } from "../intent/intent.js";
import { INTENT_CREATE_ACTION } from "../scope/scope.js";
import { fromScaledAmount, toScaledAmount } from "../scope/amount.js";

export type MandateRejectionCode =
  | "MandateAgentMismatch"
  | "MandatePrincipalMismatch"
  | "MandateActionNotAllowed"
  | "MandateVenueNotAllowed"
  | "MandateProductNotAllowed"
  | "MandateAssetNotAllowed"
  | "MandateCurrencyMismatch"
  | "MandateWindowMismatch"
  | "MandateAmountExceeded";

export interface MandateAllowed {
  readonly allowed: true;
  /** `purchase.unitAmount x purchase.quantity`, or the sum over a cart's lines (T148), exact, to seven decimals. */
  readonly total: string;
  /** The `perTx` limit it was compared against, copied from the mandate. */
  readonly limit: string;
}

export interface MandateDenied {
  readonly allowed: false;
  readonly code: MandateRejectionCode;
  readonly reason: string;
  /** Structured context — what was asked for, and what the mandate permits. */
  readonly details: Readonly<Record<string, unknown>>;
}

export type MandateDecision = MandateAllowed | MandateDenied;

function deny(
  code: MandateRejectionCode,
  reason: string,
  details: Readonly<Record<string, unknown>>,
): MandateDenied {
  return { allowed: false, code, reason, details };
}

/**
 * Decides whether a mandate covers one purchase intent.
 *
 * The checks run broadest first, same as `checkScope`: does this mandate even
 * apply to these two parties, before whether it covers this venue, this
 * asset, this window, this amount — so the reason reported is the most
 * fundamental one that failed.
 */
export function checkMandate(mandate: AgentPayMandate, intent: PurchaseIntent): MandateDecision {
  const grant = mandate.credentialSubject.grant;

  // 1. Does this mandate even empower this agent? Byte-for-byte, per B-3's
  //    rule for identifiers: a DID that differs by one byte names another
  //    subject.
  if (mandate.credentialSubject.id !== intent.agent) {
    return deny("MandateAgentMismatch", "this mandate does not empower this agent", {
      mandateAgent: mandate.credentialSubject.id,
      intentAgent: intent.agent,
    });
  }

  // 2. Was it this principal who signed it? An intent can name any principal;
  //    only a mandate whose issuer agrees is evidence of that principal's
  //    consent.
  if (mandate.issuer !== intent.principal) {
    return deny("MandatePrincipalMismatch", "this mandate was not signed by the intent's principal", {
      mandateIssuer: mandate.issuer,
      intentPrincipal: intent.principal,
    });
  }

  // 3. May this agent create purchase intents at all, under this consent?
  if (!grant.actions.includes(INTENT_CREATE_ACTION)) {
    return deny(
      "MandateActionNotAllowed",
      `this mandate does not permit "${INTENT_CREATE_ACTION}"`,
      { required: INTENT_CREATE_ACTION, permitted: grant.actions },
    );
  }

  // 4. Was this venue consented to? Empty permits none (B-1).
  if (!grant.venues.includes(intent.venue)) {
    return deny("MandateVenueNotAllowed", "this mandate does not permit this venue", {
      venue: intent.venue,
      permitted: grant.venues,
      permitsNothing: grant.venues.length === 0,
    });
  }

  // 5. Was *this product* consented to? Unlike every check around it, this
  //    one is skipped entirely when the grant does not carry `products` —
  //    the same posture `payTo` has in `reconcileTerms` (`M-14`). A mandate
  //    signed before this field existed said nothing about products, and
  //    reading silence as a restriction would retroactively narrow consent
  //    nobody gave; reading it as permission is what it actually meant. Once
  //    the field is present it obeys `B-1` like `venues`/`assets` do: an
  //    empty array permits nothing.
  //
  //    The product ids are the venue's own identifiers, carried in a signed
  //    intent — not a `Product` and not the venue's prose, so `B-19`'s rule
  //    still holds: no third-party text reaches this decision. A cart (T148)
  //    is permitted only if every one of its lines is: one product the
  //    principal did not consent to refuses the whole purchase.
  if (grant.products !== undefined) {
    const lines = intentLines(intent.purchase);
    const refused = lines.find((line) => !grant.products!.includes(line.productId));
    if (refused !== undefined) {
      return deny("MandateProductNotAllowed", "this mandate does not permit this product", {
        productId: refused.productId,
        ...(lines.length > 1 ? { line: lines.indexOf(refused) } : {}),
        permitted: grant.products,
        permitsNothing: grant.products.length === 0,
      });
    }
  }

  // 6. Was this asset consented to?
  if (!grant.assets.includes(intent.purchase.asset)) {
    return deny("MandateAssetNotAllowed", "this mandate does not permit this asset", {
      asset: intent.purchase.asset,
      permitted: grant.assets,
      permitsNothing: grant.assets.length === 0,
    });
  }

  // 7. Is the mandate's limit even denominated in what the intent is
  //    denominated in? An incomparable limit is not a limit that was
  //    satisfied — same rule as B-15.
  const priceCode = parseAssetId(intent.purchase.asset).code;
  if (priceCode !== grant.limits.currency) {
    return deny(
      "MandateCurrencyMismatch",
      "the mandate's spending limit is denominated in a different asset than the price",
      { priceAsset: intent.purchase.asset, priceCurrency: priceCode, limitCurrency: grant.limits.currency },
    );
  }

  // 8. Was this consent even in force when the intent was issued? Both edges
  //    inclusive, matching every other window in the project.
  const issuedAt = new Date(intent.issuedAt).getTime();
  const validFrom = new Date(mandate.validFrom).getTime();
  const validUntil = new Date(mandate.validUntil).getTime();
  if (issuedAt < validFrom || issuedAt > validUntil) {
    return deny("MandateWindowMismatch", "the intent was issued outside the mandate's validity window", {
      issuedAt: intent.issuedAt,
      validFrom: mandate.validFrom,
      validUntil: mandate.validUntil,
    });
  }

  // 9. Is the total within the mandate's perTx? Exact integer arithmetic. A
  //    cart's total is the sum of its lines (T148): one purchase, one limit.
  const total = intentTotal(intent.purchase);
  const limit = toScaledAmount(grant.limits.perTx);

  if (total > limit) {
    return deny("MandateAmountExceeded", "the total exceeds this mandate's per-transaction limit", {
      ...("lines" in intent.purchase
        ? { lines: intent.purchase.lines.length }
        : { unitAmount: intent.purchase.unitAmount, quantity: intent.purchase.quantity }),
      total: fromScaledAmount(total),
      limit: grant.limits.perTx,
      currency: grant.limits.currency,
    });
  }

  return { allowed: true, total: fromScaledAmount(total), limit: grant.limits.perTx };
}

/** Turns a denial into the typed error the tool boundary raises. */
export function mandateCheckError(denied: MandateDenied): AgentPassError {
  return new AgentPassError(denied.code, denied.reason, { details: denied.details });
}
