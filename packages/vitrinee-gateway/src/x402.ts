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
  type SettleResultContext,
} from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

import type { GatewayConfig } from "./config.js";
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
): x402ResourceServer {
  const server = new x402ResourceServer(facilitator).register(STELLAR_TESTNET_CAIP2, new ExactStellarScheme());
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
