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

/** The gateway's own record of a sale: what was paid, what the platform did with it. */
export interface OrderRecord {
  orderId: string;
  status: OrderStatus;
  createdAt: string;
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
  /** Day 2. */
  receipt: { jws: string; hash: string } | null;
  anchor: { status: "pending" | "anchored" | "failed"; txHash?: string } | null;
}

interface PersistedOrders {
  orders: OrderRecord[];
}

export class OrderStore {
  private readonly orders = new Map<string, OrderRecord>();

  constructor(private readonly file?: string) {
    if (file !== undefined && existsSync(file)) {
      let state: PersistedOrders;
      try {
        state = JSON.parse(readFileSync(file, "utf8")) as PersistedOrders;
      } catch (error) {
        throw new VitrineeError("ConfigError", `orders file is not valid JSON: ${file}`, {
          cause: error,
          details: { file },
        });
      }
      for (const order of state.orders) this.orders.set(order.orderId, order);
    }
  }

  async put(order: OrderRecord): Promise<void> {
    this.orders.set(order.orderId, structuredClone(order));
    await this.persist();
  }

  get(orderId: string): OrderRecord | undefined {
    const order = this.orders.get(orderId);
    return order === undefined ? undefined : structuredClone(order);
  }

  list(): OrderRecord[] {
    return [...this.orders.values()].map((o) => structuredClone(o)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private async persist(): Promise<void> {
    if (this.file === undefined) return;
    await mkdir(dirname(this.file), { recursive: true });
    const state: PersistedOrders = { orders: [...this.orders.values()] };
    await writeFile(this.file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }
}
