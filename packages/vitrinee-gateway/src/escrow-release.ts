/**
 * The shipment drives the money (Fase 9, T164, X-30).
 *
 * When the store's platform says an order paid into the escrow left in full (Shopify, T147), the store calls
 * `mark_shipped`, which opens the release window. When the window closes with no claim, the store calls `release`,
 * which pays the payee. Both are signed and paid by the store's signing account, the escrow's operator (`X-4`).
 *
 * The escrow is the judge of every step: the store only asks it. A purchase that was disputed meanwhile is never
 * released (the contract refuses, and the store stops trying); a release too early waits; a call that failed is
 * tried again later. Where each order stands is kept on the order, so a restart resumes every pending release.
 * Jumpseller does not report shipments (`R-17`): its orders never reach this module.
 */
import type { EscrowPurchase, EscrowReaderFactory } from "@vitrinee/anchor";
import { escrowContractError } from "@vitrinee/anchor";
import { stellarExpertTxUrl } from "@vitrinee/core";

import type { StoreEscrow } from "./config.js";
import type { OrderEscrowRelease, OrderRecord, OrderStore } from "./orders.js";

/** After the window closes, a margin for the ledger's clock, which trails the wall clock by a few seconds. */
export const RELEASE_MARGIN_MS = 15_000;
/** Waits between attempts of a call that failed for a reason other than the contract's word. */
export const RELEASE_RETRY_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

export interface EscrowReleaseDeps {
  orders: OrderStore;
  escrow: StoreEscrow;
  readers: EscrowReaderFactory;
  writer: {
    markShipped(orderRef: string, operatorSecret: string): Promise<{ txHash: string }>;
    release(orderRef: string, sourceSecret: string): Promise<{ txHash: string }>;
  };
  /** The store's signing account: the escrow's operator. */
  operatorSecret: string;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
  retryDelaysMs?: readonly number[];
}

/** WrongStatus (#8): the purchase is not in a state that allows the call. ReleaseTooEarly (#9): the window is open. */
const WRONG_STATUS = 8;
const RELEASE_TOO_EARLY = 9;

