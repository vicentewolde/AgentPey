/**
 * Paying a UCP checkout on Stellar (T122, Fase 7, E-1): the buyer's side of
 * the `com.agentpey.stellar_x402` payment handler.
 *
 * The twin of {@link executeBazaarPayment}, with the same guarantees in the
 * same order. What differs is only how the price arrives and how the payment
 * leaves: the payment requirements come from the checkout session's handler
 * config instead of an HTTP 402, and the signed payload goes back in the body
 * of Complete Checkout instead of a `PAYMENT-SIGNATURE` header.
 *
 * **Before anything is signed**, three independent checks, in this order:
 *
 * 1. The requirements name the same recipient, asset and network as the
 *    handler the store declares at its `/.well-known/ucp` (the handler spec's
 *    step 2). The checkout response alone is not enough: the store writes it.
 * 2. `toPaymentTerms` pins the recipient to the venue's own account and maps
 *    the asset through the venue registry, as for any x402 venue.
 * 3. `policyRail.authorise` reconciles them against the signed intent, the
 *    scope and the Mandate. Untouched by this module (P-14).
 *
 * Paying from a `policy_rail`, the network then checks `perTx`/`perDay` a
 * fourth time, inside the transfer.
 *
 * Nothing in this file knows Vitrinee: it speaks UCP and the handler spec, so
 * any business that declares the handler can be paid the same way (C-88).
 */
import { AgentPassError } from "@agentpass/core";
import type { Scope } from "@agentpass/core";
import { checkoutJwtFrom, closeCheckoutMandate, issueOpenMandatePair, verifyMerchantAuthorization } from "@agentpey/ap2";
import type { AgentPeyMandateRef, Ap2Signer } from "@agentpey/ap2";
import type { AgentPayMandate } from "@agentpey/mandate";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ExactStellarScheme, STELLAR_TESTNET_CAIP2, createEd25519Signer } from "@x402/stellar";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";

import { DEFAULT_VENUE_REGISTRY } from "../catalog/default-registry.js";
import type { VenueId } from "../catalog/ids.js";
import type { VenueRegistry } from "../catalog/registry.js";
import { intentLines, type PurchaseIntent } from "../intent/intent.js";
import { policyRailError, type PolicyRail } from "../policy/policy-rail.js";
import { PolicyRailStellarScheme, type PolicyRailPayer } from "./policy-rail-payer.js";
import { spendControlsFor, toPaymentTerms, withPaymentSent } from "./x402.js";

export const STELLAR_X402_HANDLER = "com.agentpey.stellar_x402";
/**
 * AgentPey's platform profile, sent with every request as UCP asks. The UCP
 * version the agent speaks is the one this profile declares (2026-04-08): a
 * store reads it there (T133, R-14), so the agent keeps no version constant of
 * its own. The store side's is `UCP_VERSIONS` in @vitrinee/core.
 */
export const AGENTPEY_PLATFORM_PROFILE = "https://agentpey.com/ucp/platform/agentpey.json";
/** The same platform, declaring UCP 2026-08-25 (T133). */
export const AGENTPEY_PLATFORM_PROFILE_2026_08_25 = "https://agentpey.com/ucp/platform/agentpey-2026-08-25.json";
/** The same platform, declaring UCP 2026-08-25 and AP2 mandates, with its P-256 key (T134, R-16). */
export const AGENTPEY_PLATFORM_PROFILE_AP2 = "https://agentpey.com/ucp/platform/agentpey-ap2.json";
/** UCP's AP2 mandates extension (T134). */
export const UCP_AP2_MANDATE = "dev.ucp.common.payment.ap2_mandate";

/**
 * What the agent needs to close AP2 mandates in a UCP checkout (T134, R-15, R-16): the platform's key that signs
 * the open mandate, the agent's own key that closes it, the Mandate it comes from, and the intents it already
 * closed one for (brecha 14: one closed mandate per intent).
 */
export interface UcpAp2Options {
  /** `iss` of the open mandate. */
  readonly issuer: string;
  /** The platform's P-256 key (`AGENTPEY_PLATFORM_AP2_SECRET`); its public half is in `agentpey-ap2.json`. */
  readonly platform: Ap2Signer;
  /** The agent's P-256 key: the open mandate's `cnf`, and the key that signs the closing hop. */
  readonly holder: Ap2Signer & { readonly publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string } };
  /** The AgentPey Mandate the open mandate is derived from. */
  readonly source: AgentPeyMandateRef;
  /**
   * Intent ids this agent already closed a mandate for (brecha 14). An id is
   * taken before anything else happens and never given back, even if the
   * store then refuses: a recoverable refusal leaves that intent spent, and a
   * new purchase needs a new intent. The set lives as long as its owner keeps
   * it (one process for `ucp:buy`).
   */
  readonly closed: Set<string>;
}

