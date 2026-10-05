/**
 * The UCP checkout of a storefront (T122, E-1): sessions under
 * `/ucp/v1/checkout-sessions`, paid with the `com.agentpey.stellar_x402`
 * handler. The platform creates a session, reads the x402 payment
 * requirements from the handler's response config, signs for exactly those,
 * and sends the signed payload as the credential of `complete`. The payment
 * settles here, through the same facilitator as the x402 checkout, and only
 * then does an order exist: the one `fulfilPaidPurchase` creates for either door.
 *
 * What UCP does not see: HTTP 402. The x402 payload travels in the body.
 */
import {
  RECEIPT_EXTENSION,
  RECEIPT_EXTENSION_VERSION,
  STELLAR_TESTNET_CAIP2,
  STELLAR_X402_HANDLER,
  STELLAR_X402_HANDLER_ID,
  STELLAR_X402_HANDLER_VERSION,
  STELLAR_X402_INSTRUMENT_TYPE,
  UCP_AP2_MANDATE,
  UCP_CHECKOUT,
  UCP_FULFILLMENT,
  USDC_TESTNET,
  type UcpVersion,
  VitrineeError,
  isVitrineeError,
  toMinorUnits,
  usdcAtomicToDecimal,
} from "@vitrinee/core";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { Express, Request, Response } from "express";
import { z, ZodError } from "zod";

import type { Product } from "@vitrinee/adapters";

import { fulfilPaidPurchase, purchaseQuote, quoteCheckout, type CheckoutBody, type CheckoutDeps, type CheckoutQuote, type PurchaseQuote } from "../checkout.js";
import type { OrderRecord } from "../orders.js";
import { payerFromTransactionXdr } from "../payer.js";
import {
  MAX_CHECKOUT_LINES,
  SESSION_TTL_MS,
  newSessionId,
  storedRequirementsSchema,
  type CheckoutSession,
  type CheckoutSessionPersistence,
  type StoredRequirements,
  type UcpAddress,
} from "./sessions.js";
import { AgentPassError } from "@agentpass/core";
import { checkOpenCheckoutConstraints, jcsCanonicalize, signMerchantAuthorization, verifyCheckoutJwt, verifyCheckoutMandateChain } from "@agentpey/ap2";

import type { StoreAp2Key } from "./ap2.js";
import { isDeliverableUrl, type OrderEvents } from "./order-events.js";
import type { PlatformP256Key } from "./platform-profile.js";
import { IdempotencyCache, requestHash } from "./idempotency.js";
import { ucpPlatformOf, ucpVersionOf } from "./negotiation.js";
import { stellarX402Config } from "./profile.js";


/** The business names each line by its position (T148): `li_1`, `li_2`, … */
const lineItemId = (index: number): string => `li_${index + 1}`;
const METHOD_ID = "fm_1";
const GROUP_ID = "fg_1";
const OPTION_ID = "store_shipping";
/** The one shipping option: the store arranges delivery outside the purchase. The order's expectation carries the same words. */
export const SHIPPING_OPTION_TITLE = "Envío coordinado por la tienda";

export interface UcpCheckoutDeps extends CheckoutDeps {
  sessions: CheckoutSessionPersistence;
  /** The storefront's P-256 key for AP2 (VT-43): signs every checkout response when AP2 is negotiated. */
  ap2Key: StoreAp2Key;
  /** Order events and webhooks (T147): a completed checkout hands its order the platform's webhook URL. */
  orderEvents: OrderEvents;
  x402: x402ResourceServer;
  /** Resolves once the resource server has read the facilitator's capabilities. */
  ready: () => Promise<void>;
}

// ---------------------------------------------------------------- requests

const passthrough = { context: z.unknown().optional(), signals: z.unknown().optional(), attribution: z.unknown().optional() };

const addressInput = z.object({
  id: z.string().max(100).optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  street_address: z.string().max(300).optional(),
  extended_address: z.string().max(300).optional(),
  address_locality: z.string().max(100).optional(),
  address_region: z.string().max(100).optional(),
  address_country: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, upper case").optional(),
  postal_code: z.string().max(20).optional(),
  phone_number: z.string().max(40).optional(),
});

const sessionInput = z.looseObject({
  line_items: z
    .array(z.looseObject({ id: z.string().optional(), item: z.looseObject({ id: z.string().min(1).max(200) }), quantity: z.int().min(1).max(100) }))
    .min(1)
    .max(MAX_CHECKOUT_LINES, `this store takes at most ${MAX_CHECKOUT_LINES} line items per checkout`),
  buyer: z
    .looseObject({
      first_name: z.string().max(100).optional(),
      last_name: z.string().max(100).optional(),
      email: z.email().max(200).optional(),
      phone_number: z.string().max(40).optional(),
    })
    .optional(),
  fulfillment: z
    .looseObject({
      methods: z.array(z.looseObject({ type: z.enum(["shipping", "pickup"]).optional(), destinations: z.array(addressInput).max(1).optional() })).max(1).optional(),
    })
    .optional(),
  payment: z.unknown().optional(),
  ...passthrough,
});
type SessionInput = z.infer<typeof sessionInput>;

/** The handler's credential: an x402 PaymentPayload with the version spelled the UCP way. */
export const stellarX402CredentialSchema = z.object({
  type: z.literal("x402_payment_payload"),
  x402_version: z.literal(2),
  accepted: storedRequirementsSchema,
  payload: z.object({ transaction: z.string().min(1).max(20_000) }),
});

const completeInput = z.looseObject({
  payment: z.object({
    instruments: z
      .array(
        z.looseObject({
          id: z.string().min(1).max(200),
          handler_id: z.string(),
          type: z.string(),
          selected: z.boolean().optional(),
          credential: z.unknown(),
        }),
      )
      .min(1)
      .max(10),
  }),
  /** UCP's AP2 extension (T134): the closed checkout mandate. Its size is checked where it is verified, to answer with UCP's code. */
  ap2: z.looseObject({ checkout_mandate: z.string().optional() }).optional(),
  ...passthrough,
});

const idempotencyKeySchema = z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/);

// ---------------------------------------------------------------- messages

