import type { StoreAdapter } from "@vitrinee/adapters";
import { ReceiptRegistryClient, verifyReceipt, type RegistryReader } from "@vitrinee/anchor";
import { MANIFEST_PATH, VitrineeError, isVitrineeError } from "@vitrinee/core";
import type { FacilitatorClient } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";

import { AnchorWorker, type Anchorer } from "./anchoring.js";
import { checkoutRoutes, completeCheckout, fulfilOrder, orderResponse, preflightCheckout, type CheckoutDeps } from "./checkout.js";
import type { GatewayConfig } from "./config.js";
import { SERVICE_CARD_PATH, listResources, listServiceCards, paginationFrom } from "./discovery.js";
import { buildManifest, createCatalogCache, toManifestProduct } from "./manifest.js";
import { OrderStore } from "./orders.js";
import { receiptPage } from "./receipt-page.js";
import { Reservations } from "./reservations.js";
import { SettlementLedger } from "./settlements.js";
import { QueryFreeResourceServer, createFacilitatorClient, createX402Server } from "./x402.js";

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
 * `/checkout/:productId` by `POST` or `GET`, guarded by the x402 middleware.
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

  // The dashboard ships as static files served from this same origin: one
  // deploy, no CORS, nothing to configure on stage (docs/fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md, VT-18).
  // `src/` and `dist/` sit at the same depth, so one path works in both.
  const dashboardDir = fileURLToPath(new URL("../../../apps/vitrinee-dashboard/public", import.meta.url));
  if (existsSync(dashboardDir)) {
    app.use("/dashboard", express.static(dashboardDir, { index: "index.html", maxAge: "5m" }));
    app.get("/", (_req, res) => res.redirect(302, "/dashboard/"));
  } else {
    log("dashboard files not found; /dashboard will 404", { dashboardDir });
  }

  app.get("/discovery/resources", async (req, res) => {
    const products = await catalog.get();
    const { limit, offset } = paginationFrom(req.query as Record<string, unknown>);
    res.set("Cache-Control", cacheHeader);
    res.json(listResources({ config, products, baseUrl: baseUrlOf(req), now: now(), limit, offset }));
  });

  // The ServiceCard feed AgentPey's catalogue adapter reads (VT-24).
  app.get(SERVICE_CARD_PATH, async (req, res) => {
    const products = await catalog.get();
    const query = typeof req.query["query"] === "string" ? req.query["query"] : undefined;
    res.set("Cache-Control", cacheHeader);
    res.json(listServiceCards({ config, products, ...(query === undefined ? {} : { query }) }));
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

  // Express answers HEAD with the GET handlers, but the x402 middleware only
  // guards the methods it was configured for: a HEAD would slip past it and
  // reach step 3 with no settlement. Nothing about a purchase is a HEAD.
  app.head("/checkout/:productId", (_req, res) => {
    res.set("Allow", "GET, POST").status(405).json({ error: "MethodNotAllowed", message: "checkout takes GET or POST" });
  });
  // 1. Refuse what can never be sold, replay idempotent requests, hold stock.
  //    `GET` reads the query, `POST` the JSON body; both land on one schema (VT-23).
  app.get("/checkout/:productId", preflightCheckout(deps));
  app.post("/checkout/:productId", preflightCheckout(deps));
  // 2. x402: 402 challenge, then settle (upfront) before the handler. The
  //    402's `resource.url` never carries the query, where GET puts the
  //    buyer's address (VT-25).
  app.use(paymentMiddlewareFromHTTPServer(new QueryFreeResourceServer(x402, checkoutRoutes(deps)), undefined, undefined, syncFacilitatorOnStart));
  // 3. Money moved: create the platform order, sign the receipt, queue the anchor.
  app.get("/checkout/:productId", completeCheckout(deps));
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

  // A sale that was paid and could not be fulfilled (`paid_unfulfilled`) is
  // retried here, without charging again (VT-26). It takes no input: what is
  // sent to the platform is what the order record already holds.
  app.post("/orders/:orderId/fulfil", async (req, res) => {
    res.json(orderResponse(await fulfilOrder(deps, String(req.params.orderId))));
  });

  // The same verification as a page, for the owner who clicks "Receipt" in
  // the portal (T108). The JSON below stays the source; this only renders it.
  app.get("/receipts/:hash", async (req, res) => {
    const hash = String(req.params.hash).toLowerCase();
    const record = orders.findByReceiptHash(hash);
    if (record?.receipt == null) {
      throw new VitrineeError("ReceiptNotFound", "this gateway issued no receipt with that hash", { details: { hash } });
    }
    const asked = typeof req.query["lang"] === "string" ? req.query["lang"] : undefined;
    const lang = asked === "es" || asked === "en" ? asked : /^es\b/i.test(req.get("accept-language") ?? "") ? "es" : "en";
    const anchorTxHash = record.anchor?.txHash;
    res
      .type("html")
      .send(
        receiptPage({
          orderId: record.orderId,
          verification: await verify(record.receipt.jws),
          lang,
          ...(anchorTxHash === undefined ? {} : { anchorTxHash }),
        }),
      );
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
