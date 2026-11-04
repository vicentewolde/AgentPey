import type { EscrowPurchase } from "@vitrinee/anchor";
import { describe, expect, it } from "vitest";

import { escrowEvents, isEscrowSettled } from "./escrow-events.js";

const purchase = (overrides: Partial<EscrowPurchase> = {}): EscrowPurchase => ({
  orderRef: "ord_1",
  payer: "CRAIL",
  amountAtomic: 1_000_000n,
  txHash: "e".repeat(64),
  receiptHash: "7".repeat(64),
  status: "held",
  heldAt: 1,
  shippedAt: null,
  claimHash: null,
  openedAt: null,
  responseHash: null,
  verdictHash: null,
  refundAtomic: 0n,
  refundOwedAtomic: 0n,
  closedAt: null,
  ...overrides,
});

describe("which events a change in the escrow means (T165)", () => {
  it("names each step of a dispute, one at a time", () => {
    expect(escrowEvents("held", purchase({ status: "disputed" }))).toEqual(["dispute.opened"]);
    expect(escrowEvents("shipped", purchase({ status: "disputed" }))).toEqual(["dispute.opened"]);
    expect(escrowEvents("disputed", purchase({ status: "responded", responseHash: "a".repeat(64) }))).toEqual(["dispute.responded"]);
    expect(escrowEvents("responded", purchase({ status: "resolved", responseHash: "a".repeat(64), refundAtomic: 1_000_000n }))).toEqual(["dispute.resolved", "escrow.refunded"]);
  });

  it("reports every step skipped between two reads, and only the ones that happened", () => {
    // Opened, answered and resolved between two reads, with a partial refund: the rest went to the store.
    expect(escrowEvents("held", purchase({ status: "resolved", responseHash: "a".repeat(64), refundAtomic: 400_000n }))).toEqual(["dispute.opened", "dispute.responded", "dispute.resolved", "escrow.refunded", "escrow.released"]);
    // Decided without an answer, for the store: nothing refunded.
    expect(escrowEvents("disputed", purchase({ status: "resolved", refundAtomic: 0n }))).toEqual(["dispute.resolved", "escrow.released"]);
  });

  it("names where the payment ended without a verdict: released after the window, refunded by expire", () => {
    expect(escrowEvents("shipped", purchase({ status: "released" }))).toEqual(["escrow.released"]);
    expect(escrowEvents("disputed", purchase({ status: "expired", refundAtomic: 1_000_000n }))).toEqual(["escrow.refunded"]);
    expect(escrowEvents("held", purchase({ status: "shipped" }))).toEqual([]);
    expect(escrowEvents("disputed", purchase({ status: "disputed" }))).toEqual([]);
  });

  it("stops reading once nothing can change", () => {
    expect(["released", "resolved", "expired"].every((s) => isEscrowSettled(s as EscrowPurchase["status"]))).toBe(true);
    expect(["held", "shipped", "disputed", "responded"].some((s) => isEscrowSettled(s as EscrowPurchase["status"]))).toBe(false);
  });
});
