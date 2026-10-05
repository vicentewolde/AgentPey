/**
 * Paying a UCP checkout on Stellar (T122, Fase 7, E-1): the buyer's side of
 * the `com.agentpey.stellar_x402` payment handler.
 *
 * Since T136 (R-21) the protocol half lives in the public package
 * `@agentpey/ucp-stellar`: reading the store's profile, checking the handler
 * and the checkout against it, signing and completing. This module keeps what
 * is AgentPey's own, and runs it in the package's `beforeSign` hook, after the
 * package's checks and before anything is signed:
 *
 * 1. The requirements name the same recipient, asset and network as the
 *    handler the store declares at its `/.well-known/ucp` (the package, the
 *    handler spec's step 2). The checkout response alone is not enough: the
 *    store writes it.
 * 2. The checkout is for the signed intent's lines (T148).
 * 3. AP2, when asked for (T134).
 * 4. `toPaymentTerms` pins the recipient to the venue's own account and maps
 *    the asset through the venue registry, as for any x402 venue.
 * 5. `policyRail.authorise` reconciles them against the signed intent, the
 *    scope and the Mandate. Untouched by this module (P-14).
 *
 * Paying from a `policy_rail`, the network then checks `perTx`/`perDay` a
 * last time, inside the transfer. Every error is an `AgentPassError` with the
 * package's code, and carries `paymentSent` (`C-113`).
 *
 * Nothing in this file knows Vitrinee: it speaks UCP and the handler spec, so
 * any business that declares the handler can be paid the same way (C-88).
 */
import { AgentPassError } from "@agentpass/core";
import type { Scope } from "@agentpass/core";
import { checkoutJwtFrom, closeCheckoutMandate, issueOpenMandatePair, verifyMerchantAuthorization } from "@agentpey/ap2";
import type { AgentPeyMandateRef, Ap2Signer } from "@agentpey/ap2";
import type { AgentPayMandate } from "@agentpey/mandate";
import {
  MAX_UCP_LINES as PACKAGE_MAX_UCP_LINES,
  STELLAR_X402_HANDLER as PACKAGE_STELLAR_X402_HANDLER,
  isUcpStellarError,
  originMatchesNamespace as packageOriginMatchesNamespace,
  pay,
  quote as quoteCheckout,
  type UcpBusinessProfile,
  type UcpReceipt,
  type UcpStellarError,
} from "@agentpey/ucp-stellar";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ExactStellarScheme, STELLAR_TESTNET_CAIP2, createEd25519Signer } from "@x402/stellar";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";

import { DEFAULT_VENUE_REGISTRY } from "../catalog/default-registry.js";
import type { VenueId } from "../catalog/ids.js";
import type { VenueRegistry } from "../catalog/registry.js";
import { intentLines, type PurchaseIntent } from "../intent/intent.js";
import { policyRailError, type PolicyRail } from "../policy/policy-rail.js";
import { PolicyRailStellarScheme, type PolicyRailPayer } from "./policy-rail-payer.js";
import { toPaymentTerms, withPaymentSent } from "./x402.js";

export const STELLAR_X402_HANDLER = PACKAGE_STELLAR_X402_HANDLER;
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

// ---------------------------------------------------------------- wire shapes

/** A store's P-256 key, as its profile publishes it for AP2 (T134). */
const storeP256KeySchema = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().min(1),
});

/** Whether two lists name the same lines, in the same order. */
function sameLines(a: readonly UcpLine[], b: readonly UcpLine[]): boolean {
  return a.length === b.length && a.every((line, i) => line.productId === b[i]!.productId && line.quantity === b[i]!.quantity);
}

const linePairs = (lines: readonly UcpLine[]) => lines.map((line) => [line.productId, line.quantity]);

