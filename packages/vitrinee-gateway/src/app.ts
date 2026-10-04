import type { StoreAdapter } from "@vitrinee/adapters";
import { AgentResolveReader, ReceiptRegistryClient, verifyReceipt, type DisputeReader, type RegistryReader } from "@vitrinee/anchor";
import { MANIFEST_PATH, UCP_LEGACY_VERSION, UCP_PROFILE_PATH, UCP_REST_PREFIX, VitrineeError, isVitrineeError, stellarDid } from "@vitrinee/core";
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
import {
  getCatalogProduct,
  getProductRequestSchema,
  lookupCatalog,
  lookupRequestSchema,
  searchCatalog,
  searchRequestSchema,
} from "./ucp/catalog.js";
import { registerUcpCheckout } from "./ucp/checkout.js";
import { lookupDispute, registerUcpOrders } from "./ucp/order.js";
import { ucpVersionGuard, ucpVersionOf } from "./ucp/negotiation.js";
import { OrderEvents } from "./ucp/order-events.js";
import { sharedPlatformProfileReader, type PlatformProfileReader, type PlatformSender } from "./ucp/platform-profile.js";
import { deriveStoreWebhookKey } from "./ucp/webhook-key.js";
import { deriveStoreAp2Key } from "./ucp/ap2.js";
import { buildUcpProfile, ucpLeafProfilePath } from "./ucp/profile.js";
import { MemoryCheckoutSessions, type CheckoutSessionPersistence } from "./ucp/sessions.js";
import { QueryFreeResourceServer, createFacilitatorClient, createX402Server } from "./x402.js";

