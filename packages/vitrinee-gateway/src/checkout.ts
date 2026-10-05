import { randomBytes } from "node:crypto";

import type { Buyer, BuyerConsent, Product, StoreAdapter } from "@vitrinee/adapters";
import {
  STELLAR_TESTNET_CAIP2,
  USDC_TESTNET,
  VitrineeError,
  countryCodeSchema,
  currencyDecimals,
  formatUnits,
  localToUsdcAtomic,
  parseDecimal,
  receiptIncoherence,
  signReceipt,
  stellarDid,
  stellarPayerSchema,
  stellarExpertTxUrl,
  timesQuantity,
  usdcAtomicToDecimal,
  type ReceiptClaims,
} from "@vitrinee/core";
import type { HTTPRequestContext, RouteConfig, RoutesConfig } from "@x402/core/server";
import type { Price } from "@x402/core/types";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { AnchorWorker } from "./anchoring.js";
import type { GatewayConfig } from "./config.js";
import type { OrderRecord, OrderStore } from "./orders.js";
import { payerFromTransactionXdr } from "./payer.js";
import type { Reservations } from "./reservations.js";
import { paymentKeyFromHeader, type SettlementLedger, type SettlementRecord } from "./settlements.js";

export const CHECKOUT_ROUTE = "POST /checkout/:productId";
/**
 * The same checkout, driven by the query string. x402 clients, AgentPey's
 * among them, ask for the 402 with a bodyless `GET` and retry the same URL
 * with the payment header; a `POST`-only checkout was invisible to them
 * (C-130, VT-23).
 */
export const CHECKOUT_GET_ROUTE = "GET /checkout/:productId";
export const RECEIPT_TYP = "vitrinee-receipt/0.1" as const;

export const checkoutBodySchema = z.object({
  quantity: z.int().positive().max(100).default(1),
  buyer: z
    .object({
      stellarAccount: stellarPayerSchema.optional(),
      email: z.email().optional(),
      shipping: z
        .object({
          name: z.string().max(200).optional(),
          address: z.string().max(300).optional(),
          city: z.string().max(100).optional(),
          region: z.string().max(100).optional(),
          country: countryCodeSchema.default("CL"),
          notes: z.string().max(500).optional(),
        })
        .optional(),
    })
    .default({}),
});

export type CheckoutBody = z.infer<typeof checkoutBodySchema>;

/**
 * The flat query a `GET` checkout reads: the names Vitrinee's `ServiceCard`
 * declares as `input` (see `discovery.ts`), plus the optional ones a client
 * may add by hand. Each one is a single string: a repeated parameter arrives
 * as an array and is refused, rather than one of its values being chosen.
 */
const checkoutQuerySchema = z.object({
  quantity: z.string().regex(/^\d{1,3}$/, "quantity must be a whole number").optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  notes: z.string().optional(),
});

const SHIPPING_FIELDS = ["name", "address", "city", "region", "country", "notes"] as const;

/**
 * Maps a `GET` checkout's query onto the `POST` body's shape and validates it
 * with the very same schema, so the two doors cannot drift apart on what they
 * accept. An empty value counts as absent: a form field left blank is not an
 * address.
 */
export function checkoutBodyFromQuery(query: unknown): CheckoutBody {
  const flat = checkoutQuerySchema.parse(query ?? {});
  const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value.trim());
  const shipping = Object.fromEntries(
    SHIPPING_FIELDS.flatMap((field) => {
      const value = present(flat[field]);
      return value === undefined ? [] : [[field, value]];
    }),
  );
  const email = present(flat.email);
  const quantity = present(flat.quantity);
  return checkoutBodySchema.parse({
    ...(quantity === undefined ? {} : { quantity: Number(quantity) }),
    buyer: {
      ...(email === undefined ? {} : { email }),
      ...(Object.keys(shipping).length === 0 ? {} : { shipping }),
    },
  });
}