type Severity = "recoverable" | "requires_buyer_input" | "requires_buyer_review" | "unrecoverable";
interface UcpMessage {
  type: "error";
  code: string;
  content: string;
  severity: Severity;
  path?: string;
}

const message = (code: string, content: string, severity: Severity, path?: string): UcpMessage => ({
  type: "error",
  code,
  content,
  severity,
  ...(path === undefined ? {} : { path }),
});

/** A UCP error response: the request had no resource to act on. */
function sendError(res: Response, status: number, code: string, content: string, severity: Severity = "unrecoverable"): void {
  res.status(status).json({ ucp: { version: ucpVersionOf(res), status: "error" }, messages: [message(code, content, severity)] });
}

// ---------------------------------------------------------------- quoting

interface Evaluation {
  quote: PurchaseQuote | null;
  messages: UcpMessage[];
}

function bodyFor(session: CheckoutSession): CheckoutBody {
  const d = session.destination;
  const name = [session.buyer.first_name ?? d?.first_name, session.buyer.last_name ?? d?.last_name].filter((part) => part !== undefined && part !== "").join(" ");
  const address = [d?.street_address, d?.extended_address].filter((part) => part !== undefined && part !== "").join(", ");
  return {
    // Each line is quoted with its own quantity; the body carries only who buys and where it goes.
    quantity: 1,
    buyer: {
      ...(session.buyer.email === undefined ? {} : { email: session.buyer.email }),
      ...(d === null
        ? {}
        : {
            shipping: {
              country: d.address_country ?? "CL",
              ...(name === "" ? {} : { name }),
              ...(address === "" ? {} : { address }),
              ...(d.address_locality === undefined ? {} : { city: d.address_locality }),
              ...(d.address_region === undefined ? {} : { region: d.address_region }),
              ...(d.postal_code === undefined ? {} : { notes: `CP ${d.postal_code}` }),
            },
          }),
    },
  };
}

/** Quotes the session and says what, if anything, stands between it and `complete`. Never charges. */
async function evaluate(deps: UcpCheckoutDeps, session: CheckoutSession): Promise<Evaluation> {
  // Each line is priced on its own (one rounding per unit, VT-7). A product in two lines is checked
  // against its stock for both: the earlier lines' units count as held when the later one is quoted.
  const body = bodyFor(session);
  const lines: CheckoutQuote[] = [];
  const unavailable: UcpMessage[] = [];
  const asked = new Map<string, number>();
  for (const [index, line] of session.lines.entries()) {
    const earlier = asked.get(line.productId) ?? 0;
    asked.set(line.productId, earlier + line.quantity);
    try {
      lines.push(await quoteCheckout(deps, line.productId, { ...body, quantity: line.quantity }, deps.reservations.reserved(line.productId) + earlier));
    } catch (error) {
      if (!(isVitrineeError(error) && error.code === "OutOfStock")) throw error;
      unavailable.push(message("out_of_stock", error.message, "recoverable", `$.line_items[${index}]`));
    }
  }
  if (unavailable.length > 0) return { quote: null, messages: unavailable };
  const quote = purchaseQuote(lines);
  const messages: UcpMessage[] = [];
  const d = session.destination;
  if (d === null || d.street_address === undefined || d.address_locality === undefined || d.address_country === undefined) {
    messages.push(message("missing", "a shipping destination with street_address, address_locality and address_country is required", "recoverable", "$.fulfillment"));
  } else if (!deps.config.policies.shippingCountries.includes(d.address_country)) {
    messages.push(message("address_undeliverable", `this store ships to ${deps.config.policies.shippingCountries.join(", ")}`, "recoverable", "$.fulfillment"));
  }
  return { quote, messages };
}

async function requirementsFor(deps: UcpCheckoutDeps, quote: PurchaseQuote): Promise<StoredRequirements> {
  await deps.ready();
  const [requirements] = await deps.x402.buildPaymentRequirements({
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    payTo: deps.config.merchant.stellarAccount,
    price: { amount: quote.totalAtomic.toString(), asset: USDC_TESTNET.contractId },
    maxTimeoutSeconds: deps.config.checkout.maxTimeoutSeconds,
    // Settle before the order exists, as the x402 checkout does (VT-10).
    extra: { paymentFlow: "upfront" },
  });
  if (requirements === undefined) throw new VitrineeError("PaymentError", "the facilitator offers no way to pay on stellar:testnet", { details: {} });
  return storedRequirementsSchema.parse(requirements);
}

/** Re-quotes a session and sets its status, quote and requirements accordingly. */
async function refresh(deps: UcpCheckoutDeps, session: CheckoutSession): Promise<UcpMessage[]> {
  const { quote, messages } = await evaluate(deps, session);
  if (quote === null || messages.length > 0) {
    session.status = "incomplete";
    session.requirements = null;
    if (quote !== null) session.quote = snapshot(deps, quote);
    return messages;
  }
  const current = session.quote;
  const fresh = snapshot(deps, quote);
  const sameTotal = current !== null && session.requirements !== null && current.totalAtomic === fresh.totalAtomic;
  // Same lines at the same prices: the snapshot stays as it was (its fx `as_of` too). Other lines, even at the same
  // total, are another purchase: the order is made from this snapshot once paid, so it must say what is bought now.
  session.quote = sameTotal && sameQuotedLines(current, fresh) ? current : fresh;
  // Same total, same requirements: a platform that already signed keeps a valid credential.
  if (!sameTotal) session.requirements = await requirementsFor(deps, quote);
  session.status = "ready_for_complete";
  return [];
}

function snapshot(deps: UcpCheckoutDeps, quote: PurchaseQuote): NonNullable<CheckoutSession["quote"]> {
  return {
    lines: quote.lines.map((line) => ({
      unitAtomic: line.unitAtomic.toString(),
      totalAtomic: line.totalAtomic.toString(),
      unitLocal: line.product.priceLocal,
      totalLocal: line.totalLocal,
      productSku: line.product.sku,
      productName: line.product.name,
    })),
    totalAtomic: quote.totalAtomic.toString(),
    totalLocal: quote.totalLocal,
    currency: quote.currency,
    fx: { base: "USD", quote: deps.config.fx.quote, rate: deps.config.fx.rate, asOf: deps.now().toISOString() },
  };
}

