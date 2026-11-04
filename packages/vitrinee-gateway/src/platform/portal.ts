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

import { WALLET_KIT_BUNDLE, walletIconFile } from "@agentpey/wallet-kit";
import type { EscrowConfig, EscrowPurchase, EscrowReaderFactory } from "@vitrinee/anchor";
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
  /** Reads the escrow an order was paid into, for the dispute notice (T163). Without it, the panel shows none. */
  escrows?: EscrowReaderFactory;
  /** Where a merchant answers a dispute in its escrow: AgentPey's responder page. */
  responderUrl?: string;
  onboarding: Omit<OnboardingDeps, "comercios">;
  /** Where the portal's static page lives. Defaults to `apps/vitrinee-portal/public`. */
  staticDir?: string;
  /** The wallet layer's bundle (T143). Defaults to the one `pnpm build` makes; tests point it at a file of their own. */
  walletKitBundle?: string;
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

/** A dispute in the store's escrow, as the panel tells the merchant (T163): what to do and until when. */
export interface PanelDispute {
  status: "disputed" | "responded" | "resolved" | "expired";
  respondBy: string | null;
  /** The responder page for this order, while the merchant can still answer. */
  answerUrl: string | null;
}

const PANEL_ESCROW_TIMEOUT_MS = 3_000;
export const RESPONDER_URL = "https://agentpey.com/resolve/responder";

/**
 * The dispute notice for each order paid into an escrow, read on chain: a store cannot hide a claim from its own
 * panel. A read that fails or times out shows no notice for that order and is logged; the panel still loads.
 */
async function panelDisputes(
  base: string,
  orders: readonly OrderRecord[],
  escrows: EscrowReaderFactory | undefined,
  responderUrl: string,
  now: Date,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<Map<string, PanelDispute>> {
  const notices = new Map<string, PanelDispute>();
  if (escrows === undefined) return notices;
  const configs = new Map<string, Promise<EscrowConfig>>();
  await Promise.all(
    orders.map(async (o) => {
      const contract = o.hold?.status === "held" ? o.hold.escrow : undefined;
      if (contract === undefined) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        const reader = escrows(contract);
        if (!configs.has(contract)) configs.set(contract, reader.config());
        const [purchase, config] = await Promise.race([
          Promise.all([reader.get(o.orderId), configs.get(contract)!]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new VitrineeError("NetworkError", "the escrow gave no answer in time")), PANEL_ESCROW_TIMEOUT_MS);
          }),
        ]);
        const notice = disputeNotice(base, o.orderId, purchase, config, responderUrl, now);
        if (notice !== null) notices.set(o.orderId, notice);
      } catch (error) {
        log("panel escrow read failed", { orderId: o.orderId, error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return notices;
}

export function disputeNotice(base: string, orderId: string, purchase: EscrowPurchase | null, config: Pick<EscrowConfig, "responseWindowSeconds">, responderUrl: string, now: Date): PanelDispute | null {
  if (purchase === null || purchase.openedAt === null) return null;
  if (purchase.status !== "disputed" && purchase.status !== "responded" && purchase.status !== "resolved" && purchase.status !== "expired") return null;
  const respondBy = new Date((purchase.openedAt + config.responseWindowSeconds) * 1000);
  const open = purchase.status === "disputed" && now.getTime() <= respondBy.getTime();
  const order = `${new URL(base).host}/orders/${orderId}`;
  return {
    status: purchase.status,
    respondBy: purchase.status === "disputed" ? respondBy.toISOString() : null,
    answerUrl: open ? `${responderUrl}?order=${encodeURIComponent(order)}` : null,
  };
}

function panelOrder(base: string, o: OrderRecord, dispute: PanelDispute | null = null) {
  return {
    orderId: o.orderId,
    status: o.status,
    createdAt: o.createdAt,
    // One entry per line (T148): the page writes "Imán, Taza × 2".
    items: o.items.map((item) => ({ name: item.name, quantity: item.quantity })),
    amountUSDC: o.amountUSDC,
    paymentUrl: o.settlement.explorerUrl,
    // The readable page, not the JSON (T108); the page links to the JSON.
    receiptUrl: o.receipt === null ? null : `${base}/receipts/${o.receipt.hash}`,
    platformOrderId: o.platformOrderId,
    dispute,
  };
}

export function createPortalRouter(options: PortalOptions): Router {
  const { platformHost, sessions, comercios, ordersFor, escrows, responderUrl = RESPONDER_URL, log = () => {} } = options;
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
        const disputes = await panelDisputes(base, orders, escrows, responderUrl, new Date(), log);
        return { ...publicComercio(req, platformHost, c), orders: orders.map((o) => panelOrder(base, o, disputes.get(o.orderId) ?? null)) };
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
  // The wallet layer (T143): Stellar Wallets Kit bundled by `pnpm build`, served from this origin, no CDN.
  const walletKitBundle = options.walletKitBundle ?? WALLET_KIT_BUNDLE;
  router.get("/portal/wallet-kit.js", (_req, res) => {
    if (!existsSync(walletKitBundle)) {
      log("wallet-kit bundle missing; run pnpm build", { path: walletKitBundle });
      res.status(503).type("text/plain").send("the wallet layer is not built");
      return;
    }
    res.set({ "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
    res.type("text/javascript").sendFile(walletKitBundle);
  });
  // The wallets' icons for the picker, from a closed list: the portal shows no image from another site (T143).
  router.get("/portal/wallet-icons/:name", (req, res) => {
    const file = walletIconFile(req.params.name);
    if (file === undefined) {
      res.status(404).json({ code: "NotFound", message: "no such wallet icon" });
      return;
    }
    res.set({ "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.type("image/png").sendFile(file);
  });
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
