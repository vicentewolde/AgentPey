import type { StoreAdapter } from "@vitrinee/adapters";
import { MANIFEST_PATH, VitrineeError, isVitrineeError } from "@vitrinee/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";

import type { GatewayConfig } from "./config.js";
import { buildManifest, createCatalogCache, toManifestProduct } from "./manifest.js";

export interface AppDeps {
  config: GatewayConfig;
  adapter: StoreAdapter;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The HTTP surface of a Vitrinee storefront. Day 0 serves the free routes:
 * manifest, catalogue and product. `POST /checkout/:productId` (x402) lands
 * on day 1, receipts and verification on day 2.
 */
export function createApp({ config, adapter, now = () => new Date(), log = () => {} }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // Render and every other PaaS terminate TLS in front of the app.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));

  const catalog = createCatalogCache(adapter, config.manifestCacheSeconds * 1000);
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
