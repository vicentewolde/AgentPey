/**
 * Anchors receipt hashes in receipt-registry after the checkout has already
 * answered (VT-5), and, for a store with an escrow (T159), first records the
 * purchase there with `hold`. One queue, one transaction at a time: both are
 * signed by the same account, and two in flight would collide on its sequence
 * number. Failures retry with backoff, each step on its own count; the order
 * record always says where each stands (`pending` → `held` | `anchored` |
 * `failed`).
 */
import type { AnchorInput, AnchorResult, HoldInput, HoldResult } from "@vitrinee/anchor";
import { VitrineeError, stellarExpertTxUrl } from "@vitrinee/core";

import type { OrderRecord, OrderStore } from "./orders.js";

export interface Anchorer {
  anchor(input: AnchorInput): Promise<AnchorResult>;
}

/** Records a paid purchase in the store's escrow, signed by the store's signing account. */
export interface Holder {
  hold(input: HoldInput): Promise<HoldResult>;
}

export interface AnchorWorkerOptions {
  anchorer: Anchorer;
  /** Required for orders that carry a `hold`; without it they stay `pending` and say why. */
  holder?: Holder;
  /**
   * The escrow `holder` writes to (T160). An order is held only in the escrow it was paid into: after the store's
   * escrow is switched off or replaced, its pending holds fail with a reason instead of landing in another contract,
   * where they could take funds that belong to other purchases.
   */
  escrow?: string;
  orders: OrderStore;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class AnchorWorker {
  private chain: Promise<void> = Promise.resolve();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => Date;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private stopped = false;

  constructor(private readonly options: AnchorWorkerOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? [2_000, 5_000, 15_000];
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  enqueue(orderId: string): void {
    if (this.stopped) return;
    this.chain = this.chain.then(() => this.process(orderId)).catch((error: unknown) => {
      this.log("anchor worker crashed", { orderId, error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Re-queues everything not yet held or anchored, e.g. after a restart. */
  resume(): number {
    let queued = 0;
    for (const order of this.options.orders.list()) {
      if (needsWork(order)) {
        this.enqueue(order.orderId);
        queued += 1;
      }
    }
    return queued;
  }

  /** Resolves when the queue is empty (retries scheduled later are not awaited). */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * One pass over an order: everything not held or not anchored is tried, `failed` included, so a
   * restart (`resume`) gives a step that ran out of retries one more attempt, as it always has.
   */
  private async process(orderId: string): Promise<void> {
    const order = this.options.orders.get(orderId);
    if (order === undefined || !needsWork(order)) return;
    // Held first (X-20): until `hold` lands, the payment sits in the escrow unallocated. A hold that will be
    // retried waits for its own retry before the anchor goes out: both are signed by the same account, and a
    // hold still pending on chain would collide with the anchor on its sequence number.
    if (order.hold !== undefined && order.hold.status !== "held") {
      const retry = await this.hold(order);
      if (retry !== undefined) return this.retryIn(orderId, retry);
    }
    const current = this.options.orders.get(orderId);
    if (current?.anchor !== null && current?.anchor !== undefined && current.anchor.status !== "anchored") {
      const retry = await this.anchor(current);
      if (retry !== undefined) this.retryIn(orderId, retry);
    }
  }

  private retryIn(orderId: string, delay: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.enqueue(orderId);
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }

  /** One `hold` attempt. Returns the wait before the next one, or `undefined` when there is none. */
  private async hold(order: OrderRecord): Promise<number | undefined> {
    const orderId = order.orderId;
    const hold = order.hold!;
    const attempt = hold.attempts + 1;
    try {
      if (this.options.holder === undefined) throw new VitrineeError("EscrowError", "this store has no escrow holder configured");
      if (this.options.escrow !== hold.escrow) {
        throw new VitrineeError("EscrowError", `this order was paid into escrow ${hold.escrow}; the store now holds into ${this.options.escrow ?? "no escrow"}`, {
          details: { orderId, paidInto: hold.escrow, current: this.options.escrow ?? null },
        });
      }
      const result = await this.options.holder.hold({
        orderRef: orderId,
        payer: order.settlement.payer,
        amount: BigInt(order.amountUSDCAtomic),
        txHash: order.settlement.txHash,
        receiptHash: order.receipt!.hash,
      });
      await this.options.orders.update(orderId, (o) => {
        o.hold = {
          ...o.hold!,
          status: "held",
          attempts: attempt,
          heldAt: this.now().toISOString(),
          ...(result.alreadyHeld ? {} : { ledger: result.ledger }),
          ...(result.txHash === undefined ? {} : { txHash: result.txHash, explorerUrl: stellarExpertTxUrl(result.txHash) }),
        };
        delete o.hold.lastError;
      });
      this.log("purchase held in escrow", { orderId, escrow: hold.escrow, txHash: result.txHash, attempt });
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = this.retryDelaysMs[attempt - 1];
      await this.options.orders.update(orderId, (o) => {
        o.hold = { ...o.hold!, status: delay === undefined ? "failed" : "pending", attempts: attempt, lastError: message.slice(0, 500) };
      });
      this.log(delay === undefined ? "hold failed for good" : "hold failed, will retry", { orderId, attempt, error: message.slice(0, 300), retryInMs: delay });
      return delay;
    }
  }

  /** One anchor attempt. Returns the wait before the next one, or `undefined` when there is none. */
  private async anchor(order: OrderRecord): Promise<number | undefined> {
    const orderId = order.orderId;
    const attempt = order.anchor!.attempts + 1;
    try {
      const result = await this.options.anchorer.anchor({
        hash: order.receipt!.hash,
        amount: BigInt(order.amountUSDCAtomic),
        orderRef: order.orderId,
      });
      await this.options.orders.update(orderId, (o) => {
        o.anchor = {
          ...o.anchor!,
          status: "anchored",
          attempts: attempt,
          ledger: result.ledger,
          anchoredAt: this.now().toISOString(),
          ...(result.txHash === undefined ? {} : { txHash: result.txHash, explorerUrl: stellarExpertTxUrl(result.txHash) }),
        };
        delete o.anchor.lastError;
      });
      this.log("receipt anchored", { orderId, hash: order.receipt!.hash, txHash: result.txHash, ledger: result.ledger, attempt });
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = this.retryDelaysMs[attempt - 1];
      await this.options.orders.update(orderId, (o) => {
        o.anchor = { ...o.anchor!, status: delay === undefined ? "failed" : "pending", attempts: attempt, lastError: message.slice(0, 500) };
      });
      this.log(delay === undefined ? "anchor failed for good" : "anchor failed, will retry", { orderId, attempt, error: message.slice(0, 300), retryInMs: delay });
      return delay;
    }
  }
}

/** Whether an order still has a step to do: a hold not yet held, or a receipt not yet anchored. */
function needsWork(order: OrderRecord): boolean {
  if (order.receipt === null || order.anchor === null) return false;
  return order.anchor.status !== "anchored" || (order.hold !== undefined && order.hold.status !== "held");
}
