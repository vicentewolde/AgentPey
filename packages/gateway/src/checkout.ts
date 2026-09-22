import { randomBytes } from "node:crypto";

import type { Buyer, Product, StoreAdapter } from "@vitrinee/adapters";
import {
  STELLAR_TESTNET_CAIP2,
  USDC_TESTNET,
  VitrineeError,
  countryCodeSchema,
  currencyDecimals,
  formatUnits,
  localToUsdcAtomic,
  parseDecimal,
  signReceipt,
  stellarAccountSchema,
  stellarDid,
  stellarExpertTxUrl,
  timesQuantity,
  usdcAtomicToDecimal,
  type ReceiptClaims,
} from "@vitrinee/core";
import type { HTTPRequestContext, RoutesConfig } from "@x402/core/server";
import type { Price } from "@x402/core/types";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import type { AnchorWorker } from "./anchoring.js";
import type { GatewayConfig } from "./config.js";
import type { OrderRecord, OrderStore } from "./orders.js";
import { payerFromTransactionXdr } from "./payer.js";
import type { Reservations } from "./reservations.js";
import { paymentKeyFromHeader, type SettlementLedger } from "./settlements.js";

export const CHECKOUT_ROUTE = "POST /checkout/:productId";
export const RECEIPT_TYP = "vitrinee-receipt/0.1" as const;

export const checkoutBodySchema = z.object({
  quantity: z.int().positive().max(100).default(1),
  buyer: z
    .object({
      stellarAccount: stellarAccountSchema.optional(),
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

const idempotencyKeySchema = z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/, "printable ASCII, no spaces");

export interface CheckoutQuote {
  product: Product;
  quantity: number;
  unitAtomic: bigint;
  totalAtomic: bigint;
  totalLocal: string;
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
    const body = checkoutBodySchema.parse(req.body ?? {});
    const idempotencyKey = readIdempotencyKey(req);

    if (idempotencyKey !== null) {
      const existing = deps.orders.findByIdempotencyKey(idempotencyKey);
      if (existing !== undefined) {
        if (existing.product.id !== productId || existing.quantity !== body.quantity) {
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
    const body = checkoutBodySchema.parse(context.adapter.getBody?.() ?? {});
    const quote = await quoteCheckout(deps, productId, body);
    return { amount: quote.totalAtomic.toString(), asset: USDC_TESTNET.contractId };
  };
}

export function checkoutRoutes(deps: Pick<CheckoutDeps, "config" | "adapter">): RoutesConfig {
  const { config } = deps;
  return {
    [CHECKOUT_ROUTE]: {
      accepts: [
        {
          scheme: "exact",
          network: STELLAR_TESTNET_CAIP2,
          payTo: config.merchant.stellarAccount,
          price: checkoutPrice(deps),
          maxTimeoutSeconds: config.checkout.maxTimeoutSeconds,
          // Settle before the handler runs: the platform order is only ever
          // created for money that already moved (docs/DECISIONES.md, V-10).
          extra: { paymentFlow: "upfront" },
        },
      ],
      description: `Compra en ${config.merchant.name} — pago x402 en USDC sobre Stellar testnet`,
      mimeType: "application/json",
      unpaidResponseBody: async (context: HTTPRequestContext) => {
        const productId = productIdFromPath(context.path) ?? "";
        const body = checkoutBodySchema.parse(context.adapter.getBody?.() ?? {});
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
    items: [
      {
        productId: record.product.id,
        sku: record.product.sku,
        name: record.product.name,
        quantity: record.quantity,
        unitPriceUSDC: usdcAtomicToDecimal(BigInt(record.unitPriceUSDCAtomic)),
        unitPriceUSDCAtomic: record.unitPriceUSDCAtomic,
      },
    ],
    issuedAt: issuedAt.toISOString(),
    refundWindowEndsAt: new Date(issuedAt.getTime() + config.policies.refundWindowSeconds * 1000).toISOString(),
  };
}

/**
 * Runs after the facilitator settled the payment. Creates the platform
 * order, signs the receipt, queues its anchor, and answers with everything
 * the agent needs to prove the purchase. Never answers ≥ 400 once money
 * moved: a platform failure is recorded as `paid_unfulfilled` (V-10).
 */
export function completeCheckout(deps: CheckoutDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const locals = res.locals["checkout"] as CheckoutLocals | undefined;
    if (locals === undefined) throw new Error("checkout preflight did not run");
    const { quote, body, idempotencyKey } = locals;

    const paymentHeader = req.header("payment-signature") ?? req.header("x-payment");
    const key = paymentKeyFromHeader(paymentHeader);
    const settlement = key === undefined ? undefined : deps.ledger.take(key);
    if (settlement === undefined) {
      // Money moved (upfront flow) but we cannot see it: never charge again — fail loudly.
      throw new Error("payment settled but no settlement record was found for this request");
    }

    // One settlement, one order — whatever the facilitator or a replay says.
    const duplicate = deps.orders.findBySettlementTx(settlement.txHash);
    if (duplicate !== undefined) {
      deps.log("settlement already fulfilled, returning existing order", { orderId: duplicate.orderId, txHash: settlement.txHash });
      res.set("Idempotent-Replayed", "true");
      res.status(200).json(orderResponse(duplicate));
      return;
    }

    const payer = settlement.payer ?? (key === undefined ? undefined : payerFromTransactionXdr(key)) ?? body.buyer.stellarAccount;
    if (payer === undefined) throw new Error("payment settled but the payer account could not be determined");

    const now = deps.now();
    const orderId = newOrderId(now);
    const buyer: Buyer = {
      stellarAccount: payer,
      ...(body.buyer.email === undefined ? {} : { email: body.buyer.email }),
      ...(body.buyer.shipping === undefined ? {} : { shipping: body.buyer.shipping }),
    };

    const record: OrderRecord = {
      orderId,
      status: "paid",
      createdAt: now.toISOString(),
      idempotencyKey,
      product: { id: quote.product.id, sku: quote.product.sku, name: quote.product.name },
      quantity: quote.quantity,
      unitPriceUSDCAtomic: quote.unitAtomic.toString(),
      amountUSDCAtomic: settlement.amountAtomic,
      amountUSDC: usdcAtomicToDecimal(BigInt(settlement.amountAtomic)),
      totalLocal: quote.totalLocal,
      currency: quote.product.currency,
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
    };

    try {
      const platformOrder = await deps.adapter.createOrder({
        productId: quote.product.id,
        quantity: quote.quantity,
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
    res.status(200).json(orderResponse(record));
  };
}

/** What `/orders/:id` and the checkout answer with. One shape, so the agent needs one parser. */
export function orderResponse(record: OrderRecord): Record<string, unknown> {
  return {
    orderId: record.orderId,
    status: record.status,
    createdAt: record.createdAt,
    product: record.product,
    quantity: record.quantity,
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
