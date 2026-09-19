/**
 * PolicyRail: the single point where a purchase is authorised, or is not.
 *
 * Everything before this milestone answered one question each and stayed pure:
 * `checkScope` (T12) for what the issuer signed, `checkMandate` (T17) for what
 * the principal consented to, `reconcileTerms` for whether the venue is asking
 * for the purchase that was actually signed, `checkDailyLimit` (T18) for
 * whether today's running total still has room. None of them can enforce
 * anything on its own — a check nobody is obliged to call is a suggestion.
 * This is the thing that is obliged to call all of them, in one place, and
 * that a caller cannot partially satisfy.
 *
 * **This is not a fallback.** The real bazaar's own state machine names a
 * `buyer policy authorization` step between the 402 challenge and settlement,
 * owned by the buyer and described as "independent allowlist, budget and card
 * reconciliation" — `M-11`. That is this function, and it needs no cooperation
 * from the venue to exist. The on-chain smart account (T22) is a second
 * implementation of the same port, not a replacement for this one.
 *
 * The port is `authorise(request)`, so the on-chain rail can sit behind it
 * later without any caller learning it changed. `LocalPolicyRail` is the
 * off-chain implementation, and it holds no state of its own except the
 * ledger (`M-13`).
 */
import type { Scope } from "@agentpass/core";
import { AgentPassError } from "@agentpass/core";
import type { AgentPayMandate } from "@agentpey/mandate";

import type { PurchaseIntent } from "../intent/intent.js";
import { checkDailyLimit, type DailyLimitRejectionCode } from "../ledger/check-daily-limit.js";
import type { LockedSpendLedger, ReleaseSpendInput, SpendLedger } from "../ledger/spend-ledger.js";
import { checkMandate, type MandateRejectionCode } from "../mandate/check-mandate.js";
import { checkScope, type ScopeRejectionCode } from "../scope/scope.js";
import { reconcileTerms, type PaymentTerms, type TermsRejectionCode } from "./terms.js";

export type AuthorisationRejectionCode =
  | TermsRejectionCode
  | ScopeRejectionCode
  | MandateRejectionCode
  | DailyLimitRejectionCode;

/**
 * Everything the rail needs to decide, passed in rather than held (`M-13`).
 *
 * `scope` and `mandate` arrive **already verified** — a `Scope` lifted out of
 * a credential that verified, and a mandate whose signature and window were
 * checked by `@agentpey/mandate`. PolicyRail decides; it does not verify
 * signatures, exactly as `checkScope` knows nothing about cryptography.
 */
export interface AuthorisationRequest {
  readonly intent: PurchaseIntent;
  /** From the verified credential: what its issuer signed. */
  readonly scope: Scope;
  /** The verified mandate: what the principal consented to. */
  readonly mandate: AgentPayMandate;
  /**
   * What the venue is asking to be paid, when there is a challenge to
   * reconcile against. Absent on the mock-catalogue path, where no venue has
   * asked for anything yet — and the granted decision says so in `reconciled`
   * rather than implying a check that did not happen (`M-14`).
   */
  readonly terms?: PaymentTerms;
}

export interface AuthorisationGranted {
  readonly authorised: true;
  /** The intent this authorisation is for, and the key its spend was recorded under. */
  readonly intentId: string;
  /** `unitAmount x quantity`, exact, to seven decimals. */
  readonly total: string;
  readonly currency: string;
  /** Today's total for this agent **including** this purchase. */
  readonly spentToday: string;
  /** Whether payment terms were reconciled, or there were none to reconcile. */
  readonly reconciled: boolean;
}