const reverseDomain = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

// ---------------------------------------------------------------- wire shapes

const declaration = z.looseObject({ version: z.string(), spec: z.string().optional(), schema: z.string().optional(), config: z.unknown().optional() });

const profileSchema = z.looseObject({
  ucp: z.looseObject({
    version: z.string(),
    services: z.record(z.string().regex(reverseDomain), z.array(declaration.extend({ transport: z.string(), endpoint: z.string().optional() }))),
    capabilities: z.record(z.string().regex(reverseDomain), z.array(declaration)).optional(),
    payment_handlers: z.record(z.string().regex(reverseDomain), z.array(declaration.extend({ id: z.string() }))),
  }),
  keys: z.array(z.unknown()).optional(),
});

/** A store's P-256 key, as its profile publishes it for AP2 (T134). */
const storeP256KeySchema = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().min(1),
});

const handlerConfigSchema = z.looseObject({
  x402_version: z.literal(2),
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.looseObject({ code: z.string(), contract: z.string().regex(/^C[A-Z2-7]{55}$/), decimals: z.number().int() }),
  pay_to: z.string().regex(/^G[A-Z2-7]{55}$/),
});

const requirementsSchema = z.looseObject({
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const messageSchema = z.looseObject({ type: z.string(), code: z.string().optional(), content: z.string().optional(), severity: z.string().optional() });

const checkoutSchema = z.looseObject({
  ucp: z.looseObject({ payment_handlers: z.record(z.string(), z.array(z.looseObject({ id: z.string(), config: z.unknown().optional() }))).optional() }),
  id: z.string().min(1),
  status: z.string(),
  currency: z.string(),
  totals: z.array(z.looseObject({ type: z.string(), amount: z.number() })),
  messages: z.array(messageSchema).optional(),
  order: z.looseObject({ id: z.string(), permalink_url: z.string() }).optional(),
  receipt: z
    .looseObject({
      jws: z.string(),
      hash: z.string(),
      settlement_tx_hash: z.string(),
      verify_url: z.string(),
      anchor: z.looseObject({ status: z.string(), registry: z.string() }),
    })
    .optional(),
});
type UcpCheckout = z.infer<typeof checkoutSchema>;

/** The lines a checkout says it is for (T148): what the store will charge and ship, read from its own answer. */
const checkoutLinesSchema = z.array(z.looseObject({ item: z.looseObject({ id: z.string().min(1) }), quantity: z.int().positive() })).min(1);

/** Whether two lists name the same lines, in the same order. */
function sameLines(a: readonly UcpLine[], b: readonly UcpLine[]): boolean {
  return a.length === b.length && a.every((line, i) => line.productId === b[i]!.productId && line.quantity === b[i]!.quantity);
}

const linePairs = (lines: readonly UcpLine[]) => lines.map((line) => [line.productId, line.quantity]);

// ---------------------------------------------------------------- public API

export interface UcpDestination {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly street_address: string;
  readonly address_locality: string;
  readonly address_region?: string;
  /** ISO 3166-1 alpha-2. */
  readonly address_country: string;
  readonly postal_code?: string;
}

export interface ExecuteUcpPaymentDeps {
  readonly policyRail: PolicyRail;
  /** The agent's own Stellar secret key, when it pays from its classic account. */
  readonly signerSecret: string;
  /** When set, the `policy_rail` smart account pays, and the network enforces its limits. */
  readonly payer?: PolicyRailPayer;
  readonly fetchImpl?: typeof fetch;
  /** The platform profile sent in `UCP-Agent`, which tells the store the UCP version to answer in. Defaults to {@link AGENTPEY_PLATFORM_PROFILE}. */
  readonly platformProfile?: string;
  /**
   * Pay with an AP2 mandate (T134). Pair it with {@link AGENTPEY_PLATFORM_PROFILE_AP2}. With it, a store that does
   * not offer AP2, or does not sign its checkout, is refused before anything is authorised or signed.
   */
  readonly ap2?: UcpAp2Options;
  /** Tests only: the scheme that builds the payment, in place of the real Stellar one. */
  readonly schemeForTests?: SchemeNetworkClient;
}

/** One line of a UCP checkout: a product and how many (T148). */
export interface UcpLine {
  readonly productId: string;
  readonly quantity: number;
}

/**
 * What a checkout is for: one product (`productId`, `quantity`), or a cart
 * (`lines`, T148), never both. A one-line checkout is sent exactly as before.
 */
export interface UcpPurchaseLines {
  readonly productId?: string;
  readonly quantity?: number;
  readonly lines?: readonly UcpLine[];
}

/** The most lines one checkout carries, as the stores take them. */
export const MAX_UCP_LINES = 10;

/** @throws AgentPassError `InvalidArguments` unless the input names exactly one of the two forms, with 1 to 10 lines */
export function ucpLinesOf(input: UcpPurchaseLines): readonly UcpLine[] {
  if (input.lines !== undefined) {
    if (input.productId !== undefined || input.quantity !== undefined || input.lines.length === 0 || input.lines.length > MAX_UCP_LINES) {
      throw new AgentPassError("InvalidArguments", `a UCP checkout is one product, or 1 to ${MAX_UCP_LINES} lines`, { details: { lines: input.lines.length } });
    }
    return input.lines;
  }
  if (input.productId === undefined || input.quantity === undefined) {
    throw new AgentPassError("InvalidArguments", "a UCP checkout needs a product and its quantity, or lines", { details: {} });
  }
  return [{ productId: input.productId, quantity: input.quantity }];
}

export interface ExecuteUcpPaymentInput extends UcpPurchaseLines {
  /** The store's origin: where its `/.well-known/ucp` is. */
  readonly storeUrl: string;
  /** `consent` (T149) is UCP's buyer consent extension, in the shape of the version the store answers in; sent as given. */
  readonly buyer?: { readonly email?: string; readonly first_name?: string; readonly last_name?: string; readonly consent?: Readonly<Record<string, unknown>> };
  readonly destination: UcpDestination;
  /** The already-signed intent this payment is for. */
  readonly intent: PurchaseIntent;
  readonly scope: Scope;
  readonly mandate: AgentPayMandate;
  readonly venueId: VenueId;
  readonly registry?: VenueRegistry;
  /** Sent on Complete Checkout, so a retried request cannot pay twice. */
  readonly idempotencyKey?: string;
}

export interface UcpPaymentReceipt {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly permalinkUrl: string;
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
  /** What was paid: the requirements `authorise()` reconciled. */
  readonly paid: { readonly amount: string; readonly asset: string; readonly payTo: string };
  readonly transaction: string | undefined;
  readonly receipt: NonNullable<UcpCheckout["receipt"]> | undefined;
  /** The closed AP2 checkout mandate sent in `complete`, when the store asked for one (T134). */
  readonly ap2Mandate?: string;
}

function networkError(message: string, details: Record<string, unknown>, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details });
}

