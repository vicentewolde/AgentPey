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
 * And, since T147, what happened to the parcel: `fulfillment.events[]`, an
 * append-only log (UCP), with the line marked fulfilled once the platform
 * says it all left. The same document is the body of every order webhook,
 * which alone carries the tracking: anyone holding a receipt can read this
 * order, and a tracking link leads to the courier's page about the buyer.
 */
import type { DisputeReader, DisputeRecord } from "@vitrinee/anchor";
import { RECEIPT_EXTENSION, RECEIPT_EXTENSION_VERSION, UCP_LATEST_VERSION, UCP_ORDER, VitrineeError, type UcpVersion, currencyDecimals, parseDecimal, toMinorUnits } from "@vitrinee/core";
import type { Express, Request, Response } from "express";

import type { OrderRecord, OrderStore } from "../orders.js";
import { orderLineId, shippedUnits } from "./lines.js";
import type { OrderEvents } from "./order-events.js";
import { SHIPPING_OPTION_TITLE, receiptExtension } from "./checkout.js";
import { ucpVersionOf } from "./negotiation.js";

/** What the order knows about its receipt's dispute: none, one read from the chain, or a read that failed. */
export type DisputeLookup = { kind: "none" } | { kind: "found"; contractId: string; dispute: DisputeRecord } | { kind: "unavailable" };

export const DISPUTE_READ_TIMEOUT_MS = 3_000;

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

export function ucpOrder(
  record: OrderRecord & { ucpCheckoutId: string },
  origin: string,
  lookup: DisputeLookup = { kind: "none" },
  version: UcpVersion = UCP_LATEST_VERSION,
  options: { tracking?: boolean } = {},
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
  const receipt = anchored === undefined || found === null ? anchored : { ...anchored, dispute: disputeExtension(record, found.contractId, found.dispute) };
  const messages = [
    ...(record.status === "paid_unfulfilled"
      ? [{ type: "warning", code: "fulfillment_pending", content: "Paid. The store has not accepted the order yet; it will be retried." }]
      : []),
    ...(lookup.kind === "unavailable"
      ? [{ type: "warning", code: "dispute_state_unavailable", content: "Could not read the receipt's dispute state from the chain right now; the rest of the order is current." }]
      : []),
  ];
  return {
    ucp: {
      version,
      capabilities: { [UCP_ORDER]: [{ version }], [RECEIPT_EXTENSION]: [{ version: RECEIPT_EXTENSION_VERSION }] },
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
    ...(found === null ? {} : { adjustments: [disputeAdjustment(record, found.dispute)] }),
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

export function registerUcpOrders(
  app: Express,
  prefix: string,
  orders: OrderStore,
  originOf: (req: Request) => string,
  disputes: DisputeReader | null = null,
  log: (message: string, fields?: Record<string, unknown>) => void = () => {},
  disputeTimeoutMs: number = DISPUTE_READ_TIMEOUT_MS,
  events: OrderEvents | null = null,
): void {
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
    const lookup = await lookupDispute(record, disputes, log, disputeTimeoutMs);
    res.json(ucpOrder({ ...record, ucpCheckoutId: record.ucpCheckoutId }, originOf(req), lookup, ucpVersionOf(res)));
  });
}
