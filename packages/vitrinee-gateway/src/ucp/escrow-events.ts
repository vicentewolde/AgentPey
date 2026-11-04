/**
 * Which order events a change in the escrow means (Fase 9, T165, X-31).
 *
 * The store learns where the payment stands by reading its escrow, not by being told: the buyer opens the dispute
 * (T162), the merchant answers from its wallet (T163), the arbiter resolves, anyone may release or expire. Each read
 * is compared with the state the platform was last told about, and every step in between becomes an event, so a
 * dispute that went from open to resolved between two reads still reports that it was answered, if it was.
 */
import type { EscrowPurchase, EscrowStatus } from "@vitrinee/anchor";

import type { OrderWebhookEvent } from "../orders.js";

const IN_DISPUTE: ReadonlySet<EscrowStatus> = new Set(["disputed", "responded", "resolved", "expired"]);
const ANSWERED: ReadonlySet<EscrowStatus> = new Set(["responded", "resolved", "expired"]);

/** The events between `previous` and the escrow's state now, in the order they happened. None when nothing changed. */
export function escrowEvents(previous: EscrowStatus, purchase: EscrowPurchase): OrderWebhookEvent[] {
  const current = purchase.status;
  if (current === previous) return [];
  const events: OrderWebhookEvent[] = [];
  if (!IN_DISPUTE.has(previous) && IN_DISPUTE.has(current)) events.push("dispute.opened");
  // An answer is on chain from `responded` on; a dispute decided without one never had it.
  const answered = current === "responded" || (ANSWERED.has(current) && purchase.responseHash !== null);
  if (answered && !ANSWERED.has(previous)) events.push("dispute.responded");
  if (current === "resolved") {
    events.push("dispute.resolved");
    // The verdict splits the held payment: back to the payer, the rest to the store.
    if (purchase.refundAtomic > 0n) events.push("escrow.refunded");
    if (purchase.refundAtomic < purchase.amountAtomic) events.push("escrow.released");
  }
  // The arbiter did not decide in time: the payer gets it all back (X-7).
  if (current === "expired") events.push("escrow.refunded");
  if (current === "released") events.push("escrow.released");
  return events;
}

/** States after which the escrow never changes again for this purchase: no need to keep reading it. */
export function isEscrowSettled(status: EscrowStatus): boolean {
  return status === "released" || status === "resolved" || status === "expired";
}
