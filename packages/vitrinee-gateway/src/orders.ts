import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Buyer } from "@vitrinee/adapters";
import { VitrineeError } from "@vitrinee/core";

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

interface PersistedOrders {
  orders: OrderRecord[];
}

export class OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file?: string) {
    if (file !== undefined && existsSync(file)) {
      let state: PersistedOrders;
      try {
        state = JSON.parse(readFileSync(file, "utf8")) as PersistedOrders;
      } catch (error) {
        throw new VitrineeError("ConfigError", `orders file is not valid JSON: ${file}`, { cause: error, details: { file } });
      }
      for (const order of state.orders) this.orders.set(order.orderId, order);
    }
  }

  async put(order: OrderRecord): Promise<void> {
    this.orders.set(order.orderId, structuredClone(order));
    await this.persist();
  }

  /** Read-modify-write of one record. */
  async update(orderId: string, change: (order: OrderRecord) => void): Promise<OrderRecord | undefined> {
    const current = this.orders.get(orderId);
    if (current === undefined) return undefined;
    const next = structuredClone(current);
    change(next);
    this.orders.set(orderId, next);
    await this.persist();
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

  /** Writes are serialized so two concurrent updates never interleave on disk. */
  private async persist(): Promise<void> {
    if (this.file === undefined) return;
    const file = this.file;
    const snapshot = JSON.stringify({ orders: [...this.orders.values()] } satisfies PersistedOrders, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, snapshot, { mode: 0o600 });
    });
    await this.writing;
  }
}