/** The checkout request, from whichever door it came through. Anything but `GET` reads the JSON body. */
export function checkoutBodyFor(method: string, body: unknown, query: unknown): CheckoutBody {
  return method.toUpperCase() === "GET" ? checkoutBodyFromQuery(query) : checkoutBodySchema.parse(body ?? {});
}

/** The same, read through x402's HTTP adapter: what the price and the 402 body see. */
function checkoutBodyFromContext(context: HTTPRequestContext): CheckoutBody {
  return checkoutBodyFor(context.adapter.getMethod(), context.adapter.getBody?.(), context.adapter.getQueryParams?.());
}

const idempotencyKeySchema = z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/, "printable ASCII, no spaces");

export interface CheckoutQuote {
  product: Product;
  quantity: number;
  unitAtomic: bigint;
  totalAtomic: bigint;
  totalLocal: string;
}

/**
 * What a whole purchase costs (T148): its lines, each priced by
 * {@link quoteCheckout} with its own single rounding (VT-7), and their sum.
 * The total is Σ line totals, never a conversion of the summed local price,
 * so the receipt's items add up to what is charged by construction.
 */
export interface PurchaseQuote {
  lines: readonly CheckoutQuote[];
  totalAtomic: bigint;
  totalLocal: string;
  currency: string;
}

/** @throws VitrineeError `ValidationError` for no lines, or lines priced in different currencies. */
export function purchaseQuote(lines: readonly CheckoutQuote[]): PurchaseQuote {
  const [first] = lines;
  if (first === undefined) throw new VitrineeError("ValidationError", "a purchase needs at least one line", { details: {} });
  const currency = first.product.currency;
  const decimals = currencyDecimals(currency);
  let totalAtomic = 0n;
  let totalLocal = 0n;
  for (const line of lines) {
    if (line.product.currency !== currency) {
      throw new VitrineeError("ValidationError", "every line of a purchase must be priced in the same currency", { details: { currencies: [currency, line.product.currency] } });
    }
    totalAtomic += line.totalAtomic;
    totalLocal += parseDecimal(line.totalLocal, decimals);
  }
  return { lines, totalAtomic, totalLocal: formatUnits(totalLocal, decimals), currency };
}

