/**
 * Executing a real x402 payment against a live resource — the piece that
 * turns a signed `PurchaseIntent` into money actually moving on Stellar
 * testnet. T15 gave the agent a read-only view of the bazaar; this is what
 * comes after: hit the resource, get the real `402` challenge, reconcile it
 * against what was signed, and only then pay.
 *
 * `LocalPolicyRail`/`reconcileTerms`/`SpendLedger` are not touched — they
 * already accept `terms` (`M-13`/`M-14`); nothing in phase 2/3 ever had a
 * real challenge to pass them. This module is exactly the adapter `terms.ts`
 * names as T15's job: `PaymentRequirements` (x402's shape) in,
 * {@link PaymentTerms} (ours) out — plus the part that actually signs and
 * sends, which nothing before this milestone did.
 *
 * **Fail-closed by construction, not by convention.** The challenge is
 * reconciled and authorised *before* `@x402/stellar` is ever asked to sign
 * anything. A venue that changed its mind about the price between quoting
 * the catalogue and answering the `402` gets caught by `reconcileTerms`
 * (`M-14`) here, for the first time with a real challenge instead of
 * `terms: undefined` — no signature exists to reconsider.
 *
 * By default the buyer is the agent's own classic (`G...`) account.
 * `ClientStellarSigner` is duck-typed by `@x402/stellar` — `{ address,
 * signAuthEntry, signTransaction? }` — so the agent's secret key is handed to
 * `createEd25519Signer` directly, never through a `Keypair` instance from this
 * repo's own (newer) `@stellar/stellar-sdk` copy, sidestepping any
 * cross-package `instanceof` mismatch between the two installed SDK versions.
 *
 * Pass `deps.payer` and `policy_rail` (`M-21`/`M-22`) pays instead, enforcing
 * `perTx`/`perDay` on-chain inside the same transaction that moves the money
 * — see `./policy-rail-payer.ts` for why that needs its own signing path.
 */
import { AgentPassError, isAgentPassError } from "@agentpass/core";
import type { Scope } from "@agentpass/core";
import type { AgentPayMandate } from "@agentpey/mandate";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactStellarScheme, STELLAR_TESTNET_CAIP2, createEd25519Signer } from "@x402/stellar";

import { mapAssetContract, type BazaarServiceRoute } from "../catalog/bazaar.js";
import type { VenueId } from "../catalog/ids.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { fromScaledAmount } from "../scope/amount.js";
import { policyRailError, type PolicyRail } from "../policy/policy-rail.js";
import type { PaymentTerms } from "../policy/terms.js";
import { PolicyRailStellarScheme, type PolicyRailPayer } from "./policy-rail-payer.js";

function networkError(message: string, extra?: Record<string, unknown>, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details: { ...extra } });
}

/**
 * Maps a live x402 `PaymentRequirements` to the `PaymentTerms` `authorise()`
 * already understands. Pure — no network, no signing.
 *
 * @throws AgentPassError `InvalidProduct` for a scheme/network this adapter
 * does not speak, or an asset contract it has no issuer for (`mapAssetContract`).
 */
export function toPaymentTerms(requirements: PaymentRequirements, venueId: VenueId): PaymentTerms {
  if (requirements.scheme !== "exact") {
    throw new AgentPassError(
      "InvalidProduct",
      `the bazaar's payment challenge uses a scheme this adapter does not speak: "${requirements.scheme}"`,
      { details: { scheme: requirements.scheme, venueId } },
    );
  }
  if (requirements.network !== STELLAR_TESTNET_CAIP2) {
    throw new AgentPassError(
      "InvalidProduct",
      `the bazaar's payment challenge names a network this adapter does not speak: "${requirements.network}"`,
      { details: { network: requirements.network, venueId } },
    );
  }

  let scaled: bigint;
  try {
    scaled = BigInt(requirements.amount);
  } catch (error) {
    throw new AgentPassError(
      "InvalidProduct",
      `the bazaar's payment challenge names an amount that is not an integer: "${requirements.amount}"`,
      { cause: error, details: { amount: requirements.amount, venueId } },
    );
  }

  return {
    venue: venueId,
    asset: mapAssetContract(requirements.asset, venueId),
    amount: fromScaledAmount(scaled),
    payTo: requirements.payTo,
  };
}

