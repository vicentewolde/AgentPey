/**
 * `GET /ucp/v1/orders/{id}`: an order a UCP checkout produced, in UCP's
 * shape, with the anchored receipt (T122). The receipt is anchored after the
 * checkout answers, so this is where a platform sees `anchor.status` go from
 * `pending` to `anchored`.
 *
 * And, since T127, whether the receipt is disputed in AgentPey's
 * `agent-resolve` contract, read from the chain on each request (`E-23`,
 * `E-24`): a native UCP `adjustments[]` entry any UCP client understands, and
 * `receipt.dispute` with the hashes a verifier checks against the chain. Only
 * what the contract holds: the verdict's reasoning stays with the arbiter.
 *
 * And, since T161, where the payment stands in the store's `purchase-escrow`
 * when the order was paid into one (`X-27`): `receipt.escrow`, read from the
 * chain on each request like the dispute, and a native `adjustments[]` entry
 * for a dispute in the escrow. Such an order declares receipt extension
 * `2026-10-16`; every other order is exactly as before.
 *
 * And, since T147, what happened to the parcel: `fulfillment.events[]`, an
 * append-only log (UCP), with the line marked fulfilled once the platform
 * says it all left. The same document is the body of every order webhook,
 * which alone carries the tracking: anyone holding a receipt can read this
 * order, and a tracking link leads to the courier's page about the buyer.
 */
import type { DisputeReader, DisputeRecord, EscrowConfig, EscrowPurchase, EscrowReaderFactory } from "@vitrinee/anchor";
import { RECEIPT_EXTENSION, RECEIPT_EXTENSION_ESCROW_VERSION, RECEIPT_EXTENSION_VERSION, UCP_LATEST_VERSION, UCP_ORDER, VitrineeError, type UcpVersion, currencyDecimals, parseDecimal, toMinorUnits } from "@vitrinee/core";
import type { Express, Request, Response } from "express";

import type { OrderRecord, OrderStore } from "../orders.js";
import { orderLineId, shippedUnits } from "./lines.js";
import type { OrderEvents } from "./order-events.js";
import { SHIPPING_OPTION_TITLE, receiptExtension } from "./checkout.js";
import { ucpVersionOf } from "./negotiation.js";

/** What the order knows about its receipt's dispute: none, one read from the chain, or a read that failed. */
export type DisputeLookup = { kind: "none" } | { kind: "found"; contractId: string; dispute: DisputeRecord } | { kind: "unavailable" };

export const DISPUTE_READ_TIMEOUT_MS = 3_000;

type EscrowWindows = Pick<EscrowConfig, "releaseWindowSeconds" | "responseWindowSeconds" | "resolveWindowSeconds">;

/** Where an order's payment stands in the escrow it was paid into: not paid into one, read from the chain, or a read that failed. */
export type EscrowLookup = { kind: "none" } | { kind: "found"; contract: string; purchase: EscrowPurchase; windows: EscrowWindows } | { kind: "unavailable" };

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The refund in the order's currency, for UCP's `totals`: the whole total
 * when everything paid came back, else the same share of it, rounded down.
 * The exact USDC amount is in `receipt.dispute`. Bigint throughout (VT-7, VT-36).
 */
function refundMinor(record: OrderRecord, refundAtomic: bigint): number {
  const totalMinor = parseDecimal(record.totalLocal, currencyDecimals(record.currency));
  const paid = BigInt(record.amountUSDCAtomic);
  const refund = refundAtomic > paid ? paid : refundAtomic;
  // Never above the order total, which `toMinorUnits` already checked is a safe integer.
  return Number(refund === paid ? totalMinor : (totalMinor * refund) / paid);
}

function disputeAdjustment(record: OrderRecord, dispute: DisputeRecord) {
  const base = { id: `dispute_${dispute.claimHash.slice(0, 16)}`, type: "dispute" };
  if (dispute.status === "open") {
    return { ...base, occurred_at: iso(dispute.openedAt), status: "pending" as const, description: "Refund claim open in AgentResolve; the disputed amount is locked in the merchant's guarantee." };
  }
  const refunded = refundMinor(record, dispute.refundAtomic);
  return {
    ...base,
    occurred_at: iso(dispute.resolvedAt ?? dispute.openedAt),
    status: "completed" as const,
    ...(dispute.refundAtomic === 0n
      ? { description: "Refund claim resolved in AgentResolve: rejected, nothing refunded." }
      : { description: "Refund claim resolved in AgentResolve: refunded to the payer from the merchant's guarantee.", totals: [{ type: "total", display_text: "Refunded", amount: -refunded }] }),
  };
}