export interface CheckoutDeps {
  config: GatewayConfig;
  adapter: StoreAdapter;
  orders: OrderStore;
  ledger: SettlementLedger;
  anchors: AnchorWorker;
  reservations: Reservations;
  /** Idempotency keys whose paid request is being processed right now. */
  inFlight: Set<string>;
  now: () => Date;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

interface CheckoutLocals {
  quote: CheckoutQuote;
  body: CheckoutBody;
  idempotencyKey: string | null;
}

export function productIdFromPath(path: string): string | undefined {
  const match = /^\/checkout\/([^/]+)\/?$/.exec(path);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** Prices one checkout. Throws ProductNotFound / OutOfStock / ValidationError. */
export async function quoteCheckout(
  deps: Pick<CheckoutDeps, "config" | "adapter">,
  productId: string,
  body: CheckoutBody,
  reserved = 0,
): Promise<CheckoutQuote> {
  const product = await deps.adapter.getProduct(productId);
  if (product === null) {
    throw new VitrineeError("ProductNotFound", `no product with id "${productId}"`, { details: { productId } });
  }
  const available = product.stock === null ? null : product.stock - reserved;
  if (available !== null && available < body.quantity) {
    throw new VitrineeError("OutOfStock", `only ${Math.max(available, 0)} left of "${product.name}"`, {
      details: { productId, available: Math.max(available, 0), requested: body.quantity },
    });
  }
  const unitAtomic = localToUsdcAtomic(product.priceLocal, product.currency, deps.config.fx);
  const totalAtomic = timesQuantity(unitAtomic, body.quantity);
  const decimals = currencyDecimals(product.currency);
  const totalLocal = formatUnits(parseDecimal(product.priceLocal, decimals) * BigInt(body.quantity), decimals);
  return { product, quantity: body.quantity, unitAtomic, totalAtomic, totalLocal };
}

function readIdempotencyKey(req: Request): string | null {
  const raw = req.header("idempotency-key");
  if (raw === undefined) return null;
  const parsed = idempotencyKeySchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new VitrineeError("ValidationError", "Idempotency-Key must be 1–255 printable ASCII characters", { details: {} });
  }
  return parsed.data;
}

/**
 * Runs before the x402 middleware. Refuses what can never be sold with a
 * plain 400/404/409, so nobody is asked to pay for it; answers a repeated
 * Idempotency-Key with the order it already produced; and holds stock for
 * paid requests while their settlement is in flight.
 */
export function preflightCheckout(deps: CheckoutDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const productId = productIdFromPath(req.path);
    if (productId === undefined) {
      throw new VitrineeError("ValidationError", "malformed checkout path", { details: { path: req.path } });
    }
    // A checkout answer is about one purchase: never let a cache between the
    // agent and this gateway replay a 402 or an order, least of all on `GET`.
    res.set("Cache-Control", "no-store");
    const body = checkoutBodyFor(req.method, req.body, req.query);
    const idempotencyKey = readIdempotencyKey(req);

    if (idempotencyKey !== null) {
      const existing = deps.orders.findByIdempotencyKey(idempotencyKey);
      if (existing !== undefined) {
        const [only] = existing.items;
        if (existing.items.length !== 1 || only?.productId !== productId || only.quantity !== body.quantity) {
          throw new VitrineeError("IdempotencyConflict", "this Idempotency-Key was already used for a different purchase", {
            details: { orderId: existing.orderId },
          });
        }
        res.set("Idempotent-Replayed", "true");
        res.status(200).json(orderResponse(existing));
        return;
      }
    }

    const paying = req.header("payment-signature") !== undefined || req.header("x-payment") !== undefined;
    const quote = await quoteCheckout(deps, productId, body, deps.reservations.reserved(productId));

    if (paying) {
      if (idempotencyKey !== null) {
        if (deps.inFlight.has(idempotencyKey)) {
          throw new VitrineeError("IdempotencyConflict", "a payment with this Idempotency-Key is already being processed", { details: {} });
        }
        deps.inFlight.add(idempotencyKey);
      }
      if (!deps.reservations.tryReserve(productId, body.quantity, quote.product.stock)) {
        if (idempotencyKey !== null) deps.inFlight.delete(idempotencyKey);
        throw new VitrineeError("OutOfStock", `the last units of "${quote.product.name}" are being bought right now`, {
          details: { productId, requested: body.quantity },
        });
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        deps.reservations.release(productId, body.quantity);
        if (idempotencyKey !== null) deps.inFlight.delete(idempotencyKey);
      };
      res.once("finish", release);
      res.once("close", release);
    }

    res.locals["checkout"] = { quote, body, idempotencyKey } satisfies CheckoutLocals;
    next();
  };
}

/** The dynamic price the x402 middleware asks for: unit USDC price × quantity, in atomic units. */
export function checkoutPrice(deps: Pick<CheckoutDeps, "config" | "adapter">) {
  return async (context: HTTPRequestContext): Promise<Price> => {
    const productId = productIdFromPath(context.path);
    if (productId === undefined) {
      throw new VitrineeError("ValidationError", "malformed checkout path", { details: { path: context.path } });
    }
    const body = checkoutBodyFromContext(context);
    const quote = await quoteCheckout(deps, productId, body);
    return { amount: quote.totalAtomic.toString(), asset: USDC_TESTNET.contractId };
  };
}

export function checkoutRoutes(deps: Pick<CheckoutDeps, "config" | "adapter">): RoutesConfig {
  const route = checkoutRouteConfig(deps);
  // One config object behind both doors: the same price, payTo and 402 body.
  return { [CHECKOUT_ROUTE]: route, [CHECKOUT_GET_ROUTE]: route };
}