/** The single accepted requirement this adapter's registered scheme actually speaks. */
function selectRequirements(paymentRequired: PaymentRequired): PaymentRequirements {
  const match = paymentRequired.accepts.find(
    (candidate) => candidate.scheme === "exact" && candidate.network === STELLAR_TESTNET_CAIP2,
  );
  if (match === undefined) {
    throw new AgentPassError(
      "InvalidProduct",
      "the bazaar's payment challenge offers no scheme/network this adapter speaks",
      { details: { accepts: paymentRequired.accepts.map((r) => ({ scheme: r.scheme, network: r.network })) } },
    );
  }
  return match;
}

export interface ExecuteBazaarPaymentDeps {
  readonly policyRail: PolicyRail;
  /** The agent's own Stellar secret key (`S...`) — it pays with its own classic account. */
  readonly signerSecret: string;
  /**
   * When set, the `policy_rail` smart account pays instead of the agent's
   * classic account (T31): the same limits, enforced by the network inside
   * the transfer instead of by `LocalPolicyRail` beforehand. Everything up to
   * and including `authorise()` is identical either way — only who signs the
   * transfer's authorization changes.
   */
  readonly payer?: PolicyRailPayer;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface ExecuteBazaarPaymentInput {
  /** The full URL of the paid resource, e.g. from a `ServiceCard.routeTemplate` filled in. */
  readonly resourceUrl: string;
  /** The already-signed intent this payment is for — `authorise()` reconciles the challenge against it. */
  readonly intent: PurchaseIntent;
  readonly scope: Scope;
  readonly mandate: AgentPayMandate;
  readonly venueId: VenueId;
}

export interface BazaarPaymentReceipt {
  readonly settled: boolean;
  /** The Stellar transaction hash, when the bazaar's settlement response carries one. */
  readonly transaction: string | undefined;
  /** Who paid — the agent's account or the tenant's `policy_rail`. */
  readonly payer: string | undefined;
  /** Who was paid: the challenge's `payTo`, the one reconciled against the Mandate before signing. */
  readonly payTo: string | undefined;
  readonly network: string;
  readonly amount: string | undefined;
  readonly errorReason: string | undefined;
  /** The resource's own response body, returned once payment settled. */
  readonly resourceBody: unknown;
}

/**
 * Asks a paid resource for its `402` without paying anything, and says what
 * came back.
 *
 * Split out of {@link executeBazaarPayment} so a caller can learn whether the
 * venue will quote this request at all **before** it spends anything else on
 * it — deploying and funding a tenant's rail, in F9. T85 found the order the
 * other way round in production: SignalDesk refused a credits request with a
 * `400` for its input, and a sponsored rail had already been deployed and
 * funded for a purchase that was never going to be quoted.
 *
 * **A venue refusing the request is not a network failure.** A `4xx` other
 * than `402` means the venue answered, read the request, and declined it —
 * `MerchantRejectedRequest`, with the venue's status and the start of its
 * body. Reporting it as `NetworkError` told a person "the merchant may be
 * down, try again later" about a request that would fail identically forever.
 *
 * @throws AgentPassError `MerchantRejectedRequest` for a `4xx` other than `402`.
 * @throws AgentPassError `NetworkError` for an unreachable resource, or any
 * other status that is not `402`.
 */
export async function requestPaymentChallenge(resourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let challenge: Response;
  try {
    challenge = await fetchImpl(resourceUrl);
  } catch (error) {
    throw networkError("could not reach the bazaar resource", { resourceUrl }, error);
  }
  if (challenge.status === 402) return challenge;

  if (challenge.status >= 400 && challenge.status < 500) {
    const body = await challenge.text().catch(() => "");
    throw new AgentPassError("MerchantRejectedRequest", "the venue refused this request before quoting a price", {
      details: { resourceUrl, status: challenge.status, body: body.slice(0, 300) },
    });
  }
  throw networkError("the bazaar resource did not answer with a 402 payment challenge", {
    resourceUrl,
    status: challenge.status,
  });
}

/**
 * The key `executeBazaarPayment` stamps on every error it throws, saying
 * whether a signed payment may already have left this process (`C-113`, T92).
 *
 * It exists so `PolicyRail.release` has proof rather than a guess. Releasing
 * a spend whose payment actually settled would hand back budget for a
 * purchase that happened, which is the direction `M-15` calls unsafe — so the
 * absence of this key, on any error from anywhere else, has to read as "may
 * have been sent". {@link mayHaveBeenPaid} is what enforces that default.
 */
export const PAYMENT_SENT_DETAIL = "paymentSent";

/**
 * Re-throws `error` carrying {@link PAYMENT_SENT_DETAIL}.
 *
 * A new `AgentPassError` rather than a mutation, because `details` is
 * `readonly` and assigning through it would be a lie the type system happens
 * not to catch. `code`, `message` and `cause` are carried over untouched, so
 * every existing `hasErrorCode(...)` check upstream keeps matching.
 */
function withPaymentSent(error: unknown, paymentSent: boolean): unknown {
  if (!isAgentPassError(error)) return error;
  return new AgentPassError(error.code, error.message, {
    cause: error.cause,
    details: { ...error.details, [PAYMENT_SENT_DETAIL]: paymentSent },
  });
}

/**
 * Whether `error` leaves open the possibility that a payment was already
 * sent — the question a caller must answer `false` before releasing a spend.
 *
 * **Fails closed on purpose.** Anything that is not an `AgentPassError`
 * explicitly stamped `paymentSent: false` answers `true`. An error from a
 * path that never learned about this marker, a plain `Error` escaping from a
 * dependency, a future refactor that forgets to stamp — all of them refuse
 * the release and leave today's behaviour exactly as it was before T92.
 */
export function mayHaveBeenPaid(error: unknown): boolean {
  if (!isAgentPassError(error)) return true;
  return error.details[PAYMENT_SENT_DETAIL] !== false;
}

/**
 * Executes one real x402 payment: fetches `resourceUrl`, expects a `402`,
 * reconciles the real challenge against `input.intent` through
 * `deps.policyRail` (never signs anything the rail refuses), then signs and
 * sends the payment with `@x402/stellar` and retries the request.
 *
 * @throws AgentPassError `MerchantRejectedRequest` when the venue refuses the
 * request with a `4xx` before quoting (see {@link requestPaymentChallenge}).
 * @throws AgentPassError `NetworkError` for anything network-shaped: an
 * unreachable resource, any other response that is not `402` on the first
 * request, or one that is not `2xx` after paying.
 * @throws AgentPassError with the rail's own code (`ScopeAmountExceeded`,
 * `MandateDailyLimitExceeded`, `TermsAmountMismatch`, …) when the challenge
 * is not authorised — the same codes `create_purchase_intent` already raises.
 */
export async function executeBazaarPayment(
  deps: ExecuteBazaarPaymentDeps,
  input: ExecuteBazaarPaymentInput,
): Promise<BazaarPaymentReceipt> {
  // Where the one-way door is (`C-113`, T92). Flipped immediately before the
  // signed payment header is handed to `fetch`, and read by `payAndMark`'s
  // catch below to stamp every error this function throws.
  //
  // Deliberately a flag around the whole body rather than a literal at each
  // `throw`: a throw site added here later is stamped by where it sits in the
  // sequence, which is the actual question, instead of by whether whoever
  // added it remembered. Before the flip, nothing signed has left the
  // process and the caller may release the spend; from the flip onwards the
  // payment may have been received and submitted even if the response never
  // came back, and releasing would hand back budget for a purchase that
  // settled (`C-107` is the same hazard, seen from the other side).
  let paymentSent = false;
  try {
    return await payAndMark();
  } catch (error) {
    throw withPaymentSent(error, paymentSent);
  }

  async function payAndMark(): Promise<BazaarPaymentReceipt> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const challenge = await requestPaymentChallenge(input.resourceUrl, fetchImpl);

  const scheme =
    deps.payer === undefined
      ? new ExactStellarScheme(createEd25519Signer(deps.signerSecret, STELLAR_TESTNET_CAIP2))
      : new PolicyRailStellarScheme(deps.payer);
  const client = x402Client.fromConfig({ schemes: [{ network: STELLAR_TESTNET_CAIP2, client: scheme }] });
  const httpClient = new x402HTTPClient(client);

  const challengeBody: unknown = await challenge.json().catch(() => undefined);
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => challenge.headers.get(name),
    challengeBody,
  );