/** Whether two snapshots quote the same lines, line by line, at the same prices. */
function sameQuotedLines(a: CheckoutSession["quote"], b: NonNullable<CheckoutSession["quote"]>): boolean {
  if (a === null || a.lines.length !== b.lines.length || a.currency !== b.currency) return false;
  return a.lines.every((line, i) => {
    const other = b.lines[i]!;
    return line.unitAtomic === other.unitAtomic && line.totalAtomic === other.totalAtomic && line.totalLocal === other.totalLocal && line.productSku === other.productSku && line.productName === other.productName;
  });
}

// ---------------------------------------------------------------- responses

interface RenderedLine {
  id: string;
  product: { id: string; title: string; unitMinor: number; image?: string };
  quantity: number;
  totalMinor: number;
}

interface Rendered {
  lines: RenderedLine[];
  totalMinor: number;
}

async function render(deps: UcpCheckoutDeps, session: CheckoutSession): Promise<Rendered> {
  const quoted = session.quote;
  const lines: RenderedLine[] = [];
  for (const [index, line] of session.lines.entries()) {
    const product = await deps.adapter.getProduct(line.productId);
    const currency = product?.currency ?? deps.config.merchant.currency;
    const unitMinor = product === null ? 0 : toMinorUnits(product.priceLocal, currency);
    const image = product?.images.find((url) => URL.canParse(url));
    // A quoted line shows what it will charge; an unquoted one (out of stock, say) the catalogue's price.
    const atQuote = quoted?.lines[index];
    lines.push({
      id: lineItemId(index),
      product: { id: line.productId, title: product?.name ?? line.productId, unitMinor, ...(image === undefined ? {} : { image }) },
      quantity: line.quantity,
      totalMinor: atQuote === undefined || quoted === null ? unitMinor * line.quantity : toMinorUnits(atQuote.totalLocal, quoted.currency),
    });
  }
  return {
    lines,
    totalMinor: quoted === null ? lines.reduce((sum, line) => sum + line.totalMinor, 0) : toMinorUnits(quoted.totalLocal, quoted.currency),
  };
}

function totals(subtotal: number) {
  return [
    { type: "subtotal", display_text: "Subtotal", amount: subtotal },
    // Shipping is arranged and charged by the store itself, outside this purchase.
    { type: "fulfillment", display_text: SHIPPING_OPTION_TITLE, amount: 0 },
    { type: "total", display_text: "Total", amount: subtotal },
  ];
}

export function receiptExtension(record: OrderRecord, origin: string) {
  if (record.receipt === null || record.anchor === null) return undefined;
  return {
    format: "jws",
    jws: record.receipt.jws,
    hash: record.receipt.hash,
    network: record.settlement.network,
    settlement_tx_hash: record.settlement.txHash,
    anchor: {
      status: record.anchor.status,
      registry: record.anchor.registry,
      ...(record.anchor.txHash === undefined ? {} : { tx_hash: record.anchor.txHash }),
      ...(record.anchor.ledger === undefined ? {} : { ledger: record.anchor.ledger }),
      ...(record.anchor.anchoredAt === undefined ? {} : { anchored_at: record.anchor.anchoredAt }),
    },
    verify_url: `${origin}/receipts/${record.receipt.hash}/verify`,
  };
}

function handlerFor(deps: UcpCheckoutDeps, session: CheckoutSession) {
  const business = stellarX402Config(deps.config);
  const config =
    session.requirements === null || session.quote === null
      ? business
      : {
          ...business,
          payment_requirements: session.requirements,
          fx: { base: session.quote.fx.base, quote: session.quote.fx.quote, rate: session.quote.fx.rate, as_of: session.quote.fx.asOf },
          binding: { checkout_id: session.id },
        };
  return { id: STELLAR_X402_HANDLER_ID, version: STELLAR_X402_HANDLER_VERSION, config };
}

/** Who a response is for: the origin its links use, and the UCP version it is shaped in (T133). */
interface View {
  origin: string;
  version: UcpVersion;
  /** The platform profile this request was negotiated from, when it was read (T134): its URL, whether it declares AP2, its P-256 keys. */
  platform: { url: string; ap2: boolean; keys: ReadonlyArray<PlatformP256Key>; orderWebhookUrl?: string } | null;
}

/** AP2 is negotiated on this request (T134, R-15): 2026-08-25, and the platform's profile declares the extension. */
function ap2Negotiated(view: View): view is View & { platform: NonNullable<View["platform"]> } {
  return view.version === "2026-08-25" && view.platform !== null && view.platform.ap2;
}

/** Whether a response for this session is signed: the session is AP2-locked and the response is shaped in 2026-08-25. */
function signs(session: CheckoutSession, view: View): boolean {
  return session.ap2 !== null && view.version === "2026-08-25";
}

/** The checkout as an AP2-locked business answers it: named by its origin (R-15), with the extension declared. Unsigned. */
function ap2Named(deps: UcpCheckoutDeps, body: ReturnType<typeof checkoutBody>, view: View) {
  return {
    ...body,
    ucp: { ...body.ucp, capabilities: { ...body.ucp.capabilities, [UCP_AP2_MANDATE]: [{ version: view.version }] } },
    merchant: { id: view.origin, name: deps.config.merchant.name, website: view.origin },
  };
}

async function checkoutResponse(deps: UcpCheckoutDeps, session: CheckoutSession, view: View, messages: UcpMessage[] = []) {
  const body = checkoutBody(deps, session, view, messages, await render(deps, session));
  if (!signs(session, view)) return body;
  // Security locked: the business signs the whole response but `ap2` (UCP, JCS), whatever this request negotiated.
  const named = ap2Named(deps, body, view);
  return { ...named, ap2: { merchant_authorization: await signMerchantAuthorization(named, deps.ap2Key.signer) } };
}

