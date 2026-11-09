import { readFileSync } from "node:fs";

import { MockStoreAdapter } from "@vitrinee/adapters";
import { STELLAR_X402_HANDLER, UCP_REST_PREFIX, USDC_TESTNET } from "@vitrinee/core";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { OrderStore } from "../orders.js";
import { fakeFacilitator, type FakeFacilitator } from "../test/fake-facilitator.js";
import { MERCHANT, fakePlatformProfiles, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { RECONCILE_GIVE_UP_MS, reconcileSession, verifyStrandedPayment } from "./reconcile.js";
import { MemoryCheckoutSessions, type CheckoutSession } from "./sessions.js";

// A real settlement envelope paid by AgentPey's policy_rail, so the payer can be read out of the signed transaction.
const ENVELOPE = readFileSync(new URL("../test/fixtures/settlement-42d738d4.b64", import.meta.url), "utf8").trim();
const RAIL = "CANSQJH7KPQTBUXPA42BBWZGZRKLWQZUFVF3SLQOUWKHEX4L3JP7YEDA";
const HASH = "ab".repeat(32);
const DESTINATION = { first_name: "Ana", last_name: "Rojas", street_address: "Av. Providencia 1234", address_locality: "Santiago", address_region: "RM", address_country: "CL" };

interface Requirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}
interface Checkout {
  id: string;
  ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements?: Requirements } }>> };
}

/** A facilitator that cannot say how the payment went: the chain may have it. */
function unsure(transaction: string | null): FakeFacilitator {
  const base = fakeFacilitator();
  return {
    ...base,
    async settle(payload, requirements) {
      base.settleCalls.push({ payload, requirements });
      if (transaction === null) throw new Error("timeout waiting for the facilitator");
      return { success: false, transaction, network: "stellar:testnet", errorReason: "settle_timeout" };
    },
  };
}

type Mode = "paid" | "absent" | "down" | "less" | "failed";

/** Horizon as the checks read it: the transaction, then its effects. `mode` is what the chain says. */
function horizon(state: { mode: Mode; amount: () => string | undefined }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (state.mode === "down") return new Response("bad gateway", { status: 502 });
    if (state.mode === "absent") return new Response("not found", { status: 404 });
    if (url.endsWith(`/transactions/${HASH}`)) {
      return Response.json({ successful: state.mode !== "failed", ledger: 123, created_at: "2026-11-09T01:00:00Z" });
    }
    if (url.includes(`/transactions/${HASH}/effects`)) {
      const atomic = BigInt(state.amount() ?? "0") - (state.mode === "less" ? 1n : 0n);
      const amount = `${atomic / 10_000_000n}.${(atomic % 10_000_000n).toString().padStart(7, "0")}`;
      const asset = { asset_code: USDC_TESTNET.code, asset_issuer: USDC_TESTNET.issuer };
      return Response.json({ _embedded: { records: [{ type: "contract_debited", contract: RAIL, account: "GFACILITATOR", amount, ...asset }, { type: "account_credited", account: MERCHANT, amount, ...asset }] } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

const clock = { now: new Date("2026-11-09T00:00:00.000Z") };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  clock.now = new Date("2026-11-09T00:00:00.000Z");
  while (closers.length > 0) await closers.pop()!();
});

async function start(options: { facilitator: FakeFacilitator; state: { mode: Mode; amount: () => string | undefined }; sessions?: MemoryCheckoutSessions; orders?: OrderStore }) {
  const registry = fakeRegistry();
  const adapter = new MockStoreAdapter({});
  let created = 0;
  const createOrder = adapter.createOrder.bind(adapter);
  adapter.createOrder = async (input) => {
    created += 1;
    return createOrder(input);
  };
  const sessions = options.sessions ?? new MemoryCheckoutSessions();
  const orders = options.orders ?? new OrderStore(undefined);
  const app = createApp({
    platformProfiles: fakePlatformProfiles(),
    config: testConfig(),
    adapter,
    facilitator: options.facilitator,
    anchorer: registry.anchorer,
    registry: registry.registry,
    sessions,
    orders,
    horizonFetch: horizon(options.state),
    anchorRetryDelaysMs: [1],
    now: () => clock.now,
    reconcilePending: false,
  });
  const { url, close } = await listen(app);
  closers.push(close, async () => {
    app.orderEvents.stop();
    await app.anchors.idle?.();
  });
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}${UCP_REST_PREFIX}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "UCP-Agent": 'profile="https://agentpey.com/ucp/platform/agentpey.json"' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as Checkout & Record<string, unknown> };
  };
  /** A buyer who pays, and whom the facilitator leaves without an answer. */
  const strand = async (): Promise<{ id: string; requirements: Requirements }> => {
    const { body: made } = await call("/checkout-sessions", {
      line_items: [{ item: { id: "hoodie-cordillera-m" }, quantity: 1 }],
      buyer: { email: "ana@example.com" },
      fulfillment: { methods: [{ type: "shipping", destinations: [DESTINATION] }] },
    });
    const requirements = made.ucp.payment_handlers[STELLAR_X402_HANDLER]![0]!.config.payment_requirements!;
    const completed = await call(`/checkout-sessions/${made.id}/complete`, {
      payment: { instruments: [{ id: "i", handler_id: "stellar_x402", type: "stellar_x402", selected: true, credential: { type: "x402_payment_payload", x402_version: 2, accepted: requirements, payload: { transaction: ENVELOPE } } }] },
    });
    expect(completed.body.status).toBe("complete_in_progress");
    return { id: made.id, requirements };
  };
  return { app, sessions, orders, strand, orderCount: () => created };
}