export interface AppDeps {
  config: GatewayConfig;
  adapter: StoreAdapter;
  /** Defaults to the HTTP client for `config.facilitator`. Tests inject a fake. */
  facilitator?: FacilitatorClient;
  /** Defaults to a store on `config.ordersFile`. */
  orders?: OrderStore;
  /** UCP checkout sessions (T122). Defaults to memory; the platform passes Postgres. */
  sessions?: CheckoutSessionPersistence;
  /** Defaults to receipt-registry over Soroban RPC, signed by the merchant's signing key. */
  anchorer?: Anchorer;
  /** Defaults to receipt-registry over Soroban RPC (read-only). */
  registry?: RegistryReader & { contractId?: string };
  /** Disputes over receipts, shown on UCP orders (T127). Defaults to `agent-resolve` over Soroban RPC when configured; `null` turns it off. */
  disputes?: DisputeReader | null;
  /** How long an order waits for the dispute read before answering without it (default 3 s). */
  disputeTimeoutMs?: number;
  /** Used for the Horizon settlement check. Tests inject a fake Horizon. */
  horizonFetch?: typeof fetch;
  anchorRetryDelaysMs?: readonly number[];
  /**
   * Reads the platform profile `UCP-Agent` points to, to learn the UCP version it speaks (T133, R-14).
   * Defaults to the process's one hardened HTTPS reader, shared by every storefront so they share its limits;
   * tests inject a fake; `null` answers every platform in the newest version.
   */
  platformProfiles?: PlatformProfileReader | null;
  /**
   * Delivers order webhooks to the URLs platforms dictate (T147). Defaults to
   * `platformProfiles` when it can send (the process's one client does);
   * `null` delivers nothing.
   */
  webhookSender?: PlatformSender | null;
  /** Tests only: the wait before each webhook retry. */
  webhookRetryDelaysMs?: readonly number[];
  /** How often unshipped orders are checked with the store's platform. */
  shipmentWatchIntervalMs?: number;
  /** Whether the x402 middleware syncs with the facilitator at startup (default true). */
  syncFacilitatorOnStart?: boolean;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface VitrineeApp extends Express {
  anchors: AnchorWorker;
  /** Order events and webhooks (T147). `resume()` it when the app starts serving, `stop()` it when it stops. */
  orderEvents: OrderEvents;
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
  sessions = new MemoryCheckoutSessions(),
  anchorer,
  registry,
  disputes,
  disputeTimeoutMs,
  horizonFetch,
  anchorRetryDelaysMs,
  syncFacilitatorOnStart = true,
  platformProfiles = sharedPlatformProfileReader(),
  webhookSender,
  webhookRetryDelaysMs,
  shipmentWatchIntervalMs,
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
  // The storefront's AP2 key (T134, VT-43): derived from the receipt key, published in the 2026-08-25 profile.
  const ap2Key = deriveStoreAp2Key(config.signing.secret, stellarDid(config.signing.account, "testnet"));
  // And the key it signs its order webhooks with (T147, VT-44), published in both versions' profiles.
  const webhookKey = deriveStoreWebhookKey(config.signing.secret, stellarDid(config.signing.account, "testnet"));
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

  // UCP (docs/fase-7-estandar-comercio-agentico/SPEC.md §4): the business
  // profile at the well-known path, and the catalog under its own prefix so
  // nothing here shadows the routes above.
  app.get(UCP_PROFILE_PATH, (req, res) => {
    res.set("Cache-Control", cacheHeader);
    res.json(buildUcpProfile({ config, baseUrl: baseUrlOf(req), ap2Key: ap2Key.publicJwk, webhookKey: webhookKey.publicJwk }));
  });
  // The 2026-04-08 profile, which the current one lists in `supported_versions` (R-6, T133).
  app.get(ucpLeafProfilePath(UCP_LEGACY_VERSION), (req, res) => {
    res.set("Cache-Control", cacheHeader);
    res.json(buildUcpProfile({ config, baseUrl: baseUrlOf(req), version: UCP_LEGACY_VERSION, webhookKey: webhookKey.publicJwk }));
  });

  // Every UCP route answers in the version the platform speaks, or says it cannot (T131, T133).
  app.use(UCP_REST_PREFIX, ucpVersionGuard(platformProfiles, log));

  app.post(`${UCP_REST_PREFIX}/catalog/search`, async (req, res) => {
    const request = searchRequestSchema.parse(req.body ?? {});
    res.json(searchCatalog({ config, products: await catalog.get(), request, version: ucpVersionOf(res) }));
  });

  app.post(`${UCP_REST_PREFIX}/catalog/lookup`, async (req, res) => {
    const { ids } = lookupRequestSchema.parse(req.body ?? {});
    res.json(lookupCatalog({ config, products: await catalog.get(), ids, version: ucpVersionOf(res) }));
  });

  app.post(`${UCP_REST_PREFIX}/catalog/product`, async (req, res) => {
    const { id } = getProductRequestSchema.parse(req.body ?? {});
    res.json(getCatalogProduct({ config, products: await catalog.get(), id, version: ucpVersionOf(res) }));
  });

  // The UCP checkout pays through the same resource server as the x402 checkout,
  // outside its middleware: the payment arrives in the body of `complete` (E-1).
  let initializing: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    initializing ??= x402.initialize().catch((error: unknown) => {
      initializing = undefined;
      throw new VitrineeError("NetworkError", "could not reach the payment facilitator", { cause: error, details: {} });
    });
    return initializing;
  };
  const disputeReader =
    disputes !== undefined
      ? disputes
      : config.agentResolveId === undefined
        ? null
        : new AgentResolveReader({ contractId: config.agentResolveId, rpcUrl: config.stellar.rpcUrl });
  const sender = webhookSender !== undefined ? webhookSender : isSender(platformProfiles) ? platformProfiles : null;
  const orderEvents = new OrderEvents({
    orders,
    adapter,
    sender,
    key: webhookKey,
    disputes: (record) => lookupDispute(record, disputeReader, log, disputeTimeoutMs),
    now,
    log,
    ...(webhookRetryDelaysMs === undefined ? {} : { retryDelaysMs: webhookRetryDelaysMs }),
    ...(shipmentWatchIntervalMs === undefined ? {} : { watchIntervalMs: shipmentWatchIntervalMs }),
  });
  app.orderEvents = orderEvents;
  registerUcpCheckout(app, UCP_REST_PREFIX, { ...deps, sessions, x402, ready, ap2Key, orderEvents }, baseUrlOf);
  registerUcpOrders(app, UCP_REST_PREFIX, orders, baseUrlOf, disputeReader, log, disputeTimeoutMs, orderEvents);

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
    // express.json() rejects a body that is not JSON, or too large, with its own 4xx.
    if (error instanceof Error && "type" in error && (error.type === "entity.parse.failed" || error.type === "entity.too.large")) {
      res.status(error.type === "entity.too.large" ? 413 : 400).json({ error: "ValidationError", message: "the request body is not valid JSON or is too large" });
      return;
    }
    log("unhandled error", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "InternalError", message: "unexpected failure" });
  });

  return app;
}

function isSender(client: PlatformProfileReader | null): client is PlatformProfileReader & PlatformSender {
  return client !== null && typeof (client as Partial<PlatformSender>).send === "function";
}
