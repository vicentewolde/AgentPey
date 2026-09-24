/**
 * The portal at `vitrinee.agentpey.com` (T105, C-142): a merchant's owner signs
 * in with their wallet, registers their store, and sees its orders.
 *
 * Mounted only on the portal host, never on a store's subdomain. Every route
 * under `/api/portal` except the sign-in pair needs the session cookie, and
 * a session only ever sees the comercios paid at its own account: ownership
 * is the payout account (VT-29), so there is nothing else to check and nothing
 * to forge.
 *
 * Nothing here returns a secret. A comercio leaves this module as
 * {@link publicComercio}, which has no sealed field in it; store credentials
 * are never shown again after they are saved (VT-27).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VitrineeError } from "@vitrinee/core";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";

import type { OrderPersistence, OrderRecord } from "../orders.js";
import type { Comercio, ComercioStore } from "./comercios.js";
import { onboardComercio, slugProblem, type OnboardingDeps } from "./onboarding.js";
import type { WalletSessions } from "./wallet-session.js";

export const PORTAL_API = "/api/portal";
/** How many of a comercio's latest orders the panel lists. */
const PANEL_ORDERS = 50;

export interface PortalOptions {
  platformHost: string;
  sessions: WalletSessions;
  comercios: ComercioStore;
  ordersFor: (comercio: Comercio) => OrderPersistence;
  onboarding: Omit<OnboardingDeps, "comercios">;
  /** Where the portal's static page lives. Defaults to `apps/vitrinee-portal/public`. */
  staticDir?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const challengeSchema = z.strictObject({ account: z.string().min(1) });
const proofSchema = z.strictObject({ account: z.string().min(1), nonce: z.string().regex(/^[0-9a-f]{32}$/), signature: z.string().min(1).max(200) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new VitrineeError("ValidationError", `invalid request: ${problems.join("; ")}`, { details: { problems } });
  }
  return parsed.data;
}

function storeUrl(req: Request, platformHost: string, slug: string): string {
  return `${req.protocol}://${slug}.${platformHost}`;
}

/** Everything the portal may say about a comercio: what its manifest already says, plus its status. */
function publicComercio(req: Request, platformHost: string, c: Comercio) {
  return {
    slug: c.slug,
    name: c.name,
    status: c.status,
    platform: c.platform,
    storeUrl: storeUrl(req, platformHost, c.slug),
    payTo: c.payTo,
    signingDid: `did:stellar:testnet:${c.signingAccount}`,
    createdAt: c.createdAt,
  };
}

function panelOrder(base: string, o: OrderRecord) {
  return {
    orderId: o.orderId,
    status: o.status,
    createdAt: o.createdAt,
    product: o.product.name,
    quantity: o.quantity,
    amountUSDC: o.amountUSDC,
    paymentUrl: o.settlement.explorerUrl,
    receiptUrl: o.receipt === null ? null : `${base}/receipts/${o.receipt.hash}/verify`,
    platformOrderId: o.platformOrderId,
  };
}

export function createPortalRouter(options: PortalOptions): Router {
  const { platformHost, sessions, comercios, ordersFor, log = () => {} } = options;
  const router = express.Router();
  const secure = (req: Request) => req.secure;

  // Session-changing calls come from the portal's own page. SameSite=Strict
  // already keeps other sites out; this also keeps out a page served from a
  // sibling subdomain, which a browser counts as the same site.
  const sameOrigin = (req: Request, _res: Response, next: NextFunction) => {
    // Compared with the request's own `Host`, port included; routing already
    // made sure that host is the portal's.
    const origin = req.get("origin");
    if (origin !== undefined && origin !== `${req.protocol}://${req.get("host")}`) {
      throw new VitrineeError("SessionRequired", "requests to the portal must come from the portal");
    }
    next();
  };

  const requireSession = (req: Request): string => {
    const account = sessions.readSession(req.get("cookie"));
    if (account === undefined) throw new VitrineeError("SessionRequired", "sign in with your wallet first");
    return account;
  };

  const api = express.Router();
  api.use(express.json({ limit: "16kb" }));
  api.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  api.post("/challenge", sameOrigin, (req, res) => {
    const { account } = parse(challengeSchema, req.body);
    res.json(sessions.issueChallenge(account, platformHost));
  });

  api.post("/session", sameOrigin, (req, res) => {
    const proof = parse(proofSchema, req.body);
    const account = sessions.verifyProof(proof.account, proof.nonce, proof.signature);
    res.set("Set-Cookie", sessions.sessionCookie(account, secure(req)));
    log("portal sign-in", { account });
    res.json({ account });
  });

  api.post("/logout", sameOrigin, (req, res) => {
    res.set("Set-Cookie", sessions.clearCookie(secure(req)));
    res.json({ ok: true });
  });

  api.get("/slugs/:slug", async (req, res) => {
    requireSession(req);
    const slug = String(req.params.slug).toLowerCase();
    const problem = slugProblem(slug) ?? ((await comercios.getBySlug(slug)) === undefined ? undefined : "taken");
    res.json({ slug, available: problem === undefined, ...(problem === undefined ? {} : { reason: problem }) });
  });

  /** The panel: the signed-in account's comercios, each with its latest orders. Never another account's. */
  api.get("/me", async (req, res) => {
    const account = requireSession(req);
    const mine = (await comercios.list()).filter((c) => c.payTo === account);
    const listed = await Promise.all(
      mine.map(async (c) => {
        const base = storeUrl(req, platformHost, c.slug);
        const orders = (await ordersFor(c).load()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, PANEL_ORDERS);
        return { ...publicComercio(req, platformHost, c), orders: orders.map((o) => panelOrder(base, o)) };
      }),
    );
    res.json({ account, comercios: listed });
  });

  api.post("/comercios", sameOrigin, async (req, res) => {
    const account = requireSession(req);
    const { comercio, products } = await onboardComercio(account, req.body, { ...options.onboarding, comercios });
    log("comercio registered", { slug: comercio.slug, payTo: comercio.payTo, signing: comercio.signingAccount, products });
    res.status(201).json({ comercio: publicComercio(req, platformHost, comercio), products });
  });

  router.use(PORTAL_API, api);

  const staticDir = options.staticDir ?? fileURLToPath(new URL("../../../../apps/vitrinee-portal/public", import.meta.url));
  if (existsSync(staticDir)) {
    router.use("/portal", express.static(staticDir, { index: false, maxAge: "5m" }));
    router.get("/", (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile("index.html", { root: staticDir });
    });
  } else {
    log("portal files not found; the portal page will 404", { staticDir });
  }

  return router;
}
