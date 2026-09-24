/**
 * The HTTP front of the multi-merchant platform (T103, C-142): reads the
 * `Host`, hands a store's request to that comercio's store, and keeps the
 * portal host for the platform's own routes: the owners' portal (T105), the
 * public directory (C-141) and the health check.
 *
 * During the transition to the directory (T104), the portal host can still
 * serve one comercio's store (`ROOT_COMERCIO`), so the venue row AgentPey has
 * today and the pending order of T101 keep answering at the URL they know.
 */
import { VitrineeError, isVitrineeError } from "@vitrinee/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { ComercioStore } from "./comercios.js";
import { routeHost } from "./hosts.js";
import { createPortalRouter, type PortalOptions } from "./portal.js";
import type { StorefrontPool } from "./storefronts.js";

/** Where the portal publishes its directory of comercios (C-141). AgentPey's `venues.json` names this URL. */
export const DIRECTORY_PATH = "/api/comercios";

export interface PlatformAppOptions {
  platformHost: string;
  pool: StorefrontPool;
  /** Read for the public directory. */
  comercios: ComercioStore;
  rootComercio: string | undefined;
  /**
   * The owners' portal on the platform host (T105): sign-in with the wallet,
   * registration, panel. Unset, the platform host serves only the directory.
   */
  portal?: Omit<PortalOptions, "platformHost" | "comercios" | "log">;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function createPlatformApp({ platformHost, pool, comercios, rootComercio, portal, log = () => {} }: PlatformAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  const portalRouter = portal === undefined ? undefined : createPortalRouter({ ...portal, platformHost, comercios, log });

  const serveStore = async (slug: string, req: Request, res: Response, next: NextFunction) => {
    const store = await pool.get(slug);
    if (store === undefined) {
      throw new VitrineeError("ComercioNotFound", `no store "${slug}" on this platform`, { details: { slug } });
    }
    store(req, res, next);
  };

  // The host decides first: a store's subdomain goes to that store and never
  // reaches the portal or the directory below.
  app.use(async (req, res, next) => {
    try {
      const route = routeHost(req.get("host"), platformHost);
      if (route.kind === "store") return await serveStore(route.slug, req, res, next);
      if (route.kind === "unknown") {
        throw new VitrineeError("ComercioNotFound", "this host is not a store of this platform");
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  // Only the portal host gets this far. The portal answers its own paths and
  // passes every other one on.
  if (portalRouter !== undefined) app.use(portalRouter);

  app.use(async (req, res, next) => {
    try {
      if (req.path === DIRECTORY_PATH && req.method === "GET") {
        // Public by design, and nothing in it is private: the slug, the name,
        // where the store is, the account it is paid at and the key that signs
        // its receipts are all in each store's own manifest already. Never a
        // sealed secret, never a disabled comercio.
        const scheme = req.protocol;
        const listed = (await comercios.list()).filter((c) => c.status === "active");
        res.set("Cache-Control", "public, max-age=30");
        res.json({
          platformHost,
          comercios: listed.map((c) => ({
            slug: c.slug,
            name: c.name,
            url: `${scheme}://${c.slug}.${platformHost}`,
            payTo: c.payTo,
            signingDid: `did:stellar:testnet:${c.signingAccount}`,
          })),
        });
        return;
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
