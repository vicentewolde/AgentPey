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
 */
import type { DisputeReader, DisputeRecord } from "@vitrinee/anchor";
import { RECEIPT_EXTENSION, RECEIPT_EXTENSION_VERSION, UCP_LATEST_VERSION, UCP_ORDER, VitrineeError, type UcpVersion, currencyDecimals, formatUnits, parseDecimal, toMinorUnits } from "@vitrinee/core";
import type { Express, Request, Response } from "express";

import type { OrderRecord, OrderStore } from "../orders.js";
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

export function ucpOrder(record: OrderRecord & { ucpCheckoutId: string }, origin: string, lookup: DisputeLookup = { kind: "none" }, version: UcpVersion = UCP_LATEST_VERSION) {
  const decimals = currencyDecimals(record.currency);
  const totalMinor = toMinorUnits(record.totalLocal, record.currency);
  // The total is unit × quantity, so this division is exact; it stays in bigint (VT-7, VT-36).
  const unitMinor = toMinorUnits(formatUnits(parseDecimal(record.totalLocal, decimals) / BigInt(record.quantity), decimals), record.currency);
  const shipping = record.buyer.shipping;
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
    line_items: [
      {
        id: "li_1",
        item: { id: record.product.id, title: record.product.name, price: unitMinor },
        quantity: { original: record.quantity, total: record.quantity, fulfilled: 0 },
        totals: [
          { type: "subtotal", amount: totalMinor },
          { type: "total", amount: totalMinor },
        ],
        status: "processing",
      },
    ],
    fulfillment: {
      expectations:
        shipping === undefined
          ? []
          : [
              {
                id: "exp_1",
                line_items: [{ id: "li_1", quantity: record.quantity }],
                method_type: "shipping",
                description: SHIPPING_OPTION_TITLE,
                // Country only: the order id travels inside the public receipt, so
                // anyone holding a receipt can read this. The address stays with the store.
                destination: { address_country: shipping.country },
              },
            ],
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
): void {
  app.get(`${prefix}/orders/:id`, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.params["id"]);
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
