/**
 * One store per comercio, built on demand and kept warm (T103, C-142).
 *
 * Each comercio gets a store made by the same `createApp` the single-store
 * gateway always used, from that comercio's own config: its payout account,
 * its signing key, its store credentials, its orders. That is the point of
 * this design: the checkout, the x402 middleware, the receipt and the anchor
 * are not rewritten for many merchants. Each store still has one fixed
 * `payTo`, which is what the x402 middleware expects.
 *
 * A store is rebuilt when its comercio's row changes (`updatedAt`), and a
 * comercio that is disabled or gone answers as unknown. Lookups are cached for
 * a few seconds, so a busy store does not cost a query per request.
 */
import type { StoreAdapter } from "@vitrinee/adapters";

import { createAdapter } from "../adapters.js";
import { createApp, type AppDeps, type VitrineeApp } from "../app.js";
import type { GatewayConfig } from "../config.js";
import { OrderStore, type OrderPersistence } from "../orders.js";
import { openComercioSecrets, type Comercio, type ComercioStore } from "./comercios.js";
import { comercioConfig } from "./config.js";
import type { SecretBox } from "./secret-box.js";

type Log = (message: string, fields?: Record<string, unknown>) => void;

export interface StorefrontPoolOptions {
  comercios: ComercioStore;
  box: SecretBox;
  /** The platform's environment: facilitator, registry, network, FX. No merchant values. */
  env: NodeJS.ProcessEnv;
  ordersFor: (comercio: Comercio) => OrderPersistence;
  /** Tests inject a fake facilitator, registry and Horizon per store. */
  appDeps?: (comercio: Comercio, config: GatewayConfig) => Partial<Omit<AppDeps, "config" | "adapter" | "orders">>;
  createAdapter?: (config: GatewayConfig) => StoreAdapter;
  lookupTtlMs?: number;
  now?: () => number;
  log?: Log;
}

interface Built {
  comercioId: string;
  updatedAt: string;
  app: VitrineeApp;
}

export class StorefrontPool {
  private readonly built = new Map<string, Promise<Built>>();
  private readonly lookups = new Map<string, { at: number; comercio: Comercio | undefined }>();
  private readonly ttl: number;
  private readonly clock: () => number;
  private readonly log: Log;

  constructor(private readonly options: StorefrontPoolOptions) {
    this.ttl = options.lookupTtlMs ?? 5_000;
    this.clock = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** The store for `slug`, or `undefined` for a slug that names no active comercio. */
  async get(slug: string): Promise<VitrineeApp | undefined> {
    const comercio = await this.lookup(slug);
    if (comercio === undefined || comercio.status !== "active") return undefined;
    const cached = this.built.get(slug);
    if (cached !== undefined) {
      const current = await cached.catch(() => undefined);
      if (current !== undefined && current.comercioId === comercio.id && current.updatedAt === comercio.updatedAt) return current.app;
    }
    const building = this.build(comercio);
    this.built.set(slug, building);
    // A failed build is not cached: the next request tries again.
    building.catch(() => {
      if (this.built.get(slug) === building) this.built.delete(slug);
    });
    return (await building).app;
  }

  private async lookup(slug: string): Promise<Comercio | undefined> {
    const hit = this.lookups.get(slug);
    if (hit !== undefined && this.clock() - hit.at < this.ttl) return hit.comercio;
    const comercio = await this.options.comercios.getBySlug(slug);
    this.lookups.set(slug, { at: this.clock(), comercio });
    return comercio;
  }

  private async build(comercio: Comercio): Promise<Built> {
    const secrets = openComercioSecrets(comercio, this.options.box);
    const config = comercioConfig(this.options.env, comercio, secrets);
    const adapter = this.options.createAdapter?.(config) ?? createAdapter(config, this.log);
    const orders = await OrderStore.open(this.options.ordersFor(comercio));
    const app = createApp({
      config,
      adapter,
      orders,
      log: (message, fields) => this.log(message, { comercio: comercio.slug, ...fields }),
      ...this.options.appDeps?.(comercio, config),
    });
    const resumed = app.anchors.resume();
    this.log("store ready", { comercio: comercio.slug, payTo: comercio.payTo, signing: comercio.signingAccount, orders: orders.list().length, anchorsResumed: resumed });
    return { comercioId: comercio.id, updatedAt: comercio.updatedAt, app };
  }
}
