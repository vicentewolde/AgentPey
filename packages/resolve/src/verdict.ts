/**
 * The verdict of an AgentResolve dispute — T124.
 *
 * Two shapes: what the arbiter **proposes** (its model's structured output),
 * and the **verdict** AgentPey keeps, hashes and anchors in the contract. In
 * between, {@link boundProposal} makes the proposal consistent and never
 * larger than the disputed amount — whatever the model was talked into. The
 * contract bounds it again (refund ≤ locked ≤ anchored receipt), so neither
 * this code nor the model is the last line.
 */
import { canonicalJson } from "@agentpass/core";
import { createHash } from "node:crypto";
import { z } from "zod";

export const AGENTRESOLVE_VERDICT_TYPE = "AgentResolveVerdict";
export const VERDICT_OUTCOMES = ["refund_full", "refund_partial", "rejected"] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

/**
 * What the model must return. Kept to types structured output can enforce;
 * lengths are checked afterwards by {@link proposalBoundsSchema}.
 */
export const verdictProposalSchema = z.object({
  outcome: z.enum(VERDICT_OUTCOMES),
  /** Proposed refund in atomic units of the receipt asset. 0 when rejected. */
  refund_atomic: z.int(),
  /** The reasoning, in Spanish, addressed to both parties. */
  reasoning: z.string(),
  /** Short factual findings the reasoning rests on. */
  findings: z.array(z.string()),
});

export const proposalBoundsSchema = verdictProposalSchema.extend({
  refund_atomic: z.int().nonnegative(),
  reasoning: z.string().trim().min(1).max(4000),
  findings: z.array(z.string().trim().min(1).max(500)).max(10),
});

export type VerdictProposal = z.infer<typeof verdictProposalSchema>;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const atomic = z.string().regex(/^(0|[1-9]\d*)$/);

export const agentResolveVerdictSchema = z.strictObject({
  type: z.literal(AGENTRESOLVE_VERDICT_TYPE),
  receiptHash: hex64,
  claimHash: hex64,
  claimId: z.uuid(),
  /**
   * The merchant's signed response the arbiter read (T126): its hash, or
   * `null` when none arrived within the 48 h (`E-22`). Absent only on
   * verdicts from before T126, so their hash, already on chain, still holds.
   */
  responseHash: hex64.nullable().optional(),
  outcome: z.enum(VERDICT_OUTCOMES),
  /** What the contract pays. Never above `disputedAtomic`. */
  refundAtomic: atomic,
  disputedAtomic: atomic,
  /** The model's proposal before bounding, kept so a reader sees what was adjusted. */
  proposedRefundAtomic: atomic,
  /** True when {@link boundProposal} changed the outcome or the amount. */
  adjusted: z.boolean(),
  reasoning: z.string().min(1),
  findings: z.array(z.string()),
  arbiter: z.strictObject({ model: z.string().min(1), effort: z.string().min(1) }),
  decidedAt: z.iso.datetime(),
});

export type AgentResolveVerdict = z.infer<typeof agentResolveVerdictSchema>;

export interface BoundedOutcome {
  readonly outcome: VerdictOutcome;
  readonly refund: bigint;
  readonly adjusted: boolean;
}

/**
 * Makes a proposal consistent and caps it at the disputed amount:
 * `rejected` pays 0; `refund_full` pays exactly the disputed amount; a
 * partial refund is clamped to (0, disputed) and renamed when it reaches an
 * edge. Never pays more than was disputed, whatever the proposal says.
 */
export function boundProposal(outcome: VerdictOutcome, proposedRefund: bigint, disputed: bigint): BoundedOutcome {
  const clamped = proposedRefund < 0n ? 0n : proposedRefund > disputed ? disputed : proposedRefund;
  let bounded: BoundedOutcome;
  if (outcome === "rejected") bounded = { outcome, refund: 0n, adjusted: proposedRefund !== 0n };
  else if (outcome === "refund_full") bounded = { outcome, refund: disputed, adjusted: proposedRefund !== disputed };
  else if (clamped === 0n) bounded = { outcome: "rejected", refund: 0n, adjusted: true };
  else if (clamped === disputed) bounded = { outcome: "refund_full", refund: disputed, adjusted: true };
  else bounded = { outcome, refund: clamped, adjusted: clamped !== proposedRefund };
  return bounded;
}

/** `sha256` of the verdict's canonical JSON, lowercase hex: what `resolve` stores as `verdict_hash`. */
export function verdictHash(verdict: AgentResolveVerdict): string {
  return createHash("sha256").update(canonicalJson(agentResolveVerdictSchema.parse(verdict)), "utf8").digest("hex");
}