function checkoutRouteConfig(deps: Pick<CheckoutDeps, "config" | "adapter">): RouteConfig {
  const { config } = deps;
  return {
    accepts: [
      {
        scheme: "exact",
        network: STELLAR_TESTNET_CAIP2,
        payTo: config.merchant.stellarAccount,
        price: checkoutPrice(deps),
        maxTimeoutSeconds: config.checkout.maxTimeoutSeconds,
        // Settle before the handler runs: the platform order is only ever
        // created for money that already moved (docs/fase-6-agentguard-comercializacion/vitrinee/DECISIONES.md, VT-10).
        extra: { paymentFlow: "upfront" },
      },
    ],
    description: `Compra en ${config.merchant.name} — pago x402 en USDC sobre Stellar testnet`,
    mimeType: "application/json",
    unpaidResponseBody: async (context: HTTPRequestContext) => {
      const productId = productIdFromPath(context.path) ?? "";
      const body = checkoutBodyFromContext(context);
      const quote = await quoteCheckout(deps, productId, body);
      return {
        contentType: "application/json",
        body: {
          error: "PaymentRequired",
          message: `Pago requerido: ${usdcAtomicToDecimal(quote.totalAtomic)} USDC por ${quote.quantity} × ${quote.product.name}. Reintenta con el header PAYMENT-SIGNATURE.`,
          quote: {
            productId: quote.product.id,
            name: quote.product.name,
            quantity: quote.quantity,
            totalLocal: quote.totalLocal,
            currency: quote.product.currency,
            amountUSDC: usdcAtomicToDecimal(quote.totalAtomic),
            amountUSDCAtomic: quote.totalAtomic.toString(),
            payTo: config.merchant.stellarAccount,
            network: STELLAR_TESTNET_CAIP2,
          },
        },
      };
    },
  };
}

function newOrderId(now: Date): string {
  return `ord_${now.getTime().toString(36)}${randomBytes(5).toString("hex")}`;
}

export function buildReceiptClaims(record: OrderRecord, config: GatewayConfig, issuedAt: Date): ReceiptClaims {
  return {
    typ: RECEIPT_TYP,
    orderId: record.orderId,
    platformOrderId: record.platformOrderId,
    platform: record.platform,
    merchantDid: stellarDid(config.signing.account),
    merchantAccount: config.merchant.stellarAccount,
    payerAccount: record.settlement.payer,
    network: STELLAR_TESTNET_CAIP2,
    asset: record.settlement.asset,
    amountUSDC: record.amountUSDC,
    amountUSDCAtomic: record.amountUSDCAtomic,
    settlementTxHash: record.settlement.txHash,
    items: record.items.map((item) => ({
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPriceUSDC: usdcAtomicToDecimal(BigInt(item.unitPriceUSDCAtomic)),
      unitPriceUSDCAtomic: item.unitPriceUSDCAtomic,
    })),
    issuedAt: issuedAt.toISOString(),
    refundWindowEndsAt: new Date(issuedAt.getTime() + config.policies.refundWindowSeconds * 1000).toISOString(),
  };
}

/** A purchase whose money already moved: what either checkout door hands over to become an order. */
export interface PaidPurchase {
  quote: PurchaseQuote;
  body: CheckoutBody;
  idempotencyKey: string | null;
  settlement: SettlementRecord;
  /** The account or contract that paid, as the settlement or the signed transaction says. */
  payer: string;
  /** Set by the UCP checkout: the session the order belongs to. */
  ucpCheckoutId?: string;
  /** Set by the UCP checkout (T149): the buyer's own consent decisions, for a store whose adapter records them. */
  consent?: BuyerConsent;
}

