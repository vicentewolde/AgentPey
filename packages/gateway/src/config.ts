import { Keypair } from "@stellar/stellar-sdk";
import {
  OPENZEPPELIN_FACILITATOR_TESTNET,
  VitrineeError,
  countryCodeSchema,
  currencyCodeSchema,
  decimalStringSchema,
  stellarAccountSchema,
  stellarContractIdSchema,
} from "@vitrinee/core";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4021),
  ADAPTER: z.enum(["mock"]).default("mock"),
  PUBLIC_BASE_URL: optionalString.pipe(z.url().optional()),
  MERCHANT_NAME: z.string().min(1).default("Bazar Cordillera"),
  MERCHANT_STELLAR_ACCOUNT: stellarAccountSchema,
  MERCHANT_SIGNING_SECRET: z.string().min(1, "required: the key that signs receipts and pays anchors (pnpm bootstrap)"),
  MERCHANT_COUNTRY: countryCodeSchema.default("CL"),
  MERCHANT_CURRENCY: currencyCodeSchema.default("CLP"),
  FX_RATE_CLP_USD: decimalStringSchema.default("950"),
  REFUND_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(864_000),
  SHIPPING_COUNTRIES: z
    .string()
    .default("CL")
    .transform((value) => value.split(",").map((c) => c.trim()).filter((c) => c !== ""))
    .pipe(z.array(countryCodeSchema).min(1)),
  FACILITATOR_URL: z.url().default(OPENZEPPELIN_FACILITATOR_TESTNET),
  FACILITATOR_API_KEY: optionalString,
  FACILITATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CHECKOUT_MAX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  RECEIPT_REGISTRY_ID: stellarContractIdSchema,
  STELLAR_RPC_URL: z.url().default("https://soroban-testnet.stellar.org"),
  STELLAR_HORIZON_URL: z.url().default("https://horizon-testnet.stellar.org"),
  STELLAR_NETWORK_PASSPHRASE: z.string().default("Test SDF Network ; September 2015"),
  MANIFEST_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(60),
  MOCK_ORDERS_FILE: optionalString,
  ORDERS_FILE: optionalString,
});

export interface GatewayConfig {
  port: number;
  adapter: "mock";
  publicBaseUrl: string | undefined;
  merchant: { name: string; stellarAccount: string; country: string; currency: string };
  /** The receipt-signing key. Holds XLM for anchor fees, never USDC (V-8). */
  signing: { account: string; secret: string };
  fx: { rate: string; base: "USD"; quote: string };
  policies: { refundWindowSeconds: number; shippingCountries: string[] };
  facilitator: { url: string; apiKey: string | undefined; timeoutMs: number };
  checkout: { maxTimeoutSeconds: number };
  stellar: { rpcUrl: string; horizonUrl: string; networkPassphrase: string };
  receiptRegistryId: string;
  manifestCacheSeconds: number;
  mockOrdersFile: string | undefined;
  /** Where the gateway's own order records live. `undefined` keeps them in memory only. */
  ordersFile: string | undefined;
}

/**
 * Reads configuration from the environment. Failures name the variable and
 * the rule, never the value: a malformed secret must not end up in a log.
 * Note what is *not* here: MERCHANT_PAYOUT_SECRET. The gateway has no reason
 * to read it (docs/DECISIONES.md, V-8, V-12).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new VitrineeError("ConfigError", `invalid environment: ${problems.join("; ")}`, { details: { problems } });
  }
  const e = parsed.data;
  if (e.MERCHANT_CURRENCY !== "CLP") {
    throw new VitrineeError("ConfigError", "only CLP storefronts are supported in this version", {
      details: { currency: e.MERCHANT_CURRENCY },
    });
  }
  let signingAccount: string;
  try {
    signingAccount = Keypair.fromSecret(e.MERCHANT_SIGNING_SECRET).publicKey();
  } catch {
    throw new VitrineeError("ConfigError", "invalid environment: MERCHANT_SIGNING_SECRET: not a Stellar secret seed");
  }
  if (signingAccount === e.MERCHANT_STELLAR_ACCOUNT) {
    throw new VitrineeError("ConfigError", "MERCHANT_SIGNING_SECRET must not be the payTo account's key (V-8)");
  }
  return {
    port: e.PORT,
    adapter: e.ADAPTER,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    merchant: {
      name: e.MERCHANT_NAME,
      stellarAccount: e.MERCHANT_STELLAR_ACCOUNT,
      country: e.MERCHANT_COUNTRY,
      currency: e.MERCHANT_CURRENCY,
    },
    signing: { account: signingAccount, secret: e.MERCHANT_SIGNING_SECRET },
    fx: { rate: e.FX_RATE_CLP_USD, base: "USD", quote: e.MERCHANT_CURRENCY },
    policies: { refundWindowSeconds: e.REFUND_WINDOW_SECONDS, shippingCountries: e.SHIPPING_COUNTRIES },
    facilitator: { url: e.FACILITATOR_URL, apiKey: e.FACILITATOR_API_KEY, timeoutMs: e.FACILITATOR_TIMEOUT_MS },
    checkout: { maxTimeoutSeconds: e.CHECKOUT_MAX_TIMEOUT_SECONDS },
    stellar: { rpcUrl: e.STELLAR_RPC_URL, horizonUrl: e.STELLAR_HORIZON_URL, networkPassphrase: e.STELLAR_NETWORK_PASSPHRASE },
    receiptRegistryId: e.RECEIPT_REGISTRY_ID,
    manifestCacheSeconds: e.MANIFEST_CACHE_SECONDS,
    mockOrdersFile: e.MOCK_ORDERS_FILE,
    ordersFile: e.ORDERS_FILE,
  };
}
