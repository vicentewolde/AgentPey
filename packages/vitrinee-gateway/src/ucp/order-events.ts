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

import type { OrderFulfillmentEvent, OrderRecord, OrderStore, OrderWebhook, OrderWebhookDelivery } from "../orders.js";
import { ucpOrder, type DisputeLookup } from "./order.js";
import type { PlatformSender, SendResult } from "./platform-profile.js";
import type { StoreWebhookKey } from "./webhook-key.js";

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

export interface WebhookTarget {
  url: string;
  platformProfile: string;
  version: OrderWebhook["version"];
  origin: string;
}

export interface ShipmentInput {
  source: OrderFulfillmentEvent["source"];
  occurredAt?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  platformRef?: string;
}

export interface OrderEventsDeps {
  orders: OrderStore;
  adapter: StoreAdapter;
  /** Delivers to platform-dictated URLs; `null` sends nothing (deliveries stay queued). */
  sender: PlatformSender | null;
  key: StoreWebhookKey;
  /** The order's dispute state for a snapshot (T127); a failed read never blocks an event. */
  disputes: (record: OrderRecord) => Promise<DisputeLookup>;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
  retryDelaysMs?: readonly number[];
  watchIntervalMs?: number;
}

/** What a delivery's outcome means for it: done, try again later, or never again. */
function classify(result: SendResult): "delivered" | "retry" | "give_up" {
  if (!result.ok) return result.reason === "busy" || result.reason === "unreachable" ? "retry" : "give_up";
  if (result.status >= 200 && result.status < 300) return "delivered";
  // A server error, a timeout or a rate limit can pass; a redirect is never followed, and any other answer is final.
  if (result.status >= 500 || result.status === 408 || result.status === 429) return "retry";
  return "give_up";
}

