import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { VitrineeError } from "@vitrinee/core";

import { orderTotalLocal, platformLines, resolveOrderLines, unitsByProduct } from "../lines.js";
import type { CreateOrderInput, PlatformOrder, PlatformShipment, Product, StoreAdapter } from "../types.js";
import { MOCK_CATALOG } from "./catalog.js";

export { MOCK_CATALOG, MOCK_STORE_NAME } from "./catalog.js";

export interface MockStoreAdapterOptions {
  /** Defaults to `MOCK_CATALOG`. Copied on construction; the caller's array is never mutated. */
  catalog?: readonly Product[];
  /**
   * When set, orders and stock survive a restart: the file is read on
   * construction and rewritten after every order.
   */
  ordersFile?: string;
  now?: () => Date;
  /** Defaults to true. False plays a store whose platform has nowhere for the buyer's consent, like Jumpseller (T149). */
  recordsBuyerConsent?: boolean;
}

interface PersistedState {
  seq: number;
  stock: Record<string, number | null>;
  orders: PlatformOrder[];
}

const clone = <T>(value: T): T => structuredClone(value);

/** An order persisted before T148 named one product at the top level; it is one line now. */
function withLines(order: PlatformOrder): PlatformOrder {
  if (Array.isArray(order.lines)) return order;
  const legacy = order as PlatformOrder & { productId?: string; sku?: string; quantity?: number };
  const { productId = "", sku = "", quantity = 0, ...rest } = legacy;
  return { ...rest, lines: [{ productId, sku, quantity }] };
}

/**
 * In-memory store platform. Orders are created already paid, stock is
 * decremented atomically with the order, and both can be persisted to a JSON
 * file so a demo restart does not resurrect sold stock.
 */
export class MockStoreAdapter implements StoreAdapter {
  readonly name = "mock";
  readonly reportsShipments = true;
  /** The mock's order is the store: the buyer's consent is kept on it, with the rest of the buyer (T149). */
  readonly recordsBuyerConsent: boolean;

  private readonly products = new Map<string, Product>();
  private readonly orders = new Map<string, PlatformOrder>();
  private seq = 0;
  private readonly ordersFile: string | undefined;
  private readonly now: () => Date;

  constructor(options: MockStoreAdapterOptions = {}) {
    for (const product of options.catalog ?? MOCK_CATALOG) {
      this.products.set(product.id, clone(product));
    }
    this.ordersFile = options.ordersFile;
    this.now = options.now ?? (() => new Date());
    this.recordsBuyerConsent = options.recordsBuyerConsent ?? true;
    if (this.ordersFile !== undefined) this.restore(this.ordersFile);
  }

  async listProducts(): Promise<Product[]> {
    return [...this.products.values()].map(clone);
  }

  async getProduct(id: string): Promise<Product | null> {
    const product = this.products.get(id);
    return product === undefined ? null : clone(product);
  }

  async createOrder(input: CreateOrderInput): Promise<PlatformOrder> {
    // Every line is checked before any stock moves: a refused order changes nothing.
    const products = await resolveOrderLines(input.lines, async (id) => this.products.get(id) ?? null);
    for (const [productId, units] of unitsByProduct(input.lines)) {
      const product = this.products.get(productId)!;
      if (product.stock !== null) product.stock -= units;
    }
    this.seq += 1;
    const currency = products.get(input.lines[0]!.productId)!.currency;

    const order: PlatformOrder = {
      platformOrderId: `mock-${String(this.seq).padStart(4, "0")}`,
      platform: this.name,
      status: "paid",
      reference: input.reference,
      lines: platformLines(input.lines, products),
      totalLocal: orderTotalLocal(input.lines, products, currency),
      currency,
      paymentRef: clone(input.paymentRef),
      buyer: clone(input.buyer),
      createdAt: this.now().toISOString(),
      shipments: [],
      fulfillmentStatus: "unfulfilled",
    };
    this.orders.set(order.platformOrderId, order);
    await this.persist();
    return clone(order);
  }

  async getOrder(platformOrderId: string): Promise<PlatformOrder | null> {
    const order = this.orders.get(platformOrderId);
    return order === undefined ? null : clone(order);
  }

  /** Marks an order shipped, as a merchant would in a real platform's admin (T147, tests and demos). `partial` leaves some of it behind. */
  async markShipped(platformOrderId: string, shipment: Omit<PlatformShipment, "id"> & { id?: string }, options: { partial?: boolean } = {}): Promise<PlatformOrder> {
    const order = this.orders.get(platformOrderId);
    if (order === undefined) throw new VitrineeError("OrderNotFound", `no mock order "${platformOrderId}"`, { details: { platformOrderId } });
    const shipments = order.shipments ?? [];
    shipments.push({ ...shipment, id: shipment.id ?? `ship_${platformOrderId}_${shipments.length + 1}` });
    order.shipments = shipments;
    order.fulfillmentStatus = options.partial === true ? "partial" : "fulfilled";
    await this.persist();
    return clone(order);
  }

  private restore(path: string): void {
    if (!existsSync(path)) return;
    let state: PersistedState;
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as PersistedState;
    } catch (error) {
      throw new VitrineeError("AdapterError", `mock orders file is not valid JSON: ${path}`, {
        cause: error,
        details: { path },
      });
    }
    this.seq = state.seq;
    for (const order of state.orders) this.orders.set(order.platformOrderId, withLines(order));
    for (const [id, stock] of Object.entries(state.stock)) {
      const product = this.products.get(id);
      if (product !== undefined) product.stock = stock;
    }
  }

  private async persist(): Promise<void> {
    if (this.ordersFile === undefined) return;
    const state: PersistedState = {
      seq: this.seq,
      stock: Object.fromEntries([...this.products.values()].map((p) => [p.id, p.stock])),
      orders: [...this.orders.values()],
    };
    await mkdir(dirname(this.ordersFile), { recursive: true });
    await writeFile(this.ordersFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }
}
