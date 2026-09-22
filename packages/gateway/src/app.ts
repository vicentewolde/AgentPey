import type { StoreAdapter } from "@vitrinee/adapters";
import { ReceiptRegistryClient, verifyReceipt, type RegistryReader } from "@vitrinee/anchor";
import { MANIFEST_PATH, VitrineeError, isVitrineeError } from "@vitrinee/core";
import type { FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import { AnchorWorker, type Anchorer } from "./anchoring.js";
import { checkoutRoutes, completeCheckout, orderResponse, preflightCheckout, type CheckoutDeps } from "./checkout.js";
import type { GatewayConfig } from "./config.js";
import { buildManifest, createCatalogCache, toManifestProduct } from "./manifest.js";
import { OrderStore } from "./orders.js";
import { Reservations } from "./reservations.js";
import { SettlementLedger } from "./settlements.js";
import { createFacilitatorClient, createX402Server } from "./x402.js";

export interface AppDeps {
  config: GatewayConfig;
  adapter: StoreAdapter;
  /** Defaults to the HTTP client for `config.facilitator`. Tests inject a fake. */
  facilitator?: FacilitatorClient;
  /** Defaults to a store on `config.ordersFile`. */
  orders?: OrderStore;
  /** Defaults to receipt-registry over Soroban RPC, signed by the merchant's signing key. */
  anchorer?: Anchorer;
  /** Defaults to receipt-registry over Soroban RPC (read-only). */
  registry?: RegistryReader & { contractId?: string };
  /** Used for the Horizon settlement check. Tests inject a fake Horizon. */
  horizonFetch?: typeof fetch;
  anchorRetryDelaysMs?: readonly number[];
  /** Whether the x402 middleware syncs with the facilitator at startup (default true). */
  syncFacilitatorOnStart?: boolean;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface VitrineeApp extends Express {
  anchors: AnchorWorker;
}

const verifyBodySchema = z.object({ receiptJws: z.string().min(1).max(20_000) });

/**
 * The HTTP surface of a Vitrinee storefront: free routes (manifest, catalog,
 * product, orders, receipt verification) and the one paid route,
 * `POST /checkout/:productId`, guarded by the x402 middleware.
 */
export function createApp({
  config,
  adapter,
  facilitator = createFacilitatorClient(config),
  orders = new OrderStore(config.ordersFile),
  anchorer,
  registry,
  horizonFetch,
  anchorRetryDelaysMs,
  syncFacilitatorOnStart = true,
  now = () => new Date(),
  log = () => {},
}: AppDeps): VitrineeApp {
  const app = express() as unknown as VitrineeApp;
  app.disable("x-powered-by");
  // Render and every other PaaS terminate TLS in front of the app.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));

  const registryClient =
    anchorer === undefined || registry === undefined
      ? new ReceiptRegistryClient({
          contractId: config.receiptRegistryId,
          rpcUrl: config.stellar.rpcUrl,
          networkPassphrase: config.stellar.networkPassphrase,
        })
      : undefined;
  const reader = registry ?? registryClient!;
  const anchors = new AnchorWorker({
    anchorer: anchorer ?? { anchor: (input) => registryClient!.anchor(input, config.signing.secret) },
    orders,
    ...(anchorRetryDelaysMs === undefined ? {} : { retryDelaysMs: anchorRetryDelaysMs }),
    now,
    log,
  });
  app.anchors = anchors;

  const catalog = createCatalogCache(adapter, config.manifestCacheSeconds * 1000);
  const ledger = new SettlementLedger();
  const x402 = createX402Server(facilitator, ledger, now);
  const deps: CheckoutDeps = { config, adapter, orders, ledger, anchors, reservations: new Reservations(), inFlight: new Set(), now, log };

  const baseUrlOf = (req: Request): string => config.publicBaseUrl ?? `${req.protocol}://${req.get("host") ?? "localhost"}`;
  const cacheHeader = `public, max-age=${config.manifestCacheSeconds}`;
  const verify = (jws: string) =>
    verifyReceipt(jws, {
      registry: reader,
      horizonUrl: config.stellar.horizonUrl,
      settlementAttempts: 3,
      ...(horizonFetch === undefined ? {} : { fetchImpl: horizonFetch }),
    });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", adapter: adapter.name, network: "stellar:testnet", receiptRegistry: config.receiptRegistryId });
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

  // 1. Refuse what can never be sold, replay idempotent requests, hold stock.
  app.post("/checkout/:productId", preflightCheckout(deps));
  // 2. x402: 402 challenge, then settle (upfront) before the handler.
  app.use(paymentMiddleware(checkoutRoutes(deps), x402, undefined, undefined, syncFacilitatorOnStart));
  // 3. Money moved: create the platform order, sign the receipt, queue the anchor.
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

  // A receipt this gateway issued, looked up by the hash that is anchored.
  app.get("/receipts/:hash/verify", async (req, res) => {
    const hash = String(req.params.hash).toLowerCase();
    const record = orders.findByReceiptHash(hash);
    if (record?.receipt == null) {
      throw new VitrineeError("ReceiptNotFound", "this gateway issued no receipt with that hash; POST it to /receipts/verify instead", {
        details: { hash },
      });
    }
    res.json({ orderId: record.orderId, ...(await verify(record.receipt.jws)) });
  });

  // Any receipt, including one this gateway never saw — or one somebody edited.
  app.post("/receipts/verify", async (req, res) => {
    const { receiptJws } = verifyBodySchema.parse(req.body ?? {});
    res.json(await verify(receiptJws));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "NotFound", message: `no route for ${req.method} ${req.path}` });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
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
