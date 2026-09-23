import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { VitrineeError, currencyDecimals, formatUnits, parseDecimal } from "@vitrinee/core";

import type { CreateOrderInput, PlatformOrder, Product, StoreAdapter } from "../types.js";
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
}

interface PersistedState {
  seq: number;
  stock: Record<string, number | null>;
  orders: PlatformOrder[];
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory store platform. Orders are created already paid, stock is
 * decremented atomically with the order, and both can be persisted to a JSON
 * file so a demo restart does not resurrect sold stock.
 */
export class MockStoreAdapter implements StoreAdapter {
  readonly name = "mock";

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
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new VitrineeError("ValidationError", "quantity must be a positive integer", {
        details: { quantity: input.quantity },
      });
    }
    const product = this.products.get(input.productId);
    if (product === undefined) {
      throw new VitrineeError("ProductNotFound", `no product with id "${input.productId}"`, {
        details: { productId: input.productId },
      });
    }
    if (product.stock !== null && product.stock < input.quantity) {
      throw new VitrineeError("OutOfStock", `only ${product.stock} left of "${product.name}"`, {
        details: { productId: product.id, available: product.stock, requested: input.quantity },
      });
    }

    if (product.stock !== null) product.stock -= input.quantity;
    this.seq += 1;
    const decimals = currencyDecimals(product.currency);
    const total = parseDecimal(product.priceLocal, decimals) * BigInt(input.quantity);

    const order: PlatformOrder = {
      platformOrderId: `mock-${String(this.seq).padStart(4, "0")}`,
      platform: this.name,
      status: "paid",
      reference: input.reference,
      productId: product.id,
      sku: product.sku,
      quantity: input.quantity,
      totalLocal: formatUnits(total, decimals),
      currency: product.currency,
      paymentRef: clone(input.paymentRef),
      buyer: clone(input.buyer),
      createdAt: this.now().toISOString(),
    };
    this.orders.set(order.platformOrderId, order);
    await this.persist();
    return clone(order);
  }

  async getOrder(platformOrderId: string): Promise<PlatformOrder | null> {
    const order = this.orders.get(platformOrderId);
    return order === undefined ? null : clone(order);
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
    for (const order of state.orders) this.orders.set(order.platformOrderId, order);
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
