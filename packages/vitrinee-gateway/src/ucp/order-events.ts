/**
 * Order events and order webhooks (T147, R-12). Two jobs:
 *
 * - **What happened to the parcel.** A shipment, from the store's platform
 *   (Shopify, Jumpseller) or from the local conformance store's simulation,
 *   becomes an entry of the order's append-only `fulfillment.events`. A slow
 *   watcher asks the platform about orders that have not shipped yet; reading
 *   the order asks too, at most once a minute.
 * - **Telling the platform that bought.** When the buying platform's profile
 *   names a `webhook_url`, the store POSTs the whole order to it on "created"
 *   and on every event (UCP: a full snapshot, never a delta), signed with
 *   RFC 9421 under the store's webhook key (VT-44). Each delivery keeps its
 *   `Webhook-Id`, `Webhook-Timestamp` and body on every retry. The queue lives
 *   in the order record (Postgres on the platform), so it survives a deploy.
 *
 * Deliveries go out only through the process's {@link PlatformSender}: the
 * URL was dictated by a third party and is vetted, resolved and pinned afresh
 * on each attempt (R-14).
 */
import { randomUUID } from "node:crypto";

import type { StoreAdapter } from "@vitrinee/adapters";
import { VitrineeError, signedWebhookHeaders, type EcPrivateJwk } from "@vitrinee/core";
import { z } from "zod";

import type { OrderFulfillmentEvent, OrderRecord, OrderStore, OrderWebhook, OrderWebhookDelivery } from "../orders.js";
import { parcelLines } from "./lines.js";
import { escrowEvents, isEscrowSettled } from "./escrow-events.js";
import { ucpOrder, type DisputeLookup, type EscrowLookup } from "./order.js";
import type { PlatformSender, SendResult } from "./platform-profile.js";
import type { StoreWebhookKey } from "./webhook-key.js";
import type { EscrowReleases } from "../escrow-release.js";

/** After a failed attempt, the wait before the next one; past the last, the delivery is given up. Seven attempts over about two and a half hours. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** Deliveries kept per order; the oldest finished one goes first. */
const MAX_DELIVERIES = 20;
/** How often the watcher asks the platforms about unshipped orders. */
export const SHIPMENT_WATCH_INTERVAL_MS = 10 * 60_000;
/** An order is watched this long after it was paid. */
const SHIPMENT_WATCH_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Reading an order asks the platform at most this often. */
const SHIPMENT_CHECK_MIN_INTERVAL_MS = 60_000;
const SHIPMENT_CHECK_TIMEOUT_MS = 3_000;
/** When the process's delivery budget is spent, the wait before trying again; it does not count as an attempt. */
export const WEBHOOK_BUSY_RETRY_MS = 5_000;
/** How often the store reads the escrow of an order still moving (T165): a dispute's windows are minutes long. */
export const ESCROW_WATCH_INTERVAL_MS = 60_000;
/** A read prompted by someone reading the order: at most this often per order. */
const ESCROW_CHECK_MIN_INTERVAL_MS = 15_000;
/**
 * An order read for the first time after T165 shipped: a recent one starts from `held`, so a dispute opened before
 * that first read still reports; an older one starts from what the escrow says, so a deploy never replays history.
 */
const ESCROW_BASELINE_RECENT_MS = 24 * 60 * 60_000;
/** An order whose escrow has not moved in this long is read less often: once every `ESCROW_QUIET_INTERVAL_MS`. */
const ESCROW_QUIET_AFTER_MS = 3 * 60 * 60_000;
const ESCROW_QUIET_INTERVAL_MS = 10 * 60_000;

/** The webhook key, checked once: a key that cannot sign is a configuration error, never a stuck queue. */
const webhookSigningKeySchema = z.object({
  kid: z.string().min(1),
  privateJwk: z.looseObject({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1), d: z.string().min(1) }),
});

export interface WebhookTarget {
  url: string;
  platformProfile: string;
  version: OrderWebhook["version"];
  origin: string;
}

export interface ShipmentInput {
  source: OrderFulfillmentEvent["source"];
  /** Where the order stands after this shipment; a simulation ships everything. Defaults to `fulfilled`. */
  state?: "partial" | "fulfilled";
  occurredAt?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  platformRef?: string;
  /** Which products, and how many, the parcel carried, when the platform says (T148). */
  lines?: { productId: string; quantity: number }[];
}

