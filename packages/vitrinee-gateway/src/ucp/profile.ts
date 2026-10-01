import { StrKey } from "@stellar/stellar-sdk";
import {
  RECEIPT_EXTENSION,
  RECEIPT_EXTENSION_SCHEMA_URL,
  RECEIPT_EXTENSION_SPEC_URL,
  RECEIPT_EXTENSION_VERSION,
  STELLAR_X402_HANDLER,
  STELLAR_X402_HANDLER_ID,
  STELLAR_X402_HANDLER_VERSION,
  STELLAR_X402_INSTRUMENT_TYPE,
  STELLAR_X402_SCHEMA_URL,
  STELLAR_X402_SPEC_URL,
  UCP_CATALOG_LOOKUP,
  UCP_CATALOG_SEARCH,
  UCP_CHECKOUT,
  UCP_FULFILLMENT,
  UCP_ORDER,
  UCP_REST_PREFIX,
  UCP_SHOPPING_SERVICE,
  UCP_SPEC_URLS,
  UCP_VERSION,
  USDC_TESTNET,
  stellarDid,
  stellarX402BusinessConfigSchema,
  ucpBusinessProfileSchema,
  type StellarX402BusinessConfig,
  type UcpBusinessProfile,
} from "@vitrinee/core";

import type { GatewayConfig } from "../config.js";

/** Where and in what this storefront settles: the same facts the agent-storefront manifest publishes. */
export function stellarX402Config(config: GatewayConfig): StellarX402BusinessConfig {
  return stellarX402BusinessConfigSchema.parse({
    x402_version: 2,
    scheme: "exact",
    network: "stellar:testnet",
    asset: { code: USDC_TESTNET.code, contract: USDC_TESTNET.contractId, decimals: USDC_TESTNET.decimals },
    pay_to: config.merchant.stellarAccount,
    facilitator: config.facilitator.url,
  } satisfies StellarX402BusinessConfig);
}

export interface BuildUcpProfileInput {
  config: GatewayConfig;
  baseUrl: string;
}

/**
 * The storefront's UCP business profile (`/.well-known/ucp`). It declares only
 * what this gateway answers: catalog (T121), and checkout with fulfillment,
 * order and the anchored-receipt extension (T122). A profile that advertises a
 * capability with no route behind it would send a platform into a 404.
 */
export function buildUcpProfile({ config, baseUrl }: BuildUcpProfileInput): UcpBusinessProfile {
  const origin = baseUrl.replace(/\/+$/, "");
  return ucpBusinessProfileSchema.parse({
    ucp: {
      version: UCP_VERSION,
      services: {
        [UCP_SHOPPING_SERVICE]: [
          { version: UCP_VERSION, ...UCP_SPEC_URLS.service, transport: "rest", endpoint: `${origin}${UCP_REST_PREFIX}` },
        ],
      },
      capabilities: {
        [UCP_CATALOG_SEARCH]: [{ version: UCP_VERSION, ...UCP_SPEC_URLS.catalogSearch }],
        [UCP_CATALOG_LOOKUP]: [{ version: UCP_VERSION, ...UCP_SPEC_URLS.catalogLookup }],
        [UCP_CHECKOUT]: [{ version: UCP_VERSION, ...UCP_SPEC_URLS.checkout }],
        [UCP_FULFILLMENT]: [
          {
            version: UCP_VERSION,
            ...UCP_SPEC_URLS.fulfillment,
            extends: UCP_CHECKOUT,
            // One destination, shipping only (E-4).
            config: { allows_multi_destination: { shipping: false, pickup: false }, allows_method_combinations: [["shipping"]] },
          },
        ],
        [UCP_ORDER]: [{ version: UCP_VERSION, ...UCP_SPEC_URLS.order }],
        [RECEIPT_EXTENSION]: [
          { version: RECEIPT_EXTENSION_VERSION, spec: RECEIPT_EXTENSION_SPEC_URL, schema: RECEIPT_EXTENSION_SCHEMA_URL, extends: [UCP_CHECKOUT, UCP_ORDER] },
        ],
      },
      payment_handlers: {
        [STELLAR_X402_HANDLER]: [
          {
            id: STELLAR_X402_HANDLER_ID,
            version: STELLAR_X402_HANDLER_VERSION,
            spec: STELLAR_X402_SPEC_URL,
            schema: STELLAR_X402_SCHEMA_URL,
            available_instruments: [{ type: STELLAR_X402_INSTRUMENT_TYPE }],
            config: stellarX402Config(config),
          },
        ],
      },
    },
    // The receipt-signing key (VT-8), as a JWK: with it a UCP client can check a
    // receipt's signature from the profile alone. Never the payTo account.
    signing_keys: [
      {
        kid: `${stellarDid(config.signing.account, "testnet")}#key-1`,
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(StrKey.decodeEd25519PublicKey(config.signing.account)).toString("base64url"),
        use: "sig",
        alg: "EdDSA",
      },
    ],
  });
}
