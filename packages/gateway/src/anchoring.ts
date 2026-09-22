/**
 * Anchors receipt hashes in receipt-registry after the checkout has already
 * answered (V-5). One queue, one transaction at a time: every anchor is
 * signed by the same account, and two in flight would collide on its
 * sequence number. Failures retry with backoff; the order record always says
 * where it stands (`pending` → `anchored` | `failed`).
 */
import type { AnchorInput, AnchorResult } from "@vitrinee/anchor";
import { stellarExpertTxUrl } from "@vitrinee/core";

import type { OrderStore } from "./orders.js";

export interface Anchorer {
  anchor(input: AnchorInput): Promise<AnchorResult>;
}

export interface AnchorWorkerOptions {
  anchorer: Anchorer;
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

  /** Re-queues everything not yet anchored, e.g. after a restart. */
  resume(): number {
    let queued = 0;
    for (const order of this.options.orders.list()) {
      if (order.receipt !== null && order.anchor !== null && order.anchor.status !== "anchored") {
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

  private async process(orderId: string): Promise<void> {
    const order = this.options.orders.get(orderId);
    if (order === undefined || order.receipt === null || order.anchor === null || order.anchor.status === "anchored") return;
    const attempt = order.anchor.attempts + 1;
    try {
      const result = await this.options.anchorer.anchor({
        hash: order.receipt.hash,
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
      this.log("receipt anchored", { orderId, hash: order.receipt.hash, txHash: result.txHash, ledger: result.ledger, attempt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = this.retryDelaysMs[attempt - 1];
      await this.options.orders.update(orderId, (o) => {
        o.anchor = { ...o.anchor!, status: delay === undefined ? "failed" : "pending", attempts: attempt, lastError: message.slice(0, 500) };
      });
      this.log(delay === undefined ? "anchor failed for good" : "anchor failed, will retry", { orderId, attempt, error: message.slice(0, 300), retryInMs: delay });
      if (delay !== undefined && !this.stopped) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.enqueue(orderId);
        }, delay);
        timer.unref();
        this.timers.add(timer);
      }
    }
  }
}