function disputeExtension(record: OrderRecord, contractId: string, dispute: DisputeRecord) {
  return {
    contract: contractId,
    status: dispute.status,
    claim_hash: dispute.claimHash,
    asset: record.settlement.asset,
    amount_atomic: dispute.amountAtomic.toString(),
    opened_at: iso(dispute.openedAt),
    ...(dispute.status === "resolved"
      ? {
          ...(dispute.verdictHash === null ? {} : { verdict_hash: dispute.verdictHash }),
          refund_atomic: dispute.refundAtomic.toString(),
          ...(dispute.resolvedAt === null ? {} : { resolved_at: iso(dispute.resolvedAt) }),
        }
      : {}),
  };
}

/** The purchase as the escrow holds it, with its deadlines worked out from the contract's own windows (T161). */
function escrowExtension(found: Extract<EscrowLookup, { kind: "found" }>) {
  const { purchase: p, windows: w } = found;
  return {
    contract: found.contract,
    status: p.status,
    amount_atomic: p.amountAtomic.toString(),
    held_at: iso(p.heldAt),
    ...(p.shippedAt === null ? {} : { shipped_at: iso(p.shippedAt), release_after: iso(p.shippedAt + w.releaseWindowSeconds) }),
    ...(p.claimHash === null ? {} : { claim_hash: p.claimHash }),
    ...(p.openedAt === null
      ? {}
      : { opened_at: iso(p.openedAt), respond_by: iso(p.openedAt + w.responseWindowSeconds), resolve_by: iso(p.openedAt + w.responseWindowSeconds + w.resolveWindowSeconds) }),
    ...(p.responseHash === null ? {} : { response_hash: p.responseHash }),
    ...(p.verdictHash === null ? {} : { verdict_hash: p.verdictHash }),
    refund_atomic: p.refundAtomic.toString(),
    refund_owed_atomic: p.refundOwedAtomic.toString(),
    ...(p.closedAt === null ? {} : { closed_at: iso(p.closedAt) }),
  };
}

/** A dispute in the escrow, as a native UCP adjustment: what any UCP client understands (T161, like T127's). */
function escrowDisputeAdjustment(record: OrderRecord, purchase: EscrowPurchase) {
  if (purchase.openedAt === null || purchase.claimHash === null) return undefined;
  const base = { id: `dispute_${purchase.claimHash.slice(0, 16)}`, type: "dispute" };
  if (purchase.status === "disputed" || purchase.status === "responded") {
    return { ...base, occurred_at: iso(purchase.openedAt), status: "pending" as const, description: "Refund claim open in the store's escrow; the payment stays held until it is decided." };
  }
  const refunded = refundMinor(record, purchase.refundAtomic);
  const how = purchase.status === "expired" ? "the arbiter did not decide in time, so the escrow refunded the payer in full" : "decided by the arbiter";
  return {
    ...base,
    occurred_at: iso(purchase.closedAt ?? purchase.openedAt),
    status: "completed" as const,
    ...(purchase.refundAtomic === 0n
      ? { description: `Refund claim closed in the store's escrow (${how}): nothing refunded.` }
      : { description: `Refund claim closed in the store's escrow (${how}): refunded to the payer from the held payment.`, totals: [{ type: "total", display_text: "Refunded", amount: -refunded }] }),
  };
}