function authorityOf(name: string): string {
  const [tld, domain] = name.split(".");
  return `${domain ?? ""}.${tld ?? ""}`;
}

/** UCP's spec-URL binding: HTTPS, default port, exactly the name's domain. */
export function originMatchesNamespace(name: string, url: string | undefined): boolean {
  if (url === undefined || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.port === "" && parsed.hostname === authorityOf(name);
}

/** What a store answered, read and checked: everything a payment needs, nothing signed yet (T128). */
export interface UcpQuote {
  /** The store's origin. */
  readonly storeUrl: string;
  /** The REST endpoint the store's profile declares, on the store's own origin. */
  readonly endpoint: string;
  /** The id the store gave the Stellar x402 handler in its profile. */
  readonly handlerId: string;
  readonly checkoutId: string;
  /** The first line's product and quantity: the whole checkout unless it is a cart. */
  readonly productId: string;
  readonly quantity: number;
  /** Every line, in the order the checkout has them (T148). */
  readonly lines: readonly UcpLine[];
  /** The x402 requirement for this checkout, already checked against the store's profile. */
  readonly requirements: PaymentRequirements;
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
  /** The checkout as the store answered it: with AP2, the signed terms the mandate closes over (T134). */
  readonly checkout: Readonly<Record<string, unknown>>;
  /** The store offers AP2 mandates, and these are the P-256 keys its profile publishes (T134). */
  readonly ap2: { readonly offered: boolean; readonly keys: ReadonlyArray<z.infer<typeof storeP256KeySchema>> };
}

export interface QuoteUcpCheckoutInput extends UcpPurchaseLines {
  /** The store's origin: where its `/.well-known/ucp` is. */
  readonly storeUrl: string;
  /** `consent` (T149) is UCP's buyer consent extension, in the shape of the version the store answers in; sent as given. */
  readonly buyer?: { readonly email?: string; readonly first_name?: string; readonly last_name?: string; readonly consent?: Readonly<Record<string, unknown>> };
  readonly destination: UcpDestination;
}

export interface PayUcpQuoteInput {
  /** The already-signed intent this payment is for. */
  readonly intent: PurchaseIntent;
  readonly scope: Scope;
  readonly mandate: AgentPayMandate;
  readonly venueId: VenueId;
  readonly registry?: VenueRegistry;
  /** Sent on Complete Checkout, so a retried request cannot pay twice. */
  readonly idempotencyKey?: string;
  /**
   * Read the store's profile and the checkout again before signing, and
   * refuse with `QuoteChanged` unless they still say exactly what the quote
   * said. For a quote that was kept, not one just made: whatever was stored
   * between the two is not trusted (T128).
   */
  readonly recheck?: boolean;
}

type UcpCall = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;

function caller(fetchImpl: typeof fetch, platformProfile: string = AGENTPEY_PLATFORM_PROFILE): UcpCall {
  return async (method, url, body, headers = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: "application/json", "UCP-Agent": `profile="${platformProfile}"`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw networkError("could not reach the UCP store", { url }, error);
    }
    const json: unknown = await res.json().catch(() => undefined);
    return { status: res.status, json };
  };
}

