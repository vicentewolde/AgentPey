import { MockStoreAdapter } from "@vitrinee/adapters";
import { STELLAR_X402_HANDLER, UCP_REST_PREFIX, verifyHttpMessageSignature, type EcPublicJwk } from "@vitrinee/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, type VitrineeApp } from "../app.js";
import { OrderStore, type OrderPersistence, type OrderRecord } from "../orders.js";
import { fakeFacilitator, type FakeFacilitator } from "../test/fake-facilitator.js";
import { fakePlatformProfiles, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { ucpErrors } from "../test/ucp-schemas.js";
import type { PlatformProfileSummary } from "./platform-profile.js";
import { MemoryCheckoutSessions } from "./sessions.js";

const ORDER_SCHEMA = "https://ucp.dev/schemas/shopping/order.json";
const PLATFORM = "https://platform.example/ucp/profile.json";
const QUIET_PLATFORM = "https://quiet.example/ucp/profile.json";
const WEBHOOK = "https://platform.example/webhooks/orders";
const DESTINATION = { first_name: "Ana", last_name: "Rojas", street_address: "Av. Providencia 1234", address_locality: "Santiago", address_region: "RM", address_country: "CL" };
const ready = { line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }], buyer: { email: "ana@example.com" }, fulfillment: { methods: [{ type: "shipping", destinations: [DESTINATION] }] } };

type Requirements = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number };
type Body = Record<string, unknown> & { id: string; ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements?: Requirements } }>> }; order?: { id: string } };

const platformProfile = (version: "2026-04-08" | "2026-08-25", webhook?: string): PlatformProfileSummary => ({
  ucp: { version, capabilities: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.order"] },
  keys: [],
  ...(webhook === undefined ? {} : { orderWebhookUrl: webhook }),
});

function uniqueFacilitator(): FakeFacilitator {
  const base = fakeFacilitator();
  let n = 0;
  return { ...base, async settle(payload, requirements) {
    const result = await base.settle(payload, requirements);
    n += 1;
    return { ...result, transaction: n.toString(16).padStart(64, "0") };
  } };
}

/** An order store whose records outlive the app, as Postgres does: a restart is a new app over the same rows. */
function memoryPersistence(): OrderPersistence & { rows: Map<string, OrderRecord> } {
  const rows = new Map<string, OrderRecord>();
  return { rows, load: async () => [...rows.values()].map((r) => structuredClone(r)), save: async (order) => void rows.set(order.orderId, structuredClone(order)) };
}

async function waitFor<T>(check: () => T | undefined | false, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const open: Array<{ app: VitrineeApp; close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const { app, close } of open.splice(0)) {
    app.orderEvents.stop();
    app.anchors.stop();
    await close();
  }
});

async function store(options: { orders?: OrderStore; adapter?: MockStoreAdapter; retryDelaysMs?: number[]; stopped?: boolean } = {}) {
  const profiles = fakePlatformProfiles({
    [PLATFORM]: platformProfile("2026-08-25", WEBHOOK),
    [QUIET_PLATFORM]: platformProfile("2026-08-25"),
    "https://legacy.example/profile.json": platformProfile("2026-04-08", "https://legacy.example/hooks"),
  });
  const registry = fakeRegistry();
  const adapter = options.adapter ?? new MockStoreAdapter();
  const orders = options.orders ?? new OrderStore();
  const app = createApp({
    platformProfiles: profiles,
    config: testConfig(),
    adapter,
    facilitator: uniqueFacilitator(),
    anchorer: registry.anchorer,
    registry: registry.registry,
    orders,
    sessions: new MemoryCheckoutSessions(),
    anchorRetryDelaysMs: [1],
    webhookRetryDelaysMs: options.retryDelaysMs ?? [20, 40],
  });
  if (options.stopped === true) app.orderEvents.stop();
  const { url, close } = await listen(app);
  open.push({ app, close });
  const call = async (method: string, path: string, body?: unknown, profile = PLATFORM) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", "UCP-Agent": `profile="${profile}"` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  /** A checkout created and completed by `profile`: the order it produced. */
  const buy = async (profile = PLATFORM) => {
    const { body: created } = await call("POST", `${UCP_REST_PREFIX}/checkout-sessions`, ready, profile);
    const accepted = created.ucp.payment_handlers[STELLAR_X402_HANDLER]![0]!.config.payment_requirements!;
    const credential = { type: "x402_payment_payload", x402_version: 2, accepted, payload: { transaction: Buffer.from(`tx-${Math.random()}`).toString("base64") } };
    const { body: done } = await call("POST", `${UCP_REST_PREFIX}/checkout-sessions/${created.id}/complete`, { payment: { instruments: [{ id: "i1", handler_id: "stellar_x402", type: "stellar_x402", credential }] } }, profile);
    return { checkoutId: created.id, orderId: done.order!.id };
  };
  const storeKey = async (keyid: string, path = "/.well-known/ucp"): Promise<EcPublicJwk | undefined> => {
    const profile = (await (await fetch(`${url}${path}`)).json()) as { keys?: Array<EcPublicJwk & { kid: string }>; signing_keys?: Array<EcPublicJwk & { kid: string }> };
    return [...(profile.signing_keys ?? []), ...(profile.keys ?? [])].find((k) => k.kid === keyid && k.kty === "EC");
  };
  return { app, url, profiles, adapter, orders, call, buy, storeKey };
}

