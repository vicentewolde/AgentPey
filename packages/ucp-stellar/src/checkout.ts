/**
 * Buying at a UCP store with the `com.agentpey.stellar_x402` payment handler
 * (Fase 7, E-1), in two halves (T128): {@link quote} opens a checkout and reads
 * back what it would cost, signing nothing; {@link pay} signs exactly that and
 * completes it. Moved out of the AgentPey agent in T136, which now calls these
 * two functions and keeps its own authorization (intent, Mandate, policy rail,
 * AP2) in the `beforeSign` hook.
 *
 * **Before anything is signed**, the payment requirement must name the same
 * recipient, asset and network as the handler the store declares at its
 * `/.well-known/ucp` (the handler spec's step 2): the checkout response alone
 * is not enough, the store writes it. The handler must be bound to
 * agentpey.com, the checkout must be for exactly the lines asked for, the
 * network must be Stellar testnet, and the amount must be within the caller's
 * `maxAmount`. Paying from a `policy_rail`, the network then checks the rail's
 * own limits inside the transfer.
 */
import type { PaymentPayloadResult, PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { z } from "zod";

import { toAtomic } from "./amount.js";
import { UcpStellarError, isUcpStellarError } from "./errors.js";
import {
  STELLAR_TESTNET,
  STELLAR_X402_HANDLER,
  checkoutLinesSchema,
  checkoutSchema,
  handlerConfigSchema,
  payableQuoteSchema,
  quoteInputSchema,
  requirementsSchema,
  ucpBusinessProfileSchema,
  type StellarX402HandlerConfig,
  type UcpBusinessProfile,
  type UcpBuyer,
  type UcpCheckout,
  type UcpDestination,
  type UcpLine,
  type UcpReceipt,
} from "./wire.js";

/**
 * The platform profile sent in `UCP-Agent` unless told otherwise: AgentPey's public one, which declares UCP
 * 2026-04-08 and the Stellar x402 handler, and no AP2. A store answers in the version that profile declares.
 */
export const DEFAULT_PLATFORM_PROFILE = "https://agentpey.com/ucp/platform/agentpey.json";

/** Anything that builds an x402 `exact` payment on Stellar: {@link classicPayer}, {@link policyRailPayer}, or your own. */
export type UcpStellarPayer = SchemeNetworkClient;

export interface UcpClientOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** The platform profile sent in `UCP-Agent`. Defaults to {@link DEFAULT_PLATFORM_PROFILE}. */
  readonly platformProfile?: string;
}

/** What a store publishes for this handler, read and checked. */
export interface UcpStoreProfile {
  /** The store's origin. */
  readonly storeUrl: string;
  /** The REST endpoint of `dev.ucp.shopping`, on the store's own origin. */
  readonly endpoint: string;
  /** The id the store gave the Stellar x402 handler. */
  readonly handlerId: string;
  /** The handler's config: who gets paid, in what asset, on which network. */
  readonly handler: StellarX402HandlerConfig;
  /** The whole profile as the store published it (capabilities, keys). */
  readonly profile: UcpBusinessProfile;
}

export type QuoteInput = z.input<typeof quoteInputSchema> & {
  readonly buyer?: UcpBuyer;
  readonly destination: UcpDestination;
};

/** A checkout the store opened and this package checked: everything a payment needs, nothing signed yet. */
export interface UcpStellarQuote {
  readonly storeUrl: string;
  readonly endpoint: string;
  readonly handlerId: string;
  readonly checkoutId: string;
  /** Every line, as the store's own answer has them. */
  readonly lines: readonly UcpLine[];
  /** The x402 requirement for this checkout, already checked against the store's profile. */
  readonly requirements: PaymentRequirements;
  /** The asset the handler declares. */
  readonly asset: { readonly code: string; readonly contract: string; readonly decimals: number };
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
  /** The checkout exactly as the store answered it. */
  readonly checkout: Readonly<Record<string, unknown>>;
  /** The store's profile, as read when quoting. */
  readonly profile: UcpBusinessProfile;
}

/** What {@link pay} reads of a quote. A quote kept as JSON and read back is checked again here. */
export type PayableQuote = Pick<UcpStellarQuote, "storeUrl" | "endpoint" | "handlerId" | "checkoutId" | "lines" | "requirements" | "checkout"> &
  Partial<Pick<UcpStellarQuote, "asset">>;