/** Whether the store offers AP2, and the P-256 keys its profile publishes (T134). */
function ap2Of(profile: UcpBusinessProfile): UcpQuote["ap2"] {
  return {
    offered: profile.ucp.capabilities?.[UCP_AP2_MANDATE] !== undefined,
    keys: (profile.keys ?? []).flatMap((key) => {
      const parsed = storeP256KeySchema.safeParse(key);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

/**
 * The package's error as the agent's: same code, message, cause and details. `paymentSent` is stamped by the
 * caller, from the package's own answer.
 */
function fromPackage(error: UcpStellarError): AgentPassError {
  return new AgentPassError(error.code, error.message, { cause: error.cause, details: { ...error.details } });
}

/**
 * Any error out of the package, as an `AgentPassError` stamped with `paymentSent`. The package's own errors say
 * whether the payment was sent. Anything else is judged by this module's own door, `signed`: before the payer
 * signed, it came out of the hook or the payer and nothing was sent; after, it fails closed (`C-113`, `M-15`), so a
 * future version of the package that let a raw error escape after sending could not release a spend that settled.
 */
function settled(error: unknown, signed: boolean): unknown {
  if (isUcpStellarError(error)) return withPaymentSent(fromPackage(error), error.paymentSent);
  return withPaymentSent(error, signed);
}

/** The payer, reporting when it has produced a signed payment: the agent's own door, kept apart from the package's. */
function reportingSigned(payer: SchemeNetworkClient, onSigned: () => void): SchemeNetworkClient {
  return {
    scheme: payer.scheme,
    ...(payer.schemeHooks === undefined ? {} : { schemeHooks: payer.schemeHooks }),
    ...(payer.findDefaultAsset === undefined ? {} : { findDefaultAsset: payer.findDefaultAsset.bind(payer) }),
    createPaymentPayload: async (...args) => {
      const payload = await payer.createPaymentPayload(...args);
      onSigned();
      return payload;
    },
  };
}

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
export const MAX_UCP_LINES = PACKAGE_MAX_UCP_LINES;

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
  readonly receipt: UcpReceipt | undefined;
  /** The closed AP2 checkout mandate sent in `complete`, when the store asked for one (T134). */
  readonly ap2Mandate?: string;
}

/** UCP's spec-URL binding: HTTPS, default port, exactly the name's domain. */
export const originMatchesNamespace = packageOriginMatchesNamespace;

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
  try {
    const quoted = await quoteCheckout(
      { storeUrl: input.storeUrl, lines: [...lines], destination: input.destination, ...(input.buyer === undefined ? {} : { buyer: input.buyer }) },
      { platformProfile: deps.platformProfile ?? AGENTPEY_PLATFORM_PROFILE, ...(deps.fetchImpl === undefined ? {} : { fetch: deps.fetchImpl }) },
    );
    return {
      storeUrl: quoted.storeUrl,
      endpoint: quoted.endpoint,
      handlerId: quoted.handlerId,
      checkoutId: quoted.checkoutId,
      productId: quoted.lines[0]!.productId,
      quantity: quoted.lines[0]!.quantity,
      lines: quoted.lines,
      requirements: quoted.requirements,
      total: quoted.total,
      checkout: quoted.checkout,
      ap2: ap2Of(quoted.profile),
    };
  } catch (error) {
    throw isUcpStellarError(error) ? fromPackage(error) : error;
  }
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
  let signed = false;
  try {
    // The checkout is for what the signed intent says, line by line (T148): the amount alone is reconciled below,
    // and two carts can cost the same. `quote.lines` are the store's own, read from its answer; with `recheck`, the
    // package refuses lines that changed since the quote, and they are compared with the intent again below.
    const intended = intentLines(input.intent.purchase);
    const forIntent = (lines: readonly UcpLine[]): void => {
      if (!sameLines(intended, lines)) {
        throw new AgentPassError("InvalidProduct", "the checkout is for other lines than the signed intent", {
          details: { checkoutId: quote.checkoutId, intent: linePairs(intended), checkout: linePairs(lines) },
        });
      }
    };
    forIntent(quote.lines);

    let ap2Mandate: string | undefined;
    const scheme: SchemeNetworkClient =
      deps.schemeForTests ??
      (deps.payer === undefined ? new ExactStellarScheme(createEd25519Signer(deps.signerSecret, STELLAR_TESTNET_CAIP2)) : new PolicyRailStellarScheme(deps.payer));
    const paid = await pay(quote, {
      payer: reportingSigned(scheme, () => (signed = true)),
      // The ceiling here is `authorise()`, which reconciles the amount with the signed intent: the package's own
      // cap is the quoted amount, which `recheck` already holds the store to.
      maxAmount: BigInt(quote.requirements.amount),
      recheck: input.recheck === true,
      platformProfile: deps.platformProfile ?? AGENTPEY_PLATFORM_PROFILE,
      ...(deps.fetchImpl === undefined ? {} : { fetch: deps.fetchImpl }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      beforeSign: async ({ requirements, checkout, lines, profile }) => {
        // The same total can be another cart: the lines the store would charge now must still be the intent's.
        forIntent(lines);
        // AP2 (T134, R-15): before the rail authorises or anything is signed. The intent is taken first (brecha 14),
        // then the store's signature on the checkout is checked against its published key, and the mandate closed over it.
        if (deps.ap2 !== undefined) {
          ap2Mandate = await closeMandate(deps.ap2, profile === undefined ? quote.ap2 : ap2Of(profile), checkout, quote, input, requirements);
        }
        // With the venue's pinned account and assets, and with the Mandate.
        const terms = toPaymentTerms(requirements, input.venueId, input.registry ?? DEFAULT_VENUE_REGISTRY);
        const decision = await deps.policyRail.authorise({ intent: input.intent, scope: input.scope, mandate: input.mandate, terms });
        if (!decision.authorised) throw policyRailError(decision);
        return ap2Mandate === undefined ? undefined : { completeExtensions: { ap2: { checkout_mandate: ap2Mandate } } };
      },
    });
    return { ...paid, ...(ap2Mandate === undefined ? {} : { ap2Mandate }) };
  } catch (error) {
    throw settled(error, signed);
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
async function closeMandate(
  ap2: UcpAp2Options,
  store: UcpQuote["ap2"],
  checkout: Readonly<Record<string, unknown>>,
  quote: UcpQuote,
  input: PayUcpQuoteInput,
  requirements: PaymentRequirements,
): Promise<string> {
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
  const maxCents = BigInt(requirements.amount) / STELLAR_UNITS_PER_CENT;
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