interface StoreHandler {
  readonly handlerId: string;
  readonly declared: z.infer<typeof handlerConfigSchema>;
  readonly endpoint: string;
  readonly ap2: UcpQuote["ap2"];
}

/** The store's profile: where to talk to it, and where the money goes. */
async function readStoreHandler(call: UcpCall, origin: string): Promise<StoreHandler> {
  const profileReply = await call("GET", `${origin}/.well-known/ucp`);
  const profile = profileSchema.safeParse(profileReply.json);
  if (profileReply.status !== 200 || !profile.success) {
    throw new AgentPassError("MerchantRejectedRequest", "the store does not publish a UCP business profile", { details: { storeUrl: origin, status: profileReply.status } });
  }
  const [handler] = profile.data.ucp.payment_handlers[STELLAR_X402_HANDLER] ?? [];
  if (handler === undefined || !originMatchesNamespace(STELLAR_X402_HANDLER, handler.spec) || !originMatchesNamespace(STELLAR_X402_HANDLER, handler.schema)) {
    throw new AgentPassError("MerchantRejectedRequest", `the store does not declare ${STELLAR_X402_HANDLER} with its spec on agentpey.com`, { details: { storeUrl: origin } });
  }
  const declared = handlerConfigSchema.safeParse(handler.config);
  if (!declared.success) {
    throw new AgentPassError("MerchantRejectedRequest", "the store's Stellar x402 handler config is malformed", { details: { storeUrl: origin } });
  }
  const endpoint = profile.data.ucp.services["dev.ucp.shopping"]?.find((service) => service.transport === "rest")?.endpoint;
  if (endpoint === undefined || !URL.canParse(endpoint) || new URL(endpoint).origin !== new URL(origin).origin) {
    throw new AgentPassError("MerchantRejectedRequest", "the store declares no REST endpoint of its own", { details: { storeUrl: origin } });
  }
  const ap2 = {
    offered: profile.data.ucp.capabilities?.[UCP_AP2_MANDATE] !== undefined,
    keys: (profile.data.keys ?? []).flatMap((key) => {
      const parsed = storeP256KeySchema.safeParse(key);
      return parsed.success ? [parsed.data] : [];
    }),
  };
  return { handlerId: handler.id, declared: declared.data, endpoint, ap2 };
}

/**
 * The checkout's own payment requirement, refused unless the checkout is ready
 * and the requirement names the same recipient, asset and network as the
 * handler the store declares publicly. The checkout response alone is not
 * enough: the store writes it.
 */