/**
 * Turns a settled payment into an order: creates the platform order, signs
 * the receipt, persists the record and queues its anchor. Shared by the x402
 * checkout and the UCP checkout (T122), so both doors produce the same order
 * and the same receipt from the same code.
 *
 * One settlement is one order, and so one receipt: a settlement that already
 * produced an order returns that order, flagged `replayed`. That holds for
 * two requests at once too: the second waits for the first one's order
 * instead of racing it past the lookup (T132). Never throws for a platform
 * failure once money moved: the order is recorded as `paid_unfulfilled` (VT-10).
 */
export async function fulfilPaidPurchase(deps: CheckoutDeps, purchase: PaidPurchase): Promise<{ record: OrderRecord; replayed: boolean }> {
  const { txHash } = purchase.settlement;
  const duplicate = deps.orders.findBySettlementTx(txHash);
  if (duplicate !== undefined) {
    deps.log("settlement already fulfilled, returning existing order", { orderId: duplicate.orderId, txHash });
    return { record: await keepReplayed(deps, duplicate), replayed: true };
  }

  const inFlightKey = `${deps.config.signing.account}:${txHash}`;
  const running = ordersInFlight.get(inFlightKey);
  if (running !== undefined) {
    const record = await running;
    deps.log("settlement being fulfilled by another request, returning its order", { orderId: record.orderId, txHash });
    return { record: await keepReplayed(deps, record), replayed: true };
  }
  const created = createPaidOrder(deps, purchase);
  ordersInFlight.set(inFlightKey, created);
  try {
    return { record: await created, replayed: false };
  } finally {
    ordersInFlight.delete(inFlightKey);
  }
}

/**
 * Orders being created right now, by merchant signing account and settlement
 * hash. The store is only written once the platform order exists, so without
 * this a second request for the same settlement finds nothing and creates
 * another. Keyed by the merchant, not by its `OrderStore`: the platform builds
 * a new app and a new store when a merchant edits their shop, and a request
 * that lands on the new one must still see what the old one is doing.
 * In-process, which is enough while one process serves a merchant.
 */
const ordersInFlight = new Map<string, Promise<OrderRecord>>();

/**
 * An order handed back for a settlement that already has one. The earlier
 * attempt may have failed to persist it, and then never queued its anchor; or
 * it was created through another `OrderStore` of the same merchant, and this
 * one has not seen it. Writing it again is an upsert, and the queue skips a
 * receipt that is already anchored.
 */
async function keepReplayed(deps: CheckoutDeps, record: OrderRecord): Promise<OrderRecord> {
  await deps.orders.put(record);
  deps.anchors.enqueue(record.orderId);
  return record;
}

