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
import type { AgentPayMandate } from "@agentpey/mandate";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ExactStellarScheme, STELLAR_TESTNET_CAIP2, createEd25519Signer } from "@x402/stellar";
import { z } from "zod";

import { DEFAULT_VENUE_REGISTRY } from "../catalog/default-registry.js";
import type { VenueId } from "../catalog/ids.js";
import type { VenueRegistry } from "../catalog/registry.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { policyRailError, type PolicyRail } from "../policy/policy-rail.js";
import { PolicyRailStellarScheme, type PolicyRailPayer } from "./policy-rail-payer.js";
import { spendControlsFor, toPaymentTerms, withPaymentSent } from "./x402.js";

export const UCP_VERSION = "2026-04-08";
export const STELLAR_X402_HANDLER = "com.agentpey.stellar_x402";
/** AgentPey's platform profile, sent with every request as UCP asks. */
export const AGENTPEY_PLATFORM_PROFILE = "https://agentpey.com/ucp/platform/agentpey.json";

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
  /** Tests only: the scheme that builds the payment, in place of the real Stellar one. */
  readonly schemeForTests?: SchemeNetworkClient;
}

export interface ExecuteUcpPaymentInput {
  /** The store's origin: where its `/.well-known/ucp` is. */
  readonly storeUrl: string;
  readonly productId: string;
  readonly quantity: number;
  readonly buyer?: { readonly email?: string; readonly first_name?: string; readonly last_name?: string };
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
  readonly productId: string;
  readonly quantity: number;
  /** The x402 requirement for this checkout, already checked against the store's profile. */
  readonly requirements: PaymentRequirements;
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
}

export interface QuoteUcpCheckoutInput {
  /** The store's origin: where its `/.well-known/ucp` is. */
  readonly storeUrl: string;
  readonly productId: string;
  readonly quantity: number;
  readonly buyer?: { readonly email?: string; readonly first_name?: string; readonly last_name?: string };
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

function caller(fetchImpl: typeof fetch): UcpCall {
  return async (method, url, body, headers = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: "application/json", "UCP-Agent": `profile="${AGENTPEY_PLATFORM_PROFILE}"`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
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
  return { handlerId: handler.id, declared: declared.data, endpoint };
}

/**
 * The checkout's own payment requirement, refused unless the checkout is ready
 * and the requirement names the same recipient, asset and network as the
 * handler the store declares publicly. The checkout response alone is not
 * enough: the store writes it.
 */
function requirementsOf(json: unknown, status: number, store: StoreHandler, origin: string): { checkout: UcpCheckout; requirements: PaymentRequirements } {
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
  return { checkout: checkout.data, requirements };
}

function totalOf(checkout: UcpCheckout): { amount: number; currency: string } {
  return { amount: checkout.totals.find((line) => line.type === "total")?.amount ?? 0, currency: checkout.currency };
}

/**
 * Opens a UCP checkout for one product and reads back what it would cost,
 * checked against the store's public profile. Signs nothing and moves no
 * money: the first half of {@link executeUcpPayment} (T128).
 *
 * @throws AgentPassError `MerchantRejectedRequest`, `InvalidProduct` or
 * `NetworkError`, as {@link executeUcpPayment} does before signing.
 */
export async function quoteUcpCheckout(deps: { readonly fetchImpl?: typeof fetch }, input: QuoteUcpCheckoutInput): Promise<UcpQuote> {
  const call = caller(deps.fetchImpl ?? fetch);
  const origin = input.storeUrl.replace(/\/+$/, "");
  const store = await readStoreHandler(call, origin);
  const created = await call("POST", `${store.endpoint}/checkout-sessions`, {
    line_items: [{ item: { id: input.productId }, quantity: input.quantity }],
    ...(input.buyer === undefined ? {} : { buyer: input.buyer }),
    fulfillment: { methods: [{ type: "shipping", destinations: [input.destination] }] },
  });
  const { checkout, requirements } = requirementsOf(created.json, created.status, store, origin);
  return {
    storeUrl: origin,
    endpoint: store.endpoint,
    handlerId: store.handlerId,
    checkoutId: checkout.id,
    productId: input.productId,
    quantity: input.quantity,
    requirements,
    total: totalOf(checkout),
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
    const call = caller(deps.fetchImpl ?? fetch);
    let requirements = quote.requirements;
    let handlerId = quote.handlerId;
    if (input.recheck === true) {
      const store = await readStoreHandler(call, quote.storeUrl);
      if (store.endpoint !== quote.endpoint) {
        throw new AgentPassError("QuoteChanged", "the store now declares another REST endpoint than when it quoted", { details: { checkoutId: quote.checkoutId } });
      }
      const current = await call("GET", `${store.endpoint}/checkout-sessions/${encodeURIComponent(quote.checkoutId)}`);
      let fresh: PaymentRequirements;
      try {
        fresh = requirementsOf(current.json, current.status, store, quote.storeUrl).requirements;
      } catch (error) {
        throw new AgentPassError("QuoteChanged", "the store's checkout no longer matches what it quoted", { cause: error, details: { checkoutId: quote.checkoutId } });
      }
      const same = (["payTo", "asset", "network", "amount", "scheme"] as const).every((field) => fresh[field] === quote.requirements[field]);
      if (!same) {
        throw new AgentPassError("QuoteChanged", "the store now asks for another recipient, asset, network or amount than it quoted", {
          details: { checkoutId: quote.checkoutId, quoted: { payTo: quote.requirements.payTo, amount: quote.requirements.amount }, now: { payTo: fresh.payTo, amount: fresh.amount } },
        });
      }
      requirements = fresh;
      handlerId = store.handlerId;
    }

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
    };
  }
}

/**
 * Pays one product at a UCP store with the Stellar x402 handler:
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
