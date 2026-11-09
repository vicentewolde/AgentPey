/**
 * The shipment drives the money (Fase 9, T164, X-30).
 *
 * When the store's platform says an order paid into the escrow left in full (Shopify, T147), the store calls
 * `mark_shipped`, which opens the release window. When the window closes with no claim, the store calls `release`,
 * which pays the payee. Both are signed and paid by the store's signing account, the escrow's operator (`X-4`), and
 * go through the same queue as its holds and anchors (`AnchorWorker.signerTurn`): one transaction at a time.
 *
 * The escrow is the judge of every step: the store only asks it. A purchase that was disputed meanwhile is never
 * released (the contract refuses, and the store stops trying); a release too early waits for the window the escrow
 * reports; a call that failed is tried again later. Where each order stands is kept on the order, so a restart
 * resumes every pending step, failed ones included. Nothing here ever throws to its caller: a shipment is recorded
 * whatever the escrow answers. Jumpseller does not report shipments (`R-17`): its orders never reach this module.
 */
import type { EscrowPurchase, EscrowReaderFactory } from "@vitrinee/anchor";
import { escrowContractError } from "@vitrinee/anchor";
import { VitrineeError, stellarExpertTxUrl } from "@vitrinee/core";

import type { StoreEscrow } from "./config.js";
import type { OrderEscrowExpire, OrderEscrowRelease, OrderRecord, OrderStore } from "./orders.js";

