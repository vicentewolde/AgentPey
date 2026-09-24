import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Buyer } from "@vitrinee/adapters";
import { VitrineeError } from "@vitrinee/core";
import { z } from "zod";

export type OrderStatus = "paid" | "paid_unfulfilled";

export interface OrderSettlement {
  txHash: string;
  network: string;
  payer: string;
  payTo: string;
  asset: string;
  amountAtomic: string;
  explorerUrl: string;
  settledAt: string;
}

export interface OrderAnchor {
  status: "pending" | "anchored" | "failed";
  attempts: number;
  registry: string;
  txHash?: string;
  ledger?: number;
  anchoredAt?: string;
  explorerUrl?: string;
  lastError?: string;
}

/** The gateway's own record of a sale: what was paid, what the platform did with it, how it is proven. */
export interface OrderRecord {
  orderId: string;
  status: OrderStatus;
  createdAt: string;
  idempotencyKey: string | null;
  product: { id: string; sku: string; name: string };
  quantity: number;
  unitPriceUSDCAtomic: string;
  amountUSDCAtomic: string;
  amountUSDC: string;
  totalLocal: string;
  currency: string;
  buyer: Buyer;
  settlement: OrderSettlement;
  platform: string;
  platformOrderId: string | null;
  /** Set when the platform refused the order after payment had settled. Fulfil by hand. */
  platformError: string | null;
  receipt: { jws: string; hash: string } | null;
  anchor: OrderAnchor | null;
}

/**
 * An {@link OrderRecord} read back from storage. The database is a boundary
 * like any other: a row that does not have this shape is refused, not cast.
 */
export const orderRecordSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(["paid", "paid_unfulfilled"]),
  createdAt: z.string().min(1),
  idempotencyKey: z.string().nullable(),
  product: z.object({ id: z.string(), sku: z.string(), name: z.string() }),
  quantity: z.number().int().positive(),
  unitPriceUSDCAtomic: z.string().regex(/^\d+$/),
  amountUSDCAtomic: z.string().regex(/^\d+$/),
  amountUSDC: z.string(),
  totalLocal: z.string(),
  currency: z.string(),
  buyer: z.object({
    stellarAccount: z.string(),
    email: z.string().optional(),
    shipping: z
      .object({
        name: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        region: z.string().optional(),
        country: z.string(),
        notes: z.string().optional(),
      })
      .optional(),
  }),
  settlement: z.object({
    txHash: z.string(),
    network: z.string(),
    payer: z.string(),
    payTo: z.string(),
    asset: z.string(),
    amountAtomic: z.string(),
    explorerUrl: z.string(),
    settledAt: z.string(),
  }),
  platform: z.string(),
  platformOrderId: z.string().nullable(),
  platformError: z.string().nullable(),
  receipt: z.object({ jws: z.string(), hash: z.string() }).nullable(),
  anchor: z
    .object({
      status: z.enum(["pending", "anchored", "failed"]),
      attempts: z.number().int().nonnegative(),
      registry: z.string(),
      txHash: z.string().optional(),
      ledger: z.number().int().optional(),
      anchoredAt: z.string().optional(),
      explorerUrl: z.string().optional(),
      lastError: z.string().optional(),
    })
    .nullable(),
});

interface PersistedOrders {
  orders: OrderRecord[];
}

/**
 * Where an {@link OrderStore} keeps its records beyond memory. Two
 * implementations: a JSON file (the single-store gateway, as before T103) and
 * Postgres, one merchant per store (T103, C-143).
 */
export interface OrderPersistence {
  load(): Promise<OrderRecord[]>;
  /** Persists `order`, just changed. `all` is every record, for backends that write a snapshot. */
  save(order: OrderRecord, all: readonly OrderRecord[]): Promise<void>;
}

/** The pre-T103 behaviour: one JSON file with every order, rewritten on each change. */
export class FileOrderPersistence implements OrderPersistence {
  constructor(private readonly file: string) {}

  loadSync(): OrderRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as PersistedOrders).orders;
    } catch (error) {
      throw new VitrineeError("ConfigError", `orders file is not valid JSON: ${this.file}`, { cause: error, details: { file: this.file } });
    }
  }

  async load(): Promise<OrderRecord[]> {
    return this.loadSync();
  }

  async save(_order: OrderRecord, all: readonly OrderRecord[]): Promise<void> {
    const snapshot = JSON.stringify({ orders: [...all] } satisfies PersistedOrders, null, 2) + "\n";
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, snapshot, { mode: 0o600 });
  }
}

/**
 * The gateway's own order records. Reads are served from memory, so the
 * checkout path stays synchronous where it was; every write goes through to
 * the persistence before it resolves. One process owns one merchant's store,
 * which is what makes the in-memory copy authoritative.
 */
export class OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private writing: Promise<void> = Promise.resolve();
  private readonly persistence: OrderPersistence | undefined;

  /** `file` keeps the pre-T103 constructor working: a path, a persistence, or memory only. */
  constructor(file?: string | OrderPersistence, initial: readonly OrderRecord[] = []) {
    if (typeof file === "string") {
      const filePersistence = new FileOrderPersistence(file);
      this.persistence = filePersistence;
      for (const order of filePersistence.loadSync()) this.orders.set(order.orderId, order);
    } else {
      this.persistence = file;
    }
    for (const order of initial) this.orders.set(order.orderId, structuredClone(order));
  }

  /** A store whose records are loaded from `persistence` first. */
  static async open(persistence: OrderPersistence): Promise<OrderStore> {
    return new OrderStore(persistence, await persistence.load());
  }

  async put(order: OrderRecord): Promise<void> {
    this.orders.set(order.orderId, structuredClone(order));
    await this.persist(order.orderId);
  }

  /** Read-modify-write of one record. */
  async update(orderId: string, change: (order: OrderRecord) => void): Promise<OrderRecord | undefined> {
    const current = this.orders.get(orderId);
    if (current === undefined) return undefined;
    const next = structuredClone(current);
    change(next);
    this.orders.set(orderId, next);
    await this.persist(orderId);
    return structuredClone(next);
  }

  get(orderId: string): OrderRecord | undefined {
    const order = this.orders.get(orderId);
    return order === undefined ? undefined : structuredClone(order);
  }

  private find(predicate: (order: OrderRecord) => boolean): OrderRecord | undefined {
    for (const order of this.orders.values()) if (predicate(order)) return structuredClone(order);
    return undefined;
  }

  findByReceiptHash(hash: string): OrderRecord | undefined {
    return this.find((o) => o.receipt?.hash === hash);
  }

  findByIdempotencyKey(key: string): OrderRecord | undefined {
    return this.find((o) => o.idempotencyKey === key);
  }

  findBySettlementTx(txHash: string): OrderRecord | undefined {
    return this.find((o) => o.settlement.txHash === txHash);
  }

  list(): OrderRecord[] {
    return [...this.orders.values()].map((o) => structuredClone(o)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Writes are serialized so two concurrent updates never interleave in the backend. */
  private async persist(orderId: string): Promise<void> {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    const order = structuredClone(this.orders.get(orderId)!);
    const all = [...this.orders.values()].map((o) => structuredClone(o));
    const write = this.writing.then(() => persistence.save(order, all));
    // A failed write must reach its caller, but must not poison every later write.
    this.writing = write.catch(() => undefined);
    await write;
  }
}