function checkoutBody(deps: UcpCheckoutDeps, session: CheckoutSession, { origin, version }: View, messages: UcpMessage[], rendered: Rendered) {
  const { lines, totalMinor } = rendered;
  const lineIds = lines.map((line) => line.id);
  const order = session.orderId === null ? undefined : deps.orders.get(session.orderId);
  const receipt = order === undefined ? undefined : receiptExtension(order, origin);
  const d = session.destination;
  const buyer = Object.fromEntries(Object.entries(session.buyer).filter(([, value]) => value !== undefined));
  return {
    ucp: {
      version,
      status: "success",
      capabilities: {
        [UCP_CHECKOUT]: [{ version }],
        [UCP_FULFILLMENT]: [{ version }],
        [RECEIPT_EXTENSION]: [{ version: RECEIPT_EXTENSION_VERSION }],
      },
      payment_handlers: { [STELLAR_X402_HANDLER]: [handlerFor(deps, session)] },
    },
    id: session.id,
    status: session.status,
    currency: session.quote?.currency ?? deps.config.merchant.currency,
    line_items: lines.map(({ id, product, quantity, totalMinor: lineMinor }) => ({
      id,
      item: { id: product.id, title: product.title, price: product.unitMinor, ...(product.image === undefined ? {} : { image_url: product.image }) },
      quantity,
      totals: [
        { type: "subtotal", amount: lineMinor },
        { type: "total", amount: lineMinor },
      ],
    })),
    ...(Object.keys(buyer).length === 0 ? {} : { buyer }),
    fulfillment: {
      methods: [
        {
          id: METHOD_ID,
          type: "shipping",
          line_item_ids: lineIds,
          // 2026-08-25 names each destination's kind (T133); 2026-04-08 has no such field.
          destinations: d === null ? [] : [version === "2026-04-08" ? d : { type: "shipping_address", ...d }],
          selected_destination_id: d?.id ?? null,
          groups: [
            {
              id: GROUP_ID,
              // One group for every line (UCP: a business consolidates all items into a single group per method).
              line_item_ids: lineIds,
              options: [{ id: OPTION_ID, title: SHIPPING_OPTION_TITLE, totals: [{ type: "fulfillment", amount: 0 }] }],
              selected_option_id: OPTION_ID,
            },
          ],
        },
      ],
    },
    // Never echoes an instrument back: what a platform pays with stays in the request it came in.
    payment: { instruments: [] },
    totals: totals(totalMinor),
    messages,
    links: [],
    expires_at: session.expiresAt,
    ...(order === undefined ? {} : { order: { id: order.orderId, label: order.platformOrderId ?? order.orderId, permalink_url: permalinkFor(order, origin) } }),
    ...(receipt === undefined ? {} : { receipt }),
  };
}

function permalinkFor(record: OrderRecord, origin: string): string {
  return record.receipt === null ? `${origin}/orders/${record.orderId}` : `${origin}/receipts/${record.receipt.hash}`;
}

// ---------------------------------------------------------------- session state

function applyInput(session: CheckoutSession, input: SessionInput): void {
  // Every line, in the platform's order (T148); the same product in two lines stays two lines.
  session.lines = input.line_items.map((line) => ({ productId: line.item.id, quantity: line.quantity }));
  session.buyer = {
    ...(input.buyer?.first_name === undefined ? {} : { first_name: input.buyer.first_name }),
    ...(input.buyer?.last_name === undefined ? {} : { last_name: input.buyer.last_name }),
    ...(input.buyer?.email === undefined ? {} : { email: input.buyer.email }),
    ...(input.buyer?.phone_number === undefined ? {} : { phone_number: input.buyer.phone_number }),
  };
  const method = input.fulfillment?.methods?.[0];
  if (method?.type === "pickup") {
    throw new VitrineeError("ValidationError", "this store only ships; pickup is not offered", { details: {} });
  }
  const destination = method?.destinations?.[0];
  if (destination !== undefined) {
    const { id, ...address } = destination;
    session.destination = { id: id ?? "dest_1", ...(address satisfies UcpAddress) };
  } else if (input.fulfillment !== undefined) {
    session.destination = null;
  }
}

async function loadSession(deps: UcpCheckoutDeps, id: string): Promise<CheckoutSession | undefined> {
  if (!/^cs_[0-9a-z]{1,64}$/.test(id)) return undefined;
  const session = await deps.sessions.get(id);
  if (session === undefined) return undefined;
  const live = session.status === "incomplete" || session.status === "ready_for_complete";
  if (live && Date.parse(session.expiresAt) <= deps.now().getTime()) {
    session.status = "canceled";
    session.updatedAt = deps.now().toISOString();
    await deps.sessions.save(session);
  }
  return session;
}

// ---------------------------------------------------------------- settlement

function sameRequirements(a: StoredRequirements, b: StoredRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.amount === b.amount &&
    a.payTo === b.payTo &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds
  );
}

function failureSeverity(reason: string | undefined): Severity {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("insufficient") || r.includes("trustline") || r.includes("balance")) return "requires_buyer_input";
  if (r.includes("auth") || r.includes("contract") || r.includes("limit")) return "requires_buyer_review";
  return "recoverable";
}

type SettleOutcome =
  | { kind: "settled"; response: SettleResponse }
  /** The facilitator answered no, and nothing was broadcast: safe to sign again. */
  | { kind: "refused"; reason: string }
  /** Nobody knows whether money moved. The checkout must not be settled again. */
  | { kind: "unknown"; reason: string; transaction: string | null };

async function settle(deps: UcpCheckoutDeps, requirements: StoredRequirements, transaction: string): Promise<SettleOutcome> {
  const payload: PaymentPayload = { x402Version: 2, accepted: requirements as PaymentRequirements, payload: { transaction } };
  let response: SettleResponse;
  try {
    response = await deps.x402.settlePayment(payload, requirements as PaymentRequirements);
  } catch (error) {
    const answered = (error as { response?: Partial<SettleResponse> } | undefined)?.response;
    const reason = answered?.errorReason ?? (error instanceof Error ? error.message : String(error));
    // An explicit refusal with no transaction broadcast is a definite "no"; anything else
    // (a timeout, a dropped connection, an answer we cannot read) may have paid.
    if (answered !== undefined && answered.success === false && (answered.transaction ?? "") === "") return { kind: "refused", reason };
    return { kind: "unknown", reason, transaction: answered?.transaction === undefined || answered.transaction === "" ? null : answered.transaction };
  }
  if (response.success) return { kind: "settled", response };
  const reason = response.errorReason ?? "unknown reason";
  return response.transaction === "" ? { kind: "refused", reason } : { kind: "unknown", reason, transaction: response.transaction };
}