  // Reconcile before signing anything (M-14) — the first real exercise of
  // this path with a challenge nobody controlled ahead of time.
  const requirements = selectRequirements(paymentRequired);
  const terms = toPaymentTerms(requirements, input.venueId);
  const decision = await deps.policyRail.authorise({
    intent: input.intent,
    scope: input.scope,
    mandate: input.mandate,
    terms,
  });
  if (!decision.authorised) throw policyRailError(decision);

  // Signing happens here, and this is where a rail with no USDC fails: the
  // transfer is simulated before it can be signed, and the simulation is
  // refused. Nothing has been sent yet, so this is still releasable.
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  // The door. Everything from here on may have moved money.
  paymentSent = true;

  let paid: Response;
  try {
    paid = await fetchImpl(input.resourceUrl, { headers: paymentHeaders });
  } catch (error) {
    throw networkError("could not resend the request with payment", { resourceUrl: input.resourceUrl }, error);
  }

  const result = await httpClient.processResponse(paid);
  if (result.paymentStatus !== "settled") {
    const header = result.header as SettleResponse | PaymentRequired | undefined;
    const errorReason =
      header !== undefined && "errorReason" in header ? header.errorReason : undefined;
    throw networkError("the bazaar did not confirm settlement of the payment", {
      resourceUrl: input.resourceUrl,
      status: result.status,
      paymentStatus: result.paymentStatus,
      errorReason,
    });
  }