export interface OrderEventsDeps {
  orders: OrderStore;
  adapter: StoreAdapter;
  /** Delivers to platform-dictated URLs; `null` sends nothing (deliveries stay queued). */
  sender: PlatformSender | null;
  key: StoreWebhookKey;
  /** The order's dispute state for a snapshot (T127); a failed read never blocks an event. */
  disputes: (record: OrderRecord) => Promise<DisputeLookup>;
  /** Where the order's payment stands in its escrow (T161); a failed read never blocks an event either. */
  escrow?: (record: OrderRecord) => Promise<EscrowLookup>;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
  retryDelaysMs?: readonly number[];
  watchIntervalMs?: number;
  /** How often the escrow of a moving order is read for dispute and escrow events (T165). */
  escrowWatchIntervalMs?: number;
  /** Opens the escrow's release window when an order paid into it ships in full, and releases at its end (T164). */
  releases?: Pick<EscrowReleases, "afterShipment" | "resume" | "stop" | "idle">;
}

/** What a delivery's outcome means for it: done, try again later, wait for the budget, or never again. */
function classify(result: SendResult): "delivered" | "retry" | "defer" | "give_up" {
  // Our own budget was spent: nothing reached the receiver, so it is not an attempt (T147 review).
  if (!result.ok && result.reason === "busy") return "defer";
  if (!result.ok) return result.reason === "unreachable" ? "retry" : "give_up";
  if (result.status >= 200 && result.status < 300) return "delivered";
  // A server error, a timeout or a rate limit can pass; a redirect is never followed, and any other answer is final.
  if (result.status >= 500 || result.status === 408 || result.status === 429) return "retry";
  return "give_up";
}

export class OrderEvents {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly retryDelaysMs: readonly number[];
  private readonly checking = new Map<string, Promise<void>>();
  private readonly signingKey: { kid: string; privateJwk: EcPrivateJwk };
  private watcher: NodeJS.Timeout | undefined;
  private watching = false;
  private escrowWatcher: NodeJS.Timeout | undefined;
  private escrowWatching = false;
  private readonly escrowChecks = new Map<string, Promise<void>>();
  private readonly escrowCheckedAt = new Map<string, number>();
  private stopped = false;

  /** @throws VitrineeError `ConfigError` for a webhook key that cannot sign */
  constructor(private readonly deps: OrderEventsDeps) {
    this.retryDelaysMs = deps.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
    const key = webhookSigningKeySchema.safeParse({ kid: deps.key.signer.kid, privateJwk: deps.key.signer.privateJwk });
    if (!key.success) throw new VitrineeError("ConfigError", "the store's webhook key is not a P-256 key with a kid", { details: {} });
    const { kty, crv, x, y, d } = key.data.privateJwk;
    this.signingKey = { kid: key.data.kid, privateJwk: { kty, crv, x, y, d } };
  }

  /**
   * Where the platform that bought wants this order's events, from its profile
   * at `complete`, and the "Order created" event UCP requires. Once per order:
   * a replayed `complete` finds it already set.
   */
  async attachWebhook(orderId: string, target: WebhookTarget): Promise<void> {
    if (!isDeliverableUrl(target.url)) {
      this.deps.log("order webhook not attached: not a usable URL", { orderId });
      return;
    }
    let attached = false;
    const order = await this.deps.orders.update(orderId, (o) => {
      if (o.webhook !== undefined || o.ucpCheckoutId === undefined) return;
      o.webhook = { ...target, deliveries: [] };
      attached = true;
    });
    if (order === undefined || !attached) return;
    this.deps.log("order webhook attached", { orderId, url: target.url, version: target.version });
    await this.queue(orderId, "created");
  }