/** What the `beforeSign` hook sees: what is about to be signed. */
export interface BeforeSignContext {
  /** The requirement that will be signed. */
  readonly requirements: PaymentRequirements;
  /** The checkout as the store last answered it. */
  readonly checkout: Readonly<Record<string, unknown>>;
  /** The lines that checkout is for. */
  readonly lines: readonly UcpLine[];
  /** The store's profile, when `recheck` read it again. */
  readonly profile?: UcpBusinessProfile;
}

export interface BeforeSignResult {
  /** Members added to the Complete Checkout body next to `payment`, such as an extension's (`ap2`). */
  readonly completeExtensions?: Readonly<Record<string, unknown>>;
}

export interface PayOptions extends UcpClientOptions {
  /** Builds and signs the payment. The key stays wherever this payer keeps it. */
  readonly payer: UcpStellarPayer;
  /**
   * The most this payment may cost: a decimal amount of the asset (`"5.00"`), or atomic units as a `bigint`.
   * Refused with `AmountAboveLimit` before anything is signed.
   */
  readonly maxAmount: string | bigint;
  /**
   * Read the store's profile and the checkout again before signing, and refuse with `QuoteChanged` unless they
   * still say what the quote said. Defaults to `true`.
   */
  readonly recheck?: boolean;
  /** Sent on Complete Checkout, so a retried request cannot pay twice. */
  readonly idempotencyKey?: string;
  /**
   * Your last word before signing: throw to stop the payment (nothing is sent, and your error reaches the caller
   * as you threw it), or return extension members for the Complete Checkout body.
   */
  readonly beforeSign?: (context: BeforeSignContext) => Promise<BeforeSignResult | void> | BeforeSignResult | void;
}

export interface UcpStellarReceipt {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly permalinkUrl: string;
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
  /** What was paid: the requirement that was signed. */
  readonly paid: { readonly amount: string; readonly asset: string; readonly payTo: string };
  /** The settlement transaction, when the store reports it. */
  readonly transaction: string | undefined;
  /** The store's signed receipt, when it issues one. */
  readonly receipt: UcpReceipt | undefined;
}

// ---------------------------------------------------------------- HTTP

type UcpCall = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;

function caller(options: UcpClientOptions): UcpCall {
  const fetchImpl = options.fetch ?? fetch;
  const profile = options.platformProfile ?? DEFAULT_PLATFORM_PROFILE;
  return async (method, url, body, headers = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: "application/json", "UCP-Agent": `profile="${profile}"`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new UcpStellarError("NetworkError", "could not reach the UCP store", { cause: error, details: { url } });
    }
    const json: unknown = await res.json().catch(() => undefined);
    return { status: res.status, json };
  };
}