export interface AuthorisationRefused {
  readonly authorised: false;
  readonly code: AuthorisationRejectionCode;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type AuthorisationDecision = AuthorisationGranted | AuthorisationRefused;

/**
 * The port. Two methods, because a granted authorisation has a consequence
 * that sometimes has to be undone — `authorise` reserves budget, `release`
 * gives it back when the purchase provably never happened (`C-113`). There is
 * still only one question; `release` is the answer to what happens when the
 * world does not follow through on it.
 *
 * `authorised` rather than the `allowed` the pure checks use, and deliberately:
 * a granted authorisation has **recorded a spend** (`M-15`). Calling it is not
 * free of consequences the way calling `checkScope` is, and the two words
 * being different is the cheapest possible reminder of that.
 */
export interface PolicyRail {
  authorise(request: AuthorisationRequest): Promise<AuthorisationDecision>;
  /**
   * The other half of `authorise`'s consequence: give back the spend it
   * recorded, because the purchase it reserved budget for provably never
   * reached the network (`C-113`, T92).
   *
   * **The caller must have proof, not a guess.** The only failures that
   * qualify are the ones that happened before anything signed left the
   * process — `executeBazaarPayment` marks exactly that on every error it
   * throws (`details.paymentSent`), and everything upstream of it is
   * unambiguously pre-payment. A failure that *might* have paid is never
   * released: `M-15`'s core reasoning is unchanged, and under-counting a
   * day's spend is the direction it calls unsafe.
   *
   * @throws AgentPassError `SpendNotRecorded` for an intent with nothing to
   * give back — never silence, so a caller releasing the wrong id finds out.
   */
  release(input: ReleaseSpendInput): Promise<void>;
}

export interface LocalPolicyRailDeps {
  readonly ledger: SpendLedger;
  /**
   * The clock the day boundary is read from. Never `intent.issuedAt`: that
   * field is signed by the agent, over its own document, so an agent that
   * wanted to reset its daily budget would only have to date the intent
   * yesterday (`M-16`).
   */
  readonly now?: () => Date;
}

function refuse(
  code: AuthorisationRejectionCode,
  reason: string,
  details: Readonly<Record<string, unknown>>,
): AuthorisationRefused {
  return { authorised: false, code, reason, details };
}

/**
 * The off-chain PolicyRail.
 *
 * Authorisations are serialised per subject: the read of today's total, the
 * decision, and the recording of the spend happen inside one critical section,
 * closing the TOCTOU that `M-10` deferred to this milestone (`M-15`).
 *
 * `M-15` originally closed this with an in-memory promise chain and said so
 * out loud: "it holds within this process and nowhere else — with a durable
 * ledger behind more than one instance, this has to become a database
 * transaction or a distributed lock." `pnpm run loadtest:perday` (F8, T64)
 * measured exactly that gap with four real, separate Node processes: `perDay`
 * was exceeded even though nothing crashed. This now prefers
 * `ledger.atomically` when the ledger provides one (`@agentpey/vault`'s
 * Postgres backend does — a real cross-process critical section, not a
 * promise chain) and falls back to the original in-process queue otherwise
 * (the in-memory and file-backed ledgers, which cannot outlive one process
 * regardless of what serialises calls to them).
 */
export function createLocalPolicyRail(deps: LocalPolicyRailDeps): PolicyRail {
  const { ledger } = deps;
  const clock = deps.now ?? (() => new Date());

  /** subject -> the tail of that subject's queue of authorisations (fallback path only). */
  const queues = new Map<string, Promise<unknown>>();

  function serialise<T>(subject: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(subject) ?? Promise.resolve();
    // `catch` before chaining: one authorisation that throws must not poison
    // every later authorisation for the same subject.
    const next = previous.then(work, work);
    queues.set(
      subject,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * The critical section, however the ledger backs it: `ledger.atomically`
   * when present, or the in-process `serialise` queue handing `work` the
   * ledger's own (unscoped) methods otherwise. Either way `work` sees the
   * same `LockedSpendLedger` shape, so `authorise()` below never has to know
   * which one it got.
   */
  function criticalSection<T>(subject: string, work: (locked: LockedSpendLedger) => Promise<T>): Promise<T> {
    if (ledger.atomically) {
      return ledger.atomically(subject, work);
    }
    return serialise(subject, () =>
      work({
        spentOn: (s, currency, at) => ledger.spentOn(s, currency, at),
        hasRecorded: (intentId) => ledger.hasRecorded(intentId),
        record: (entry) => ledger.record(entry),
        release: (input) => ledger.release(input),
      }),
    );
  }

  return {
    async authorise(request: AuthorisationRequest): Promise<AuthorisationDecision> {
      const { intent, scope, mandate, terms } = request;

      // 1. Which purchase is this, and who collects it? Before whether it is
      //    permitted (M-14). `grant.payTo` is read straight off the mandate
      //    here, ahead of `checkMandate` below — it is a fact the mandate
      //    declares, not a permission check that needs the others to have
      //    run first.
      if (terms !== undefined) {
        const reconciled = reconcileTerms(intent, terms, mandate.credentialSubject.grant.payTo);
        if (!reconciled.allowed) {
          return refuse(reconciled.code, reconciled.reason, reconciled.details);
        }
      }

      // 2. What the issuer signed. Never handed the product (T12): the four
      //    facts come off the intent, which has no field for a venue's prose.
      const scoped = checkScope(scope, {
        venue: intent.venue,
        asset: intent.purchase.asset,
        unitAmount: intent.purchase.unitAmount,
        quantity: intent.purchase.quantity,
      });
      if (!scoped.allowed) return refuse(scoped.code, scoped.reason, scoped.details);

      // 3. What the principal consented to. Both authorities must allow, and
      //    neither can widen what the other permits (M-4).
      const mandated = checkMandate(mandate, intent);
      if (!mandated.allowed) return refuse(mandated.code, mandated.reason, mandated.details);

      // Both checks above proved the limit currency equals the price's, so
      // the two are the same string and either one names today's budget.
      const currency = scope.limits.currency;
      // `scoped.total` and `mandated.total` are the same arithmetic on the same
      // inputs; using one is not a shortcut past the other.
      const total = scoped.total;
      const subject = intent.agent;

      // 4. The stateful half, in one critical section (M-15).
      return criticalSection(subject, async ({ spentOn, hasRecorded, record }) => {
        const at = clock();
        const spentToday = await spentOn(subject, currency, at);

        // A purchase can be authorised more than once for the same intentId
        // — T19's structural check, then T24's real-terms check, are two
        // `authorise()` calls for one purchase. The ledger already
        // de-duplicates the *recording*; without this, the *check* still
        // added `total` on top of a `spentToday` that, on the second call,
        // already includes it — double-counting one purchase against the
        // daily limit (G-8). A re-verification adds nothing new to check.
        const alreadyRecorded = await hasRecorded(intent.intentId);
        const addition = alreadyRecorded ? "0" : total;

        // Both limits, against the same running total, each with its own code
        // so a caller can tell which authority refused (M-9, M-16).
        const underScope = checkDailyLimit(
          scope.limits.perDay,
          spentToday,
          addition,
          "ScopeDailyLimitExceeded",
        );
        if (!underScope.allowed) {
          return refuse(underScope.code, underScope.reason, underScope.details);
        }

        const underMandate = checkDailyLimit(
          mandate.credentialSubject.grant.limits.perDay,
          spentToday,
          addition,
          "MandateDailyLimitExceeded",
        );
        if (!underMandate.allowed) {
          return refuse(underMandate.code, underMandate.reason, underMandate.details);
        }

        // Recorded on authorising, not on paying: over-counting a purchase
        // that falls through is fail-closed, under-counting is not (M-15).
        // The ledger de-duplicates by intentId, so authorising the same intent
        // twice counts once.
        await record({ subject, intentId: intent.intentId, currency, amount: total, at });

        return {
          authorised: true,
          intentId: intent.intentId,
          total,
          currency,
          spentToday: underScope.total,
          reconciled: terms !== undefined,
        };
      });
    },

    /**
     * Inside the same critical section `authorise` records in, keyed on the
     * same subject — a release racing an authorisation for the same agent
     * must not let either read a total the other is halfway through changing.
     *
     * The subject is not a parameter: it is read off the recorded spend by
     * the ledger itself, which is also the only thing that knows the amount
     * and the day. That leaves `criticalSection` needing a key before the
     * ledger has looked anything up, so it locks on the intent. For the
     * Postgres vault that is immaterial — `atomically` ignores the key and
     * locks the whole tenant's chain, which is strictly wider. For the
     * in-process fallback it is narrower than the subject's own queue, and
     * that is sound for the same reason: those ledgers cannot outlive one
     * process, and within one process `release`'s read-modify-write of the
     * totals map runs without an `await` in the middle.
     */
    async release(input: ReleaseSpendInput): Promise<void> {
      await criticalSection(input.intentId, ({ release }) => release(input));
    },
  };
}

/** Turns a refusal into the typed error the tool boundary raises. */
export function policyRailError(refused: AuthorisationRefused): AgentPassError {
  return new AgentPassError(refused.code, refused.reason, { details: refused.details });
}