// ---------------------------------------------------------------- AP2 (T134)

/** UCP's AP2 error code for each way a mandate can fail (`payment_ap2_mandate.json`). */
function ap2Code(error: AgentPassError): string {
  switch (error.code) {
    case "Ap2MandateExpired":
    case "Ap2MandateNotYetValid":
      return "mandate_expired";
    case "Ap2ScopeMismatch":
    case "Ap2ConstraintUnsupported":
      return "mandate_scope_mismatch";
    case "Ap2MerchantAuthorizationInvalid":
      return "merchant_authorization_invalid";
    // A platform with keys, none of them the one named, or a mandate signed in another platform's name: the
    // mandate does not verify. (A platform with no key at all is `agent_missing_key`, answered before verifying.)
    case "Ap2KeyNotFound":
    case "Ap2IssuerMismatch":
    default:
      return "mandate_invalid_signature";
  }
}

const MAX_MANDATE_LENGTH = 32_000;

/** What a closed mandate must agree with: every member of the checkout that says what is bought, from whom, for how much, and where it goes. */
function termsOf(checkout: Readonly<Record<string, unknown>>): string {
  const ucp = checkout.ucp as { payment_handlers?: unknown } | undefined;
  return jcsCanonicalize({
    id: checkout.id,
    merchant: checkout.merchant,
    currency: checkout.currency,
    line_items: checkout.line_items,
    buyer: checkout.buyer,
    fulfillment: checkout.fulfillment,
    totals: checkout.totals,
    payment_handlers: ucp?.payment_handlers,
  });
}

type Ap2Outcome = { ok: true; mandate: string } | { ok: false; refusal: UcpMessage };

/**
 * The checks UCP's AP2 extension asks of a business before it charges an
 * AP2-locked checkout: a mandate is there; it comes from the platform profile
 * the checkout was opened with; that platform signed the open mandate, in its
 * own name (`iss` is its profile's origin), with a key its profile publishes;
 * the agent's hop is bound to it, to this business (`aud`) and to this
 * checkout (`nonce`); the checkout inside carries this business's own
 * signature; what it signed is what this session would charge and ship now;
 * and the open mandate's constraints hold. A failure of the store itself
 * (the catalog, the adapter) is not a bad mandate: it propagates.
 */
async function checkAp2Mandate(deps: UcpCheckoutDeps, session: CheckoutSession, lock: NonNullable<CheckoutSession["ap2"]>, view: View, input: z.infer<typeof completeInput>): Promise<Ap2Outcome> {
  const refuse = (code: string, text: string): Ap2Outcome => ({ ok: false, refusal: message(code, text, "recoverable", "$.ap2.checkout_mandate") });
  const mandate = input.ap2?.checkout_mandate;
  if (mandate === undefined || mandate === "") return refuse("mandate_required", "this checkout is AP2-locked: complete needs ap2.checkout_mandate");
  if (mandate.length > MAX_MANDATE_LENGTH) return refuse("mandate_invalid_signature", "the checkout mandate is too large");
  if (view.platform === null) return refuse("agent_missing_key", "the platform's profile could not be read, so there is no key to verify its mandate with");
  if (view.platform.url !== lock.platformProfile) return refuse("mandate_invalid_signature", "this checkout was opened by another platform profile; only that platform's mandate completes it");
  const keys = view.platform.keys;
  if (keys.length === 0) return refuse("agent_missing_key", "the platform's profile publishes no P-256 key to verify its mandate with");

  // Outside the try: the store failing to price the checkout is not the mandate's fault.
  const current = ap2Named(deps, checkoutBody(deps, session, view, [], await render(deps, session)), view);
  try {
    const verified = await verifyCheckoutMandateChain(mandate, {
      platformKey: (kid) => keys.find((key) => key.kid === kid) ?? (kid === undefined && keys.length === 1 ? keys[0] : undefined),
      issuer: new URL(lock.platformProfile).origin,
      aud: view.origin,
      nonce: session.id,
      now: deps.now(),
    });
    // The checkout it closes over: signed by this business, and the terms this session would charge and ship right now.
    const signed = await verifyCheckoutJwt(verified.checkoutJwt, deps.ap2Key.publicJwk);
    if (termsOf(signed) !== termsOf(current)) return refuse("mandate_scope_mismatch", "the checkout mandate is for other terms than this checkout's");
    checkOpenCheckoutConstraints(verified.open, signed, view.origin);
    return { ok: true, mandate };
  } catch (error) {
    if (!(error instanceof AgentPassError)) throw error;
    const code = ap2Code(error);
    deps.log("ap2 mandate refused", { checkoutId: session.id, code, reason: error.message });
    return refuse(code, error.message);
  }
}

// ---------------------------------------------------------------- routes

function readIdempotencyKey(req: Request): string | null {
  const raw = req.header("idempotency-key");
  if (raw === undefined) return null;
  const parsed = idempotencyKeySchema.safeParse(raw.trim());
  if (!parsed.success) throw new VitrineeError("ValidationError", "Idempotency-Key must be 1–255 printable ASCII characters", { details: {} });
  return parsed.data;
}

/** Wraps a UCP handler so every failure answers as a UCP error response, never as the gateway's own shape. */
function ucpRoute(deps: UcpCheckoutDeps, handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    res.set("Cache-Control", "no-store");
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof ZodError) {
        sendError(res, 400, "invalid_request", error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; "), "recoverable");
        return;
      }
      if (isVitrineeError(error)) {
        if (error.code === "ProductNotFound") return sendError(res, 400, "item_unavailable", `product not found: ${error.message}`, "recoverable");
        if (error.code === "ValidationError") return sendError(res, 400, "invalid_request", error.message, "recoverable");
        if (error.httpStatus >= 500) deps.log("ucp request failed", { code: error.code, message: error.message });
        return sendError(res, error.httpStatus, error.code === "NetworkError" ? "unavailable" : "internal_error", error.message, "recoverable");
      }
      deps.log("ucp request failed", { error: error instanceof Error ? error.message : String(error) });
      sendError(res, 500, "internal_error", "unexpected failure", "recoverable");
    }
  };
}

/**
 * One writer per session at a time: `complete`, `PUT` and `cancel` all take
 * this lock, so a change can never land between a settlement and its order.
 */