const stored = async (sessions: MemoryCheckoutSessions, id: string): Promise<CheckoutSession> => (await sessions.get(id))!;

describe("a payment whose outcome the store never learned (T180, X-32)", () => {
  it("finds the payment on the chain, checks it and makes the order once", async () => {
    const state = { mode: "paid" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const { id, requirements } = await s.strand();
    state.amount = () => requirements.amount;

    await s.app.sessionReconciler.sweepOnce();
    const done = await stored(s.sessions, id);
    expect(done).toMatchObject({ status: "completed", settlement: { txHash: HASH, payer: RAIL, amountAtomic: requirements.amount } });
    expect(done.orderId).not.toBeNull();
    expect(s.orderCount()).toBe(1);

    // Another pass finds nothing held: no second order, no second charge.
    await s.app.sessionReconciler.sweepOnce();
    expect(s.orderCount()).toBe(1);
    expect(s.orders.list()).toHaveLength(1);
  });

  it("changes nothing in a dry run, and says what it would do", async () => {
    const state = { mode: "paid" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const { id, requirements } = await s.strand();
    state.amount = () => requirements.amount;
    const session = await stored(s.sessions, id);

    const result = await reconcileSession({ checkout: undefined as never, horizonUrl: "https://horizon.test", fetchImpl: horizon(state) }, session, { apply: false });
    expect(result).toEqual({ kind: "paid", applied: false, transaction: HASH });
    expect(await stored(s.sessions, id)).toMatchObject({ status: "complete_in_progress", settlement: null });
    expect(s.orderCount()).toBe(0);
  });

  it("looks again, with growing waits, when the transaction is not on the chain yet; and finishes once it is", async () => {
    const state = { mode: "absent" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const { id, requirements } = await s.strand();
    state.amount = () => requirements.amount;

    await s.app.sessionReconciler.sweepOnce();
    expect((await stored(s.sessions, id)).reconcile).toMatchObject({ attempts: 1, review: null, lastReason: expect.stringContaining("not found") });
    // Not due yet: the sweep leaves it alone.
    await s.app.sessionReconciler.sweepOnce();
    expect((await stored(s.sessions, id)).reconcile?.attempts).toBe(1);

    state.mode = "paid";
    clock.now = new Date(clock.now.getTime() + 60_000);
    await s.app.sessionReconciler.sweepOnce();
    expect((await stored(s.sessions, id)).status).toBe("completed");
    expect(s.orderCount()).toBe(1);
  });

  it("sends the checkout to a person when a day passes with no payment", async () => {
    const state = { mode: "absent" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const { id } = await s.strand();
    clock.now = new Date(clock.now.getTime() + RECONCILE_GIVE_UP_MS + 60_000);
    await s.app.sessionReconciler.sweepOnce();
    expect((await stored(s.sessions, id)).reconcile?.review).toMatchObject({ reason: expect.stringContaining("in a day") });
    expect(s.orderCount()).toBe(0);
  });

  it("never assumes a payment of another amount", async () => {
    const state = { mode: "less" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const { id, requirements } = await s.strand();
    state.amount = () => requirements.amount;
    await s.app.sessionReconciler.sweepOnce();
    const held = await stored(s.sessions, id);
    expect(held).toMatchObject({ status: "complete_in_progress", settlement: null });
    expect(held.reconcile?.review?.reason).toContain("not debited");
    expect(s.orderCount()).toBe(0);
  });

  it("never assumes a payment that failed on the chain", async () => {
    const state = { mode: "failed" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const { id, requirements } = await s.strand();
    state.amount = () => requirements.amount;
    await s.app.sessionReconciler.sweepOnce();
    expect((await stored(s.sessions, id)).reconcile?.review?.reason).toContain("failed on chain");
    expect(s.orderCount()).toBe(0);
  });

  it("marks for review, without assuming a payment, a checkout whose facilitator never gave a hash", async () => {
    const state = { mode: "paid" as Mode, amount: (): string | undefined => "1" };
    const s = await start({ facilitator: unsure(null), state });
    const { id } = await s.strand();
    await s.app.sessionReconciler.sweepOnce();
    const held = await stored(s.sessions, id);
    expect(held.reconcile?.review?.reason).toContain("never reported a transaction");
    expect(held.settlement).toBeNull();
    expect(s.orderCount()).toBe(0);
    // A person who finds the transaction can hand it over: it is verified like any other.
    const requirements = held.requirements!;
    state.amount = () => requirements.amount;
    const verdict = await verifyStrandedPayment({ horizonUrl: "https://horizon.test", fetchImpl: horizon(state) }, held, HASH);
    expect(verdict).toMatchObject({ kind: "verified", transaction: HASH, payer: RAIL });
  });

  it("makes one order when two held checkouts name the same transaction", async () => {
    const state = { mode: "paid" as Mode, amount: (): string | undefined => undefined };
    const s = await start({ facilitator: unsure(HASH), state });
    const first = await s.strand();
    const second = await s.strand();
    state.amount = () => first.requirements.amount;
    await s.app.sessionReconciler.sweepOnce();
    const statuses = [(await stored(s.sessions, first.id)).status, (await stored(s.sessions, second.id)).status];
    expect(statuses.filter((status) => status === "completed")).toHaveLength(1);
    const left = (await stored(s.sessions, statuses[0] === "completed" ? second.id : first.id)).reconcile?.review;
    expect(left?.reason).toContain("another checkout's order");
    expect(s.orderCount()).toBe(1);
    expect(s.orders.list()).toHaveLength(1);
  });

  it("resumes after a restart: a new process reads the held checkout and finishes it", async () => {
    const state = { mode: "down" as Mode, amount: (): string | undefined => undefined };
    const first = await start({ facilitator: unsure(HASH), state });
    const { id, requirements } = await first.strand();
    state.amount = () => requirements.amount;
    await first.app.sessionReconciler.sweepOnce();
    expect((await stored(first.sessions, id)).reconcile).toMatchObject({ attempts: 1, review: null });
    first.app.sessionReconciler.stop();

    // Horizon is back, the old process is gone; the sessions and orders live on in the database.
    state.mode = "paid";
    clock.now = new Date(clock.now.getTime() + 60_000);
    const second = await start({ facilitator: unsure(HASH), state, sessions: first.sessions, orders: first.orders });
    await second.app.sessionReconciler.sweepOnce();
    expect((await stored(second.sessions, id)).status).toBe("completed");
    expect(second.orders.list()).toHaveLength(1);
  });
});
