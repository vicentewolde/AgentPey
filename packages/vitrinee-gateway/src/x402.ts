import { STELLAR_TESTNET_CAIP2 } from "@vitrinee/core";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type PaywallConfig,
  type SettleFailureContext,
  type SettleResultContext,
} from "@x402/core/server";
import { SettleError } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

import type { GatewayConfig } from "./config.js";
import { payerFromTransactionXdr } from "./payer.js";
import type { PayerGuard } from "./payer-guard.js";
import { paymentKeyFromPayload, type SettlementLedger } from "./settlements.js";

/** The "Built on Stellar" facilitator (OpenZeppelin). The API key never leaves this closure. */
export function createFacilitatorClient(config: GatewayConfig): HTTPFacilitatorClient {
  const apiKey = config.facilitator.apiKey;
  return new HTTPFacilitatorClient({
    url: config.facilitator.url,
    timeoutMs: config.facilitator.timeoutMs,
    createAuthHeaders:
      apiKey === undefined
        ? undefined
        : async () => {
            const headers = { Authorization: `Bearer ${apiKey}` };
            return { verify: headers, settle: headers, supported: headers };
          },
  });
}

/**
 * One resource server for the whole gateway: the Stellar `exact` scheme on
 * testnet, plus the hook that records every successful settlement in the
 * ledger the checkout handler reads from.
 */
export function createX402Server(
  facilitator: FacilitatorClient,
  ledger: SettlementLedger,
  now: () => Date = () => new Date(),
  guard?: PayerGuard,
  log: (message: string, fields?: Record<string, unknown>) => void = () => {},
): x402ResourceServer {
  const server = new x402ResourceServer(facilitator).register(STELLAR_TESTNET_CAIP2, new ExactStellarScheme());
  if (guard?.active === true) installPayerGuard(server, guard, log);
  server.onAfterSettle(async (context: SettleResultContext) => {
    if (!context.result.success) return;
    const key = paymentKeyFromPayload(context.paymentPayload);
    if (key === undefined) return;
    ledger.put(key, {
      txHash: context.result.transaction,
      network: context.result.network,
      payer: context.result.payer,
      payTo: context.requirements.payTo,
      asset: context.requirements.asset,
      amountAtomic: context.requirements.amount,
      settledAt: now().toISOString(),
    });
  });
  return server;
}

/**
 * The store's brake on who may pay (T172, VT-49), one place for both checkouts: every payment, UCP or x402, reaches
 * this server's `settlePayment`. The payer is read from the transaction the payer signed, before the facilitator is
 * asked to settle, so a refused payer moves no money. A refusal is a definite "no": the UCP checkout answers it as a
 * payment that did not settle, and the x402 middleware answers 402 with the reason.
 *
 * A place taken in the window is given back if the facilitator then refuses the payment; if nobody knows whether it
 * settled it stays taken, the cautious side.
 */
function installPayerGuard(server: x402ResourceServer, guard: PayerGuard, log: (message: string, fields?: Record<string, unknown>) => void): void {
  /** The payer each admitted payment is under, by the transaction it signed, until it settles or fails. */
  const admitted = new Map<string, string | undefined>();
  server.onBeforeSettle(async (context) => {
    const key = paymentKeyFromPayload(context.paymentPayload);
    const payer = key === undefined ? undefined : payerFromTransactionXdr(key);
    const admission = guard.admit(payer);
    if (admission.ok) {
      if (key !== undefined) admitted.set(key, payer);
      return;
    }
    log("payer refused", { payer, code: admission.code, ...(admission.code === "payer_rate_limited" ? { retryAfterSeconds: admission.retryAfterSeconds } : {}) });
    return {
      abort: true as const,
      reason: admission.code,
      message: admission.code === "payer_blocked" ? "this payer account is not allowed to buy from this store" : `this payer account has bought too often; try again in ${admission.retryAfterSeconds} s`,
    };
  });
  server.onAfterSettle(async (context: SettleResultContext) => {
    const key = paymentKeyFromPayload(context.paymentPayload);
    if (key !== undefined) admitted.delete(key);
  });
  server.onSettleFailure(async (context: SettleFailureContext) => {
    const key = paymentKeyFromPayload(context.paymentPayload);
    if (key === undefined || !admitted.has(key)) return;
    const payer = admitted.get(key);
    admitted.delete(key);
    // Only a payment the facilitator definitely refused gives its place back: a refusal that names a transaction may
    // have settled, and an error that is not a refusal at all (a timeout, a dropped connection) leaves nobody knowing.
    const error = context.error;
    if (error instanceof SettleError && error.transaction === "") guard.release(payer);
  });
}

/**
 * The request URL with its query string removed: `https://t.test/checkout/7`
 * for `https://t.test/checkout/7?name=Ana&address=…`.
 */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * The x402 HTTP server, except that the URL it announces as the 402's
 * `resource.url` never carries the query string (VT-25).
 *
 * The `GET` checkout takes the buyer's name and shipping address in the query
 * (VT-23). x402 uses the full request URL as `resource.url`, and a client
 * copies that object verbatim into the payment payload it sends the
 * facilitator, so the address would reach a third party that only needs to
 * move USDC. `RouteConfig.resource` cannot help: it is one fixed string per
 * route, the same for every product, and absent when there is no public base
 * URL. Instead, every request is handed to x402 with an adapter whose
 * `getUrl()` drops the query. Everything else x402 reads from the request,
 * including the query parameters the price is computed from, is untouched:
 * `getUrl()` is only read to build `resource.url` (and the browser paywall,
 * which this gateway does not serve).
 */
export class QueryFreeResourceServer extends x402HTTPResourceServer {
  override processHTTPRequest(context: HTTPRequestContext, paywallConfig?: PaywallConfig): Promise<HTTPProcessResult> {
    return super.processHTTPRequest({ ...context, adapter: withoutQueryInUrl(context.adapter) }, paywallConfig);
  }
}

/**
 * The same adapter with only `getUrl` replaced. Built on the original as its
 * prototype, so every other method still reads the real request.
 */
function withoutQueryInUrl(adapter: HTTPAdapter): HTTPAdapter {
  const wrapped = Object.create(adapter) as HTTPAdapter;
  wrapped.getUrl = () => withoutQuery(adapter.getUrl());
  return wrapped;
}