async function withSessionLock(deps: UcpCheckoutDeps, id: string, res: Response, work: () => Promise<void>): Promise<void> {
  const lock = `ucp:${id}`;
  if (deps.inFlight.has(lock)) return sendError(res, 409, "invalid_state", "this checkout is being changed or completed right now", "recoverable");
  deps.inFlight.add(lock);
  try {
    await work();
  } finally {
    deps.inFlight.delete(lock);
  }
}

/** The platform's profile URL in `UCP-Agent`, so one platform's key never answers another's request. */
function agentProfile(req: Request): string {
  return /(?:^|[;,\s])profile="([^"]*)"/.exec(req.get("ucp-agent") ?? "")?.[1] ?? "";
}

/** A `complete` answer worth replaying: a finished checkout, or an error that will not change. Anything recoverable is retried for real. */
export function keepCompleteAnswer(status: number, body: unknown): boolean {
  if (status >= 400) return true;
  return (body as { status?: unknown } | null)?.status === "completed";
}

/**
 * Runs a write under its `Idempotency-Key` (T131): a repeat with the same key and
 * the same request gets the first answer back; the same key with another request
 * gets 409 and changes nothing. No key, no memory. A 409 or a 5xx is not kept:
 * running that request again is the right answer to a retry. Nor is anything
 * `keep` turns down. The key is scoped to the platform that sent it.
 */
async function idempotent(
  cache: IdempotencyCache,
  req: Request,
  res: Response,
  run: () => Promise<void>,
  keep: (status: number, body: unknown) => boolean = () => true,
): Promise<void> {
  const key = readIdempotencyKey(req);
  if (key === null) return run();
  const path = req.originalUrl.split("?")[0] ?? "";
  // The version is part of the scope: a replay never answers in a version the request did not negotiate.
  const scope = `${agentProfile(req)} ${ucpVersionOf(res)} ${req.method} ${path} ${key}`;
  const hash = requestHash(req.method, path, req.body);
  const found = cache.lookup(scope, hash);
  if (found.kind === "replay") {
    res.status(found.status).json(found.body);
    return;
  }
  if (found.kind === "conflict") return sendError(res, 409, "idempotency_conflict", "this Idempotency-Key was already used with a different request");
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode < 500 && res.statusCode !== 409 && keep(res.statusCode, body)) cache.remember(scope, hash, res.statusCode, body);
    return send(body);
  }) as Response["json"];
  await run();
}

export function registerUcpCheckout(app: Express, prefix: string, deps: UcpCheckoutDeps, originOf: (req: Request) => string): void {
  const viewOf = (req: Request, res: Response): View => {
    const platform = ucpPlatformOf(res);
    return {
      origin: originOf(req),
      version: ucpVersionOf(res),
      platform:
        platform === undefined
          ? null
          : {
              url: platform.url,
              ap2: platform.profile.ucp.capabilities.includes(UCP_AP2_MANDATE),
              keys: platform.profile.keys,
              ...(platform.profile.orderWebhookUrl === undefined ? {} : { orderWebhookUrl: platform.profile.orderWebhookUrl }),
            },
    };
  };
  const idempotency = new IdempotencyCache(deps.now);
  const notFound = (res: Response, id: string) => sendError(res, 404, "not_found", `no checkout session "${id}"`);

  app.post(
    `${prefix}/checkout-sessions`,
    ucpRoute(deps, (req, res) => idempotent(idempotency, req, res, async () => {
      const input = sessionInput.parse(req.body ?? {});
      const now = deps.now();
      const session: CheckoutSession = {
        id: newSessionId(now),
        status: "incomplete",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        lines: [],
        buyer: {},
        destination: null,
        quote: null,
        requirements: null,
        paymentKey: null,
        completeIdempotencyKey: null,
        orderId: null,
        settlement: null,
        settleAttempt: null,
        ap2: null,
        webhook: null,
      };
      const view = viewOf(req, res);
      // AP2 is negotiated once, when the checkout is created, and locks it for good (T134, R-15): no later request,
      // whatever profile or version it presents, completes it without a mandate from this platform.
      if (ap2Negotiated(view)) session.ap2 = { platformProfile: view.platform.url, mandate: null };
      applyInput(session, input);
      const messages = await refresh(deps, session);
      await deps.sessions.save(session);
      res.status(201).json(await checkoutResponse(deps, session, view, messages));
    })),
  );

  app.get(
    `${prefix}/checkout-sessions/:id`,
    ucpRoute(deps, async (req, res) => {
      const id = String(req.params["id"]);
      const session = await loadSession(deps, id);
      if (session === undefined) return notFound(res, id);
      res.json(await checkoutResponse(deps, session, viewOf(req, res)));
    }),
  );

  app.put(
    `${prefix}/checkout-sessions/:id`,
    ucpRoute(deps, (req, res) => idempotent(idempotency, req, res, async () => {
      const id = String(req.params["id"]);
      const input = sessionInput.parse(req.body ?? {});
      await withSessionLock(deps, id, res, async () => {
        const session = await loadSession(deps, id);
        if (session === undefined) return notFound(res, id);
        if (session.status !== "incomplete" && session.status !== "ready_for_complete") {
          return sendError(res, 409, "invalid_state", `checkout is ${session.status} and can no longer change`);
        }
        applyInput(session, input);
        const messages = await refresh(deps, session);
        session.updatedAt = deps.now().toISOString();
        await deps.sessions.save(session);
        res.json(await checkoutResponse(deps, session, viewOf(req, res), messages));
      });
    })),
  );

  app.post(
    `${prefix}/checkout-sessions/:id/cancel`,
    ucpRoute(deps, (req, res) => idempotent(idempotency, req, res, async () => {
      const id = String(req.params["id"]);
      await withSessionLock(deps, id, res, async () => {
        const session = await loadSession(deps, id);
        if (session === undefined) return notFound(res, id);
        if (session.status === "completed" || session.status === "complete_in_progress") {
          return sendError(res, 409, "invalid_state", `checkout is ${session.status} and cannot be canceled`);
        }
        session.status = "canceled";
        session.updatedAt = deps.now().toISOString();
        await deps.sessions.save(session);
        res.json(await checkoutResponse(deps, session, viewOf(req, res)));
      });
    })),
  );

  app.post(
    `${prefix}/checkout-sessions/:id/complete`,
    ucpRoute(deps, (req, res) => idempotent(idempotency, req, res, async () => {
      const id = String(req.params["id"]);
      const idempotencyKey = readIdempotencyKey(req);
      const input = completeInput.parse(req.body ?? {});
      await withSessionLock(deps, id, res, () => complete(deps, id, idempotencyKey, input, res, viewOf(req, res)));
    }, keepCompleteAnswer)),
  );
}

