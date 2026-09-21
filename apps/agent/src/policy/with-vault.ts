/**
 * Wraps a {@link PolicyRail} so every refusal is also kept in a
 * {@link MandateVault} — Fase 5, T27.
 *
 * A grant needs no wrapping to reach the vault: `LocalPolicyRail.authorise()`
 * already calls `ledger.record()` on success, and a `MandateVault` satisfies
 * `SpendLedger` structurally, so passing one as `deps.ledger` is enough for
 * every grant to persist. Every refusal, though, returns straight from
 * `authorise()` without ever touching the ledger — `checkScope`, `checkMandate`
 * and `checkDailyLimit` are pure, and `reconcileTerms` runs before the ledger
 * is even reached. This is the one seam that adds nothing to `policy-rail.ts`
 * itself (Fase 3, closed): it observes what the port already returns.
 */
import type { MandateVault } from "@agentpey/vault";

import type { AuthorisationDecision, AuthorisationRequest, PolicyRail } from "./policy-rail.js";

export function withVault(policyRail: PolicyRail, vault: MandateVault): PolicyRail {
  return {
    async authorise(request: AuthorisationRequest): Promise<AuthorisationDecision> {
      const decision = await policyRail.authorise(request);
      if (!decision.authorised) {
        await vault.recordRefusal({
          subject: request.intent.agent,
          intentId: request.intent.intentId,
          code: decision.code,
          reason: decision.reason,
          details: decision.details,
        });
      }
      return decision;
    },

    /**
     * Forwarded untouched, and deliberately **not** recorded (T93). The vault
     * is the record of decisions that happened; a preview is a question about
     * one that has not. Writing previews into the chain would fill a tenant's
     * evidence with refusals nobody ever ran into, and make "how many times
     * was this agent refused" unanswerable.
     */
    preview: (request) => policyRail.preview(request),

    // Forwarded untouched. A release is already an entry in this same vault —
    // `LocalPolicyRail.release` writes it through the ledger, which *is* the
    // vault — so wrapping it here would record it twice.
    release: (input) => policyRail.release(input),
  };
}