async function createPaidOrder(deps: CheckoutDeps, purchase: PaidPurchase): Promise<OrderRecord> {
  const { quote, body, idempotencyKey, settlement, payer } = purchase;
  const now = deps.now();
  const orderId = newOrderId(now);
  const buyer: Buyer = {
    stellarAccount: payer,
    ...(body.buyer.email === undefined ? {} : { email: body.buyer.email }),
    ...(body.buyer.shipping === undefined ? {} : { shipping: body.buyer.shipping }),
    // Kept on the record so a retried platform order carries it too. Never in the receipt or the public order.
    ...(purchase.consent === undefined || Object.keys(purchase.consent).length === 0 ? {} : { consent: purchase.consent }),
  };

  const record: OrderRecord = {
    orderId,
    status: "paid",
    createdAt: now.toISOString(),
    idempotencyKey,
    items: quote.lines.map((line) => ({
      productId: line.product.id,
      sku: line.product.sku,
      name: line.product.name,
      quantity: line.quantity,
      unitPriceUSDCAtomic: line.unitAtomic.toString(),
      unitPriceLocal: line.product.priceLocal,
    })),
    amountUSDCAtomic: settlement.amountAtomic,
    amountUSDC: usdcAtomicToDecimal(BigInt(settlement.amountAtomic)),
    totalLocal: quote.totalLocal,
    currency: quote.currency,
    buyer,
    settlement: {
      txHash: settlement.txHash,
      network: settlement.network,
      payer,
      payTo: settlement.payTo,
      asset: settlement.asset,
      amountAtomic: settlement.amountAtomic,
      explorerUrl: stellarExpertTxUrl(settlement.txHash),
      settledAt: settlement.settledAt,
    },
    platform: deps.adapter.name,
    platformOrderId: null,
    platformError: null,
    receipt: null,
    anchor: null,
    ...(purchase.ucpCheckoutId === undefined ? {} : { ucpCheckoutId: purchase.ucpCheckoutId }),
  };

  // Before the platform order exists: a settlement this store could not sign a
  // receipt for must not leave an order in the shop that nothing here records.
  const incoherence = receiptIncoherence(buildReceiptClaims(record, deps.config, now));
  if (incoherence !== null) {
    deps.log("settlement cannot back a receipt; no order created", { txHash: settlement.txHash, reason: incoherence });
    throw new VitrineeError("SettlementUnaccounted", `payment settled but it cannot back a receipt: ${incoherence}`, {
      details: { txHash: settlement.txHash },
    });
  }

  try {
    const platformOrder = await deps.adapter.createOrder({
      lines: quote.lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
      buyer,
      reference: orderId,
      paymentRef: {
        txHash: settlement.txHash,
        network: settlement.network,
        asset: settlement.asset,
        amountUSDCAtomic: settlement.amountAtomic,
        payerAccount: payer,
      },
    });
    record.platformOrderId = platformOrder.platformOrderId;
  } catch (error) {
    record.status = "paid_unfulfilled";
    record.platformError = error instanceof Error ? error.message : String(error);
    deps.log("platform order failed after settlement", { orderId, txHash: settlement.txHash, error: record.platformError });
  }

  record.receipt = signReceipt(buildReceiptClaims(record, deps.config, deps.now()), deps.config.signing.secret);
  record.anchor = { status: "pending", attempts: 0, registry: deps.config.receiptRegistryId };

  await deps.orders.put(record);
  deps.anchors.enqueue(orderId);
  deps.log("checkout completed", {
    orderId,
    status: record.status,
    platformOrderId: record.platformOrderId,
    txHash: settlement.txHash,
    amountUSDC: record.amountUSDC,
    receiptHash: record.receipt.hash,
  });
  return record;
}

/**
 * Runs after the facilitator settled the payment. Creates the platform
 * order, signs the receipt, queues its anchor, and answers with everything
 * the agent needs to prove the purchase. Never answers ≥ 400 once money
 * moved: a platform failure is recorded as `paid_unfulfilled` (VT-10).
 */
export function completeCheckout(deps: CheckoutDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const locals = res.locals["checkout"] as CheckoutLocals | undefined;
    if (locals === undefined) throw new VitrineeError("ConfigError", "checkout preflight did not run");
    const { quote, body, idempotencyKey } = locals;

    const paymentHeader = req.header("payment-signature") ?? req.header("x-payment");
    const key = paymentKeyFromHeader(paymentHeader);
    const settlement = key === undefined ? undefined : deps.ledger.take(key);
    if (settlement === undefined) {
      // Money moved (upfront flow) but we cannot see it: never charge again — fail loudly.
      throw new VitrineeError("SettlementUnaccounted", "payment settled but no settlement record was found for this request");
    }

    // One settlement, one order — whatever the facilitator or a replay says.
    const duplicate = deps.orders.findBySettlementTx(settlement.txHash);
    const payer = duplicate?.settlement.payer ?? settlement.payer ?? (key === undefined ? undefined : payerFromTransactionXdr(key)) ?? body.buyer.stellarAccount;
    if (payer === undefined) {
      throw new VitrineeError("SettlementUnaccounted", "payment settled but the payer account could not be determined", { details: { txHash: settlement.txHash } });
    }

    const { record, replayed } = await fulfilPaidPurchase(deps, { quote: purchaseQuote([quote]), body, idempotencyKey, settlement, payer });
    if (replayed) res.set("Idempotent-Replayed", "true");
    res.status(200).json(orderResponse(record));
  };
}