describe("order webhooks (T147)", () => {
  it("delivers the 'Order created' event on complete: the whole order, signed with the key the store publishes", async () => {
    const s = await store();
    const { checkoutId, orderId } = await s.buy();
    const delivery = await waitFor(() => s.profiles.sent.find((d) => d.url === WEBHOOK));
    expect(delivery.headers["webhook-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(delivery.headers["webhook-timestamp"]).toMatch(/^\d{10}$/);
    expect(delivery.headers["ucp-agent"]).toBe(`profile="${s.url}/.well-known/ucp"`);
    const body = JSON.parse(delivery.body) as Record<string, unknown> & { ucp: { version: string } };
    expect(body).toMatchObject({ id: orderId, checkout_id: checkoutId, ucp: { version: "2026-08-25" } });
    expect(ucpErrors(ORDER_SCHEMA, body, "2026-08-25")).toEqual([]);
    const check = verifyHttpMessageSignature({ method: "POST", url: WEBHOOK, headers: delivery.headers, body: delivery.body, keyFor: () => undefined });
    expect(check).toEqual({ ok: false, reason: "key_not_found" });
    const keyid = /keyid="([^"]+)"/.exec(delivery.headers["signature-input"]!)![1]!;
    expect(keyid).toMatch(/#ucp-p256$/);
    const key = await s.storeKey(keyid);
    expect(verifyHttpMessageSignature({ method: "POST", url: WEBHOOK, headers: delivery.headers, body: delivery.body, keyFor: (id) => (id === keyid ? key : undefined) })).toMatchObject({ ok: true, keyid });
    // The 2026-04-08 profile publishes it in `signing_keys`, where that version's platforms look.
    expect(await s.storeKey(keyid, "/.well-known/ucp/2026-04-08")).toEqual(key);
    expect(s.orders.get(orderId)?.webhook?.deliveries).toEqual([expect.objectContaining({ event: "created", status: "delivered", attempts: 1, lastStatus: 200 })]);
  });

  it("speaks the platform's version: a 2026-04-08 platform gets a 2026-04-08 order", async () => {
    const s = await store();
    const { orderId } = await s.buy("https://legacy.example/profile.json");
    const delivery = await waitFor(() => s.profiles.sent.find((d) => d.url === "https://legacy.example/hooks"));
    const body = JSON.parse(delivery.body) as { id: string; ucp: { version: string } };
    expect(body).toMatchObject({ id: orderId, ucp: { version: "2026-04-08" } });
    expect(ucpErrors(ORDER_SCHEMA, body, "2026-04-08")).toEqual([]);
  });

  it("retries a delivery the receiver failed with the same id, timestamp and body", async () => {
    const s = await store();
    s.profiles.respond = (_url, attempt) => (attempt === 1 ? { ok: true, status: 500 } : { ok: true, status: 200 });
    const { orderId } = await s.buy();
    await waitFor(() => s.profiles.sent.length >= 2 && s.orders.get(orderId)?.webhook?.deliveries[0]?.status === "delivered");
    const [first, second] = s.profiles.sent;
    expect(second!.headers["webhook-id"]).toBe(first!.headers["webhook-id"]);
    expect(second!.headers["webhook-timestamp"]).toBe(first!.headers["webhook-timestamp"]);
    expect(second!.body).toBe(first!.body);
    expect(s.orders.get(orderId)?.webhook?.deliveries[0]).toMatchObject({ attempts: 2, status: "delivered" });
  });

  it.each([
    ["a 4xx", { ok: true as const, status: 404 }],
    ["a redirect, never followed", { ok: true as const, status: 302 }],
    ["a URL the sender refuses", { ok: false as const, reason: "blocked_address" as const }],
  ])("gives up at once on %s", async (_label, answer) => {
    const s = await store();
    s.profiles.respond = () => answer;
    const { orderId } = await s.buy();
    await waitFor(() => s.orders.get(orderId)?.webhook?.deliveries[0]?.status === "failed");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.profiles.sent).toHaveLength(1);
  });

  it("gives up after its last retry when the receiver keeps failing", async () => {
    const s = await store();
    s.profiles.respond = () => ({ ok: true, status: 503 });
    const { orderId } = await s.buy();
    await waitFor(() => s.orders.get(orderId)?.webhook?.deliveries[0]?.status === "failed");
    expect(s.profiles.sent).toHaveLength(3);
    expect(s.orders.get(orderId)?.webhook?.deliveries[0]).toMatchObject({ attempts: 3, lastStatus: 503, lastError: "HTTP 503", nextAttemptAt: null });
  });

  it("sends nothing to a platform that names no webhook URL", async () => {
    const s = await store();
    const { orderId } = await s.buy(QUIET_PLATFORM);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.profiles.sent).toEqual([]);
    expect(s.orders.get(orderId)?.webhook).toBeUndefined();
  });

  it("keeps a pending delivery in the order, and a new process over the same orders sends it", async () => {
    const persistence = memoryPersistence();
    const first = await store({ orders: await OrderStore.open(persistence), stopped: true });
    const { orderId } = await first.buy();
    expect(persistence.rows.get(orderId)?.webhook?.deliveries).toEqual([expect.objectContaining({ status: "pending", attempts: 0 })]);
    expect(first.profiles.sent).toEqual([]);

    const second = await store({ orders: await OrderStore.open(persistence) });
    expect(second.app.orderEvents.resume()).toBe(1);
    const delivery = await waitFor(() => second.profiles.sent[0]);
    expect(JSON.parse(delivery.body)).toMatchObject({ id: orderId });
    await waitFor(() => persistence.rows.get(orderId)?.webhook?.deliveries[0]?.status === "delivered");
  });
});

