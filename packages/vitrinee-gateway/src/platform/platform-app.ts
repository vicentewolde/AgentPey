/**
 * The HTTP front of the multi-merchant platform (T103, C-142): reads the
 * `Host`, hands a store's request to that comercio's store, and keeps the
 * portal host for the platform's own routes.
 *
 * During the transition to the directory (T104), the portal host can still
 * serve one comercio's store (`ROOT_COMERCIO`), so the venue row AgentPey has
 * today and the pending order of T101 keep answering at the URL they know.
 */
import { VitrineeError, isVitrineeError } from "@vitrinee/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { routeHost } from "./hosts.js";
import type { StorefrontPool } from "./storefronts.js";

export interface PlatformAppOptions {
  platformHost: string;
  pool: StorefrontPool;
  rootComercio: string | undefined;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function createPlatformApp({ platformHost, pool, rootComercio, log = () => {} }: PlatformAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const serveStore = async (slug: string, req: Request, res: Response, next: NextFunction) => {
    const store = await pool.get(slug);
    if (store === undefined) {
      throw new VitrineeError("ComercioNotFound", `no store "${slug}" on this platform`, { details: { slug } });
    }
    store(req, res, next);
  };

  app.use(async (req, res, next) => {
    try {
      const route = routeHost(req.get("host"), platformHost);
      if (route.kind === "store") return await serveStore(route.slug, req, res, next);
      if (route.kind === "unknown") {
        throw new VitrineeError("ComercioNotFound", "this host is not a store of this platform");
      }
      if (req.path === "/health") {
        res.json({ status: "ok", mode: "platform", platformHost, rootComercio: rootComercio ?? null });
        return;
      }
      if (rootComercio !== undefined) return await serveStore(rootComercio, req, res, next);
      res.status(404).json({ error: "NotFound", message: `no route for ${req.method} ${req.path}` });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (isVitrineeError(error)) {
      if (error.httpStatus >= 500) log("request failed", { code: error.code, message: error.message });
      res.status(error.httpStatus).json(error.toJSON());
      return;
    }
    log("unhandled error", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "InternalError", message: "unexpected failure" });
  });

  return app;
}
