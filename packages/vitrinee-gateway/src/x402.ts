import { STELLAR_TESTNET_CAIP2 } from "@vitrinee/core";
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type FacilitatorClient,
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
