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
  UCP_AP2_MANDATE,
  UCP_AP2_MANDATE_URLS,
  UCP_LEGACY_VERSION,
  UCP_PROFILE_PATH,
  USDC_TESTNET,
  ucpSpecUrls,
  stellarDid,
  stellarX402BusinessConfigSchema,
  ucpBusinessProfileSchema,
  type StellarX402BusinessConfig,
  type UcpBusinessProfile,
  type UcpVersion,
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
  /** Which profile: the current one at `/.well-known/ucp`, or an older version's leaf profile. Defaults to the current one. */
  version?: UcpVersion;
  /** The storefront's AP2 public key (T134, VT-43). With it, the 2026-08-25 profile offers the AP2 extension and publishes the key. */
  ap2Key?: { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string; alg: "ES256"; use: "sig" };
  /** The key the storefront signs its order webhooks with (T147, VT-44). Published in both versions: a platform finds it by `keyid`. */
  webhookKey?: { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string; alg: "ES256"; use: "sig" };
}

/** Where a version's leaf profile lives, next to the current one (R-6). */
export function ucpLeafProfilePath(version: UcpVersion): string {
  return `${UCP_PROFILE_PATH}/${version}`;
}

/** The receipt-signing key (VT-8), as a public JWK: with it a UCP client can check a receipt's signature from the profile alone. Never the payTo account. */
function signingJwk(config: GatewayConfig) {
  return {
    kid: `${stellarDid(config.signing.account, "testnet")}#key-1`,
    kty: "OKP",
    crv: "Ed25519",
    x: Buffer.from(StrKey.decodeEd25519PublicKey(config.signing.account)).toString("base64url"),
    use: "sig",
    alg: "EdDSA",
  };
}

/**
 * The storefront's UCP business profile. It declares only what this gateway
 * answers: catalog (T121), and checkout with fulfillment, order and the
 * anchored-receipt extension (T122). A profile that advertises a capability
 * with no route behind it would send a platform into a 404.
 *
 * `/.well-known/ucp` is the 2026-08-25 profile, and it points to the 2026-04-08
 * one through `supported_versions` (R-6, T133). UCP forbids listing an older
 * version's capabilities inside a newer profile, so each version is a whole
 * profile of its own. They differ where the versions do: 2026-08-25 publishes
 * the key in `keys[]` (2026-04-08 in `signing_keys`, mirrored in `keys` as its
 * release branch allows), renamed the fulfillment config and moved the specs.
 */
export function buildUcpProfile({ config, baseUrl, version = "2026-08-25", ap2Key, webhookKey }: BuildUcpProfileInput): UcpBusinessProfile {
  const origin = baseUrl.replace(/\/+$/, "");
  const urls = ucpSpecUrls(version);
  const legacy = version === "2026-04-08";
  const jwk = signingJwk(config);
  return ucpBusinessProfileSchema.parse({
    ucp: {
      version,
      ...(legacy ? {} : { supported_versions: { [UCP_LEGACY_VERSION]: `${origin}${ucpLeafProfilePath(UCP_LEGACY_VERSION)}` } }),
      services: {
        [UCP_SHOPPING_SERVICE]: [{ version, ...urls.service, transport: "rest", endpoint: `${origin}${UCP_REST_PREFIX}` }],
      },
      capabilities: {
        [UCP_CATALOG_SEARCH]: [{ version, ...urls.catalogSearch }],
        [UCP_CATALOG_LOOKUP]: [{ version, ...urls.catalogLookup }],
        [UCP_CHECKOUT]: [{ version, ...urls.checkout }],
        [UCP_FULFILLMENT]: [
          {
            version,
            ...urls.fulfillment,
            extends: UCP_CHECKOUT,
            // One destination, shipping only (E-4).
            config: legacy
              ? { allows_multi_destination: { shipping: false, pickup: false }, allows_method_combinations: [["shipping"]] }
              : { multi_destination: [], method_combinations: [["shipping"]] },
          },
        ],
        [UCP_ORDER]: [{ version, ...urls.order }],
        // AP2 mandates (T134, R-15): 2026-08-25 only, and only negotiated with a platform that declares it too.
        ...(legacy || ap2Key === undefined
          ? {}
          : { [UCP_AP2_MANDATE]: [{ version, ...UCP_AP2_MANDATE_URLS, extends: UCP_CHECKOUT, config: { vp_formats_supported: { "dc+sd-jwt": {} } } }] }),
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
    // 2026-04-08 verifies webhooks against `signing_keys`, ES256 only: the webhook key goes there too.
    ...(legacy
      ? { signing_keys: webhookKey === undefined ? [jwk] : [jwk, webhookKey], keys: webhookKey === undefined ? [jwk] : [jwk, webhookKey] }
      : { keys: [jwk, ...(ap2Key === undefined ? [] : [ap2Key]), ...(webhookKey === undefined ? [] : [webhookKey])] }),
  });
}
