/**
 * A dispute's documents, kept with the order (Fase 9, T163, X-29).
 *
 * A dispute in the store's `purchase-escrow` holds two hashes: the buyer's claim (`claim_hash`, opened from the chat
 * in T162) and the merchant's answer (`response_hash`). The documents themselves live here, next to the order, so the
 * merchant reads the claim and the arbiter reads both without anyone passing files around. Nothing here is trusted
 * for its content: the store keeps a document only when its hash is the one the escrow holds, and whoever reads it
 * hashes it again against the chain.
 *
 * The merchant answers with its wallet. The escrow's `respond` needs the payout account's signature, and the store
 * never holds that key (VT-8): `prepare` builds the transaction for the wallet to sign, and `submit` sends it only
 * after reading back that it is exactly that call, for this order and this document, from the payout account.
 *
 * Every route is public, like the order itself: the chain is the gate. Reads and the two answer steps are CORS-open
 * to AgentPey's responder page only.
 */
import { createHash } from "node:crypto";

import { canonicalJson, jwsDocumentHash } from "@agentpass/core";
import { decodeEscrowCall, type EscrowClient, type EscrowPurchase, type EscrowReaderFactory } from "@vitrinee/anchor";
import { VitrineeError, stellarExpertTxUrl } from "@vitrinee/core";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";

import type { StoreEscrow } from "./config.js";
import type { OrderRecord, OrderStore } from "./orders.js";

/** AgentPey's responder page, the one origin allowed to call these routes from a browser. */
export const DISPUTE_PAGE_ORIGINS: readonly string[] = ["https://agentpey.com"];
/** How long a prepared `respond` stays valid: long enough to read it in the wallet and sign. */
export const RESPOND_VALID_SECONDS = 300;
/** A response document is text written by a person: bounded so the order record stays small. */
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CLAIM_BYTES = 32 * 1024;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256");

/** What the store checks of a response: who answers, to what. The arbiter checks the rest (`@agentpey/resolve`). */
const responseDocumentSchema = z.looseObject({
  type: z.literal("AgentResolveResponse"),
  respondent: z.string().min(1),
  receiptHash: hex64,
  claimHash: hex64,
});
const claimBodySchema = z.strictObject({ claim_jws: z.string().trim().min(1).max(MAX_CLAIM_BYTES) });
const prepareBodySchema = z.strictObject({ response: z.record(z.string(), z.unknown()) });
const submitBodySchema = z.strictObject({ response: z.record(z.string(), z.unknown()), signed_xdr: z.string().min(1).max(64 * 1024) });

/** sha256 of the document's canonical JSON, lowercase hex: `responseHash` in `@agentpey/resolve`. */
export function disputeResponseHash(document: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(document), "utf8").digest("hex");
}

export interface DisputeDeps {
  orders: OrderStore;
  /** The store's escrow, as `verifyStoreEscrow` read it; `undefined` for a store paid directly (no routes then). */
  escrow: StoreEscrow | undefined;
  readers: EscrowReaderFactory;
  /** Builds and sends `respond`; the store's own client of its escrow. */
  writer: Pick<EscrowClient, "prepareRespond" | "submitSigned">;
  networkPassphrase: string;
  allowedOrigins?: readonly string[];
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

function refused(message: string, details: Record<string, unknown>): VitrineeError {
  return new VitrineeError("DisputeRefused", message, { details });
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new VitrineeError("ValidationError", "the request body does not have the expected shape", { details: { issues: parsed.error.issues.map((i) => i.message) } });
  return parsed.data;
}

export function registerDisputes(app: Express, deps: DisputeDeps): void {
  const escrow = deps.escrow;
  if (escrow === undefined) return;
  const origins = deps.allowedOrigins ?? DISPUTE_PAGE_ORIGINS;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const payeeDid = `did:stellar:testnet:${escrow.payee}`;

  const cors = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin !== undefined && origins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "content-type");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
  app.use("/orders/:id/dispute", cors);

  /** The order, paid into this store's escrow; refused otherwise. */
  const heldOrder = (id: string): OrderRecord => {
    const record = deps.orders.get(id);
    if (record === undefined || record.hold?.escrow !== escrow.contract || record.receipt === null) {
      throw new VitrineeError("OrderNotFound", `no order "${id}" paid into this store's escrow`, { details: { orderId: id } });
    }
    return record;
  };
  const purchaseOf = async (id: string): Promise<EscrowPurchase> => {
    let purchase: EscrowPurchase | null;
    try {
      purchase = await deps.readers(escrow.contract).get(id);
    } catch (error) {
      throw new VitrineeError("NetworkError", "could not read the store's escrow on Stellar", { cause: error, details: { orderId: id } });
    }
    if (purchase === null) throw refused("the escrow holds no purchase for this order", { orderId: id });
    return purchase;
  };

