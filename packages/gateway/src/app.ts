import type { StoreAdapter } from "@vitrinee/adapters";
import { MANIFEST_PATH, VitrineeError, isVitrineeError } from "@vitrinee/core";
import type { FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";

import { checkoutRoutes, completeCheckout, orderResponse, preflightCheckout } from "./checkout.js";
import type { GatewayConfig } from "./config.js";
import { buildManifest, createCatalogCache, toManifestProduct } from "./manifest.js";
import { OrderStore } from "./orders.js";
import { SettlementLedger } from "./settlements.js";
import { createFacilitatorClient, createX402Server } from "./x402.js";

export interface AppDeps {
  config: GatewayConfig;
  adapter: StoreAdapter;
  /** Defaults to the HTTP client for `config.facilitator`. Tests inject a fake. */
  facilitator?: FacilitatorClient;
  /** Defaults to a store on `config.ordersFile`. */
  orders?: OrderStore;
  /** Whether the x402 middleware syncs with the facilitator at startup (default true). */
  syncFacilitatorOnStart?: boolean;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The HTTP surface of a Vitrinee storefront: free routes (manifest, catalog,
 * product, orders) and the one paid route, `POST /checkout/:productId`,
 * guarded by the x402 middleware. Receipts and verification arrive on day 2.
 */
export function createApp({
  config,
  adapter,
  facilitator = createFacilitatorClient(config),
  orders = new OrderStore(config.ordersFile),
  syncFacilitatorOnStart = true,
  now = () => new Date(),
  log = () => {},
}: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // Render and every other PaaS terminate TLS in front of the app.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));

  const catalog = createCatalogCache(adapter, config.manifestCacheSeconds * 1000);
  const ledger = new SettlementLedger();
  const x402 = createX402Server(facilitator, ledger, now);
  const deps = { config, adapter, orders, ledger, now, log };

  const baseUrlOf = (req: Request): string =>
    config.publicBaseUrl ?? `${req.protocol}://${req.get("host") ?? "localhost"}`;
  const cacheHeader = `public, max-age=${config.manifestCacheSeconds}`;

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", adapter: adapter.name, network: "stellar:testnet" });
  });

  app.get(MANIFEST_PATH, async (req, res) => {
    const products = await catalog.get();
    res.set("Cache-Control", cacheHeader);
    res.json(buildManifest({ config, products, baseUrl: baseUrlOf(req), now: now() }));
  });

  app.get("/catalog", async (_req, res) => {
    const products = await catalog.get();
    res.set("Cache-Control", cacheHeader);
    res.json({ products: products.map((p) => toManifestProduct(p, config)) });
  });

  app.get("/products/:id", async (req, res) => {
    const id = String(req.params.id);
    const product = await adapter.getProduct(id);
    if (product === null) {
      throw new VitrineeError("ProductNotFound", `no product with id "${id}"`, { details: { productId: id } });
    }
    res.json({ product: toManifestProduct(product, config) });
  });

  // 1. Refuse what can never be sold, before anyone is asked to pay.
  app.post("/checkout/:productId", preflightCheckout(deps));
  // 2. x402: 402 challenge, then verify + settle (upfront) before the handler.
  app.use(paymentMiddleware(checkoutRoutes(deps), x402, undefined, undefined, syncFacilitatorOnStart));
  // 3. Money moved: create the platform order and record the sale.
  app.post("/checkout/:productId", completeCheckout(deps));

  app.get("/orders", (_req, res) => {
    res.json({ orders: orders.list().map(orderResponse) });
  });

  app.get("/orders/:orderId", (req, res) => {
    const orderId = String(req.params.orderId);
    const record = orders.get(orderId);
    if (record === undefined) {
      throw new VitrineeError("OrderNotFound", `no order with id "${orderId}"`, { details: { orderId } });
    }
    res.json(orderResponse(record));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "NotFound", message: `no route for ${req.method} ${req.path}` });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isVitrineeError(error)) {
      if (error.httpStatus >= 500) log("request failed", { code: error.code, message: error.message });
      res.status(error.httpStatus).json(error.toJSON());
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: "ValidationError", message: "invalid request", details: { issues: error.issues } });
      return;
    }
    log("unhandled error", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "InternalError", message: "unexpected failure" });
  });

  return app;
}