async function complete(
  deps: UcpCheckoutDeps,
  id: string,
  idempotencyKey: string | null,
  input: z.infer<typeof completeInput>,
  res: Response,
  view: View,
): Promise<void> {
  const session = await loadSession(deps, id);
  if (session === undefined) return sendError(res, 404, "not_found", `no checkout session "${id}"`);
  // A completed checkout is never charged twice. A retry with the key that completed it
  // was answered above from the idempotency memory, or reads it back here; a request
  // with any other key is a new attempt on a finished checkout, and is refused (T131).
  if (session.status === "completed") {
    if (idempotencyKey !== null && session.completeIdempotencyKey !== `ucp:${idempotencyKey}`) {
      return sendError(res, 409, "invalid_state", "checkout is already completed");
    }
    res.json(await checkoutResponse(deps, session, view));
    return;
  }
  if (session.status === "canceled") return sendError(res, 409, "invalid_state", "checkout is canceled");

  // Money may already have moved for this checkout. Whatever this request carries, it is never settled.
  if (session.status === "complete_in_progress") {
    if (session.settlement !== null) {
      await finish(deps, session);
      res.json(await checkoutResponse(deps, session, view));
      return;
    }
    res.json(await checkoutResponse(deps, session, view, [held()]));
    return;
  }

  const selected = input.payment.instruments.filter((instrument) => instrument.selected !== false);
  const instrument = selected.length === 1 ? selected[0] : undefined;
  if (instrument === undefined || instrument.handler_id !== STELLAR_X402_HANDLER_ID || instrument.type !== STELLAR_X402_INSTRUMENT_TYPE) {
    res.json(await checkoutResponse(deps, session, view, [message("payment_failed", `select exactly one ${STELLAR_X402_INSTRUMENT_TYPE} instrument of handler ${STELLAR_X402_HANDLER_ID}`, "recoverable", "$.payment.instruments")]));
    return;
  }
  const credential = stellarX402CredentialSchema.safeParse(instrument.credential);
  if (!credential.success) {
    res.json(await checkoutResponse(deps, session, view, [message("payment_failed", "the credential is not an x402_payment_payload of version 2", "recoverable", "$.payment.instruments[0].credential")]));
    return;
  }
  const transaction = credential.data.payload.transaction;

  if (session.status === "incomplete") {
    const messages = await refresh(deps, session);
    await deps.sessions.save(session);
    res.json(await checkoutResponse(deps, session, view, messages.length > 0 ? messages : [message("invalid_state", "checkout was not ready; review the refreshed terms and complete again", "recoverable")]));
    return;
  }
  // AP2-locked (T134, R-15): the lock is the session's, set when it was created, never this request's. No mandate,
  // or one that does not verify, and nothing is charged; the platform can close a new mandate and complete again.
  let ap2Mandate: string | null = null;
  if (session.ap2 !== null) {
    const outcome = await checkAp2Mandate(deps, session, session.ap2, view, input);
    if (!outcome.ok) {
      res.json(await checkoutResponse(deps, session, view, [outcome.refusal]));
      return;
    }
    ap2Mandate = outcome.mandate;
  }

  const stored = session.requirements;
  if (stored === null || session.quote === null) throw new VitrineeError("StorageError", "a ready checkout has no payment requirements", { details: { checkoutId: session.id } });

  // The price may have moved since the platform signed. Nothing is charged for a stale quote.
  const { quote, messages } = await evaluate(deps, session);
  if (quote === null || messages.length > 0 || quote.totalAtomic.toString() !== stored.amount) {
    await refresh(deps, session);
    session.updatedAt = deps.now().toISOString();
    await deps.sessions.save(session);
    const why = messages.length > 0 ? messages : [message("payment_failed", "the total changed since these terms were issued; sign the refreshed requirements", "recoverable", "$.totals")];
    res.json(await checkoutResponse(deps, session, view, why));
    return;
  }
  if (!sameRequirements(credential.data.accepted, stored)) {
    res.json(await checkoutResponse(deps, session, view, [message("payment_failed", "the credential was signed for other payment requirements than this checkout's", "recoverable", "$.payment.instruments[0].credential.accepted")]));
    return;
  }

  // Every line's units, or none of them (T148): summed per product, against the stock just quoted.
  const holds = heldUnits(session, quote);
  const short = deps.reservations.tryReserveAll(holds);
  if (short !== null) {
    const index = session.lines.findIndex((line) => line.productId === short);
    const name = quote.lines[index]?.product.name ?? short;
    res.json(await checkoutResponse(deps, session, view, [message("out_of_stock", `the last units of "${name}" are being bought right now`, "recoverable", `$.line_items[${index}]`)]));
    return;
  }
  try {
    // Persisted before settling: from here on, a crash or a retry finds the checkout in progress, never ready to pay again.
    session.status = "complete_in_progress";
    session.paymentKey = transaction;
    session.completeIdempotencyKey = idempotencyKey === null ? null : `ucp:${idempotencyKey}`;
    session.settlement = null;
    session.settleAttempt = null;
    // The mandate this charge is made under, kept with the session as evidence (a dispute, T127, may ask for it).
    if (session.ap2 !== null) session.ap2 = { ...session.ap2, mandate: ap2Mandate };
    // Where the platform completing this checkout wants the order's events (T147), kept for when the order exists.
    // Only what fits the session and is a usable URL: anything else means no webhook, never a failed complete.
    const webhookUrl = view.platform?.orderWebhookUrl;
    const keepable = webhookUrl !== undefined && view.platform !== null && isDeliverableUrl(webhookUrl) && view.platform.url.length <= 2_048 && view.origin.length <= 2_048;
    session.webhook = keepable ? { url: webhookUrl, platformProfile: view.platform!.url, version: view.version, origin: view.origin } : null;
    session.updatedAt = deps.now().toISOString();
    await deps.sessions.save(session);

    const outcome = await settle(deps, stored, transaction);
    if (outcome.kind === "refused") {
      deps.log("ucp settlement refused", { checkoutId: session.id, errorReason: outcome.reason });
      session.status = "ready_for_complete";
      session.paymentKey = null;
      session.updatedAt = deps.now().toISOString();
      await deps.sessions.save(session);
      res.json(await checkoutResponse(deps, session, view, [message("payment_failed", `the payment did not settle: ${outcome.reason}`, failureSeverity(outcome.reason), "$.payment")]));
      return;
    }
    if (outcome.kind === "unknown") {
      session.settleAttempt = { transaction: outcome.transaction, error: outcome.reason, at: deps.now().toISOString() };
      session.updatedAt = deps.now().toISOString();
      await deps.sessions.save(session);
      deps.log("ucp settlement outcome unknown; checkout held for reconciliation", { checkoutId: session.id, transaction: outcome.transaction, error: outcome.reason });
      res.json(await checkoutResponse(deps, session, view, [held()]));
      return;
    }
    const settled = outcome.response;
    // Logged before anything else can fail: if the save below does, reconciliation still has the hash.
    deps.log("ucp payment settled", { checkoutId: session.id, txHash: settled.transaction, amountAtomic: stored.amount, payTo: stored.payTo });
    session.settlement = {
      txHash: settled.transaction,
      network: settled.network,
      ...(settled.payer === undefined ? {} : { payer: settled.payer }),
      payTo: stored.payTo,
      asset: stored.asset,
      amountAtomic: stored.amount,
      settledAt: deps.now().toISOString(),
    };
    session.updatedAt = deps.now().toISOString();
    await deps.sessions.save(session);
    // The x402 server's settle hook filed it in the in-memory ledger too; the session is the record now.
    deps.ledger.take(transaction);
    await finish(deps, session);
  } finally {
    deps.reservations.releaseAll(holds);
  }
  res.json(await checkoutResponse(deps, session, view));
}