  const settlement = result.header as SettleResponse;
  return {
    settled: true,
    transaction: settlement.transaction,
    payer: settlement.payer,
    payTo: terms.payTo,
    network: settlement.network,
    amount: settlement.amount,
    errorReason: settlement.errorReason,
    resourceBody: result.body,
  };
  }
}

/**
 * Fills a `ServiceCard.routeTemplate`'s `{name}` placeholders (e.g.
 * `/api/x402/swap-risk?pair={pair}&amount={amount}&side={side}`) with
 * `params`, and joins it onto `baseUrl` into a fetchable URL.
 *
 * Pure. Does not know or care which params a given route requires — the
 * bazaar's own `402` answers that; this only refuses a placeholder the
 * caller forgot to fill.
 *
 * @throws AgentPassError `InvalidArguments` for a placeholder in
 * `route.routeTemplate` that `params` does not supply.
 */
export function fillRouteTemplate(
  baseUrl: string,
  route: BazaarServiceRoute,
  params: Readonly<Record<string, string | number>>,
): string {
  const filled = route.routeTemplate.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!(name in params)) {
      throw new AgentPassError(
        "InvalidArguments",
        `route "${route.routeTemplate}" needs a "${name}" parameter, which was not supplied`,
        { details: { productId: route.id, routeTemplate: route.routeTemplate, missing: name } },
      );
    }
    return encodeURIComponent(String(params[name]));
  });
  return `${baseUrl.replace(/\/+$/, "")}${filled}`;
}
