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

/** Lets fake time pass while a step runs (each fake chain call takes 100 ms). */
async function run(step: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
  await step;
}

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
function setup(options: { record?: OrderRecord; records?: OrderRecord[]; start?: EscrowPurchase; failShip?: number; failRelease?: number; orders?: OrderStore; queued?: boolean } = {}) {
  let chain: EscrowPurchase = options.start ?? purchase();
  let shipFailures = options.failShip ?? 0;
  let releaseFailures = options.failRelease ?? 0;
  const calls: string[] = [];
  const now = () => new Date(Date.now());
  // One purchase per order: the first order's is `chain`, others start held and move on their own.
  const others = new Map<string, EscrowPurchase>();
  const purchaseOf = (orderRef: string): EscrowPurchase => (orderRef === ORDER ? chain : (others.get(orderRef) ?? purchase({ orderRef })));
  const setPurchase = (orderRef: string, p: EscrowPurchase) => (orderRef === ORDER ? (chain = p) : others.set(orderRef, p));
  const readers: EscrowReaderFactory = (contractId) => ({ contractId, get: async (orderRef: string) => purchaseOf(orderRef), config: async () => { throw new Error("unused"); }, byTx: async () => null }) as unknown as EscrowReader;
  let inFlight = 0;
  let maxInFlight = 0;
  const contractError = (code: number) => new VitrineeError("EscrowError", `simulation failed: HostError: Error(Contract, #${code})`);
  const writer = {
    async markShipped(orderRef: string) {
      calls.push(`mark_shipped ${orderRef}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real call takes a while: anything else sent meanwhile would collide on the account's sequence.
      await new Promise((done) => setTimeout(done, 100));
      inFlight -= 1;
      if (shipFailures > 0) {
        shipFailures -= 1;
        throw new VitrineeError("EscrowError", "mark_shipped submission TRY_AGAIN_LATER");
      }
      const p = purchaseOf(orderRef);
      if (p.status !== "held") throw contractError(8);
      setPurchase(orderRef, { ...p, status: "shipped", shippedAt: Math.floor(Date.now() / 1000) });
      return { txHash: "a".repeat(64) };
    },
    async release(orderRef: string) {
      calls.push(`release ${orderRef}`);
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        throw new VitrineeError("EscrowError", "release transaction NOT_FOUND");
      }
      const p = purchaseOf(orderRef);
      if (p.status !== "shipped") throw contractError(8);
      if (Date.now() / 1000 < (p.shippedAt ?? 0) + STORE_ESCROW.releaseWindowSeconds) throw contractError(9);
      setPurchase(orderRef, { ...p, status: "released", closedAt: Math.floor(Date.now() / 1000) });
      return { txHash: "b".repeat(64) };
    },
  };
  const orders = options.orders ?? new OrderStore(undefined, options.records ?? [options.record ?? order()]);
  const logs: string[] = [];
  // The signing account's queue, as AnchorWorker.signerTurn runs it.
  let queue: Promise<unknown> = Promise.resolve();
  const signerTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
  const releases = new EscrowReleases({
    orders,
    escrow: STORE_ESCROW,
    readers,
    writer,
    operatorSecret: "SOPERATOR",
    now,
    log: (message) => logs.push(message),
    retryDelaysMs: [1_000, 5_000],
    ...(options.queued === false ? {} : { signerTurn }),
  });
  return { releases, orders, calls, logs, maxInFlight: () => maxInFlight, purchaseOf, chain: () => chain, dispute: () => (chain = { ...chain, status: "disputed", openedAt: Math.floor(Date.now() / 1000), claimHash: "c".repeat(64) }) };
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
    await run(s.releases.afterShipment(ORDER));
    expect(s.calls).toEqual([`mark_shipped ${ORDER}`]);
    expect(s.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "shipped", shippedTx: "a".repeat(64) });
    // A second notice of the same shipment sends nothing.
    await run(s.releases.afterShipment(ORDER));
    expect(s.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600_000 + RELEASE_MARGIN_MS);
    await s.releases.idle();
    expect(s.calls).toEqual([`mark_shipped ${ORDER}`, `release ${ORDER}`]);
    expect(s.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "released", releaseTx: "b".repeat(64) });
    expect(s.chain().status).toBe("released");
  });

  it("never releases a purchase disputed during the window: the claim takes over", async () => {
    const s = setup();
    await run(s.releases.afterShipment(ORDER));
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

  it("waits for the window the escrow reports when its clock is behind the one kept here, without counting a failure", async () => {
    // Kept here: the window ends at T0+600. On chain the parcel shipped 20 s later, so the escrow says #9 until T0+620.
    const s = setup({
      record: order({ escrowRelease: { status: "shipped", attempts: 0, shippedAt: new Date(T0 * 1000).toISOString(), releaseAfter: new Date((T0 + 600) * 1000).toISOString() } }),
      start: purchase({ status: "shipped", shippedAt: T0 + 20 }),
    });
    s.releases.resume();
    await vi.advanceTimersByTimeAsync(600_000 + RELEASE_MARGIN_MS);
    await s.releases.idle();
    expect(s.chain().status).toBe("shipped");
    expect(s.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "shipped", attempts: 0 });
    await vi.advanceTimersByTimeAsync(20_000 + RELEASE_MARGIN_MS);
    await s.releases.idle();
    expect(s.orders.get(ORDER)?.escrowRelease?.status).toBe("released");
    expect(s.calls).toEqual([`release ${ORDER}`, `release ${ORDER}`]);
  });

  it("tries again after a failed call, and gives up after its delays, by hand from there", async () => {
    const retried = setup({ failShip: 1 });
    await run(retried.releases.afterShipment(ORDER));
    expect(retried.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("TRY_AGAIN_LATER") });
    await vi.advanceTimersByTimeAsync(1_000);
    await retried.releases.idle();
    expect(retried.orders.get(ORDER)?.escrowRelease?.status).toBe("shipped");

    const stuck = setup({ failShip: 3 });
    await run(stuck.releases.afterShipment(ORDER));
    await vi.advanceTimersByTimeAsync(2_000);
    await stuck.releases.idle();
    await vi.advanceTimersByTimeAsync(6_000);
    await stuck.releases.idle();
    expect(stuck.orders.get(ORDER)?.escrowRelease).toMatchObject({ status: "failed", attempts: 3 });
    expect(stuck.calls).toHaveLength(3);
    // A restart gives it one more chance: the contract judges every call anyway.
    expect(stuck.releases.resume()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await stuck.releases.idle();
    expect(stuck.orders.get(ORDER)?.escrowRelease?.status).toBe("shipped");
  });

  it("does nothing for an order that did not leave in full, or that is not held in this store's escrow", async () => {
    for (const record of [order({ fulfillmentState: "partial" }), order({ hold: { status: "held", attempts: 1, escrow: "COTHER" } }), order({ hold: { status: "pending", attempts: 0, escrow: ESCROW } })]) {
      const s = setup({ record });
      await run(s.releases.afterShipment(ORDER));
      expect(s.calls).toEqual([]);
      expect(s.orders.get(ORDER)?.escrowRelease).toBeUndefined();
    }
  });

  it("does not open the window of a purchase already disputed: the claim came first", async () => {
    const s = setup({ start: purchase({ status: "disputed", openedAt: T0 - 10, claimHash: "c".repeat(64) }) });
    await run(s.releases.afterShipment(ORDER));
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

    const unsent = setup({ record: order({ escrowRelease: { status: "pending", attempts: 0 } }) });
    expect(unsent.releases.resume()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await unsent.releases.idle();
    expect(unsent.calls).toEqual([`mark_shipped ${ORDER}`]);
    // An order fulfilled before T164 existed, never marked for the escrow, is left alone at startup.
    const old = setup();
    expect(old.releases.resume()).toBe(0);
  });

  it("sends one transaction at a time from the signing account, even when two windows close together", async () => {
    const second = "ord_ship_2";
    const s = setup({ records: [order({ escrowRelease: { status: "pending", attempts: 0 } }), order({ orderId: second, escrowRelease: { status: "pending", attempts: 0 } })] });
    expect(s.releases.resume()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await s.releases.idle();
    expect(s.maxInFlight()).toBe(1);
    expect(s.purchaseOf(second).status).toBe("shipped");
    expect(s.chain().status).toBe("shipped");
  });

  it("never throws when the order store cannot save, and logs it", async () => {
    const orders = new OrderStore(undefined, [order()]);
    const failing = Object.assign(Object.create(Object.getPrototypeOf(orders) as object) as OrderStore, orders, {
      update: () => Promise.reject(new Error("postgres is down")),
    });
    const s = setup({ orders: failing });
    await expect(run(s.releases.afterShipment(ORDER))).resolves.toBeUndefined();
    expect(s.logs).toContain("escrow release state not saved");
  });
});
