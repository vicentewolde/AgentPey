import type { EscrowPurchase, EscrowReader, EscrowReaderFactory } from "@vitrinee/anchor";
import { VitrineeError } from "@vitrinee/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoreEscrow } from "./config.js";
import { EscrowReleases, RELEASE_MARGIN_MS } from "./escrow-release.js";
import { OrderStore, type OrderRecord } from "./orders.js";

const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
const ORDER = "ord_ship_1";
const T0 = 1_793_000_000; // seconds
const STORE_ESCROW: StoreEscrow = { contract: ESCROW, payee: "GPAYEE", arbiter: "GARBITER", releaseWindowSeconds: 600, responseWindowSeconds: 900, resolveWindowSeconds: 3600 };

const order = (overrides: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    orderId: ORDER,
    status: "paid",
    createdAt: "2026-11-04T12:00:00.000Z",
    receipt: { jws: "r", hash: "7".repeat(64) },
    hold: { status: "held", attempts: 1, escrow: ESCROW },
    fulfillmentState: "fulfilled",
    ...overrides,
  }) as OrderRecord;

const purchase = (overrides: Partial<EscrowPurchase> = {}): EscrowPurchase => ({
  orderRef: ORDER,
  payer: "CRAIL",
  amountAtomic: 5_157_895n,
  txHash: "e".repeat(64),
  receiptHash: "7".repeat(64),
  status: "held",
  heldAt: T0 - 100,
  shippedAt: null,
  claimHash: null,
  openedAt: null,
  responseHash: null,
  verdictHash: null,
  refundAtomic: 0n,
  refundOwedAtomic: 0n,
  closedAt: null,
  ...overrides,
});