function messagesOf(json: unknown): unknown[] {
  const messages = (json as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? messages.slice(0, 5) : [];
}

function invalidArguments(message: string, error: z.ZodError): UcpStellarError {
  return new UcpStellarError("InvalidArguments", message, { cause: error, details: { issues: error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
}

// ---------------------------------------------------------------- profile

function authorityOf(name: string): string {
  const [tld, domain] = name.split(".");
  return `${domain ?? ""}.${tld ?? ""}`;
}

/** UCP's spec-URL binding: HTTPS, default port, exactly the name's domain (`com.agentpey.*` on agentpey.com). */
export function originMatchesNamespace(name: string, url: string | undefined): boolean {
  if (url === undefined || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.port === "" && parsed.hostname === authorityOf(name);
}

function originOf(storeUrl: string): string {
  return new URL(storeUrl).origin;
}

async function readProfile(call: UcpCall, origin: string): Promise<UcpStoreProfile> {
  const reply = await call("GET", `${origin}/.well-known/ucp`);
  const profile = ucpBusinessProfileSchema.safeParse(reply.json);
  if (reply.status !== 200 || !profile.success) {
    throw new UcpStellarError("MerchantRejectedRequest", "the store does not publish a UCP business profile", { details: { storeUrl: origin, status: reply.status } });
  }
  const [handler] = profile.data.ucp.payment_handlers[STELLAR_X402_HANDLER] ?? [];
  if (handler === undefined || !originMatchesNamespace(STELLAR_X402_HANDLER, handler.spec) || !originMatchesNamespace(STELLAR_X402_HANDLER, handler.schema)) {
    throw new UcpStellarError("MerchantRejectedRequest", `the store does not declare ${STELLAR_X402_HANDLER} with its spec on agentpey.com`, { details: { storeUrl: origin } });
  }
  const declared = handlerConfigSchema.safeParse(handler.config);
  if (!declared.success) {
    throw new UcpStellarError("MerchantRejectedRequest", "the store's Stellar x402 handler config is malformed", { details: { storeUrl: origin } });
  }
  if (declared.data.network !== STELLAR_TESTNET) {
    throw new UcpStellarError("UnsupportedNetwork", `the store's handler is on ${declared.data.network}; this package pays on ${STELLAR_TESTNET} only`, { details: { storeUrl: origin, network: declared.data.network } });
  }
  const endpoint = profile.data.ucp.services["dev.ucp.shopping"]?.find((service) => service.transport === "rest")?.endpoint;
  if (endpoint === undefined || !URL.canParse(endpoint) || new URL(endpoint).origin !== origin) {
    throw new UcpStellarError("MerchantRejectedRequest", "the store declares no REST endpoint of its own", { details: { storeUrl: origin } });
  }
  return { storeUrl: origin, endpoint, handlerId: handler.id, handler: declared.data, profile: profile.data };
}

/**
 * Reads a store's `/.well-known/ucp` and checks its Stellar x402 handler: bound to agentpey.com, well formed, on
 * Stellar testnet, with a REST endpoint on the store's own origin.
 *
 * @throws UcpStellarError `InvalidArguments`, `MerchantRejectedRequest`, `UnsupportedNetwork` or `NetworkError`
 */
export async function readStoreProfile(storeUrl: string, options: UcpClientOptions = {}): Promise<UcpStoreProfile> {
  const url = payableQuoteSchema.shape.storeUrl.safeParse(storeUrl);
  if (!url.success) throw invalidArguments("the store URL is not an https URL", url.error);
  return readProfile(caller(options), originOf(url.data));
}

// ---------------------------------------------------------------- checkout

interface ReadCheckout {
  readonly checkout: UcpCheckout;
  readonly requirements: PaymentRequirements;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly lines: readonly UcpLine[];
}

/**
 * The checkout's own payment requirement, refused unless the checkout is ready and the requirement names the same
 * recipient, asset and network as the handler the store declares publicly.
 */
function readCheckout(json: unknown, status: number, store: UcpStoreProfile): ReadCheckout {
  const checkout = checkoutSchema.safeParse(json);
  if (!checkout.success || status >= 300) {
    throw new UcpStellarError("MerchantRejectedRequest", "the store did not open a checkout for this product", {
      details: { storeUrl: store.storeUrl, status, messages: messagesOf(json) },
    });
  }
  if (checkout.data.status !== "ready_for_complete") {
    throw new UcpStellarError("MerchantRejectedRequest", "the store's checkout is not ready to pay", {
      details: { checkoutId: checkout.data.id, status: checkout.data.status, messages: checkout.data.messages ?? [] },
    });
  }
  const config = checkout.data.ucp.payment_handlers?.[STELLAR_X402_HANDLER]?.[0]?.config as { payment_requirements?: unknown; binding?: { checkout_id?: unknown } } | undefined;
  const requirements = requirementsSchema.safeParse(config?.payment_requirements);
  if (!requirements.success || config?.binding?.checkout_id !== checkout.data.id) {
    throw new UcpStellarError("MerchantRejectedRequest", "the checkout carries no payment requirements for this session", { details: { checkoutId: checkout.data.id } });
  }
  const req = requirements.data;
  if (req.payTo !== store.handler.pay_to || req.asset !== store.handler.asset.contract || req.network !== store.handler.network) {
    throw new UcpStellarError("InvalidProduct", "the checkout asks to pay someone or something other than the store's declared handler", {
      details: { checkoutId: checkout.data.id, payTo: req.payTo, declaredPayTo: store.handler.pay_to, asset: req.asset, network: req.network },
    });
  }
  const lines = checkoutLinesSchema.safeParse((json as { line_items?: unknown }).line_items);
  if (!lines.success) {
    throw new UcpStellarError("MerchantRejectedRequest", "the checkout does not say which lines it is for", { details: { checkoutId: checkout.data.id } });
  }
  return {
    checkout: checkout.data,
    // The parsed requirement, with `extra` always present as x402 types it.
    requirements: { ...req, network: req.network as PaymentRequirements["network"], extra: req.extra ?? {} },
    // The store's bytes as parsed: what an extension closes over must be exactly what the store sent.
    raw: json as Readonly<Record<string, unknown>>,
    lines: lines.data.map((line) => ({ productId: line.item.id, quantity: line.quantity })),
  };
}

function sameLines(a: readonly UcpLine[], b: readonly UcpLine[]): boolean {
  return a.length === b.length && a.every((line, i) => line.productId === b[i]!.productId && line.quantity === b[i]!.quantity);
}

const linePairs = (lines: readonly UcpLine[]) => lines.map((line) => [line.productId, line.quantity]);

function totalOf(checkout: UcpCheckout): { amount: number; currency: string } {
  return { amount: checkout.totals.find((line) => line.type === "total")?.amount ?? 0, currency: checkout.currency };
}

/**
 * Opens a checkout for one product, or a cart of up to ten lines, and reads back what it would cost, checked
 * against the store's public profile. Signs nothing and moves no money, but it does open a checkout session at the
 * store. With `buyer.consent`, the consent goes in an update right after the create: UCP 2026-08-25 has a store
 * count only the consent options it advertised in an earlier answer.
 *
 * @throws UcpStellarError `InvalidArguments`, `MerchantRejectedRequest`, `UnsupportedNetwork`, `InvalidProduct` or
 * `NetworkError`; never with `paymentSent`
 */
export async function quote(input: QuoteInput, options: UcpClientOptions = {}): Promise<UcpStellarQuote> {
  const parsed = quoteInputSchema.safeParse(input);
  if (!parsed.success) throw invalidArguments("a quote needs a store, a destination, and one product with its quantity or 1 to 10 lines", parsed.error);
  const { storeUrl, buyer, destination } = parsed.data;
  const lines: readonly UcpLine[] = parsed.data.lines ?? [{ productId: parsed.data.productId!, quantity: parsed.data.quantity! }];

  const call = caller(options);
  const store = await readProfile(call, originOf(storeUrl));
  const { consent, ...contact } = buyer ?? {};
  const session = (withConsent: boolean) => ({
    line_items: lines.map((line) => ({ item: { id: line.productId }, quantity: line.quantity })),
    ...(buyer === undefined ? {} : { buyer: withConsent && consent !== undefined ? { ...contact, consent } : contact }),
    fulfillment: { methods: [{ type: "shipping", destinations: [destination] }] },
  });
  let reply = await call("POST", `${store.endpoint}/checkout-sessions`, session(false));
  if (consent !== undefined) {
    const opened = readCheckout(reply.json, reply.status, store).checkout;
    reply = await call("PUT", `${store.endpoint}/checkout-sessions/${encodeURIComponent(opened.id)}`, session(true));
    const updated = checkoutSchema.safeParse(reply.json);
    if (updated.success && updated.data.id !== opened.id) {
      throw new UcpStellarError("MerchantRejectedRequest", "the store answered the consent update with another checkout", { details: { checkoutId: opened.id, answered: updated.data.id } });
    }
  }
  const { checkout, requirements, raw, lines: opened } = readCheckout(reply.json, reply.status, store);
  if (!sameLines(lines, opened)) {
    throw new UcpStellarError("InvalidProduct", "the store opened a checkout for other lines than the ones asked for", {
      details: { checkoutId: checkout.id, asked: linePairs(lines), opened: linePairs(opened) },
    });
  }
  return {
    storeUrl: store.storeUrl,
    endpoint: store.endpoint,
    handlerId: store.handlerId,
    checkoutId: checkout.id,
    lines: opened,
    requirements,
    asset: { code: store.handler.asset.code, contract: store.handler.asset.contract, decimals: store.handler.asset.decimals },
    total: totalOf(checkout),
    checkout: raw,
    profile: store.profile,
  };
}

/** x402's own spend controls, capped at exactly the requirement being paid. */
function spendControlsFor(requirements: PaymentRequirements) {
  return {
    maxAmountPerPayment: false as const,
    allowedAssets: [{ network: requirements.network, asset: requirements.asset, maxAmountPerPayment: requirements.amount }],
  };
}

/**
 * The caller's payer, with its own errors marked so they reach the caller as thrown; anything x402 itself throws
 * becomes a typed `PaymentNotCreated`.
 */
function guarded(payer: UcpStellarPayer, own: WeakSet<object>): UcpStellarPayer {
  return {
    scheme: payer.scheme,
    ...(payer.schemeHooks === undefined ? {} : { schemeHooks: payer.schemeHooks }),
    ...(payer.findDefaultAsset === undefined ? {} : { findDefaultAsset: payer.findDefaultAsset.bind(payer) }),
    createPaymentPayload: async (...args): Promise<PaymentPayloadResult> => {
      try {
        return await payer.createPaymentPayload(...args);
      } catch (error) {
        if (typeof error === "object" && error !== null) own.add(error);
        throw error;
      }
    },
  };
}

/**
 * Pays a quote: checks it again (with `recheck`, against what the store says now), refuses an amount above
 * `maxAmount`, gives `beforeSign` the last word, signs exactly the requirement and completes the checkout.
 *
 * @throws UcpStellarError `InvalidArguments`, `UnsupportedNetwork`, `QuoteChanged`, `InvalidProduct`,
 * `AmountAboveLimit`, `PaymentNotCreated`, `RailInsufficientFunds` or `NetworkError`, each with `paymentSent`.
 * An error thrown by your own `payer` or `beforeSign` reaches you as you threw it; nothing was sent.
 */
export async function pay(quoteToPay: PayableQuote, options: PayOptions): Promise<UcpStellarReceipt> {
  const parsedQuote = payableQuoteSchema.safeParse(quoteToPay);
  if (!parsedQuote.success) throw invalidArguments("this is not a quote from quote()", parsedQuote.error);
  const q = parsedQuote.data;
  const quoted: PaymentRequirements = { ...q.requirements, network: q.requirements.network as PaymentRequirements["network"], extra: q.requirements.extra ?? {} };
  if (quoted.network !== STELLAR_TESTNET) {
    throw new UcpStellarError("UnsupportedNetwork", `the quote is on ${quoted.network}; this package pays on ${STELLAR_TESTNET} only`, { details: { network: quoted.network } });
  }
  const maxAtomic = maxAmountOf(options.maxAmount, q.asset?.decimals);
  const call = caller(options);

  let requirements = quoted;
  let handlerId = q.handlerId;
  let latest: Readonly<Record<string, unknown>> = q.checkout;
  let lines: readonly UcpLine[] = q.lines;
  let profile: UcpBusinessProfile | undefined;
  if (options.recheck ?? true) {
    let store: UcpStoreProfile;
    try {
      store = await readProfile(call, originOf(q.storeUrl));
    } catch (error) {
      // The quote was on testnet: a profile that now names another network is a quote that changed.
      if (isUcpStellarError(error) && error.code === "UnsupportedNetwork") {
        throw new UcpStellarError("QuoteChanged", "the store's handler is now on another network than when it quoted", { cause: error, details: { checkoutId: q.checkoutId } });
      }
      throw error;
    }
    if (store.endpoint !== q.endpoint) {
      throw new UcpStellarError("QuoteChanged", "the store now declares another REST endpoint than when it quoted", { details: { checkoutId: q.checkoutId } });
    }
    const current = await call("GET", `${store.endpoint}/checkout-sessions/${encodeURIComponent(q.checkoutId)}`);
    let fresh: ReadCheckout;
    try {
      fresh = readCheckout(current.json, current.status, store);
    } catch (error) {
      throw new UcpStellarError("QuoteChanged", "the store's checkout no longer matches what it quoted", { cause: error, details: { checkoutId: q.checkoutId } });
    }
    const same = (["payTo", "asset", "network", "amount", "scheme"] as const).every((field) => fresh.requirements[field] === quoted[field]);
    if (!same || fresh.checkout.id !== q.checkoutId) {
      throw new UcpStellarError("QuoteChanged", "the store now asks for another recipient, asset, network or amount than it quoted", {
        details: { checkoutId: q.checkoutId, quoted: { payTo: quoted.payTo, amount: quoted.amount }, now: { payTo: fresh.requirements.payTo, amount: fresh.requirements.amount } },
      });
    }
    // The same total can be another cart: an update can change the lines without changing the price.
    if (!sameLines(q.lines, fresh.lines)) {
      throw new UcpStellarError("InvalidProduct", "the store's checkout is now for other lines than it quoted", {
        details: { checkoutId: q.checkoutId, quoted: linePairs(q.lines), checkout: linePairs(fresh.lines) },
      });
    }
    requirements = fresh.requirements;
    handlerId = store.handlerId;
    latest = fresh.raw;
    lines = fresh.lines;
    profile = store.profile;
  }
  if (BigInt(requirements.amount) > maxAtomic) {
    throw new UcpStellarError("AmountAboveLimit", "the checkout costs more than the maxAmount allowed", { details: { checkoutId: q.checkoutId, amount: requirements.amount, maxAmount: maxAtomic.toString() } });
  }

  const extensions = (await options.beforeSign?.({ requirements, checkout: latest, lines, ...(profile === undefined ? {} : { profile }) }))?.completeExtensions ?? {};
  if ("payment" in extensions) {
    throw new UcpStellarError("InvalidArguments", "beforeSign may add extensions, not replace the payment", { details: { checkoutId: q.checkoutId } });
  }

  // Sign exactly this requirement, capped at its own amount.
  const own = new WeakSet<object>();
  const client = x402Client.fromConfig({ schemes: [{ network: STELLAR_TESTNET, client: guarded(options.payer, own) }] });
  client.setSpendControls(spendControlsFor(requirements));
  const completeUrl = `${q.endpoint}/checkout-sessions/${encodeURIComponent(q.checkoutId)}/complete`;
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: completeUrl, description: `UCP checkout ${q.checkoutId}`, mimeType: "application/json" },
    accepts: [requirements],
  };
  let payload: Awaited<ReturnType<x402HTTPClient["createPaymentPayload"]>>;
  try {
    payload = await new x402HTTPClient(client).createPaymentPayload(paymentRequired);
  } catch (error) {
    if (isUcpStellarError(error)) throw error.withPaymentSent(false);
    if (typeof error === "object" && error !== null && own.has(error)) throw error;
    throw new UcpStellarError("PaymentNotCreated", "the payment could not be built, and nothing was sent", { cause: error, details: { checkoutId: q.checkoutId } });
  }
  const transaction = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof transaction !== "string" || transaction === "") {
    throw new UcpStellarError("PaymentNotCreated", "the payment scheme produced no transaction", { details: { checkoutId: q.checkoutId } });
  }

  // The door. From here on money may have moved: every failure says so.
  try {
    const completed = await call(
      "POST",
      completeUrl,
      {
        ...extensions,
        payment: {
          instruments: [
            {
              id: "instr_1",
              handler_id: handlerId,
              type: "stellar_x402",
              selected: true,
              credential: { type: "x402_payment_payload", x402_version: 2, accepted: payload.accepted, payload: { transaction } },
            },
          ],
        },
      },
      options.idempotencyKey === undefined ? {} : { "Idempotency-Key": options.idempotencyKey },
    );
    const done = checkoutSchema.safeParse(completed.json);
    if (!done.success || done.data.status !== "completed" || done.data.order === undefined) {
      throw new UcpStellarError("NetworkError", "the store did not confirm the completed checkout", {
        details: { checkoutId: q.checkoutId, status: completed.status, checkoutStatus: done.success ? done.data.status : undefined, messages: messagesOf(completed.json) },
      });
    }
    return {
      checkoutId: done.data.id,
      orderId: done.data.order.id,
      permalinkUrl: done.data.order.permalink_url,
      total: totalOf(done.data),
      paid: { amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo },
      transaction: done.data.receipt?.settlement_tx_hash,
      receipt: done.data.receipt,
    };
  } catch (error) {
    if (isUcpStellarError(error)) throw error.withPaymentSent(true);
    throw new UcpStellarError("NetworkError", "the checkout's completion failed after the payment was sent", { cause: error, details: { checkoutId: q.checkoutId }, paymentSent: true });
  }
}

/** @throws UcpStellarError `InvalidArguments` for a negative bigint, a malformed decimal, or a decimal without the asset's decimals */
function maxAmountOf(maxAmount: string | bigint, decimals: number | undefined): bigint {
  if (typeof maxAmount === "bigint") {
    if (maxAmount < 0n) throw new UcpStellarError("InvalidArguments", "maxAmount cannot be negative", { details: { maxAmount: maxAmount.toString() } });
    return maxAmount;
  }
  if (typeof maxAmount !== "string") throw new UcpStellarError("InvalidArguments", "maxAmount is required: a decimal string or a bigint of atomic units", { details: {} });
  if (decimals === undefined) {
    throw new UcpStellarError("InvalidArguments", "a decimal maxAmount needs the quote's asset; pass atomic units as a bigint instead", { details: {} });
  }
  return toAtomic(maxAmount, decimals);
}