/** After the window closes, a margin for the ledger's clock, which trails the wall clock by a few seconds. */
export const RELEASE_MARGIN_MS = 15_000;
/** Waits between attempts of a call that failed for a reason other than the contract's word. */
export const RELEASE_RETRY_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** How often the keeper looks for disputes it was not told about, and the least between two looks at one order. */
export const DISPUTE_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Orders older than this are not looked at for disputes (the escrow's own windows are minutes to hours). */
const DISPUTE_SWEEP_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** The longest a timer waits before looking again: `setTimeout` overflows past ~24.8 days. */
const MAX_WAIT_MS = 24 * 60 * 60_000;

export interface EscrowReleaseDeps {
  orders: OrderStore;
  escrow: StoreEscrow;
  readers: EscrowReaderFactory;
  writer: {
    markShipped(orderRef: string, operatorSecret: string): Promise<{ txHash: string }>;
    release(orderRef: string, sourceSecret: string): Promise<{ txHash: string }>;
    /** Refunds a disputed purchase in full once the arbiter's window closed (T181). */
    expire(orderRef: string, sourceSecret: string): Promise<{ txHash: string }>;
  };
  /** The store's signing account: the escrow's operator. */
  operatorSecret: string;
  /** The signing account's queue, shared with holds and anchors. Without it, calls run as they come (tests). */
  signerTurn?: <T>(work: () => Promise<T>) => Promise<T>;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
  retryDelaysMs?: readonly number[];
  /** The escrow moved for this order (released, or found disputed): tell the platform now (T165). */
  onChange?: (orderId: string) => void;
  /** Milliseconds between sweeps for disputes nobody announced (tests). */
  sweepIntervalMs?: number;
}

/** WrongStatus (#8): the purchase is not in a state that allows the call. ReleaseTooEarly (#9): the window is open. */
const WRONG_STATUS = 8;
const RELEASE_TOO_EARLY = 9;
/** ResolveWindowOpen (#16): the arbiter still has time. */
const RESOLVE_WINDOW_OPEN = 16;

const errorText = (error: unknown): string => (error instanceof Error ? error.message.slice(0, 300) : String(error));

export class EscrowReleases {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private sweeper: NodeJS.Timeout | undefined;
  private readonly sweptAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly deps: EscrowReleaseDeps) {}

  /** The platform says the order left in full: open the release window, once. Never rejects. */
  afterShipment(orderId: string): Promise<void> {
    return this.serialized(orderId, () => this.markShipped(orderId));
  }

  /**
   * Re-schedules every step left half done (after a restart): a window still open, a shipment not yet sent to the
   * escrow, and a step that gave up, which gets another chance since the contract judges every call anyway.
   */
  resume(): number {
    let pending = 0;
    for (const order of this.deps.orders.list()) {
      if (order.hold?.escrow !== this.deps.escrow.contract || order.hold.status !== "held") continue;
      const release = order.escrowRelease;
      if (release === undefined) continue;
      if (release.status === "pending" || (release.status === "failed" && release.shippedAt === undefined)) {
        this.schedule(order.orderId, 0, "ship");
      } else if (release.status === "shipped" || release.status === "failed") {
        this.schedule(order.orderId, this.untilRelease(release), "release");
      } else {
        continue;
      }
      pending += 1;
    }
    for (const order of this.deps.orders.list()) {
      if (order.hold?.escrow !== this.deps.escrow.contract || order.hold.status !== "held") continue;
      const expire = order.escrowExpire;
      if (expire === undefined || (expire.status !== "scheduled" && expire.status !== "failed")) continue;
      this.schedule(order.orderId, expire.status === "failed" ? 0 : this.untilExpire(expire), "expire");
      pending += 1;
    }
    this.startSweeper();
    return pending;
  }

  /**
   * The escrow shows (or may show) a dispute on this order: schedule `expire` for when the arbiter's window closes
   * (T181, X-33). A purchase that is not disputed is left alone; one already closed is recorded as such. Never rejects.
   */
  afterDispute(orderId: string): Promise<void> {
    return this.serialized(orderId, () => this.watchDispute(orderId));
  }

  /**
   * Looks at every order held in the store's escrow once, for a dispute opened without the store being told
   * (a claim sent straight to the chain). One read per order, at most every `DISPUTE_SWEEP_INTERVAL_MS`.
   */
  async sweepOnce(): Promise<void> {
    const now = this.deps.now().getTime();
    for (const order of this.deps.orders.list()) {
      if (this.stopped) return;
      if (order.hold?.escrow !== this.deps.escrow.contract || order.hold.status !== "held") continue;
      if (now - Date.parse(order.createdAt) > DISPUTE_SWEEP_WINDOW_MS) continue;
      if (order.escrowRelease?.status === "released" || order.escrowExpire !== undefined) continue;
      const last = this.sweptAt.get(order.orderId);
      if (last !== undefined && now - last < DISPUTE_SWEEP_INTERVAL_MS) continue;
      this.sweptAt.set(order.orderId, now);
      await this.afterDispute(order.orderId);
    }
  }

  private startSweeper(): void {
    if (this.stopped || this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => void this.sweepOnce(), this.deps.sweepIntervalMs ?? DISPUTE_SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  /** Resolves when no step is running (scheduled ones are not awaited). Tests, shutdown, and a store being replaced. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  stop(): void {
    this.stopped = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private serialized(orderId: string, work: () => Promise<void>): Promise<void> {
    const guarded = () =>
      work().catch((error: unknown) => {
        // Last line: a step that could not even record its failure (the order store is down). Logged, never thrown.
        this.deps.log("escrow release step crashed", { orderId, error: errorText(error) });
      });
    const before = this.running.get(orderId) ?? Promise.resolve();
    const next = before.then(guarded, guarded).finally(() => {
      if (this.running.get(orderId) === next) this.running.delete(orderId);
    });
    this.running.set(orderId, next);
    return next;
  }

  private schedule(orderId: string, delayMs: number, step: "ship" | "release" | "expire"): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(orderId));
    const timer = setTimeout(
      () => {
        this.timers.delete(orderId);
        void this.serialized(orderId, () => (step === "ship" ? this.markShipped(orderId) : step === "release" ? this.release(orderId) : this.expire(orderId)));
      },
      Math.min(MAX_WAIT_MS, Math.max(0, Number.isFinite(delayMs) ? delayMs : 0)),
    );
    timer.unref();
    this.timers.set(orderId, timer);
  }

  /** How long until `release` may be called, from the window kept on the order. */
  private untilRelease(release: OrderEscrowRelease): number {
    const at = release.releaseAfter === undefined ? Number.NaN : Date.parse(release.releaseAfter);
    return Number.isFinite(at) ? at - this.deps.now().getTime() + RELEASE_MARGIN_MS : 0;
  }

  /** How long until `expire` may be called, from the deadline kept on the order. */
  private untilExpire(expire: OrderEscrowExpire): number {
    const at = expire.expireAfter === undefined ? Number.NaN : Date.parse(expire.expireAfter);
    return Number.isFinite(at) ? at - this.deps.now().getTime() + RELEASE_MARGIN_MS : 0;
  }

  private async saveExpire(orderId: string, expire: OrderEscrowExpire): Promise<void> {
    await this.deps.orders.update(orderId, (order) => {
      order.escrowExpire = expire;
    });
  }

  private turn<T>(work: () => Promise<T>): Promise<T> {
    return this.deps.signerTurn === undefined ? work() : this.deps.signerTurn(work);
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
  private fromChain(purchase: EscrowPurchase, current: OrderEscrowRelease): OrderEscrowRelease | null {
    const base = { attempts: 0, ...(current.shippedTx === undefined ? {} : { shippedTx: current.shippedTx }) };
    switch (purchase.status) {
      case "shipped": {
        const shippedAt = purchase.shippedAt ?? 0;
        return { ...base, status: "shipped", shippedAt: new Date(shippedAt * 1000).toISOString(), releaseAfter: new Date((shippedAt + this.deps.escrow.releaseWindowSeconds) * 1000).toISOString() };
      }
      case "released":
        return { ...base, status: "released", ...(current.releaseTx === undefined ? {} : { releaseTx: current.releaseTx }) };
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

  /** Records a failed attempt and schedules the next, or gives up. A failure to record is only logged. */
  private async retry(orderId: string, step: "ship" | "release", current: OrderEscrowRelease, error: unknown): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? RELEASE_RETRY_DELAYS_MS;
    const attempts = current.attempts + 1;
    const message = errorText(error);
    const delay = delays[attempts - 1];
    this.deps.log(`escrow ${step} failed`, { orderId, attempts, error: message, ...(delay === undefined ? { gaveUp: true } : { retryInMs: delay }) });
    if (delay !== undefined) this.schedule(orderId, delay, step);
    try {
      await this.save(orderId, { ...current, attempts, lastError: message, ...(delay === undefined ? { status: "failed" as const } : {}) });
    } catch (saveError) {
      this.deps.log("escrow release state not saved", { orderId, error: errorText(saveError) });
    }
  }

  /** Records what the escrow says now, and schedules the release while the window runs. */
  private async settle(orderId: string, purchase: EscrowPurchase | null, current: OrderEscrowRelease): Promise<void> {
    if (purchase === null) throw new VitrineeError("EscrowError", "the escrow holds no purchase for this order", { details: { orderId } });
    const next = this.fromChain(purchase, current);
    if (next === null) throw new VitrineeError("EscrowError", "the escrow still shows the purchase held, not shipped", { details: { orderId } });
    await this.save(orderId, next);
    if (next.status === "released" || next.status === "disputed") this.deps.onChange?.(orderId);
    if (next.status === "disputed") this.deps.log("escrow release stopped: a claim was opened", { orderId });
    if (next.status === "shipped") this.schedule(orderId, this.untilRelease(next), "release");
  }

  private async markShipped(orderId: string): Promise<void> {
    const order = this.held(orderId);
    if (order === undefined || order.fulfillmentState !== "fulfilled") return;
    const current: OrderEscrowRelease = order.escrowRelease ?? { status: "pending", attempts: 0 };
    if (current.status !== "pending" && !(current.status === "failed" && current.shippedAt === undefined)) return;
    try {
      let purchase = await this.read(orderId);
      if (purchase?.status === "held") {
        try {
          const sent = await this.turn(() => this.deps.writer.markShipped(orderId, this.deps.operatorSecret));
          current.shippedTx = sent.txHash;
          this.deps.log("escrow window opened", { orderId, transaction: sent.txHash, explorerUrl: stellarExpertTxUrl(sent.txHash) });
        } catch (error) {
          // Already moved on (shipped by an earlier attempt, or disputed): the escrow's state below says which.
          if (escrowContractError(error) !== WRONG_STATUS) throw error;
        }
        purchase = await this.read(orderId);
      }
      await this.settle(orderId, purchase, current);
    } catch (error) {
      await this.retry(orderId, "ship", current, error);
    }
  }

  private async release(orderId: string): Promise<void> {
    const order = this.held(orderId);
    const current = order?.escrowRelease;
    if (order === undefined || current === undefined || !(current.status === "shipped" || (current.status === "failed" && current.shippedAt !== undefined))) return;
    try {
      const purchase = await this.read(orderId);
      if (purchase?.status === "shipped") {
        try {
          const sent = await this.turn(() => this.deps.writer.release(orderId, this.deps.operatorSecret));
          current.releaseTx = sent.txHash;
          this.deps.log("escrow released", { orderId, transaction: sent.txHash, explorerUrl: stellarExpertTxUrl(sent.txHash) });
        } catch (error) {
          const code = escrowContractError(error);
          if (code === RELEASE_TOO_EARLY) {
            // The escrow's window, not the one kept here, decides: wait for it, without counting a failure.
            const window = this.fromChain(purchase, current);
            this.schedule(orderId, window === null ? RELEASE_MARGIN_MS : Math.max(RELEASE_MARGIN_MS, this.untilRelease(window)), "release");
            return;
          }
          if (code !== WRONG_STATUS) throw error;
        }
      }
      await this.settle(orderId, await this.read(orderId), current);
    } catch (error) {
      await this.retry(orderId, "release", current, error);
    }
  }

  // ------------------------------------------------------------ expire (T181, X-33)

  private async watchDispute(orderId: string): Promise<void> {
    const order = this.held(orderId);
    if (order === undefined) return;
    const current: OrderEscrowExpire = { ...(order.escrowExpire ?? { status: "scheduled" as const, attempts: 0 }) };
    if (current.status === "expired" || current.status === "done") return;
    try {
      await this.settleExpire(orderId, await this.read(orderId), current);
    } catch (error) {
      if (order.escrowExpire === undefined) {
        // Nothing to retry for an order never seen disputed: the next sweep looks again.
        this.deps.log("dispute look failed", { orderId, error: errorText(error) });
        return;
      }
      await this.retryExpire(orderId, current, error);
    }
  }

  /** Records what the escrow says now: a dispute waiting for its deadline, or a purchase already closed. */
  private async settleExpire(orderId: string, purchase: EscrowPurchase | null, current: OrderEscrowExpire): Promise<void> {
    if (purchase === null) throw new VitrineeError("EscrowError", "the escrow holds no purchase for this order", { details: { orderId } });
    switch (purchase.status) {
      case "disputed":
      case "responded": {
        if (purchase.openedAt === null) throw new VitrineeError("EscrowError", "the escrow shows a dispute with no opening time", { details: { orderId } });
        const expireAfter = new Date((purchase.openedAt + this.deps.escrow.responseWindowSeconds + this.deps.escrow.resolveWindowSeconds) * 1000).toISOString();
        const next: OrderEscrowExpire = { ...current, status: "scheduled", expireAfter, attempts: current.status === "failed" ? 0 : current.attempts };
        delete next.lastError;
        await this.saveExpire(orderId, next);
        this.schedule(orderId, this.untilExpire(next), "expire");
        return;
      }
      case "expired":
      case "resolved":
      case "released": {
        // Closed: by our `expire`, by a verdict, or by a release. Nothing left to do for this order.
        const status = purchase.status === "expired" ? "expired" : "done";
        const wasOpen = current.status === "scheduled" || current.status === "failed";
        await this.saveExpire(orderId, { ...current, status });
        if (wasOpen || current.expireTx !== undefined) this.deps.onChange?.(orderId);
        if (status === "expired") this.deps.log("escrow expired: the payer was refunded in full", { orderId, ...(current.expireTx === undefined ? {} : { transaction: current.expireTx }) });
        return;
      }
      case "held":
      case "shipped":
        return;
    }
  }

  private async expire(orderId: string): Promise<void> {
    const order = this.held(orderId);
    const stored = order?.escrowExpire;
    if (order === undefined || stored === undefined || (stored.status !== "scheduled" && stored.status !== "failed")) return;
    const current: OrderEscrowExpire = { ...stored };
    try {
      const purchase = await this.read(orderId);
      if (purchase?.status === "disputed" || purchase?.status === "responded") {
        try {
          const sent = await this.turn(() => this.deps.writer.expire(orderId, this.deps.operatorSecret));
          current.expireTx = sent.txHash;
          this.deps.log("escrow expire sent", { orderId, transaction: sent.txHash, explorerUrl: stellarExpertTxUrl(sent.txHash) });
        } catch (error) {
          const code = escrowContractError(error);
          if (code === RESOLVE_WINDOW_OPEN) {
            // The escrow's clock, not the one kept here, decides: wait for it, without counting a failure.
            const window = this.settleWindow(purchase);
            this.schedule(orderId, window === null ? RELEASE_MARGIN_MS : Math.max(RELEASE_MARGIN_MS, window), "expire");
            return;
          }
          if (code !== WRONG_STATUS) throw error;
        }
      }
      await this.settleExpire(orderId, await this.read(orderId), current);
    } catch (error) {
      await this.retryExpire(orderId, current, error);
    }
  }

  private settleWindow(purchase: EscrowPurchase): number | null {
    if (purchase.openedAt === null) return null;
    const at = (purchase.openedAt + this.deps.escrow.responseWindowSeconds + this.deps.escrow.resolveWindowSeconds) * 1000;
    return at - this.deps.now().getTime() + RELEASE_MARGIN_MS;
  }

  private async retryExpire(orderId: string, current: OrderEscrowExpire, error: unknown): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? RELEASE_RETRY_DELAYS_MS;
    const attempts = current.attempts + 1;
    const message = errorText(error);
    const delay = delays[attempts - 1];
    this.deps.log("escrow expire failed", { orderId, attempts, error: message, ...(delay === undefined ? { gaveUp: true } : { retryInMs: delay }) });
    if (delay !== undefined) this.schedule(orderId, delay, "expire");
    try {
      await this.saveExpire(orderId, { ...current, attempts, lastError: message, ...(delay === undefined ? { status: "failed" as const } : {}) });
    } catch (saveError) {
      this.deps.log("escrow expire state not saved", { orderId, error: errorText(saveError) });
    }
  }
}