function requirementsOf(
  json: unknown,
  status: number,
  store: StoreHandler,
  origin: string,
): { checkout: UcpCheckout; requirements: PaymentRequirements; raw: Readonly<Record<string, unknown>>; lines: readonly UcpLine[] } {
  const checkout = checkoutSchema.safeParse(json);
  if (!checkout.success || status >= 300) {
    throw new AgentPassError("MerchantRejectedRequest", "the store did not open a checkout for this product", {
      details: { storeUrl: origin, status, messages: messagesOf(json) },
    });
  }
  if (checkout.data.status !== "ready_for_complete") {
    throw new AgentPassError("MerchantRejectedRequest", "the store's checkout is not ready to pay", {
      details: { checkoutId: checkout.data.id, status: checkout.data.status, messages: checkout.data.messages ?? [] },
    });
  }
  const resolved = z
    .looseObject({ payment_requirements: requirementsSchema, binding: z.looseObject({ checkout_id: z.string() }) })
    .safeParse(checkout.data.ucp.payment_handlers?.[STELLAR_X402_HANDLER]?.[0]?.config);
  if (!resolved.success || resolved.data.binding.checkout_id !== checkout.data.id) {
    throw new AgentPassError("MerchantRejectedRequest", "the checkout carries no payment requirements for this session", { details: { checkoutId: checkout.data.id } });
  }
  const requirements = resolved.data.payment_requirements as unknown as PaymentRequirements;
  if (requirements.payTo !== store.declared.pay_to || requirements.asset !== store.declared.asset.contract || requirements.network !== store.declared.network) {
    throw new AgentPassError("InvalidProduct", "the checkout asks to pay someone or something other than the store's declared handler", {
      details: { checkoutId: checkout.data.id, payTo: requirements.payTo, declaredPayTo: store.declared.pay_to, asset: requirements.asset, network: requirements.network },
    });
  }
  const lines = checkoutLinesSchema.safeParse((json as { line_items?: unknown }).line_items);
  if (!lines.success) {
    throw new AgentPassError("MerchantRejectedRequest", "the checkout does not say which lines it is for", { details: { checkoutId: checkout.data.id } });
  }
  // `raw` is the store's bytes as parsed, an object (the schema above passed): what AP2 closes over must be exactly
  // what the store signed, and zod's output may drop or reorder members.
  return {
    checkout: checkout.data,
    requirements,
    raw: json as Readonly<Record<string, unknown>>,
    lines: lines.data.map((line) => ({ productId: line.item.id, quantity: line.quantity })),
  };
}

function totalOf(checkout: UcpCheckout): { amount: number; currency: string } {
  return { amount: checkout.totals.find((line) => line.type === "total")?.amount ?? 0, currency: checkout.currency };
}

/**
 * Opens a UCP checkout for one product, or a cart (T148), and reads back what it would cost,
 * checked against the store's public profile. Signs nothing and moves no
 * money: the first half of {@link executeUcpPayment} (T128).
 *
 * @throws AgentPassError `MerchantRejectedRequest`, `InvalidProduct` or
 * `NetworkError`, as {@link executeUcpPayment} does before signing.
 */
export async function quoteUcpCheckout(deps: { readonly fetchImpl?: typeof fetch; readonly platformProfile?: string }, input: QuoteUcpCheckoutInput): Promise<UcpQuote> {
  const lines = ucpLinesOf(input);
  const call = caller(deps.fetchImpl ?? fetch, deps.platformProfile);
  const origin = input.storeUrl.replace(/\/+$/, "");
  const store = await readStoreHandler(call, origin);
  const { consent, ...buyer } = input.buyer ?? {};
  const session = (withConsent: boolean) => ({
    line_items: lines.map((line) => ({ item: { id: line.productId }, quantity: line.quantity })),
    ...(input.buyer === undefined ? {} : { buyer: withConsent && consent !== undefined ? { ...buyer, consent } : buyer }),
    fulfillment: { methods: [{ type: "shipping", destinations: [input.destination] }] },
  });
  let reply = await call("POST", `${store.endpoint}/checkout-sessions`, session(false));
  // The buyer's consent (T149) goes in an update: UCP 2026-08-25 has a store count only the consent options it
  // advertised in an earlier answer, and the create's answer is where it advertises them. Before any mandate is opened.
  if (consent !== undefined) {
    const opened = requirementsOf(reply.json, reply.status, store, origin).checkout;
    reply = await call("PUT", `${store.endpoint}/checkout-sessions/${encodeURIComponent(opened.id)}`, session(true));
    const updated = checkoutSchema.safeParse(reply.json);
    if (updated.success && updated.data.id !== opened.id) {
      throw new AgentPassError("MerchantRejectedRequest", "the store answered the consent update with another checkout", { details: { checkoutId: opened.id, answered: updated.data.id } });
    }
  }
  const { checkout, requirements, raw, lines: opened } = requirementsOf(reply.json, reply.status, store, origin);
  // The store's own answer says what it will charge for: it must be the lines asked for (T148 review).
  if (!sameLines(lines, opened)) {
    throw new AgentPassError("InvalidProduct", "the store opened a checkout for other lines than the ones asked for", {
      details: { checkoutId: checkout.id, asked: linePairs(lines), opened: linePairs(opened) },
    });
  }
  return {
    storeUrl: origin,
    endpoint: store.endpoint,
    handlerId: store.handlerId,
    checkoutId: checkout.id,
    productId: opened[0]!.productId,
    quantity: opened[0]!.quantity,
    lines: opened,
    requirements,
    total: totalOf(checkout),
    checkout: raw,
    ap2: store.ap2,
  };
}

