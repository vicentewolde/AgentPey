/**
 * Buyer console — the buyer side, in a browser.
 *
 * The buyer here is deliberately generic: any standard x402 client, not a
 * named platform. That is the whole claim of the project (brief § 2.3).
 *
 * A platform that wants to buy from any Vitrinee storefront: it reads the
 * store's bazaar (`/discovery/resources`) and its manifest, shows the live
 * catalogue, and runs the exact same purchase the CLI agent runs — the
 * `buy()` in `@vitrinee/agent`, a standard x402 client. Nothing about the
 * payment is reimplemented here; this file only turns clicks into a call and
 * streams the narration back.
 *
 * The buyer's secret lives in this process and never leaves it, the same way
 * the gateway never holds the payer's key (V-12, mirrored).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buy, directIntent, loadRepoEnv, tamperAmount, type ShippingDetails } from "@vitrinee/agent";
import { MANIFEST_PATH, isVitrineeError, storefrontManifestSchema, type ManifestProduct } from "@vitrinee/core";
import { createEd25519Signer } from "@x402/stellar";
import express, { type Request, type Response } from "express";
import { z } from "zod";

loadRepoEnv();

const here = dirname(fileURLToPath(import.meta.url));
// tsx runs from src/, `node dist/server.js` from dist/; public/ is beside both.
const publicDir = resolve(here, "../public");

const GATEWAY_URL = (process.env["GATEWAY_URL"] ?? "http://localhost:4021").replace(/\/+$/, "");
const PORT = Number(process.env["CONSOLE_PORT"] ?? 4022);
const MAX_USDC = process.env["AGENT_MAX_USDC"] ?? "100";
const SECRET = process.env["AGENT_SECRET_KEY"];

const payerAccount = SECRET === undefined ? null : createEd25519Signer(SECRET, "stellar:testnet").address;

const shippingSchema = z.object({
  name: z.string().max(200).optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  country: z.string().length(2).default("CL"),
  notes: z.string().max(500).optional(),
});

const buyBodySchema = z.object({
  productId: z.string().min(1),
  quantity: z.int().positive().max(100).default(1),
  shipping: shippingSchema.default({ country: "CL" }),
  maxUsdc: z.string().regex(/^\d+(\.\d{1,7})?$/).default(MAX_USDC),
  dryRun: z.boolean().default(false),
  /** Free-text order the operator typed instead of clicking a product. */
  instruction: z.string().max(400).optional(),
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir, { index: "index.html" }));

/** Who this console is and which storefront it is pointed at. */
app.get("/api/session", (_req, res) => {
  res.json({
    platform: "Comprador x402",
    gatewayUrl: GATEWAY_URL,
    payerAccount,
    canPay: SECRET !== undefined,
    maxUsdc: MAX_USDC,
    network: "stellar:testnet",
  });
});

interface BazaarItem {
  resource: string;
  accepts: { amount: string; asset: string; payTo: string; network: string; scheme: string; maxTimeoutSeconds: number }[];
  description: string;
  serviceName: string;
  tags: string[];
  lastUpdated: string;
}

/**
 * The live catalogue, as an agent sees it: the bazaar listing is the source of
 * truth for what is purchasable and at what price; the manifest adds the human
 * details (images, SKU, local price) for the people watching the screen.
 */
app.get("/api/bazaar", async (_req, res) => {
  const [manifestResponse, bazaarResponse] = await Promise.all([
    fetch(`${GATEWAY_URL}${MANIFEST_PATH}`),
    fetch(`${GATEWAY_URL}/discovery/resources?limit=200`),
  ]);
  if (!manifestResponse.ok) {
    res.status(502).json({ error: "GatewayUnreachable", message: `el gateway respondió HTTP ${manifestResponse.status} al manifest`, gatewayUrl: GATEWAY_URL });
    return;
  }
  const manifest = storefrontManifestSchema.parse(await manifestResponse.json());
  const bazaar = bazaarResponse.ok ? ((await bazaarResponse.json()) as { items?: BazaarItem[]; pagination?: unknown }) : { items: [] };
  const items = bazaar.items ?? [];

  // Bazaar entries carry the checkout URL; the manifest carries the route.
  const offerFor = (product: ManifestProduct): BazaarItem | undefined =>
    items.find((item) => item.resource.endsWith(product.checkoutRoute));

  res.json({
    merchant: manifest.merchant,
    network: manifest.network,
    fx: manifest.fx,
    settlement: manifest.settlement,
    endpoints: manifest.endpoints,
    products: manifest.products.map((product) => {
      const offer = offerFor(product);
      return {
        ...product,
        purchasable: offer !== undefined,
        offer: offer === undefined ? null : { accepts: offer.accepts, tags: offer.tags, lastUpdated: offer.lastUpdated },
      };
    }),
    bazaarTotal: (bazaar as { pagination?: { total?: number } }).pagination?.total ?? items.length,
  });
});

