/**
 * The buyer's confirmation, signed from their own wallet (T185, `Y-1`).
 *
 * `confirm` in the store's escrow pays the store at once, so it is the buyer's to give and never the agent's. The store
 * builds the transaction (`prepare`) for the one account that may authorize it and sends it back signed (`submit`) only
 * after reading that it is exactly `confirm` for this order, on this escrow, from that account:
 * - a purchase paid from a classic account: that account;
 * - a purchase paid from a `policy_rail`: the rail's principal, read from the rail on chain, never its agent key.
 * The store never holds either key, and a chat tool can only hand the person a link to the page where they sign.
 *
 * Public routes, like the order itself: the chain is the gate. CORS-open to AgentPey's signing page only.
 */
import { decodeEscrowCall, type EscrowClient, type EscrowPurchase, type EscrowReaderFactory } from "@vitrinee/anchor";
import { VitrineeError, stellarExpertTxUrl } from "@vitrinee/core";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";

import type { StoreEscrow } from "./config.js";
import { DISPUTE_PAGE_ORIGINS } from "./disputes.js";
import type { OrderRecord, OrderStore } from "./orders.js";

/** How long a prepared `confirm` stays valid: long enough to read it in the wallet and sign. */
export const CONFIRM_VALID_SECONDS = 300;
const MAX_CONFIRM_FEE_STROOPS = 10_000_000n;

const prepareBodySchema = z.strictObject({ account: z.string().regex(/^G[A-Z2-7]{55}$/) });
const submitBodySchema = z.strictObject({ signed_xdr: z.string().min(1).max(64 * 1024) });

export interface ConfirmationDeps {
  orders: OrderStore;
  escrow: StoreEscrow | undefined;
  readers: EscrowReaderFactory;
  writer: Pick<EscrowClient, "prepareConfirm" | "submitSigned">;
  /** The wallet a `policy_rail` answers to. */
  principalOf: (rail: string) => Promise<string>;
  networkPassphrase: string;
  allowedOrigins?: readonly string[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** The escrow just moved for this order: tell the platform now (T165). */
  onChange?: (orderId: string) => void;
}

function refused(message: string, details: Record<string, unknown>): VitrineeError {
  return new VitrineeError("DisputeRefused", message, { details });
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new VitrineeError("ValidationError", "the request body does not have the expected shape", { details: { issues: parsed.error.issues.map((i) => i.message) } });
  return parsed.data;
}

export function registerConfirmations(app: Express, deps: ConfirmationDeps): void {
  const escrow = deps.escrow;
  if (escrow === undefined) return;
  const origins = deps.allowedOrigins ?? DISPUTE_PAGE_ORIGINS;
  const log = deps.log ?? (() => {});

  app.use("/orders/:id/confirm", (req: Request, res: Response, next: NextFunction) => {
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
  });

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
  /** The one account whose signature the escrow's `confirm` accepts for this purchase. */
  const confirmer = async (purchase: EscrowPurchase): Promise<string> => (purchase.payer.startsWith("C") ? deps.principalOf(purchase.payer) : purchase.payer);
  /** A purchase `confirm` can pay now: held or shipped, with no dispute open (the contract refuses the rest). */
  const confirmable = (purchase: EscrowPurchase): boolean => purchase.status === "held" || purchase.status === "shipped";

  const view = (record: OrderRecord, purchase: EscrowPurchase, signer: string) => ({
    order_id: record.orderId,
    escrow: escrow.contract,
    status: purchase.status,
    can_confirm: confirmable(purchase),
    amount_atomic: purchase.amountAtomic.toString(),
    payee: escrow.payee,
    // Who must sign: the page checks the connected wallet against it before building anything.
    signer,
    network_passphrase: deps.networkPassphrase,
  });

  app.get("/orders/:id/confirm", async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const record = heldOrder(String(req.params["id"]));
    const purchase = await purchaseOf(record.orderId);
    res.json(view(record, purchase, await confirmer(purchase)));
  });

  app.post("/orders/:id/confirm/prepare", async (req: Request, res: Response) => {
    const id = String(req.params["id"]);
    const record = heldOrder(id);
    const { account } = parse(prepareBodySchema, req.body);
    const purchase = await purchaseOf(id);
    if (!confirmable(purchase)) throw refused("this purchase cannot be confirmed now", { status: purchase.status });
    const signer = await confirmer(purchase);
    if (account !== signer) throw refused("only the account that paid, or its rail's principal, confirms this purchase", { account });
    const xdr = await deps.writer.prepareConfirm({ orderRef: id }, signer, CONFIRM_VALID_SECONDS);
    res.json({ xdr, ...view(record, purchase, signer) });
  });

  app.post("/orders/:id/confirm/submit", async (req: Request, res: Response) => {
    const id = String(req.params["id"]);
    const record = heldOrder(id);
    const { signed_xdr: signedXdr } = parse(submitBodySchema, req.body);
    const purchase = await purchaseOf(id);
    const signer = await confirmer(purchase);
    // Sent only if it is exactly confirm(this order) on this escrow, from the account that may authorize it.
    const call = decodeEscrowCall(signedXdr, deps.networkPassphrase);
    const args = call?.args ?? [];
    const orderRef = args[0] instanceof Uint8Array ? Buffer.from(args[0]).toString("utf8") : null;
    const exact = call !== null && call.contract === escrow.contract && call.fn === "confirm" && args.length === 1 && orderRef === id && call.source === signer && call.feeStroops <= MAX_CONFIRM_FEE_STROOPS;
    if (!exact) throw refused("the signed transaction is not this store's confirm for this order, from the account that may give it", { orderId: id });
    // Already paid out by an earlier send of this very confirmation: nothing to send again.
    if (purchase.status !== "released" || purchase.confirmedAt === undefined || purchase.confirmedAt === null) {
      if (!confirmable(purchase)) throw refused("this purchase cannot be confirmed now", { status: purchase.status });
      try {
        await deps.writer.submitSigned("confirm", signedXdr);
      } catch (error) {
        throw new VitrineeError("EscrowError", "the confirmation could not be confirmed on Stellar; check the order before signing again", { cause: error, details: { orderId: id, transaction: call.hash } });
      }
    }
    const after = await purchaseOf(id);
    if (after.status !== "released") throw new VitrineeError("EscrowError", "the confirm transaction landed but the escrow did not release the purchase", { details: { orderId: id, transaction: call.hash } });
    log("purchase confirmed by the buyer", { orderId: id, transaction: call.hash });
    deps.onChange?.(id);
    res.json({ ...view(record, after, signer), transaction: call.hash, explorer_url: stellarExpertTxUrl(call.hash) });
  });
}
