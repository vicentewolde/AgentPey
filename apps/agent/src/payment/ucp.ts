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
import { z } from "zod";

import { DEFAULT_VENUE_REGISTRY } from "../catalog/default-registry.js";
import type { VenueId } from "../catalog/ids.js";
import type { VenueRegistry } from "../catalog/registry.js";
import type { PurchaseIntent } from "../intent/intent.js";
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
  /** Intent ids a mandate was already closed for, by this agent. */
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
  /** Close AP2 mandates when the store signs its checkout (T134). Pair it with {@link AGENTPEY_PLATFORM_PROFILE_AP2}. */
  readonly ap2?: UcpAp2Options;
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
  readonly productId: string;
  readonly quantity: number;
  /** The x402 requirement for this checkout, already checked against the store's profile. */
  readonly requirements: PaymentRequirements;
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
  /** The checkout as the store answered it: with AP2, the signed terms the mandate closes over (T134). */
  readonly checkout: Readonly<Record<string, unknown>>;
  /** The store offers AP2 mandates, and these are the P-256 keys its profile publishes (T134). */
  readonly ap2: { readonly offered: boolean; readonly keys: ReadonlyArray<z.infer<typeof storeP256KeySchema>> };
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
export async function quoteUcpCheckout(deps: { readonly fetchImpl?: typeof fetch; readonly platformProfile?: string }, input: QuoteUcpCheckoutInput): Promise<UcpQuote> {
  const call = caller(deps.fetchImpl ?? fetch, deps.platformProfile);
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
    checkout: created.json as Record<string, unknown>,
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
      latest = current.json as Record<string, unknown>;
      storeAp2 = store.ap2;
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

    // AP2 (T134, R-15): after the rail authorised and before anything leaves, close the mandate over the
    // checkout the store signed, having checked that signature against the key its profile publishes.
    const ap2Mandate = deps.ap2 !== undefined && storeAp2.offered ? await closeMandate(deps.ap2, storeAp2, latest, quote, input) : undefined;

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

/**
 * The agent's side of AP2 in the UCP checkout (T134, R-15): check the store's
 * signature on the checkout against its published key, then have the
 * platform sign an open checkout mandate for exactly this item, quantity and
 * store, and close it over the signed checkout for this store (`aud`) and
 * this checkout (`nonce`). One closed mandate per intent (brecha 14).
 */
async function closeMandate(ap2: UcpAp2Options, store: UcpQuote["ap2"], checkout: Readonly<Record<string, unknown>>, quote: UcpQuote, input: PayUcpQuoteInput): Promise<string> {
  if (ap2.closed.has(input.intent.intentId)) {
    throw new AgentPassError("Ap2MandateInvalid", "this intent already closed an AP2 mandate; a second one is not issued (brecha 14)", { details: { intentId: input.intent.intentId } });
  }
  const authorization = (checkout.ap2 as { merchant_authorization?: unknown } | undefined)?.merchant_authorization;
  if (typeof authorization !== "string") {
    throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "the store offers AP2 but did not sign its checkout (merchant_authorization_missing)", { details: { checkoutId: quote.checkoutId } });
  }
  let kid: unknown;
  try {
    kid = (JSON.parse(Buffer.from(authorization.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: unknown }).kid;
  } catch {
    kid = undefined;
  }
  const key = store.keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) throw new AgentPassError("Ap2MerchantAuthorizationInvalid", "the store's profile publishes no key for its checkout signature", { details: { kid } });
  await verifyMerchantAuthorization(checkout, key);

  const now = new Date();
  const line = (checkout.line_items as Array<{ item?: { title?: unknown } }> | undefined)?.[0];
  const maxCents = BigInt(quote.requirements.amount) / STELLAR_UNITS_PER_CENT;
  const open = (
    await issueOpenMandatePair(
      {
        issuer: ap2.issuer,
        source: ap2.source,
        agentKey: ap2.holder.publicJwk,
        merchant: { id: quote.storeUrl, name: String((checkout.merchant as { name?: unknown } | undefined)?.name ?? new URL(quote.storeUrl).host), website: quote.storeUrl },
        item: { id: quote.productId, title: typeof line?.item?.title === "string" ? line.item.title : quote.productId },
        quantity: quote.quantity,
        maxAmount: maxCents > 0n ? maxCents : 1n,
        currency: "USDC",
        paymentInstrument: { id: quote.handlerId, type: "stellar_x402" },
        issuedAt: now,
        expiresAt: new Date(Math.min(now.getTime() + 15 * 60_000, Date.parse(input.intent.expiresAt))),
      },
      ap2.platform,
    )
  ).checkout;
  const chain = await closeCheckoutMandate({ open, holder: ap2.holder, checkoutJwt: checkoutJwtFrom(checkout), aud: quote.storeUrl, nonce: quote.checkoutId, issuedAt: now });
  ap2.closed.add(input.intent.intentId);
  return chain;
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