/** Orders this storefront has issued, so the console can show history. */
app.get("/api/orders", async (_req, res) => {
  const response = await fetch(`${GATEWAY_URL}/orders`);
  res.status(response.status).json(await response.json());
});

/** Re-verifies a receipt, optionally after editing the amount inside it (V-11's demo). */
app.post("/api/verify", async (req, res) => {
  const { receiptJws, tamper } = z.object({ receiptJws: z.string().min(1), tamper: z.boolean().default(false) }).parse(req.body ?? {});
  const edit = tamper ? tamperAmount(receiptJws) : null;
  const response = await fetch(`${GATEWAY_URL}/receipts/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiptJws: edit?.jws ?? receiptJws }),
  });
  const verification = (await response.json()) as Record<string, unknown>;
  res.status(response.status).json({ ...verification, tampered: edit });
});

/**
 * The purchase, streamed. Server-sent events so the browser shows the same
 * line-by-line narration the CLI prints, while the payment is still in flight.
 */
app.post("/api/buy", async (req: Request, res: Response) => {
  const body = buyBodySchema.parse(req.body ?? {});
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const manifestResponse = await fetch(`${GATEWAY_URL}${MANIFEST_PATH}`);
    if (!manifestResponse.ok) throw new Error(`el gateway respondió HTTP ${manifestResponse.status} al manifest`);
    const manifest = storefrontManifestSchema.parse(await manifestResponse.json());
    const product = manifest.products.find((p) => p.id === body.productId);
    if (product === undefined) throw new Error(`el producto "${body.productId}" no está en el catálogo`);

    // Blank fields are absent fields: the gateway would reject an empty string.
    const filled = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());
    const shipping: ShippingDetails = {
      country: body.shipping.country,
      ...(filled(body.shipping.name) === undefined ? {} : { name: filled(body.shipping.name)! }),
      ...(filled(body.shipping.address) === undefined ? {} : { address: filled(body.shipping.address)! }),
      ...(filled(body.shipping.city) === undefined ? {} : { city: filled(body.shipping.city)! }),
      ...(filled(body.shipping.region) === undefined ? {} : { region: filled(body.shipping.region)! }),
      ...(filled(body.shipping.notes) === undefined ? {} : { notes: filled(body.shipping.notes)! }),
    };

    const result = await buy({
      gatewayUrl: GATEWAY_URL,
      instruction: body.instruction ?? `${product.name} × ${body.quantity} → ${shipping.city ?? shipping.country}`,
      intent: directIntent(product, body.quantity, shipping),
      signerSecret: body.dryRun ? undefined : SECRET,
      maxUsdc: body.maxUsdc,
      dryRun: body.dryRun,
      log: (line) => send("log", { line }),
    });

    send("done", {
      intent: { product: result.intent.product, quantity: result.intent.quantity, shipping: result.intent.shipping },
      requirements: result.requirements,
      order: result.order ?? null,
      verification: result.verification ?? null,
      elapsedMs: Math.round(result.elapsedMs),
      timings: result.timings,
      dryRun: body.dryRun,
    });
  } catch (error) {
    send("failed", {
      code: isVitrineeError(error) ? error.code : "Error",
      message: error instanceof Error ? error.message : String(error),
      details: isVitrineeError(error) ? error.details : {},
    });
  } finally {
    res.end();
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const message = error instanceof Error ? error.message : String(error);
  res.status(isVitrineeError(error) ? error.httpStatus : 500).json({ error: "ConsoleError", message });
});

app.listen(PORT, () => {
  const line = readFileSync(resolve(publicDir, "index.html"), "utf8").length > 0 ? "" : " (sin UI)";
  process.stdout.write(`\nComprador x402  http://localhost:${PORT}${line}\n`);
  process.stdout.write(`  storefront     ${GATEWAY_URL}\n`);
  process.stdout.write(`  pagador        ${payerAccount ?? "(sin AGENT_SECRET_KEY: solo dry run)"}\n`);
  process.stdout.write(`  tope           ${MAX_USDC} USDC por pago\n\n`);
});
