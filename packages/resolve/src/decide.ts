/**
 * From a checked claim to the verdict AgentPey anchors — T124.
 *
 * The arbiter proposes; {@link boundProposal} makes the proposal consistent
 * and caps it at the disputed amount; the result is the verdict document whose
 * hash goes on chain. Nothing here pays: `resolve` in the contract does, and
 * only after a person confirms this exact hash (`E-18`).
 */
import type { Arbiter } from "./arbiter.js";
import type { CheckedClaim } from "./claim.js";
import type { VerifiedResponse } from "./response.js";
import { AGENTRESOLVE_VERDICT_TYPE, agentResolveVerdictSchema, boundProposal, verdictHash } from "./verdict.js";
import type { AgentResolveVerdict } from "./verdict.js";

export interface DecideDisputeInput {
  readonly checked: CheckedClaim;
  readonly receiptHash: string;
  readonly claimHash: string;
  readonly arbiter: Arbiter;
  /** The merchant's verified response, or `null` when none arrived in time (T126). */
  readonly response: VerifiedResponse | null;
  readonly now?: Date;
}

export interface DecidedDispute {
  readonly verdict: AgentResolveVerdict;
  /** `sha256` of the verdict's canonical JSON: the confirmation a person gives, and what the contract stores. */
  readonly hash: string;
}

export async function decideDispute(input: DecideDisputeInput): Promise<DecidedDispute> {
  const { checked } = input;
  const decision = await input.arbiter.decide({
    claim: checked.claim,
    receipt: checked.receipt,
    disputedAtomic: checked.disputedAtomic,
    response: input.response?.response ?? null,
  });
  const proposed = BigInt(decision.proposal.refund_atomic);
  const bounded = boundProposal(decision.proposal.outcome, proposed, checked.disputedAtomic);

  const verdict = agentResolveVerdictSchema.parse({
    type: AGENTRESOLVE_VERDICT_TYPE,
    receiptHash: input.receiptHash,
    claimHash: input.claimHash,
    claimId: checked.claim.claimId,
    responseHash: input.response?.hash ?? null,
    outcome: bounded.outcome,
    refundAtomic: bounded.refund.toString(),
    disputedAtomic: checked.disputedAtomic.toString(),
    proposedRefundAtomic: (proposed < 0n ? 0n : proposed).toString(),
    adjusted: bounded.adjusted,
    reasoning: decision.proposal.reasoning,
    findings: decision.proposal.findings,
    arbiter: { model: decision.model, effort: decision.effort },
    decidedAt: (input.now ?? new Date()).toISOString(),
  });
  return { verdict, hash: verdictHash(verdict) };
}