describe("shipping events (T147)", () => {
  it("records a shipment the platform reports, shows it in the order, and tells the platform that bought", async () => {
    const adapter = new MockStoreAdapter();
    const s = await store({ adapter });
    const { orderId } = await s.buy();
    await waitFor(() => s.profiles.sent[0]);
    const platformOrderId = s.orders.get(orderId)!.platformOrderId!;
    await adapter.markShipped(platformOrderId, { shippedAt: "2026-10-05T12:00:00.000Z", trackingNumber: "CX123", trackingUrl: "https://track.example/CX123", carrier: "Chilexpress" });

    // Reading the order asks the platform.
    const { body: order } = await s.call("GET", `${UCP_REST_PREFIX}/orders/${orderId}`);
    expect(order["fulfillment"]).toMatchObject({
      events: [{ id: "ful_1", type: "shipped", occurred_at: "2026-10-05T12:00:00.000Z", line_items: [{ id: "li_1", quantity: 1 }], tracking_number: "CX123", tracking_url: "https://track.example/CX123", carrier: "Chilexpress" }],
    });
    expect(order["line_items"]).toEqual([expect.objectContaining({ quantity: { original: 1, total: 1, fulfilled: 1 }, status: "fulfilled" })]);
    expect(ucpErrors(ORDER_SCHEMA, order, "2026-08-25")).toEqual([]);
    const { body: legacy } = await s.call("GET", `${UCP_REST_PREFIX}/orders/${orderId}`, undefined, "https://legacy.example/profile.json");
    expect(ucpErrors(ORDER_SCHEMA, legacy, "2026-04-08")).toEqual([]);

    const shipped = await waitFor(() => s.profiles.sent[1]);
    expect(shipped.headers["webhook-id"]).not.toBe(s.profiles.sent[0]!.headers["webhook-id"]);
    expect(JSON.parse(shipped.body)).toMatchObject({ id: orderId, fulfillment: { events: [expect.objectContaining({ type: "shipped" })] } });
    // Asked again, the same shipment is not recorded twice.
    await s.app.orderEvents.checkShipment(orderId, { force: true });
    expect(s.orders.get(orderId)?.fulfillmentEvents).toHaveLength(1);
  });

  it("finds a shipment with the watcher, without anyone reading the order", async () => {
    const adapter = new MockStoreAdapter();
    const s = await store({ adapter });
    const { orderId } = await s.buy();
    await adapter.markShipped(s.orders.get(orderId)!.platformOrderId!, { shippedAt: "2026-10-05T12:00:00.000Z" });
    await s.app.orderEvents.watchOnce();
    expect(s.orders.get(orderId)?.fulfillmentEvents).toEqual([expect.objectContaining({ type: "shipped", source: "platform", platformRef: expect.any(String) })]);
  });

  it("asks a platform that cannot tell nothing at all", async () => {
    const adapter = new MockStoreAdapter();
    Object.defineProperty(adapter, "reportsShipments", { value: false });
    let asked = 0;
    const getOrder = adapter.getOrder.bind(adapter);
    adapter.getOrder = async (id) => {
      asked += 1;
      return getOrder(id);
    };
    const s = await store({ adapter });
    const { orderId } = await s.buy();
    await s.call("GET", `${UCP_REST_PREFIX}/orders/${orderId}`);
    await s.app.orderEvents.watchOnce();
    expect(asked).toBe(0);
  });

  it("records a simulated shipment once, however often it is asked for", async () => {
    const s = await store();
    const { orderId } = await s.buy();
    await s.app.orderEvents.recordShipment(orderId, { source: "simulation" });
    await s.app.orderEvents.recordShipment(orderId, { source: "simulation" });
    expect(s.orders.get(orderId)?.fulfillmentEvents).toHaveLength(1);
    await expect(s.app.orderEvents.recordShipment("ord_missing", { source: "simulation" })).rejects.toMatchObject({ code: "OrderNotFound" });
  });
});