  /**
   * Appends a `shipped` event to the order's log, unless this shipment is
   * already there, and tells the platform that bought. A simulation records one
   * shipment per order; a platform's, one per shipment it reports.
   */
  async recordShipment(orderId: string, shipment: ShipmentInput): Promise<OrderRecord | undefined> {
    let appended = false;
    const order = await this.deps.orders.update(orderId, (o) => {
      const events = o.fulfillmentEvents ?? [];
      const seen = events.some((e) => e.type === "shipped" && (shipment.platformRef === undefined ? e.source === shipment.source : e.platformRef === shipment.platformRef));
      if (o.fulfillmentState !== "fulfilled" || shipment.state !== "partial") o.fulfillmentState = shipment.state ?? "fulfilled";
      // All of it left an order held in an escrow: the release window is owed (T164), recorded with the shipment so a
      // restart in between still opens it.
      if (this.deps.releases !== undefined && o.fulfillmentState === "fulfilled" && o.hold?.status === "held" && o.escrowRelease === undefined) {
        o.escrowRelease = { status: "pending", attempts: 0 };
      }
      if (seen) return;
      // Which lines this parcel carried (T148). None that can be named: not an event yet; it is asked about again.
      const lines = parcelLines(o, shipment);
      if (lines.length === 0) return;
      events.push({
        id: `ful_${events.length + 1}`,
        type: "shipped",
        occurredAt: shipment.occurredAt ?? this.deps.now().toISOString(),
        source: shipment.source,
        ...(shipment.trackingNumber === undefined ? {} : { trackingNumber: shipment.trackingNumber }),
        ...(shipment.trackingUrl === undefined ? {} : { trackingUrl: shipment.trackingUrl }),
        ...(shipment.carrier === undefined ? {} : { carrier: shipment.carrier }),
        ...(shipment.platformRef === undefined ? {} : { platformRef: shipment.platformRef }),
        lines,
      });
      o.fulfillmentEvents = events;
      appended = true;
    });
    if (order === undefined) throw new VitrineeError("OrderNotFound", `no order "${orderId}"`, { details: { orderId } });
    if (appended) {
      this.deps.log("order shipped", { orderId, source: shipment.source, platformRef: shipment.platformRef });
      if (order.webhook !== undefined) await this.queue(orderId, "shipped");
    }
    // All of it left: the escrow's release window opens (T164). Not awaited: reading an order never waits on the chain.
    if (order.escrowRelease?.status === "pending") void this.deps.releases?.afterShipment(orderId);
    return order;
  }

  /**
   * Asks the store's platform whether an order left, and records each new
   * shipment, until the platform says it all left or was cancelled. At most
   * once a minute per order unless `force`, one question at a time per order,
   * and a platform that does not answer in time is asked again later. Never
   * throws: reading an order must not depend on it.
   */
  async checkShipment(orderId: string, options: { force?: boolean } = {}): Promise<void> {
    const running = this.checking.get(orderId);
    if (running !== undefined) return running;
    const work = this.askPlatform(orderId, options.force === true).finally(() => this.checking.delete(orderId));
    this.checking.set(orderId, work);
    return work;
  }