/** An escrow in memory that answers `mark_shipped` and `release` the way the contract does. */
function setup(options: { record?: OrderRecord; start?: EscrowPurchase; failShip?: number; failRelease?: number } = {}) {
  let chain: EscrowPurchase = options.start ?? purchase();
  let shipFailures = options.failShip ?? 0;
  let releaseFailures = options.failRelease ?? 0;
  const calls: string[] = [];
  const now = () => new Date(Date.now());
  const readers: EscrowReaderFactory = (contractId) => ({ contractId, get: async () => chain, config: async () => { throw new Error("unused"); }, byTx: async () => null }) as EscrowReader;
  const contractError = (code: number) => new VitrineeError("EscrowError", `simulation failed: HostError: Error(Contract, #${code})`);
  const writer = {
    async markShipped(orderRef: string) {
      calls.push(`mark_shipped ${orderRef}`);
      if (shipFailures > 0) {
        shipFailures -= 1;
        throw new VitrineeError("EscrowError", "mark_shipped submission TRY_AGAIN_LATER");
      }
      if (chain.status !== "held") throw contractError(8);
      chain = { ...chain, status: "shipped", shippedAt: Math.floor(Date.now() / 1000) };
      return { txHash: "a".repeat(64) };
    },
    async release(orderRef: string) {
      calls.push(`release ${orderRef}`);
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        throw new VitrineeError("EscrowError", "release transaction NOT_FOUND");
      }
      if (chain.status !== "shipped") throw contractError(8);
      if (Date.now() / 1000 < (chain.shippedAt ?? 0) + STORE_ESCROW.releaseWindowSeconds) throw contractError(9);
      chain = { ...chain, status: "released", closedAt: Math.floor(Date.now() / 1000) };
      return { txHash: "b".repeat(64) };
    },
  };
  const orders = new OrderStore(undefined, [options.record ?? order()]);
  const logs: string[] = [];
  const releases = new EscrowReleases({
    orders,
    escrow: STORE_ESCROW,
    readers,
    writer,
    operatorSecret: "SOPERATOR",
    now,
    log: (message) => logs.push(message),
    retryDelaysMs: [1_000, 5_000],
  });
  return { releases, orders, calls, logs, chain: () => chain, dispute: () => (chain = { ...chain, status: "disputed", openedAt: Math.floor(Date.now() / 1000), claimHash: "c".repeat(64) }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0 * 1000));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the shipment opens the release window, and the store releases when it closes (T164)", () => {
  it("marks the order shipped once, waits the window, and releases to the payee", async () => {
    const s = setup();
    await s.releases.afterShipment(ORDER);
    expect(s.calls).toEqual([`mark_shipped ${ORDER}`]);
    expect(s.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "shipped", shippedTx: "a".repeat(64), releaseAfter: new Date((T0 + 600) * 1000).toISOString() });
    // A second notice of the same shipment sends nothing.
    await s.releases.afterShipment(ORDER);
    expect(s.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600_000 + RELEASE_MARGIN_MS);
    await s.releases.idle();
    expect(s.calls).toEqual([`mark_shipped ${ORDER}`, `release ${ORDER}`]);
    expect(s.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "released", releaseTx: "b".repeat(64) });
    expect(s.chain().status).toBe("released");
  });

  it("never releases a purchase disputed during the window: the claim takes over", async () => {
    const s = setup();
    await s.releases.afterShipment(ORDER);
    s.dispute();
    await vi.advanceTimersByTimeAsync(600_000 + RELEASE_MARGIN_MS);
    await s.releases.idle();
    expect(s.calls).toEqual([`mark_shipped ${ORDER}`]);
    expect(s.orders.get(ORDER)?.escrowRelease?.status).toBe("disputed");
    expect(s.logs).toContain("escrow release stopped: a claim was opened");
    // Nothing is scheduled after that.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.calls).toHaveLength(1);
  });

  it("asks again shortly when the ledger's clock is still inside the window, without counting a failure", async () => {
    const s = setup();
    await s.releases.afterShipment(ORDER);
    // The wall clock reached the end, the ledger did not yet: release one second early.
    await vi.advanceTimersByTimeAsync(600_000 + RELEASE_MARGIN_MS);
    await s.releases.idle();
    expect(s.orders.get(ORDER)?.escrowRelease?.status).toBe("released");
    vi.setSystemTime(new Date(T0 * 1000));
    const early = setup();
    await early.releases.afterShipment(ORDER);
    vi.setSystemTime(new Date((T0 + 599) * 1000));
    // Force a release attempt before the window: the contract answers #9 and the store waits.
    await (early.releases as unknown as { release(id: string): Promise<void> }).release(ORDER);
    expect(early.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "shipped", attempts: 0 });
    await vi.advanceTimersByTimeAsync(RELEASE_MARGIN_MS);
    await early.releases.idle();
    expect(early.orders.get(ORDER)?.escrowRelease?.status).toBe("released");
  });

  it("tries again after a failed call, and gives up after its delays, by hand from there", async () => {
    const retried = setup({ failShip: 1 });
    await retried.releases.afterShipment(ORDER);
    expect(retried.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("TRY_AGAIN_LATER") });
    await vi.advanceTimersByTimeAsync(1_000);
    await retried.releases.idle();
    expect(retried.orders.get(ORDER)?.escrowRelease?.status).toBe("shipped");

    const stuck = setup({ failShip: 5 });
    await stuck.releases.afterShipment(ORDER);
    await vi.advanceTimersByTimeAsync(1_000);
    await stuck.releases.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    await stuck.releases.idle();
    expect(stuck.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "failed", attempts: 3 });
    expect(stuck.calls).toHaveLength(3);
  });

  it("does nothing for an order that did not leave in full, or that is not held in this store's escrow", async () => {
    for (const record of [order({ fulfillmentState: "partial" }), order({ hold: { status: "held", attempts: 1, escrow: "COTHER" } }), order({ hold: { status: "pending", attempts: 0, escrow: ESCROW } })]) {
      const s = setup({ record });
      await s.releases.afterShipment(ORDER);
      expect(s.calls).toEqual([]);
      expect(s.orders.get(ORDER)?.escrowRelease).toBeUndefined();
    }
  });

  it("does not open the window of a purchase already disputed: the claim came first", async () => {
    const s = setup({ start: purchase({ status: "disputed", openedAt: T0 - 10, claimHash: "c".repeat(64) }) });
    await s.releases.afterShipment(ORDER);
    expect(s.calls).toEqual([]);
    expect(s.orders.get(ORDER)?.escrowRelease?.status).toBe("disputed");
  });

  it("resumes after a restart: a window still running, and a shipment never sent to the escrow", async () => {
    const running = setup({
      record: order({ escrowRelease: { status: "shipped", attempts: 0, shippedAt: new Date(T0 * 1000).toISOString(), releaseAfter: new Date((T0 + 600) * 1000).toISOString() } }),
      start: purchase({ status: "shipped", shippedAt: T0 }),
    });
    expect(running.releases.resume()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000 + RELEASE_MARGIN_MS);
    await running.releases.idle();
    expect(running.calls).toEqual([`release ${ORDER}`]);

    const unsent = setup();
    expect(unsent.releases.resume()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await unsent.releases.idle();
    expect(unsent.calls).toEqual([`mark_shipped ${ORDER}`]);
  });
});
