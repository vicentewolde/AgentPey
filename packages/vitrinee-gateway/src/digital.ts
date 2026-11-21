/**
 * Digital products: the download is the delivery (T188, `Y-5`, `Y-11`).
 *
 * A store names which of its products are digital, and where each file lives (`DIGITAL_PRODUCTS`, or the platform's
 * `COMERCIO_DIGITAL_PRODUCTS` by slug). An order made only of digital products has no parcel: the buyer gets the file
 * from `GET /orders/:id/download`, and the first download that reaches them is recorded as the order's delivery, which,
 * for an order held in the store's escrow, opens the release window (`mark_shipped`) exactly as a parcel leaving would.
 * Later downloads hand the file over again and change nothing.
 *
 * Who may download: only whoever paid, proven by a short-lived link they sign with their own Stellar key
 * (`@vitrinee/core` `signDownloadLink`): the classic account that paid, or, for a purchase a `policy_rail` paid, the
 * rail's owner (the buyer's agent) or its principal (the buyer's wallet), read from the rail on chain. Order pages are
 * public, so the store never prints a link there: it only says the order is digital.
 *
 * The file is fetched by the store, server side, from the URL the store configured (a file in Shopify's Files, for
 * instance) and streamed to the buyer, who never sees that URL. Orders mixing physical and digital products follow the
 * physical path: the platform reports the parcel, as before.
 */
import { DOWNLOAD_LINK_MAX_SECONDS, VitrineeError, verifyDownloadLink } from "@vitrinee/core";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { OrderRecord, OrderStore } from "./orders.js";

/** The largest file a store hands over: a design, a PDF credential, an image pack. */
export const MAX_DIGITAL_FILE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
/** A link signed on a clock a little ahead of the store's still works. */
const CLOCK_SKEW_SECONDS = 60;

export const digitalProductSchema = z.strictObject({
  /** Where the store keeps the file. HTTPS only, with no credentials in it: it is fetched by the store, never shown. */
  url: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    }, "an https URL without credentials"),
  /** The name the buyer's download gets. */
  name: z.string().trim().min(1).max(200),
  /** Sent as the download's type; the file host's is used when absent. */
  mediaType: z
    .string()
    .regex(/^[a-z]+\/[a-z0-9.+-]+$/)
    .optional(),
});
export type DigitalProduct = z.infer<typeof digitalProductSchema>;
export type DigitalProducts = ReadonlyMap<string, DigitalProduct>;

const digitalProductsSchema = z.record(z.string().trim().min(1).max(200), digitalProductSchema);

/**
 * `DIGITAL_PRODUCTS`: a JSON object from product id to `{ url, name, mediaType? }`. Unset: the store sells no digital
 * product. @throws VitrineeError `ConfigError` naming what is wrong, never the URLs.
 */
export function parseDigitalProducts(value: string | undefined): Map<string, DigitalProduct> {
  if (value === undefined || value.trim() === "") return new Map();
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new VitrineeError("ConfigError", "invalid environment: DIGITAL_PRODUCTS is not JSON");
  }
  const parsed = digitalProductsSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new VitrineeError("ConfigError", `invalid environment: DIGITAL_PRODUCTS: ${problems.join("; ")}`, { details: { problems } });
  }
  return new Map(Object.entries(parsed.data));
}

/** Whether every product of the order is digital: only then is the download its delivery. */
export function isDigitalOrder(record: Pick<OrderRecord, "items">, products: DigitalProducts): boolean {
  return products.size > 0 && record.items.length > 0 && record.items.every((item) => products.has(item.productId));
}