/** What a `complete` holds while it settles: each product once, with the units of every line naming it. */
function heldUnits(session: CheckoutSession, quote: PurchaseQuote): { productId: string; quantity: number; stock: number | null }[] {
  const units = new Map<string, { productId: string; quantity: number; stock: number | null }>();
  for (const [index, line] of session.lines.entries()) {
    const entry = units.get(line.productId);
    if (entry === undefined) units.set(line.productId, { productId: line.productId, quantity: line.quantity, stock: quote.lines[index]?.product.stock ?? null });
    else entry.quantity += line.quantity;
  }
  return [...units.values()];
}

function held(): UcpMessage {
  return message("payment_pending", "a payment for this checkout may already have moved; it is held for reconciliation and will not be charged again", "requires_buyer_review", "$.payment");
}

/**
 * Money moved and the session holds the settlement: create the order from the
 * session's own snapshot (never a fresh quote, which could now say out of
 * stock) and close the session. Safe to call again after a failure.
 */
async function finish(deps: UcpCheckoutDeps, session: CheckoutSession): Promise<void> {
  const settlement = session.settlement;
  const snapshot = session.quote;
  if (settlement === null || snapshot === null) {
    throw new VitrineeError("StorageError", "a paid checkout lost its settlement or its quote", { details: { checkoutId: session.id } });
  }
  const payer = settlement.payer ?? (session.paymentKey === null ? undefined : payerFromTransactionXdr(session.paymentKey));
  if (payer === undefined) {
    throw new VitrineeError("PaymentError", "payment settled but the payer account could not be determined", { details: { checkoutId: session.id, txHash: settlement.txHash } });
  }
  if (snapshot.lines.length !== session.lines.length) {
    throw new VitrineeError("StorageError", "a paid checkout's quote does not cover its lines", { details: { checkoutId: session.id } });
  }
  const lines = session.lines.map((line, index): CheckoutQuote => {
    const quoted = snapshot.lines[index]!;
    const product: Product = {
      id: line.productId,
      sku: quoted.productSku,
      name: quoted.productName,
      description: "",
      priceLocal: quoted.unitLocal,
      currency: snapshot.currency,
      stock: null,
      images: [],
    };
    return { product, quantity: line.quantity, unitAtomic: BigInt(quoted.unitAtomic), totalAtomic: BigInt(quoted.totalAtomic), totalLocal: quoted.totalLocal };
  });
  const quote = purchaseQuote(lines);
  // What was charged is the snapshot's total; a snapshot whose lines say otherwise is not turned into an order.
  if (quote.totalAtomic.toString() !== snapshot.totalAtomic || quote.totalAtomic.toString() !== settlement.amountAtomic) {
    throw new VitrineeError("SettlementUnaccounted", "payment settled but the checkout's lines do not add up to it", { details: { checkoutId: session.id, txHash: settlement.txHash } });
  }
  const { record } = await fulfilPaidPurchase(deps, {
    quote,
    body: bodyFor(session),
    idempotencyKey: session.completeIdempotencyKey,
    settlement: { ...settlement, payer },
    payer,
    ucpCheckoutId: session.id,
  });
  if (record.ucpCheckoutId !== session.id) {
    throw new VitrineeError("PaymentError", "this settlement already produced another checkout's order", {
      details: { checkoutId: session.id, orderId: record.orderId, txHash: settlement.txHash },
    });
  }
  // A replayed order was written and queued for its anchor again by `fulfilPaidPurchase`.
  session.status = "completed";
  session.orderId = record.orderId;
  session.updatedAt = deps.now().toISOString();
  await deps.sessions.save(session);
  deps.log("ucp checkout completed", { checkoutId: session.id, orderId: record.orderId, amountUSDC: usdcAtomicToDecimal(BigInt(settlement.amountAtomic)) });
  // The "Order created" webhook (T147). The checkout is already complete and paid: a failure here is logged, never answered.
  if (session.webhook !== null) {
    try {
      await deps.orderEvents.attachWebhook(record.orderId, session.webhook);
    } catch (error) {
      deps.log("order webhook not attached", { orderId: record.orderId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