/**
 * Pays a quote: reconciles its requirement against the venue and the Mandate,
 * signs exactly that requirement and completes the checkout. The second half
 * of {@link executeUcpPayment} (T128).
 *
 * With `recheck`, the store's profile and the checkout are read again first,
 * and the payment is refused with `QuoteChanged` unless recipient, asset,
 * network and amount are still the quote's.
 *
 * @throws AgentPassError as {@link executeUcpPayment}; every error carries
 * `paymentSent` (`C-113`).
 */
export async function payUcpQuote(deps: ExecuteUcpPaymentDeps, quote: UcpQuote, input: PayUcpQuoteInput): Promise<UcpPaymentReceipt> {
  let paymentSent = false;
  try {
    return await payAndMark();
  } catch (error) {
    throw withPaymentSent(error, paymentSent);
  }

  async function payAndMark(): Promise<UcpPaymentReceipt> {
    // The checkout is for what the signed intent says, line by line (T148): the amount alone is reconciled below,
    // and two carts can cost the same. `quote.lines` are the store's own, read from its answer; with `recheck`, the
    // lines it answers now are compared again below.
    const intended = intentLines(input.intent.purchase);
    const forIntent = (lines: readonly UcpLine[]): void => {
      if (!sameLines(intended, lines)) {
        throw new AgentPassError("InvalidProduct", "the checkout is for other lines than the signed intent", {
          details: { checkoutId: quote.checkoutId, intent: linePairs(intended), checkout: linePairs(lines) },
        });
      }
    };
    forIntent(quote.lines);
    const call = caller(deps.fetchImpl ?? fetch, deps.platformProfile);
    let requirements = quote.requirements;
    let handlerId = quote.handlerId;
    let latest = quote.checkout;
    let storeAp2 = quote.ap2;
    if (input.recheck === true) {
      const store = await readStoreHandler(call, quote.storeUrl);
      if (store.endpoint !== quote.endpoint) {
        throw new AgentPassError("QuoteChanged", "the store now declares another REST endpoint than when it quoted", { details: { checkoutId: quote.checkoutId } });
      }
      const current = await call("GET", `${store.endpoint}/checkout-sessions/${encodeURIComponent(quote.checkoutId)}`);
      let fresh: PaymentRequirements;
      let freshRaw: Readonly<Record<string, unknown>>;
      let freshLines: readonly UcpLine[];
      try {
        ({ requirements: fresh, raw: freshRaw, lines: freshLines } = requirementsOf(current.json, current.status, store, quote.storeUrl));
      } catch (error) {
        throw new AgentPassError("QuoteChanged", "the store's checkout no longer matches what it quoted", { cause: error, details: { checkoutId: quote.checkoutId } });
      }
      const same = (["payTo", "asset", "network", "amount", "scheme"] as const).every((field) => fresh[field] === quote.requirements[field]);
      if (!same) {
        throw new AgentPassError("QuoteChanged", "the store now asks for another recipient, asset, network or amount than it quoted", {
          details: { checkoutId: quote.checkoutId, quoted: { payTo: quote.requirements.payTo, amount: quote.requirements.amount }, now: { payTo: fresh.payTo, amount: fresh.amount } },
        });
      }
      // The same total can be another cart: the lines the store would charge now must still be the intent's.
      forIntent(freshLines);
      requirements = fresh;
      handlerId = store.handlerId;
      latest = freshRaw;
      storeAp2 = store.ap2;
    }

    // AP2 (T134, R-15): before the rail authorises or anything is signed. The intent is taken first (brecha 14),
    // then the store's signature on the checkout is checked against its published key, and the mandate closed over it.
    const ap2Mandate = deps.ap2 === undefined ? undefined : await closeMandate(deps.ap2, storeAp2, latest, quote, input);

    // With the venue's pinned account and assets, and with the Mandate.
    const terms = toPaymentTerms(requirements, input.venueId, input.registry ?? DEFAULT_VENUE_REGISTRY);
    const decision = await deps.policyRail.authorise({ intent: input.intent, scope: input.scope, mandate: input.mandate, terms });
    if (!decision.authorised) throw policyRailError(decision);

    // Sign exactly the authorised requirement, capped at its own amount.
    const scheme =
      deps.schemeForTests ??
      (deps.payer === undefined ? new ExactStellarScheme(createEd25519Signer(deps.signerSecret, STELLAR_TESTNET_CAIP2)) : new PolicyRailStellarScheme(deps.payer));
    const client = x402Client.fromConfig({ schemes: [{ network: STELLAR_TESTNET_CAIP2, client: scheme }] });
    client.setSpendControls(spendControlsFor(requirements));
    const completeUrl = `${quote.endpoint}/checkout-sessions/${encodeURIComponent(quote.checkoutId)}/complete`;
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: completeUrl, description: `UCP checkout ${quote.checkoutId}`, mimeType: "application/json" },
      accepts: [requirements],
    };
    const payload = await new x402HTTPClient(client).createPaymentPayload(paymentRequired);
    const transaction = (payload.payload as { transaction?: unknown }).transaction;
    if (typeof transaction !== "string") throw new AgentPassError("PaymentNotCreated", "the payment scheme produced no transaction", { details: {} });

    // The door. From here on money may have moved.
    paymentSent = true;
    const completed = await call(
      "POST",
      completeUrl,
      {
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
        ...(ap2Mandate === undefined ? {} : { ap2: { checkout_mandate: ap2Mandate } }),
      },
      input.idempotencyKey === undefined ? {} : { "Idempotency-Key": input.idempotencyKey },
    );
    const done = checkoutSchema.safeParse(completed.json);
    if (!done.success || done.data.status !== "completed" || done.data.order === undefined) {
      throw networkError("the store did not confirm the completed checkout", {
        checkoutId: quote.checkoutId,
        status: completed.status,
        checkoutStatus: done.success ? done.data.status : undefined,
        messages: messagesOf(completed.json),
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
      ...(ap2Mandate === undefined ? {} : { ap2Mandate }),
    };
  }
}

