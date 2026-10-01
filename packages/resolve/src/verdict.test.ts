import { describe, expect, it } from "vitest";

import { boundProposal, verdictHash } from "./verdict.js";
import type { AgentResolveVerdict } from "./verdict.js";

const DISPUTED = 15_684_211n;

describe("boundProposal — consistent, and never more than the disputed amount", () => {
  it.each([
    ["a full refund pays exactly the disputed amount", "refund_full", DISPUTED, { outcome: "refund_full", refund: DISPUTED, adjusted: false }],
    ["a full refund asking for more is cut to the disputed amount", "refund_full", 10n * DISPUTED, { outcome: "refund_full", refund: DISPUTED, adjusted: true }],
    ["a partial refund in range is kept", "refund_partial", 5_000_000n, { outcome: "refund_partial", refund: 5_000_000n, adjusted: false }],
    ["a partial refund above the dispute becomes full", "refund_partial", 999_000_000n, { outcome: "refund_full", refund: DISPUTED, adjusted: true }],
    ["a partial refund of zero becomes a rejection", "refund_partial", 0n, { outcome: "rejected", refund: 0n, adjusted: true }],
    ["a negative partial refund becomes a rejection", "refund_partial", -5n, { outcome: "rejected", refund: 0n, adjusted: true }],
    ["a rejection pays nothing, whatever amount came with it", "rejected", 7n, { outcome: "rejected", refund: 0n, adjusted: true }],
  ] as const)("%s", (_name, outcome, proposed, expected) => {
    expect(boundProposal(outcome, proposed, DISPUTED)).toEqual(expected);
  });
});

describe("verdictHash", () => {
  const verdict: AgentResolveVerdict = {
    type: "AgentResolveVerdict",
    receiptHash: "f".repeat(64),
    claimHash: "e".repeat(64),
    claimId: "4b8a1f0e-2c3d-4e5f-9a6b-7c8d9e0f1a2b",
    outcome: "refund_full",
    refundAtomic: "15684211",
    disputedAtomic: "15684211",
    proposedRefundAtomic: "15684211",
    adjusted: false,
    reasoning: "El pedido no llegó.",
    findings: ["Sin seguimiento."],
    arbiter: { model: "claude-opus-5-5", effort: "high" },
    decidedAt: "2026-10-02T12:00:00.000Z",
  };

  it("does not depend on key order, and changes with any field", () => {
    const reordered = Object.fromEntries(Object.entries(verdict).reverse()) as AgentResolveVerdict;
    expect(verdictHash(reordered)).toBe(verdictHash(verdict));
    expect(verdictHash({ ...verdict, refundAtomic: "15684210" })).not.toBe(verdictHash(verdict));
    expect(verdictHash(verdict)).toMatch(/^[0-9a-f]{64}$/);
  });
});