export class EscrowReleases {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: EscrowReleaseDeps) {}

  /**
   * The platform says the order left in full: open the release window, once. Never throws: a shipment is recorded
   * whatever the escrow answers, and a failed call is tried again.
   */
  afterShipment(orderId: string): Promise<void> {
    return this.serialized(orderId, () => this.markShipped(orderId));
  }

  /** Re-schedules every order whose window is open or whose shipment was never sent to the escrow (after a restart). */
  resume(): number {
    let pending = 0;
    for (const order of this.deps.orders.list()) {
      if (order.hold?.escrow !== this.deps.escrow.contract || order.hold.status !== "held") continue;
      const release = order.escrowRelease;
      if (release?.status === "shipped" && release.releaseAfter !== undefined) {
        this.schedule(order.orderId, Date.parse(release.releaseAfter) - this.deps.now().getTime() + RELEASE_MARGIN_MS);
        pending += 1;
      } else if ((release === undefined || release.status === "pending") && order.fulfillmentState === "fulfilled") {
        this.schedule(order.orderId, 0, "ship");
        pending += 1;
      }
    }
    return pending;
  }

  /** Resolves when no call is running (scheduled ones are not awaited). Tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private serialized(orderId: string, work: () => Promise<void>): Promise<void> {
    const before = this.running.get(orderId) ?? Promise.resolve();
    const next = before.then(work, work).finally(() => {
      if (this.running.get(orderId) === next) this.running.delete(orderId);
    });
    this.running.set(orderId, next);
    return next;
  }

  private schedule(orderId: string, delayMs: number, step: "ship" | "release" = "release"): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(orderId));
    const timer = setTimeout(() => {
      this.timers.delete(orderId);
      void this.serialized(orderId, () => (step === "ship" ? this.markShipped(orderId) : this.release(orderId)));
    }, Math.max(0, delayMs));
    timer.unref();
    this.timers.set(orderId, timer);
  }

  private held(orderId: string): OrderRecord | undefined {
    const order = this.deps.orders.get(orderId);
    return order?.hold?.escrow === this.deps.escrow.contract && order.hold.status === "held" ? order : undefined;
  }

  private async save(orderId: string, release: OrderEscrowRelease): Promise<void> {
    await this.deps.orders.update(orderId, (order) => {
      order.escrowRelease = release;
    });
  }

  private async read(orderId: string): Promise<EscrowPurchase | null> {
    return this.deps.readers(this.deps.escrow.contract).get(orderId);
  }

  /** Where the escrow says a purchase stands, kept on the order: shipped (with its window), released, or no longer ours to move. */
  private fromChain(purchase: EscrowPurchase, current: OrderEscrowRelease | undefined): OrderEscrowRelease | null {
    const base = { attempts: current?.attempts ?? 0, ...(current?.shippedTx === undefined ? {} : { shippedTx: current.shippedTx }) };
    switch (purchase.status) {
      case "shipped": {
        const shippedAt = purchase.shippedAt ?? 0;
        return { ...base, status: "shipped", shippedAt: new Date(shippedAt * 1000).toISOString(), releaseAfter: new Date((shippedAt + this.deps.escrow.releaseWindowSeconds) * 1000).toISOString() };
      }
      case "released":
        return { ...base, status: "released", ...(current?.releaseTx === undefined ? {} : { releaseTx: current.releaseTx }) };
      case "disputed":
      case "responded":
      case "resolved":
      case "expired":
        // A claim was opened: the arbiter decides where the money goes, not the shipment.
        return { ...base, status: "disputed" };
      case "held":
        return null;
    }
  }

  private retry(orderId: string, step: "ship" | "release", current: OrderEscrowRelease, error: unknown): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? RELEASE_RETRY_DELAYS_MS;
    const attempts = current.attempts + 1;
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    const delay = delays[attempts - 1];
    this.deps.log(`escrow ${step} failed`, { orderId, attempts, error: message, ...(delay === undefined ? { gaveUp: true } : { retryInMs: delay }) });
    if (delay !== undefined) this.schedule(orderId, delay, step);
    return this.save(orderId, { ...current, attempts, lastError: message, ...(delay === undefined ? { status: "failed" as const } : {}) });
  }

  private async markShipped(orderId: string): Promise<void> {
    const order = this.held(orderId);
    if (order === undefined || order.fulfillmentState !== "fulfilled") return;
    const current = order.escrowRelease ?? { status: "pending" as const, attempts: 0 };
    if (current.status !== "pending") return;
    try {
      let purchase = await this.read(orderId);
      if (purchase?.status === "held") {
        try {
          const sent = await this.deps.writer.markShipped(orderId, this.deps.operatorSecret);
          current.shippedTx = sent.txHash;
          this.deps.log("escrow window opened", { orderId, transaction: sent.txHash, explorerUrl: stellarExpertTxUrl(sent.txHash) });
        } catch (error) {
          // Already moved on (shipped by an earlier attempt, or disputed): the escrow's state below says which.
          if (escrowContractError(error) !== WRONG_STATUS) throw error;
        }
        purchase = await this.read(orderId);
      }
      const next = purchase === null ? null : this.fromChain(purchase, current);
      if (next === null) throw new Error(purchase === null ? "the escrow holds no purchase for this order" : "the escrow still shows the purchase held");
      await this.save(orderId, next);
      if (next.status === "shipped" && next.releaseAfter !== undefined) this.schedule(orderId, Date.parse(next.releaseAfter) - this.deps.now().getTime() + RELEASE_MARGIN_MS);
    } catch (error) {
      await this.retry(orderId, "ship", current, error);
    }
  }

  private async release(orderId: string): Promise<void> {
    const order = this.held(orderId);
    const current = order?.escrowRelease;
    if (order === undefined || current?.status !== "shipped") return;
    try {
      const purchase = await this.read(orderId);
      if (purchase?.status === "shipped") {
        try {
          const sent = await this.deps.writer.release(orderId, this.deps.operatorSecret);
          current.releaseTx = sent.txHash;
          this.deps.log("escrow released", { orderId, transaction: sent.txHash, explorerUrl: stellarExpertTxUrl(sent.txHash) });
        } catch (error) {
          const code = escrowContractError(error);
          if (code === RELEASE_TOO_EARLY) {
            // The ledger's clock is behind: ask again shortly, without counting it as a failure.
            this.schedule(orderId, RELEASE_MARGIN_MS);
            return;
          }
          if (code !== WRONG_STATUS) throw error;
        }
      }
      const after = await this.read(orderId);
      const next = after === null ? null : this.fromChain(after, current);
      if (next === null) throw new Error("the escrow holds no purchase for this order");
      await this.save(orderId, next);
      if (next.status === "disputed") this.deps.log("escrow release stopped: a claim was opened", { orderId });
      if (next.status === "shipped" && next.releaseAfter !== undefined) this.schedule(orderId, Date.parse(next.releaseAfter) - this.deps.now().getTime() + RELEASE_MARGIN_MS);
    } catch (error) {
      await this.retry(orderId, "release", current, error);
    }
  }
}
