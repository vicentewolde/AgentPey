/**
 * The Mandate: the principal's signed consent.
 *
 * A credential (phase 1) says *who this agent is and what its issuer believes
 * it may do*. A purchase intent (phase 2) says *what this agent wants to do
 * right now*. The Mandate is the third statement, and the one that was missing:
 * **the principal's own signature on "I authorise this agent to spend up to
 * this much, at these venues, in these assets, until this date."**
 *
 * It is a different document, not a different cryptography (see `sign.ts`).
 * The envelope is the same W3C VC 2.0 shape phase 1 already uses, for one
 * concrete reason beyond familiarity: the registry's `anchor(issuer, hash,
 * subject, expires_at)` maps onto `issuer` / `sha256(jws)` /
 * `credentialSubject.id` / `validUntil` with nothing left over, so a mandate
 * can be anchored and revoked by the existing contract without changing it.
 *
 * **The issuer *is* the principal.** There is no separate `principal` field
 * duplicating it: two fields that must always agree are a bug waiting for the
 * one code path that forgets to check.
 */
import {
  VC_CONTEXT_V2,
  credentialStatusSchema,
  scopeSchema,
  stellarDidSchema,
  type Scope,
} from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk/base";
import { z } from "zod";

export const AGENTPAY_MANDATE_TYPE = "AgentPayMandate";

/**
 * A Stellar payee: a classic account (`G...`) or a contract (`C...`) — the
 * same either-or `parseAssetId` already accepts for an asset's issuer,
 * because a real x402 challenge's `payTo` can be either.
 */
const payeeSchema = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value), {
    message: "expected a Stellar account (G...) or contract (C...) address",
  });

/**
 * What the principal authorises. `scopeSchema` extended, not reused verbatim
 * as before `M-14`: phase 3 still compares a mandate's grant against a
 * credential's scope field by field (`venues`, `assets`, `limits` — `M-4`),
 * and that comparison stays meaningful with one extra field neither the
 * comparison nor the credential's scope needs to know about.
 *
 * `payTo` is **optional**, deliberately or the same way `terms` already is in
 * `PolicyRail.authorise()` (`M-14`): a mandate written before this field
 * existed, or one that intentionally leaves it open, has nothing to check
 * against, and `reconcileTerms` leaves `payTo` unchecked exactly as it did
 * before — not silently, `reconciled` and the terms check both say so. Once
 * present, it follows `B-1`'s rule for `venues`/`assets`: an empty array
 * permits no payee, it does not mean "unchecked".
 *
 * `products` is the same idea applied to *what* may be bought, added in T73
 * for F9 and following `payTo`'s precedent field for field: optional, so
 * every mandate signed before this existed keeps meaning exactly what it
 * meant; unchecked when absent, and saying so out loud rather than silently;
 * and, once present, an empty array permits no product rather than permitting
 * all of them.
 *
 * **Why this belongs on the grant and not on the credential's `scope`.** A
 * product allowlist is the principal narrowing their own consent — "you may
 * spend at this merchant, but only on this" — which is exactly what a grant
 * is for. `scopeSchema` stays untouched: the issuer's belief about what an
 * agent may do is not the place where a buyer's shopping list lives, and
 * widening `scopeSchema` would change every credential ever issued as well
 * as the credential-vs-mandate comparison of `M-4`.
 */
export const mandateGrantSchema = scopeSchema.extend({
  payTo: z.array(payeeSchema).optional(),
  products: z.array(z.string().min(1)).optional(),
});

export const mandateSubjectSchema = z.strictObject({
  /** The agent this mandate empowers. Matches the credential's subject. */
  id: stellarDidSchema,
  grant: mandateGrantSchema,
});

export const agentPayMandateSchema = z.strictObject({
  "@context": z.tuple([z.literal(VC_CONTEXT_V2)]),
  type: z.tuple([z.literal("VerifiableCredential"), z.literal(AGENTPAY_MANDATE_TYPE)]),
  /**
   * Unique per mandate.
   *
   * Not decoration: the registry refuses to re-anchor a hash it already holds
   * (phase 1, invariant 1), so two mandates identical in every other field —
   * same agent, same grant, same window — would collide on `sha256(jws)` and
   * the second could never be anchored. A fresh id makes every mandate its own
   * document.
   */
  mandateId: z.uuid(),
  /** The principal. Signs this document, and is who the agent acts for. */
  issuer: stellarDidSchema,
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  credentialSubject: mandateSubjectSchema,
  /**
   * Where this mandate's status is answered — the same registry, with the same
   * `Active | Revoked | Expired | Unknown` semantics, as a credential. Keeping
   * the VC property name (`credentialStatus`) rather than inventing
   * `mandateStatus` is deliberate: it is the W3C property, and generic VC
   * tooling can read it.
   */
  credentialStatus: credentialStatusSchema,
});

export type AgentPayMandate = z.infer<typeof agentPayMandateSchema>;
export type MandateSubject = z.infer<typeof mandateSubjectSchema>;
export type MandateGrant = z.infer<typeof mandateGrantSchema>;

/**
 * The credential's `scope` from a grant — everything `mandateGrantSchema`
 * adds on top of `scopeSchema` (`payTo`, `products`) stripped back off.
 *
 * One function, not a destructuring statement copied into every caller that
 * builds a credential from a proposed grant: `mandateGrantSchema` picked up
 * `products` in T73 after `payTo` (`M-14`) already existed, and the one place
 * in `apps/web` that did this by hand kept excluding only `payTo` — every
 * consent-session wallet-anchor then failed `InvalidCredential: payload does
 * not match the AgentPass schema`, because `scopeSchema` is a `strictObject`
 * and does not know `products`. Found running the real flow with a real
 * wallet, not by reading. A grant with a third optional field added later and
 * forgotten here would fail loudly the same way; centralising the stripping
 * means there is exactly one place to update, not one per caller.
 */
export function grantToScope(grant: MandateGrant): Scope {
  const { payTo: _payTo, products: _products, ...scope } = grant;
  return scope;
}