  private async askPlatform(orderId: string, force: boolean): Promise<void> {
    if (this.deps.adapter.reportsShipments !== true) return;
    const order = this.deps.orders.get(orderId);
    if (order === undefined || order.platformOrderId === null || order.ucpCheckoutId === undefined) return;
    if (order.fulfillmentState === "fulfilled" || order.fulfillmentState === "canceled") return;
    const now = this.deps.now();
    if (!force && order.fulfillmentCheckedAt !== undefined && now.getTime() - Date.parse(order.fulfillmentCheckedAt) < SHIPMENT_CHECK_MIN_INTERVAL_MS) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.deps.orders.update(orderId, (o) => {
        o.fulfillmentCheckedAt = now.toISOString();
      });
      const platformOrder = await Promise.race([
        this.deps.adapter.getOrder(order.platformOrderId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new VitrineeError("NetworkError", `the store's platform gave no answer in ${SHIPMENT_CHECK_TIMEOUT_MS} ms`)), SHIPMENT_CHECK_TIMEOUT_MS);
        }),
      ]);
      if (platformOrder === null) return;
      if (platformOrder.status === "canceled") {
        await this.deps.orders.update(orderId, (o) => {
          o.fulfillmentState = "canceled";
        });
        return;
      }
      const state = platformOrder.fulfillmentStatus === "fulfilled" ? "fulfilled" : "partial";
      for (const shipment of platformOrder.shipments ?? []) {
        await this.recordShipment(orderId, {
          source: "platform",
          state,
          platformRef: shipment.id,
          occurredAt: shipment.shippedAt,
          ...(shipment.trackingNumber === undefined ? {} : { trackingNumber: shipment.trackingNumber }),
          ...(shipment.trackingUrl === undefined ? {} : { trackingUrl: shipment.trackingUrl }),
          ...(shipment.carrier === undefined ? {} : { carrier: shipment.carrier }),
          ...(shipment.lines === undefined ? {} : { lines: shipment.lines }),
        });
      }
    } catch (error) {
      this.deps.log("shipment check failed", { orderId, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Re-schedules every delivery still pending (after a restart) and starts the shipment watcher. */
  resume(): number {
    let pending = 0;
    for (const order of this.deps.orders.list()) {
      if (order.webhook?.deliveries.some((d) => d.status === "pending") === true) {
        this.schedule(order.orderId, 0);
        pending += 1;
      }
    }
    this.deps.releases?.resume();
    this.startWatcher();
    this.startEscrowWatcher();
    return pending;
  }

  /** Resolves when no delivery, and no escrow step, is running (scheduled ones are not awaited). Tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.escrowChecks.size > 0) await Promise.allSettled([...this.running.values(), ...this.escrowChecks.values()]);
    await this.deps.releases?.idle();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.watcher !== undefined) clearInterval(this.watcher);
    this.watcher = undefined;
    if (this.escrowWatcher !== undefined) clearInterval(this.escrowWatcher);
    this.escrowWatcher = undefined;
    this.deps.releases?.stop();
  }

  // ------------------------------------------------------------ escrow events (T165)

  /**
   * Reads the order's escrow and tells the platform what changed since it was last told: a dispute opened, answered
   * or resolved, the payment released or refunded (X-31). One read at a time per order; `force: false` (an order
   * being read) at most every 15 s. Never throws: a failed read is tried at the next pass.
   */
  async checkEscrow(orderId: string, options: { force?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    const running = this.escrowChecks.get(orderId);
    if (running !== undefined) return running;
    const last = this.escrowCheckedAt.get(orderId);
    if (options.force !== true && last !== undefined && this.deps.now().getTime() - last < ESCROW_CHECK_MIN_INTERVAL_MS) return;
    const work = this.readEscrow(orderId)
      .catch((error: unknown) => {
        this.deps.log("escrow check failed", { orderId, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      })
      .finally(() => this.escrowChecks.delete(orderId));
    this.escrowChecks.set(orderId, work);
    return work;
  }

  private async readEscrow(orderId: string): Promise<void> {
    const order = this.deps.orders.get(orderId);
    if (this.stopped || order?.webhook === undefined || order.ucpCheckoutId === undefined || order.hold?.status !== "held" || this.deps.escrow === undefined) return;
    this.escrowCheckedAt.set(orderId, this.deps.now().getTime());
    const lookup = await this.deps.escrow(order);
    if (lookup.kind !== "found") return;
    const status = lookup.purchase.status;
    const recent = this.deps.now().getTime() - Date.parse(order.createdAt) < ESCROW_BASELINE_RECENT_MS;
    const previous = order.escrowSeen?.status ?? (recent ? "held" : status);
    if (previous === status && order.escrowSeen !== undefined) return;
    const events = escrowEvents(previous, lookup.purchase);
    // Every delivery is built from this one read, then saved with the state they report in a single write: a crash
    // or a failed save in between loses nothing, and the next read tries again (T165 review).
    const deliveries: OrderWebhookDelivery[] = [];
    for (const event of events) {
      const delivery = await this.delivery(order, event, lookup);
      if (delivery !== null) deliveries.push(delivery);
    }
    // A store replaced meanwhile writes nothing: the new one reads the escrow itself (T147).
    if (this.stopped) return;
    const at = this.deps.now().toISOString();
    await this.deps.orders.update(orderId, (o) => {
      o.escrowSeen = { status, at };
      appendDeliveries(o, deliveries);
    });
    if (events.length > 0) this.deps.log("escrow changed", { orderId, from: previous, to: status, events });
    if (deliveries.length > 0) this.schedule(orderId, 0);
  }

  private startEscrowWatcher(): void {
    if (this.stopped || this.escrowWatcher !== undefined || this.deps.escrow === undefined) return;
    this.escrowWatcher = setInterval(() => {
      if (this.escrowWatching) return;
      this.escrowWatching = true;
      void this.watchEscrowsOnce().finally(() => {
        this.escrowWatching = false;
      });
    }, this.deps.escrowWatchIntervalMs ?? ESCROW_WATCH_INTERVAL_MS);
    this.escrowWatcher.unref();
  }

  /** Reads the escrow of every UCP order of the last 30 days still moving there, one at a time. */
  async watchEscrowsOnce(): Promise<void> {
    const cutoff = this.deps.now().getTime() - SHIPMENT_WATCH_WINDOW_MS;
    for (const order of this.deps.orders.list()) {
      if (this.stopped) return;
      if (order.webhook === undefined || order.hold?.status !== "held" || Date.parse(order.createdAt) < cutoff) continue;
      if (order.escrowSeen !== undefined && isEscrowSettled(order.escrowSeen.status)) continue;
      // An order quiet for hours is read every 10 minutes, not every minute: the RPC is shared (T165 review).
      const quiet = order.escrowSeen !== undefined && this.deps.now().getTime() - Date.parse(order.escrowSeen.at) > ESCROW_QUIET_AFTER_MS;
      const last = this.escrowCheckedAt.get(order.orderId);
      if (quiet && last !== undefined && this.deps.now().getTime() - last < ESCROW_QUIET_INTERVAL_MS) continue;
      await this.checkEscrow(order.orderId, { force: true });
    }
  }

  // ------------------------------------------------------------ deliveries

  private async queue(orderId: string, event: OrderWebhookDelivery["event"]): Promise<void> {
    const current = this.deps.orders.get(orderId);
    if (current?.webhook === undefined || current.ucpCheckoutId === undefined) return;
    // Where the payment stands in the escrow, as the order itself shows it (T161): the webhook is the same document.
    const escrow: EscrowLookup = this.deps.escrow === undefined ? { kind: "none" } : await this.deps.escrow(current);
    const delivery = await this.delivery(current, event, escrow);
    if (delivery === null) return;
    await this.deps.orders.update(orderId, (o) => appendDeliveries(o, [delivery]));
    this.schedule(orderId, 0);
  }

  /** One delivery: the whole order as it stands, with the escrow lookup already read. `null` for an order without a webhook. */
  private async delivery(current: OrderRecord, event: OrderWebhookDelivery["event"], escrow: EscrowLookup): Promise<OrderWebhookDelivery | null> {
    if (current.webhook === undefined || current.ucpCheckoutId === undefined) return null;
    const lookup: DisputeLookup = event === "created" ? { kind: "none" } : await this.deps.disputes(current);
    const now = this.deps.now();
    // The tracking goes to the platform that bought, and only there: the public order shows the country alone (T127, T147 review).
    const body = JSON.stringify(ucpOrder({ ...current, ucpCheckoutId: current.ucpCheckoutId }, current.webhook.origin, lookup, current.webhook.version, { tracking: true, escrow }));
    return { id: randomUUID(), timestamp: Math.floor(now.getTime() / 1000), event, body, status: "pending", attempts: 0, nextAttemptAt: now.toISOString() };
  }

  private schedule(orderId: string, delayMs: number): void {
    if (this.stopped) return;
    const existing = this.timers.get(orderId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(orderId);
      this.run(orderId);
    }, Math.max(0, delayMs));
    timer.unref();
    this.timers.set(orderId, timer);
  }

  /** One drain per order at a time: deliveries go out in order, a later one waits behind an earlier one. */
  private run(orderId: string): void {
    const previous = this.running.get(orderId);
    const next = (previous ?? Promise.resolve())
      .then(() => this.drain(orderId))
      .catch((error: unknown) => this.deps.log("order webhook drain crashed", { orderId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (this.running.get(orderId) === next) this.running.delete(orderId);
      });
    this.running.set(orderId, next);
  }

  private async drain(orderId: string): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const order = this.deps.orders.get(orderId);
      const webhook = order?.webhook;
      const delivery = webhook?.deliveries.find((d) => d.status === "pending");
      if (webhook === undefined || delivery === undefined) return;
      const due = delivery.nextAttemptAt === null ? 0 : Date.parse(delivery.nextAttemptAt) - this.deps.now().getTime();
      if (due > 0) {
        this.schedule(orderId, due);
        return;
      }
      await this.attempt(orderId, webhook, delivery);
    }
  }

  private async attempt(orderId: string, webhook: OrderWebhook, delivery: OrderWebhookDelivery): Promise<void> {
    const now = this.deps.now();
    let result: SendResult;
    let unsignable: string | undefined;
    if (this.deps.sender === null) {
      result = { ok: false, reason: "unreachable" };
    } else {
      let headers: Record<string, string> | undefined;
      try {
        headers = signedWebhookHeaders({
          url: webhook.url,
          body: delivery.body,
          profileUrl: `${webhook.origin}/.well-known/ucp`,
          webhookId: delivery.id,
          webhookTimestamp: delivery.timestamp,
          created: Math.floor(now.getTime() / 1000),
          key: this.signingKey,
        });
      } catch (error) {
        // A URL or a value that cannot be signed will not become signable: given up, never a stuck queue.
        unsignable = error instanceof Error ? error.message : String(error);
      }
      result = headers === undefined ? { ok: false, reason: "bad_url" } : await this.deps.sender.send(webhook.url, { body: delivery.body, headers });
    }
    const outcome = classify(result);
    const attempt = outcome === "defer" ? delivery.attempts : delivery.attempts + 1;
    const delay = outcome === "defer" ? WEBHOOK_BUSY_RETRY_MS : this.retryDelaysMs[attempt - 1];
    const status = outcome === "delivered" ? "delivered" : (outcome === "retry" || outcome === "defer") && delay !== undefined ? "pending" : "failed";
    await this.deps.orders.update(orderId, (o) => {
      const target = o.webhook?.deliveries.find((d) => d.id === delivery.id);
      if (target === undefined) return;
      target.attempts = attempt;
      target.status = status;
      target.nextAttemptAt = status === "pending" ? new Date(now.getTime() + delay!).toISOString() : null;
      if (result.ok) target.lastStatus = result.status;
      if (status === "delivered") delete target.lastError;
      else target.lastError = unsignable ?? (result.ok ? `HTTP ${result.status}` : result.reason);
      // A finished delivery's body is never sent again: keep the record, drop the bytes.
      if (status !== "pending") target.body = "";
    });
    this.deps.log(status === "delivered" ? "order webhook delivered" : status === "pending" ? "order webhook failed, will retry" : "order webhook given up", {
      orderId,
      webhookId: delivery.id,
      event: delivery.event,
      attempt,
      ...(result.ok ? { status: result.status } : { reason: unsignable ?? result.reason }),
      ...(status === "pending" ? { retryInMs: delay } : {}),
    });
  }

  // ------------------------------------------------------------ the watcher

  private startWatcher(): void {
    if (this.stopped || this.watcher !== undefined) return;
    this.watcher = setInterval(() => {
      // One pass at a time: a slow platform never stacks a second one on top.
      if (this.watching) return;
      this.watching = true;
      void this.watchOnce().finally(() => {
        this.watching = false;
      });
    }, this.deps.watchIntervalMs ?? SHIPMENT_WATCH_INTERVAL_MS);
    this.watcher.unref();
  }

  /** Asks the platform about every UCP order of the last 30 days that has not all left nor been cancelled, one at a time. */
  async watchOnce(): Promise<void> {
    if (this.deps.adapter.reportsShipments !== true) return;
    const cutoff = this.deps.now().getTime() - SHIPMENT_WATCH_WINDOW_MS;
    for (const order of this.deps.orders.list()) {
      if (this.stopped) return;
      if (order.ucpCheckoutId === undefined || order.platformOrderId === null || Date.parse(order.createdAt) < cutoff) continue;
      if (order.fulfillmentState === "fulfilled" || order.fulfillmentState === "canceled") continue;
      await this.checkShipment(order.orderId);
    }
  }
}

/** Adds deliveries to an order's queue, dropping the oldest finished ones past the limit; never a pending one. */
function appendDeliveries(order: OrderRecord, added: readonly OrderWebhookDelivery[]): void {
  if (order.webhook === undefined || added.length === 0) return;
  const deliveries = [...order.webhook.deliveries, ...added];
  while (deliveries.length > MAX_DELIVERIES) {
    const finished = deliveries.findIndex((d) => d.status !== "pending");
    if (finished === -1) break;
    deliveries.splice(finished, 1);
  }
  order.webhook.deliveries = deliveries;
}

/** What may be kept as a webhook URL: a parsable http(s) URL within the length a session and an order store (T147 review). The sender vets it again on every delivery. */
export function isDeliverableUrl(url: string): boolean {
  if (url.length > 2_048 || !URL.canParse(url)) return false;
  const protocol = new URL(url).protocol;
  return protocol === "https:" || protocol === "http:";
}