/**
 * Tries again to create the platform order for a sale that was paid and could
 * not be fulfilled (`VT-26`, T101). Money never moves here: the settlement is
 * already in the record, and everything sent to the platform comes from that
 * record, never from the caller.
 *
 * The receipt is left exactly as it was issued and anchored: it proves the
 * payment and the sale, and still says `platformOrderId: null`. Re-signing it
 * would change the hash that is already anchored on-chain. What changes is
 * the order record: `platformOrderId`, `status: "paid"`, and no error.
 *
 * Two callers at once cannot both create a platform order: the second is
 * refused while the first is in flight, and after it the status is no longer
 * `paid_unfulfilled`. A platform that refuses again leaves the order as it
 * was, with the newer reason, and answers `200` like the first attempt did.
 */
export async function fulfilOrder(deps: CheckoutDeps, orderId: string): Promise<OrderRecord> {
  const record = deps.orders.get(orderId);
  if (record === undefined) throw new VitrineeError("OrderNotFound", `no order with id "${orderId}"`, { details: { orderId } });
  if (record.status !== "paid_unfulfilled") {
    throw new VitrineeError("ValidationError", `order "${orderId}" is not waiting to be fulfilled`, {
      details: { orderId, status: record.status },
    });
  }
  const lock = `fulfil:${orderId}`;
  if (deps.inFlight.has(lock)) {
    throw new VitrineeError("ValidationError", `order "${orderId}" is being fulfilled right now`, { details: { orderId } });
  }
  deps.inFlight.add(lock);
  try {
    let platformOrderId: string | undefined;
    let failure: string | undefined;
    try {
      const platformOrder = await deps.adapter.createOrder({
        lines: record.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        buyer: record.buyer,
        reference: record.orderId,
        paymentRef: {
          txHash: record.settlement.txHash,
          network: record.settlement.network,
          asset: record.settlement.asset,
          amountUSDCAtomic: record.settlement.amountAtomic,
          payerAccount: record.settlement.payer,
        },
      });
      platformOrderId = platformOrder.platformOrderId;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const updated = await deps.orders.update(orderId, (order) => {
      if (platformOrderId !== undefined) {
        order.platformOrderId = platformOrderId;
        order.platformError = null;
        order.status = "paid";
      } else {
        order.platformError = failure ?? "unknown error";
      }
    });
    deps.log(platformOrderId === undefined ? "fulfilment retry failed" : "order fulfilled on retry", {
      orderId,
      platformOrderId: platformOrderId ?? null,
      error: failure ?? null,
    });
    return updated ?? record;
  } finally {
    deps.inFlight.delete(lock);
  }
}

/**
 * What `/orders/:id` and the checkout answer with. One shape, so the agent
 * needs one parser. `items` lists every line (T148); an order of one line
 * also keeps the `product` and `quantity` x402 clients read since day 1.
 */
export function orderResponse(record: OrderRecord): Record<string, unknown> {
  const [only] = record.items;
  return {
    orderId: record.orderId,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.items.length === 1 && only !== undefined ? { product: { id: only.productId, sku: only.sku, name: only.name }, quantity: only.quantity } : {}),
    items: record.items.map((item) => ({ productId: item.productId, sku: item.sku, name: item.name, quantity: item.quantity, unitPriceUSDCAtomic: item.unitPriceUSDCAtomic })),
    amountUSDC: record.amountUSDC,
    amountUSDCAtomic: record.amountUSDCAtomic,
    totalLocal: record.totalLocal,
    currency: record.currency,
    platform: record.platform,
    platformOrderId: record.platformOrderId,
    platformError: record.platformError,
    settlement: record.settlement,
    receipt: record.receipt === null ? null : { ...record.receipt, verifyPath: `/receipts/${record.receipt.hash}/verify` },
    anchor: record.anchor,
  };
}
