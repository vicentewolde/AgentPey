import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";

export const FAKE_PAYER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";
export const FAKE_TX_HASH = "c0ffee".padEnd(64, "0");

export interface FakeFacilitator extends FacilitatorClient {
  verifyCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }>;
  settleCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }>;
}

/**
 * A facilitator that says yes. Lets the whole 402 → pay → order path run in
 * CI with no network: the real one is exercised by `test:integration`.
 */
export function fakeFacilitator(options: { verify?: Partial<VerifyResponse>; settle?: Partial<SettleResponse> } = {}): FakeFacilitator {
  const verifyCalls: FakeFacilitator["verifyCalls"] = [];
  const settleCalls: FakeFacilitator["settleCalls"] = [];
  return {
    verifyCalls,
    settleCalls,
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }],
        extensions: [],
        signers: { "stellar:testnet": ["GCNJB6V5YIODDSSCWXZ2VOKMRPRVZ2V723RRQS6STXE6NWTGVOJY35CN"] },
      };
    },
    async verify(payload, requirements) {
      verifyCalls.push({ payload, requirements });
      return { isValid: true, payer: FAKE_PAYER, ...options.verify };
    },
    async settle(payload, requirements) {
      settleCalls.push({ payload, requirements });
      return { success: true, transaction: FAKE_TX_HASH, network: "stellar:testnet", payer: FAKE_PAYER, ...options.settle };
    },
  };
}