export class OrderEvents {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly retryDelaysMs: readonly number[];
  private watcher: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly deps: OrderEventsDeps) {
    this.retryDelaysMs = deps.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  }

  /**
   * Where the platform that bought wants this order's events, from its profile
   * at `complete`, and the "Order created" event UCP requires. Once per order:
   * a replayed `complete` finds it already set.
   */
  async attachWebhook(orderId: string, target: WebhookTarget): Promise<void> {
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
      if (seen) return;
      events.push({
        id: `ful_${events.length + 1}`,
        type: "shipped",
        occurredAt: shipment.occurredAt ?? this.deps.now().toISOString(),
        source: shipment.source,
        ...(shipment.trackingNumber === undefined ? {} : { trackingNumber: shipment.trackingNumber }),
        ...(shipment.trackingUrl === undefined ? {} : { trackingUrl: shipment.trackingUrl }),
        ...(shipment.carrier === undefined ? {} : { carrier: shipment.carrier }),
        ...(shipment.platformRef === undefined ? {} : { platformRef: shipment.platformRef }),
      });
      o.fulfillmentEvents = events;
      appended = true;
    });
    if (order === undefined) throw new VitrineeError("OrderNotFound", `no order "${orderId}"`, { details: { orderId } });
    if (appended) {
      this.deps.log("order shipped", { orderId, source: shipment.source, platformRef: shipment.platformRef });
      if (order.webhook !== undefined) await this.queue(orderId, "shipped");
    }
    return order;
  }

  /**
   * Asks the store's platform whether an unshipped order left, and records
   * each new shipment. At most once a minute per order unless `force`; a
   * platform that does not answer in time is asked again later.
   */
  async checkShipment(orderId: string, options: { force?: boolean } = {}): Promise<void> {
    if (this.deps.adapter.reportsShipments !== true) return;
    const order = this.deps.orders.get(orderId);
    if (order === undefined || order.platformOrderId === null || order.ucpCheckoutId === undefined) return;
    if ((order.fulfillmentEvents ?? []).some((e) => e.type === "shipped")) return;
    const now = this.deps.now();
    if (options.force !== true && order.fulfillmentCheckedAt !== undefined && now.getTime() - Date.parse(order.fulfillmentCheckedAt) < SHIPMENT_CHECK_MIN_INTERVAL_MS) return;
    await this.deps.orders.update(orderId, (o) => {
      o.fulfillmentCheckedAt = now.toISOString();
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const platformOrder = await Promise.race([
        this.deps.adapter.getOrder(order.platformOrderId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new VitrineeError("NetworkError", `the store's platform gave no answer in ${SHIPMENT_CHECK_TIMEOUT_MS} ms`)), SHIPMENT_CHECK_TIMEOUT_MS);
        }),
      ]);
      for (const shipment of platformOrder?.shipments ?? []) {
        await this.recordShipment(orderId, {
          source: "platform",
          platformRef: shipment.id,
          occurredAt: shipment.shippedAt,
          ...(shipment.trackingNumber === undefined ? {} : { trackingNumber: shipment.trackingNumber }),
          ...(shipment.trackingUrl === undefined ? {} : { trackingUrl: shipment.trackingUrl }),
          ...(shipment.carrier === undefined ? {} : { carrier: shipment.carrier }),
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
    this.startWatcher();
    return pending;
  }

  /** Resolves when no delivery is running (scheduled retries are not awaited). Tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.watcher !== undefined) clearInterval(this.watcher);
    this.watcher = undefined;
  }

  // ------------------------------------------------------------ deliveries

  private async queue(orderId: string, event: OrderWebhookDelivery["event"]): Promise<void> {
    const current = this.deps.orders.get(orderId);
    if (current?.webhook === undefined || current.ucpCheckoutId === undefined) return;
    const lookup: DisputeLookup = event === "created" ? { kind: "none" } : await this.deps.disputes(current);
    const now = this.deps.now();
    const body = JSON.stringify(ucpOrder({ ...current, ucpCheckoutId: current.ucpCheckoutId }, current.webhook.origin, lookup, current.webhook.version));
    const delivery: OrderWebhookDelivery = { id: randomUUID(), timestamp: Math.floor(now.getTime() / 1000), event, body, status: "pending", attempts: 0, nextAttemptAt: now.toISOString() };
    await this.deps.orders.update(orderId, (o) => {
      if (o.webhook === undefined) return;
      const deliveries = [...o.webhook.deliveries, delivery];
      while (deliveries.length > MAX_DELIVERIES) {
        const finished = deliveries.findIndex((d) => d.status !== "pending");
        if (finished === -1) break;
        deliveries.splice(finished, 1);
      }
      o.webhook.deliveries = deliveries;
    });
    this.schedule(orderId, 0);
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
    const attempt = delivery.attempts + 1;
    let result: SendResult;
    if (this.deps.sender === null) {
      result = { ok: false, reason: "unreachable" };
    } else {
      const { kty, crv, x, y, d } = this.deps.key.signer.privateJwk as Partial<EcPrivateJwk>;
      const headers = signedWebhookHeaders({
        url: webhook.url,
        body: delivery.body,
        profileUrl: `${webhook.origin}/.well-known/ucp`,
        webhookId: delivery.id,
        webhookTimestamp: delivery.timestamp,
        created: Math.floor(now.getTime() / 1000),
        key: { privateJwk: { kty: kty!, crv: crv!, x: x!, y: y!, d: d! }, kid: this.deps.key.signer.kid ?? "" },
      });
      result = await this.deps.sender.send(webhook.url, { body: delivery.body, headers });
    }
    const outcome = classify(result);
    const delay = this.retryDelaysMs[attempt - 1];
    const status = outcome === "delivered" ? "delivered" : outcome === "retry" && delay !== undefined ? "pending" : "failed";
    await this.deps.orders.update(orderId, (o) => {
      const target = o.webhook?.deliveries.find((d) => d.id === delivery.id);
      if (target === undefined) return;
      target.attempts = attempt;
      target.status = status;
      target.nextAttemptAt = status === "pending" ? new Date(now.getTime() + delay!).toISOString() : null;
      if (result.ok) target.lastStatus = result.status;
      if (status === "delivered") delete target.lastError;
      else target.lastError = result.ok ? `HTTP ${result.status}` : result.reason;
    });
    this.deps.log(status === "delivered" ? "order webhook delivered" : status === "pending" ? "order webhook failed, will retry" : "order webhook given up", {
      orderId,
      webhookId: delivery.id,
      event: delivery.event,
      attempt,
      ...(result.ok ? { status: result.status } : { reason: result.reason }),
      ...(status === "pending" ? { retryInMs: delay } : {}),
    });
  }

  // ------------------------------------------------------------ the watcher

  private startWatcher(): void {
    if (this.stopped || this.watcher !== undefined) return;
    this.watcher = setInterval(() => void this.watchOnce(), this.deps.watchIntervalMs ?? SHIPMENT_WATCH_INTERVAL_MS);
    this.watcher.unref();
  }

  /** Asks the platform about every unshipped UCP order of the last 30 days, one at a time. */
  async watchOnce(): Promise<void> {
    if (this.deps.adapter.reportsShipments !== true) return;
    const cutoff = this.deps.now().getTime() - SHIPMENT_WATCH_WINDOW_MS;
    for (const order of this.deps.orders.list()) {
      if (this.stopped) return;
      if (order.ucpCheckoutId === undefined || order.platformOrderId === null || Date.parse(order.createdAt) < cutoff) continue;
      if ((order.fulfillmentEvents ?? []).some((e) => e.type === "shipped")) continue;
      await this.checkShipment(order.orderId);
    }
  }
}
