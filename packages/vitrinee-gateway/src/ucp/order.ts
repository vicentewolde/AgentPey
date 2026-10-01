/**
 * `GET /ucp/v1/orders/{id}`: an order a UCP checkout produced, in UCP's
 * shape, with the anchored receipt (T122). The receipt is anchored after the
 * checkout answers, so this is where a platform sees `anchor.status` go from
 * `pending` to `anchored`.
 */
import { RECEIPT_EXTENSION, RECEIPT_EXTENSION_VERSION, UCP_ORDER, UCP_VERSION, currencyDecimals, formatUnits, parseDecimal, toMinorUnits } from "@vitrinee/core";
import type { Express, Request, Response } from "express";

import type { OrderRecord, OrderStore } from "../orders.js";
import { receiptExtension } from "./checkout.js";

export function ucpOrder(record: OrderRecord & { ucpCheckoutId: string }, origin: string) {
  const decimals = currencyDecimals(record.currency);
  const totalMinor = toMinorUnits(record.totalLocal, record.currency);
  // The total is unit × quantity, so this division is exact; it stays in bigint (VT-7, VT-36).
  const unitMinor = toMinorUnits(formatUnits(parseDecimal(record.totalLocal, decimals) / BigInt(record.quantity), decimals), record.currency);
  const shipping = record.buyer.shipping;
  const receipt = receiptExtension(record, origin);
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { [UCP_ORDER]: [{ version: UCP_VERSION }], [RECEIPT_EXTENSION]: [{ version: RECEIPT_EXTENSION_VERSION }] },
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
    messages:
      record.status === "paid_unfulfilled"
        ? [{ type: "warning", code: "fulfillment_pending", content: "Paid. The store has not accepted the order yet; it will be retried." }]
        : [],
    ...(receipt === undefined ? {} : { receipt }),
  };
}

export function registerUcpOrders(app: Express, prefix: string, orders: OrderStore, originOf: (req: Request) => string): void {
  app.get(`${prefix}/orders/:id`, (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.params["id"]);
    const record = orders.get(id);
    // Only orders a UCP checkout created are UCP orders: the others have no checkout to point at.
    if (record === undefined || record.ucpCheckoutId === undefined) {
      res.status(404).json({
        ucp: { version: UCP_VERSION, status: "error" },
        messages: [{ type: "error", code: "not_found", content: `no UCP order "${id}"`, severity: "unrecoverable" }],
      });
      return;
    }
    res.json(ucpOrder({ ...record, ucpCheckoutId: record.ucpCheckoutId }, originOf(req)));
  });
}
