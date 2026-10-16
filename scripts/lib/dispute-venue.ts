/**
 * Where a receipt's dispute lives, and the arbiter's rules for each place (Fase 9, T158, `X-26`).
 *
 * A receipt paid straight to the merchant is disputed in `agent-resolve`, keyed by the receipt hash, and refunded
 * from the merchant's guarantee (T124). A receipt paid into a store's `purchase-escrow` (it names the escrow, T159)
 * is disputed in that escrow, keyed by the order, and refunded from the payment the escrow holds. The verdict, its
 * hash and the human confirmation (`E-18`) are the same in both; what differs is read here, without a network, so
 * `scripts/resolve.ts` can call the right contract and its checks can be tested.
 */
import { AgentPassError } from "@agentpass/core";
import { RESPONSE_WINDOW_SECONDS } from "../../packages/resolve/src/index.js";

import type { EscrowConfig, EscrowPurchase } from "../../packages/vitrinee-anchor/src/index.js";

export type DisputeVenue =
  | { readonly kind: "agent-resolve"; readonly contractId: string; readonly key: string }
  | { readonly kind: "escrow"; readonly contractId: string; readonly key: string };

/** The receipt's own word on where it was paid: its `escrow`, or nothing. */
export function venueOf(receipt: { readonly orderId: string; readonly escrow?: { readonly contract: string } | undefined }, receiptHash: string, agentResolveId: string): DisputeVenue {
  return receipt.escrow === undefined
    ? { kind: "agent-resolve", contractId: agentResolveId, key: receiptHash }
    : { kind: "escrow", contractId: receipt.escrow.contract, key: receipt.orderId };
}

/** Either contract's dispute, in one shape. */
export interface DisputeView {
  /** `none`: the escrow holds the purchase but no dispute was opened; `closed`: released or expired, past any verdict. */
  readonly status: "none" | "open" | "resolved" | "closed";
  readonly claimHash: string | null;
  readonly payer: string;
  /** What a refund can reach: the amount locked in `agent-resolve`, the whole purchase in an escrow. */
  readonly amount: bigint;
  /** Unix seconds; `null` before a dispute opens. */
  readonly openedAt: number | null;
  /** The merchant's response on chain (escrow only; `agent-resolve` keeps none). */
  readonly responseHash: string | null;
  readonly verdictHash: string | null;
  readonly refund: bigint;
  /** The escrow's own word on where the purchase stands, for the operator's eyes. */
  readonly detail: string;
}

/** An `agent-resolve` dispute (`scripts/resolve.ts`, `disputeSchema`). */
export function fromAgentResolve(d: { payer: string; claim_hash: string; amount: bigint; opened_at: number; status: "Open" | "Resolved"; verdict_hash: string | null; refund: bigint }): DisputeView {
  return {
    status: d.status === "Open" ? "open" : "resolved",
    claimHash: d.claim_hash,
    payer: d.payer,
    amount: d.amount,
    openedAt: d.opened_at,
    responseHash: null,
    verdictHash: d.verdict_hash,
    refund: d.refund,
    detail: d.status,
  };
}

/** A purchase as the store's `purchase-escrow` keeps it. */
export function fromEscrow(p: EscrowPurchase): DisputeView {
  const status = p.status === "disputed" || p.status === "responded" ? "open" : p.status === "resolved" ? "resolved" : p.status === "held" || p.status === "shipped" ? "none" : "closed";
  return {
    status,
    claimHash: p.claimHash,
    payer: p.payer,
    amount: p.amountAtomic,
    openedAt: p.openedAt,
    responseHash: p.responseHash,
    verdictHash: p.verdictHash,
    refund: p.refundAtomic,
    detail: p.status,
  };
}

/** The merchant's time to answer before a one-sided decision: 48 h in `agent-resolve` (`E-22`), the escrow's own (`X-26`). */
export function responseWindowOf(venue: DisputeVenue, escrow: Pick<EscrowConfig, "responseWindowSeconds"> | undefined): number {
  if (venue.kind === "agent-resolve") return RESPONSE_WINDOW_SECONDS;
  if (escrow === undefined) throw new AgentPassError("ConfigError", "an escrow dispute needs the escrow's config", { details: { escrow: venue.contractId } });
  return escrow.responseWindowSeconds;
}

/**
 * The dispute on chain is open, for this exact claim.
 *
 * @throws AgentPassError `ResolveReceiptInvalid` otherwise
 */
export function assertOpenFor(view: DisputeView | null, claimHash: string): asserts view is DisputeView & { openedAt: number } {
  if (view === null || view.status !== "open" || view.claimHash !== claimHash || view.openedAt === null) {
    throw new AgentPassError("ResolveReceiptInvalid", "there is no open dispute on chain for this claim", {
      details: { status: view?.status ?? null, onChain: view?.claimHash ?? null, claim: claimHash },
    });
  }
}

/**
 * A response the merchant gave on chain is the one the arbiter must hear: no decision without the file whose hash
 * the escrow stores, and no file that is not it. With none on chain, a file is heard as before (T126).
 *
 * @throws AgentPassError `ResolveResponseInvalid`
 */
export function assertResponseMatches(view: DisputeView, fileHash: string | null): void {
  if (view.responseHash === null) return;
  if (fileHash === null) {
    throw new AgentPassError("ResolveResponseInvalid", "the merchant answered on chain: decide with the response file whose hash the escrow stores", { details: { onChain: view.responseHash } });
  }
  if (fileHash !== view.responseHash) {
    throw new AgentPassError("ResolveResponseInvalid", "the response file is not the one the merchant answered with on chain", { details: { onChain: view.responseHash, file: fileHash } });
  }
}

/**
 * When the escrow lets the arbiter resolve (`X-7`, `X-15`): after the merchant answered or its window closed, and
 * before the arbiter's own window closes. After that only `expire` is valid, and it refunds the payer in full.
 * `agent-resolve` has no such window (brecha 18).
 *
 * @throws AgentPassError `ResolveResponsePending` too early, `ResolveWindowClosed` too late
 */
export function assertMayExecute(venue: DisputeVenue, view: DisputeView & { openedAt: number }, escrow: Pick<EscrowConfig, "responseWindowSeconds" | "resolveWindowSeconds"> | undefined, now: Date): void {
  if (venue.kind === "agent-resolve") return;
  if (escrow === undefined) throw new AgentPassError("ConfigError", "an escrow dispute needs the escrow's config", { details: { escrow: venue.contractId } });
  const seconds = Math.floor(now.getTime() / 1000);
  const answerBy = view.openedAt + escrow.responseWindowSeconds;
  const resolveBy = answerBy + escrow.resolveWindowSeconds;
  if (view.responseHash === null && seconds < answerBy) {
    throw new AgentPassError("ResolveResponsePending", "the escrow refuses a verdict before the merchant answers or its window closes", {
      details: { answerBy: new Date(answerBy * 1000).toISOString() },
    });
  }
  if (seconds >= resolveBy) {
    throw new AgentPassError("ResolveWindowClosed", "the arbiter's window in the escrow has closed: only expire is valid now, and it refunds the payer in full (X-7)", {
      details: { resolveBy: new Date(resolveBy * 1000).toISOString() },
    });
  }
}

/** A resolved dispute is the archived verdict's: the same hash, refund and claim on chain. */
export function verdictMatches(view: DisputeView, verdict: { readonly refundAtomic: string; readonly claimHash: string }, localHash: string): boolean {
  return view.verdictHash === localHash && BigInt(verdict.refundAtomic) === view.refund && verdict.claimHash === view.claimHash;
}