export interface DownloadDeps {
  orders: OrderStore;
  products: DigitalProducts;
  /** The owner and principal of a `policy_rail` that paid, read on chain. */
  railKeysOf: (rail: string) => Promise<{ owner: string; principal: string }>;
  /** Records the delivery (`OrderEvents.recordShipment`), which opens the escrow's window for a held order. */
  delivered: (orderId: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

const denied = (message: string, details: Record<string, unknown> = {}) => new VitrineeError("DownloadDenied", message, { details });

/** The accounts that may download what this order paid for: its payer, or the owner and principal of the rail that paid. */
async function readersOf(record: OrderRecord, railKeysOf: DownloadDeps["railKeysOf"]): Promise<readonly string[]> {
  const payer = record.settlement.payer;
  if (payer.startsWith("G")) return [payer];
  try {
    const keys = await railKeysOf(payer);
    return [keys.owner, keys.principal];
  } catch (error) {
    throw new VitrineeError("NetworkError", "could not read the rail that paid this order", { cause: error, details: { orderId: record.orderId } });
  }
}

/** A filename safe in a `Content-Disposition` header: ASCII for old clients, UTF-8 for the rest. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function fetchFile(product: DigitalProduct, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; mediaType: string }> {
  let res: globalThis.Response;
  try {
    res = await fetchImpl(product.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new VitrineeError("DownloadUnavailable", "the store could not reach its file", { cause: error });
  }
  if (!res.ok) throw new VitrineeError("DownloadUnavailable", "the store's file host did not hand over the file", { details: { status: res.status } });
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DIGITAL_FILE_BYTES) throw new VitrineeError("DownloadUnavailable", "the file is larger than a store may hand over", { details: { bytes: declared } });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DIGITAL_FILE_BYTES) throw new VitrineeError("DownloadUnavailable", "the file is empty or too large", { details: { bytes: bytes.byteLength } });
  const upstream = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const mediaType = product.mediaType ?? (/^[a-z]+\/[a-z0-9.+-]+$/.test(upstream) ? upstream : "application/octet-stream");
  return { bytes, mediaType };
}

const querySchema = z.object({
  reader: z.string().regex(/^G[A-Z2-7]{55}$/),
  exp: z.string().regex(/^[0-9]{1,12}$/).transform(Number),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
  /** Which line of the order, from 1, when it has more than one product. */
  line: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .optional(),
});

export function registerDownloads(app: Express, deps: DownloadDeps): void {
  if (deps.products.size === 0) return;
  const fetchImpl = deps.fetchImpl ?? fetch;

  app.get("/orders/:id/download", async (req: Request, res: Response) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" });
    const orderId = String(req.params["id"]);
    const query = querySchema.safeParse(req.query);
    if (!query.success) throw denied("a download needs a link signed by whoever paid: reader, exp and sig");
    const { reader, exp, sig } = query.data;

    const now = Math.floor(deps.now().getTime() / 1000);
    if (exp <= now) throw denied("this download link expired; ask for a new one");
    if (exp > now + DOWNLOAD_LINK_MAX_SECONDS + CLOCK_SKEW_SECONDS) throw denied("this download link lasts too long");
    const store = (req.get("host") ?? "").toLowerCase();
    if (!verifyDownloadLink({ store, orderId, reader, expiresAt: exp }, sig)) throw denied("the link's signature does not match this store, order and reader");

    // The same answer for an order that does not exist and one that is not digital: neither has a file here.
    const record = deps.orders.get(orderId);
    if (record === undefined || record.receipt === null || !isDigitalOrder(record, deps.products)) {
      throw new VitrineeError("OrderNotFound", `no digital order "${orderId}" in this store`, { details: { orderId } });
    }
    if (!(await readersOf(record, deps.railKeysOf)).includes(reader)) throw denied("only whoever paid this order can download it", { orderId });

    const line = query.data.line ?? 1;
    const item = record.items[line - 1];
    if (item === undefined) throw new VitrineeError("OrderNotFound", `the order has no line ${line}`, { details: { orderId, line } });
    const product = deps.products.get(item.productId)!;
    const file = await fetchFile(product, fetchImpl);

    // Recorded once the file left the store, not when it was asked for: the delivery is the file reaching the buyer.
    res.on("finish", () => {
      const first = record.fulfillmentState !== "fulfilled";
      deps
        .delivered(orderId)
        .then(() => {
          if (first) deps.log("digital order delivered: first download", { orderId, line });
        })
        .catch((error: unknown) => deps.log("digital delivery not recorded", { orderId, error: error instanceof Error ? error.message : String(error) }));
    });
    res.status(200).set({ "Content-Type": file.mediaType, "Content-Length": String(file.bytes.byteLength), "Content-Disposition": disposition(product.name), "X-Content-Type-Options": "nosniff" }).end(file.bytes);
  });
}