/** Seven-decimal Stellar units per AP2 minor unit (cents, E-12). */
const STELLAR_UNITS_PER_CENT = 100_000n;

/** What the agent reads of a checkout the store signed, before closing a mandate over it. */
const signedCheckoutSchema = z.looseObject({
  id: z.string().min(1),
  ap2: z.looseObject({ merchant_authorization: z.string().regex(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/) }).optional(),
  merchant: z.looseObject({ name: z.string().min(1).optional() }).optional(),
  line_items: z.array(z.looseObject({ item: z.looseObject({ id: z.string().min(1), title: z.string().min(1).optional() }), quantity: z.int().positive() })).min(1),
});

/**
 * The agent's side of AP2 in the UCP checkout (T134, R-15): take the intent
 * (one closed mandate per intent, brecha 14, decided before any await so two
 * payments at once cannot both pass), check the store's signature on the
 * checkout against its published key, then have the platform sign an open
 * checkout mandate for exactly these lines (items and quantities) and this store, and close it
 * over the signed checkout for this store (`aud`) and this checkout (`nonce`).
 */
async function closeMandate(ap2: UcpAp2Options, store: UcpQuote["ap2"], checkout: Readonly<Record<string, unknown>>, quote: UcpQuote, input: PayUcpQuoteInput): Promise<string> {
  if (!store.offered) {
    throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "this payment must carry an AP2 mandate and the store does not offer AP2", { details: { storeUrl: quote.storeUrl } });
  }
  const intentId = input.intent.intentId;
  if (ap2.closed.has(intentId)) {
    throw new AgentPassError("Ap2MandateInvalid", "this intent already closed an AP2 mandate; a second one is not issued (brecha 14)", { details: { intentId } });
  }
  ap2.closed.add(intentId);

  const signed = signedCheckoutSchema.safeParse(checkout);
  if (!signed.success || signed.data.id !== quote.checkoutId) {
    throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "the store's checkout is not the quoted one, or is unreadable", { details: { checkoutId: quote.checkoutId } });
  }
  const authorization = signed.data.ap2?.merchant_authorization;
  if (authorization === undefined) {
    throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "the store offers AP2 but did not sign its checkout (merchant_authorization_missing)", { details: { checkoutId: quote.checkoutId } });
  }
  let kid: unknown;
  try {
    kid = decodeProtectedHeader(`${authorization.split("..")[0]}.e30.`).kid;
  } catch {
    kid = undefined;
  }
  const key = store.keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "the store's profile publishes no key for its checkout signature", { details: { kid } });
  await verifyMerchantAuthorization(checkout, key);

  // The store's lines must be the quoted ones, in order: the open mandate allows exactly those (T148).
  const signedLines = signed.data.line_items;
  if (signedLines.length !== quote.lines.length || signedLines.some((line, i) => line.item.id !== quote.lines[i]!.productId || line.quantity !== quote.lines[i]!.quantity)) {
    throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "the store's signed checkout is not for the quoted lines", { details: { checkoutId: quote.checkoutId } });
  }
  const now = new Date();
  const maxCents = BigInt(quote.requirements.amount) / STELLAR_UNITS_PER_CENT;
  const open = (
    await issueOpenMandatePair(
      {
        issuer: ap2.issuer,
        source: ap2.source,
        agentKey: ap2.holder.publicJwk,
        merchant: { id: quote.storeUrl, name: signed.data.merchant?.name ?? new URL(quote.storeUrl).host, website: quote.storeUrl },
        // One line keeps the one-item form, exactly as before T148; a cart names each of its lines.
        ...(signedLines.length === 1
          ? { item: { id: quote.productId, title: signedLines[0]!.item.title ?? quote.productId }, quantity: quote.quantity }
          : { lines: signedLines.map((line) => ({ item: { id: line.item.id, title: line.item.title ?? line.item.id }, quantity: line.quantity })) }),
        // Only the checkout half is sent (R-15, point 4: no payment mandate in stellar_x402); its amount is a ceiling.
        maxAmount: maxCents + 1n,
        currency: "USDC",
        paymentInstrument: { id: quote.handlerId, type: "stellar_x402" },
        issuedAt: now,
        expiresAt: new Date(Math.min(now.getTime() + 15 * 60_000, Date.parse(input.intent.expiresAt))),
      },
      ap2.platform,
    )
  ).checkout;
  return closeCheckoutMandate({ open, holder: ap2.holder, checkoutJwt: checkoutJwtFrom(checkout), aud: quote.storeUrl, nonce: quote.checkoutId, issuedAt: now });
}

/**
 * Pays one product, or a cart (T148), at a UCP store with the Stellar x402 handler:
 * {@link quoteUcpCheckout} then {@link payUcpQuote}, with nothing kept in
 * between, so the quote is not read again.
 *
 * @throws AgentPassError `MerchantRejectedRequest` when the store does not
 * declare the handler properly, or does not make the checkout ready.
 * @throws AgentPassError `InvalidProduct` when the requirements disagree with
 * the store's profile or the venue's pinned account.
 * @throws AgentPassError with the rail's own code when `authorise()` refuses.
 * @throws AgentPassError `NetworkError` for anything network-shaped, and when
 * the store does not confirm the completed checkout.
 * Every error carries `paymentSent` (`C-113`): whether a signed payment may
 * have left this process.
 */
export async function executeUcpPayment(deps: ExecuteUcpPaymentDeps, input: ExecuteUcpPaymentInput): Promise<UcpPaymentReceipt> {
  let quote: UcpQuote;
  try {
    quote = await quoteUcpCheckout(deps, input);
  } catch (error) {
    throw withPaymentSent(error, false);
  }
  return payUcpQuote(deps, quote, input);
}

function messagesOf(json: unknown): unknown[] {
  const messages = (json as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? messages.slice(0, 5) : [];
}