export function ucpOrder(
  record: OrderRecord & { ucpCheckoutId: string },
  origin: string,
  lookup: DisputeLookup = { kind: "none" },
  version: UcpVersion = UCP_LATEST_VERSION,
  options: { tracking?: boolean; escrow?: EscrowLookup } = {},
) {
  const totalMinor = toMinorUnits(record.totalLocal, record.currency);
  const shipping = record.buyer.shipping;
  const events = record.fulfillmentEvents ?? [];
  // The platform saying it all left is final; until then each line counts what its events carried (T148).
  const everything = record.fulfillmentState === "fulfilled";
  const shippedPerLine = shippedUnits(record);
  const allLines = record.items.map((item, index) => ({ id: orderLineId(index), quantity: item.quantity }));
  const tracking = options.tracking === true;
  const anchored = receiptExtension(record, origin);
  const found = lookup.kind === "found" ? lookup : null;
  const escrow = options.escrow ?? { kind: "none" };
  const held = escrow.kind === "found" ? escrow : null;
  const withDispute = anchored === undefined || found === null ? anchored : { ...anchored, dispute: disputeExtension(record, found.contractId, found.dispute) };
  const receipt = withDispute === undefined || held === null ? withDispute : { ...withDispute, escrow: escrowExtension(held) };
  const adjustments = [...(found === null ? [] : [disputeAdjustment(record, found.dispute)]), ...(held === null ? [] : [escrowDisputeAdjustment(record, held.purchase)].filter((a) => a !== undefined))];
  // An order paid into an escrow speaks the receipt extension's escrow version; every other order, the one it always did.
  const receiptVersion = record.hold === undefined ? RECEIPT_EXTENSION_VERSION : RECEIPT_EXTENSION_ESCROW_VERSION;
  const messages = [
    ...(record.status === "paid_unfulfilled"
      ? [{ type: "warning", code: "fulfillment_pending", content: "Paid. The store has not accepted the order yet; it will be retried." }]
      : []),
    ...(lookup.kind === "unavailable"
      ? [{ type: "warning", code: "dispute_state_unavailable", content: "Could not read the receipt's dispute state from the chain right now; the rest of the order is current." }]
      : []),
    ...(escrow.kind === "unavailable"
      ? [{ type: "warning", code: "escrow_state_unavailable", content: "Could not read where the payment stands in the store's escrow right now; the rest of the order is current." }]
      : []),
  ];
  return {
    ucp: {
      version,
      capabilities: { [UCP_ORDER]: [{ version }], [RECEIPT_EXTENSION]: [{ version: receiptVersion }] },
    },
    id: record.orderId,
    ...(record.platformOrderId === null ? {} : { label: record.platformOrderId }),
    checkout_id: record.ucpCheckoutId,
    permalink_url: record.receipt === null ? `${origin}/orders/${record.orderId}` : `${origin}/receipts/${record.receipt.hash}`,
    currency: record.currency,
    line_items: record.items.map((item, index) => {
      const unitMinor = toMinorUnits(item.unitPriceLocal, record.currency);
      const lineMinor = unitMinor * item.quantity;
      const fulfilled = everything ? item.quantity : shippedPerLine[index]!;
      return {
        id: orderLineId(index),
        item: { id: item.productId, title: item.name, price: unitMinor },
        quantity: { original: item.quantity, total: item.quantity, fulfilled },
        totals: [
          { type: "subtotal", amount: lineMinor },
          { type: "total", amount: lineMinor },
        ],
        // UCP derives it: fulfilled once fulfilled == total, partial once some left.
        status: fulfilled === item.quantity ? "fulfilled" : fulfilled > 0 ? "partial" : "processing",
      };
    }),
    fulfillment: {
      expectations:
        shipping === undefined
          ? []
          : [
              {
                id: "exp_1",
                line_items: allLines,
                method_type: "shipping",
                description: SHIPPING_OPTION_TITLE,
                // Country only: the order id travels inside the public receipt, so
                // anyone holding a receipt can read this. The address stays with the store.
                destination: { address_country: shipping.country },
              },
            ],
      events: events.map((event) => ({
        id: event.id,
        occurred_at: event.occurredAt,
        type: event.type,
        // An event from before T148 names no lines: its order had one, and it stood for all of it.
        line_items: event.lines ?? allLines,
        ...(event.carrier === undefined ? {} : { carrier: event.carrier }),
        ...(!tracking || event.trackingNumber === undefined ? {} : { tracking_number: event.trackingNumber }),
        ...(!tracking || event.trackingUrl === undefined ? {} : { tracking_url: event.trackingUrl }),
      })),
    },
    totals: [
      { type: "subtotal", amount: totalMinor },
      { type: "fulfillment", amount: 0 },
      { type: "total", amount: totalMinor },
    ],
    ...(adjustments.length === 0 ? {} : { adjustments }),
    messages,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/**
 * The dispute over an order's receipt, if there can be one: only an anchored
 * receipt can be disputed (`ReceiptNotAnchored` in the contract). A read that
 * fails or takes too long never fails the order (T127).
 */
export async function lookupDispute(
  record: OrderRecord,
  disputes: DisputeReader | null,
  log: (message: string, fields?: Record<string, unknown>) => void = () => {},
  timeoutMs: number = DISPUTE_READ_TIMEOUT_MS,
): Promise<DisputeLookup> {
  if (disputes === null || record.receipt === null || record.anchor?.status !== "anchored") return { kind: "none" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const dispute = await Promise.race([
      disputes.get(record.receipt.hash),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VitrineeError("NetworkError", `agent-resolve gave no answer in ${timeoutMs} ms`, { details: { timeoutMs } })), timeoutMs);
      }),
    ]);
    return dispute === null ? { kind: "none" } : { kind: "found", contractId: disputes.contractId, dispute };
  } catch (error) {
    log("dispute read failed", { orderId: record.orderId, error: error instanceof Error ? error.message : String(error) });
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where an order's payment stands in the escrow it was paid into (`record.hold.escrow`, T159), read from the chain
 * with the same bound as the dispute: a read that fails or takes too long never fails the order (T161). The
 * contract's windows never change, so they are read once per contract.
 */
export async function lookupEscrow(
  record: OrderRecord,
  escrows: EscrowReaderFactory | null,
  windows: Map<string, EscrowWindows>,
  log: (message: string, fields?: Record<string, unknown>) => void = () => {},
  timeoutMs: number = DISPUTE_READ_TIMEOUT_MS,
): Promise<EscrowLookup> {
  const contract = record.hold?.escrow;
  if (escrows === null || contract === undefined) return { kind: "none" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const reader = escrows(contract);
    const read = async () => {
      const known = windows.get(contract);
      const [purchase, config] = await Promise.all([reader.get(record.orderId), known === undefined ? reader.config() : Promise.resolve(known)]);
      return { purchase, config };
    };
    const { purchase, config } = await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VitrineeError("NetworkError", `the escrow gave no answer in ${timeoutMs} ms`, { details: { timeoutMs } })), timeoutMs);
      }),
    ]);
    const w = { releaseWindowSeconds: config.releaseWindowSeconds, responseWindowSeconds: config.responseWindowSeconds, resolveWindowSeconds: config.resolveWindowSeconds };
    windows.set(contract, w);
    // Paid into the escrow but not recorded yet (the hold is pending): nothing to show but the warning-free order.
    return purchase === null ? { kind: "none" } : { kind: "found", contract, purchase, windows: w };
  } catch (error) {
    log("escrow read failed", { orderId: record.orderId, escrow: contract, error: error instanceof Error ? error.message : String(error) });
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export function registerUcpOrders(
  app: Express,
  prefix: string,
  orders: OrderStore,
  originOf: (req: Request) => string,
  disputes: DisputeReader | null = null,
  log: (message: string, fields?: Record<string, unknown>) => void = () => {},
  disputeTimeoutMs: number = DISPUTE_READ_TIMEOUT_MS,
  events: OrderEvents | null = null,
  escrows: EscrowReaderFactory | null = null,
): void {
  const windows = new Map<string, EscrowWindows>();
  app.get(`${prefix}/orders/:id`, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.params["id"]);
    // Has it shipped? Asks the store's platform at most once a minute per order, bounded in time (T147).
    if (events !== null) await events.checkShipment(id);
    const record = orders.get(id);
    // Only orders a UCP checkout created are UCP orders: the others have no checkout to point at.
    if (record === undefined || record.ucpCheckoutId === undefined) {
      res.status(404).json({
        ucp: { version: ucpVersionOf(res), status: "error" },
        messages: [{ type: "error", code: "not_found", content: `no UCP order "${id}"`, severity: "unrecoverable" }],
      });
      return;
    }
    const [lookup, escrow] = await Promise.all([lookupDispute(record, disputes, log, disputeTimeoutMs), lookupEscrow(record, escrows, windows, log, disputeTimeoutMs)]);
    res.json(ucpOrder({ ...record, ucpCheckoutId: record.ucpCheckoutId }, originOf(req), lookup, ucpVersionOf(res), { escrow }));
  });
}