  /** A response the escrow can take now: the right respondent, answering this order's open dispute, in time. */
  const checkResponse = (record: OrderRecord, purchase: EscrowPurchase, document: Record<string, unknown>): { hash: string; respondBy: Date } => {
    if (Buffer.byteLength(canonicalJson(document), "utf8") > MAX_RESPONSE_BYTES) throw refused("the response is too long", { limitBytes: MAX_RESPONSE_BYTES });
    const response = parse(responseDocumentSchema, document);
    if (response.respondent !== payeeDid) throw refused("only the store's payout account answers a dispute in its escrow", { respondent: response.respondent });
    if (response.receiptHash !== record.receipt?.hash) throw refused("the response is about another receipt than this order's", { receiptHash: response.receiptHash });
    if (purchase.status === "responded") throw refused("the store already answered this dispute", { orderId: record.orderId });
    if (purchase.status !== "disputed" || purchase.openedAt === null) throw refused("this order has no open dispute to answer", { status: purchase.status });
    if (response.claimHash !== purchase.claimHash) throw refused("the response answers another claim than the one in the escrow", { claimHash: response.claimHash });
    const respondBy = new Date((purchase.openedAt + escrow.responseWindowSeconds) * 1000);
    // The contract refuses from the second after the window (`now > opened_at + response_window`).
    if (now().getTime() > respondBy.getTime()) throw refused(`the time to answer ended on ${respondBy.toISOString()}`, { respondBy: respondBy.toISOString() });
    return { hash: disputeResponseHash(document), respondBy };
  };

  const view = (record: OrderRecord) => ({
    order_id: record.orderId,
    escrow: escrow.contract,
    payee: escrow.payee,
    claim_jws: record.dispute?.claimJws ?? null,
    response:
      record.dispute?.response === undefined
        ? null
        : { document: record.dispute.response.document, hash: record.dispute.response.hash, transaction: record.dispute.response.transaction, explorer_url: stellarExpertTxUrl(record.dispute.response.transaction) },
  });

  app.get("/orders/:id/dispute", (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json(view(heldOrder(String(req.params["id"]))));
  });

  // The buyer's claim, kept once its hash is the escrow's claim_hash. Anyone may bring it: only the real one fits.
  app.post("/orders/:id/dispute/claim", async (req: Request, res: Response) => {
    const id = String(req.params["id"]);
    const record = heldOrder(id);
    const { claim_jws: claimJws } = parse(claimBodySchema, req.body);
    const purchase = await purchaseOf(id);
    if (purchase.claimHash === null) throw refused("the escrow has no claim for this order", { status: purchase.status });
    if (jwsDocumentHash(claimJws) !== purchase.claimHash) throw refused("this claim is not the one the escrow holds", { claimHash: purchase.claimHash });
    if (record.dispute?.claimJws !== claimJws) {
      await deps.orders.update(id, (order) => {
        order.dispute = { ...order.dispute, claimJws };
      });
      log("dispute claim kept", { orderId: id, claimHash: purchase.claimHash });
    }
    res.json(view(heldOrder(id)));
  });

  app.post("/orders/:id/dispute/response/prepare", async (req: Request, res: Response) => {
    const id = String(req.params["id"]);
    const record = heldOrder(id);
    const { response } = parse(prepareBodySchema, req.body);
    const { hash, respondBy } = checkResponse(record, await purchaseOf(id), response);
    const xdr = await deps.writer.prepareRespond({ orderRef: id, responseHash: hash }, escrow.payee, RESPOND_VALID_SECONDS);
    res.json({ xdr, response_hash: hash, payee: escrow.payee, respond_by: respondBy.toISOString(), network_passphrase: deps.networkPassphrase });
  });

  app.post("/orders/:id/dispute/response/submit", async (req: Request, res: Response) => {
    const id = String(req.params["id"]);
    const record = heldOrder(id);
    const body = parse(submitBodySchema, req.body);
    const { hash } = checkResponse(record, await purchaseOf(id), body.response);
    // Sent only if it is exactly respond(this order, this document) on this escrow, from the payout account.
    const call = decodeEscrowCall(body.signed_xdr, deps.networkPassphrase);
    const args = call?.args ?? [];
    const orderRef = args[0] instanceof Uint8Array ? Buffer.from(args[0]).toString("utf8") : null;
    const signedHash = args[1] instanceof Uint8Array ? Buffer.from(args[1]).toString("hex") : null;
    if (call === null || call.contract !== escrow.contract || call.fn !== "respond" || args.length !== 2 || orderRef !== id || signedHash !== hash || call.source !== escrow.payee) {
      throw refused("the signed transaction is not this store's respond for this order and this response", { orderId: id });
    }
    const sent = await deps.writer.submitSigned("respond", body.signed_xdr);
    const after = await purchaseOf(id);
    if (after.responseHash !== hash) {
      throw new VitrineeError("EscrowError", "the respond transaction landed but the escrow holds another answer", { details: { orderId: id, transaction: sent.txHash } });
    }
    await deps.orders.update(id, (order) => {
      order.dispute = { ...order.dispute, response: { document: body.response, hash, transaction: sent.txHash } };
    });
    log("dispute response kept", { orderId: id, responseHash: hash, transaction: sent.txHash });
    res.json(view(heldOrder(id)));
  });
}
