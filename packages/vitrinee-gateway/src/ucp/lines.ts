/**
 * The lines of a UCP order and what has shipped of each (T148). The order's
 * lines are its `items`, named `li_1`, `li_2`, … by position, the same ids the
 * checkout gave them.
 */
import type { OrderRecord } from "../orders.js";

/** What a shipment says about its contents: which products and how many, when the platform says, and whether it completes the order. */
export interface ParcelReport {
  lines?: { productId: string; quantity: number }[];
  state?: "partial" | "fulfilled";
}

/** The UCP id of the order's line at `index` (T148): the same as the checkout's. */
export const orderLineId = (index: number): string => `li_${index + 1}`;

/**
 * How many units of each line the recorded events already account for (T148).
 * An event from before T148 names no lines: it is not counted here, and the
 * order's state alone says whether those units left.
 */
export function shippedUnits(record: Pick<OrderRecord, "items" | "fulfillmentEvents">): number[] {
  const shipped = record.items.map(() => 0);
  for (const event of record.fulfillmentEvents ?? []) {
    for (const line of event.lines ?? []) {
      const index = Number(line.id.slice(3)) - 1;
      if (/^li_\d+$/.test(line.id) && index >= 0 && index < shipped.length) shipped[index]! += line.quantity;
    }
  }
  return shipped.map((units, index) => Math.min(units, record.items[index]!.quantity));
}

/**
 * Which of the order's lines a parcel carried (T148). With the platform's
 * detail, each product's units go to the lines naming it that still have
 * units pending, in order. Without it, a parcel that completes the order
 * carries whatever is still pending; a partial one says nothing about which
 * lines left, so it is attributed to none (an event is never recorded for
 * units nobody can name).
 */
export function parcelLines(record: Pick<OrderRecord, "items" | "fulfillmentEvents">, shipment: ParcelReport): { id: string; quantity: number }[] {
  const shipped = shippedUnits(record);
  const pending = record.items.map((item, index) => item.quantity - shipped[index]!);
  const take = (index: number, units: number): number => {
    const taken = Math.min(units, pending[index]!);
    pending[index]! -= taken;
    return taken;
  };
  const carried = record.items.map(() => 0);
  if (shipment.lines !== undefined && shipment.lines.length > 0) {
    for (const line of shipment.lines) {
      let left = line.quantity;
      for (const [index, item] of record.items.entries()) {
        if (left <= 0) break;
        if (item.productId !== line.productId) continue;
        const taken = take(index, left);
        carried[index]! += taken;
        left -= taken;
      }
    }
  } else if ((shipment.state ?? "fulfilled") === "fulfilled") {
    for (const index of record.items.keys()) carried[index]! += take(index, pending[index]!);
  }
  return carried.flatMap((quantity, index) => (quantity > 0 ? [{ id: orderLineId(index), quantity }] : []));
}
