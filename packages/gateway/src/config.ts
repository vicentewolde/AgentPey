import {
  OPENZEPPELIN_FACILITATOR_TESTNET,
  VitrineeError,
  countryCodeSchema,
  currencyCodeSchema,
  decimalStringSchema,
  stellarAccountSchema,
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
  MANIFEST_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(60),
  MOCK_ORDERS_FILE: optionalString,
  ORDERS_FILE: optionalString,
});

export interface GatewayConfig {
  port: number;
  adapter: "mock";
  publicBaseUrl: string | undefined;
  merchant: { name: string; stellarAccount: string; country: string; currency: string };
  fx: { rate: string; base: "USD"; quote: string };
  policies: { refundWindowSeconds: number; shippingCountries: string[] };
  facilitator: { url: string; apiKey: string | undefined; timeoutMs: number };
  checkout: { maxTimeoutSeconds: number };
  manifestCacheSeconds: number;
  mockOrdersFile: string | undefined;
  /** Where the gateway's own order records live. `undefined` keeps them in memory only. */
  ordersFile: string | undefined;
}

/**
 * Reads configuration from the environment. Failures name the variable and
 * the rule, never the value: a malformed secret must not end up in a log.
 * Note what is *not* here: MERCHANT_PAYOUT_SECRET. The gateway has no reason
 * to read it (docs/DECISIONES.md, V-8).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new VitrineeError("ConfigError", `invalid environment: ${problems.join("; ")}`, {
      details: { problems },
    });
  }
  const e = parsed.data;
  if (e.MERCHANT_CURRENCY !== "CLP") {
    throw new VitrineeError("ConfigError", "only CLP storefronts are supported in this version", {
      details: { currency: e.MERCHANT_CURRENCY },
    });
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
    fx: { rate: e.FX_RATE_CLP_USD, base: "USD", quote: e.MERCHANT_CURRENCY },
    policies: {
      refundWindowSeconds: e.REFUND_WINDOW_SECONDS,
      shippingCountries: e.SHIPPING_COUNTRIES,
    },
    facilitator: { url: e.FACILITATOR_URL, apiKey: e.FACILITATOR_API_KEY, timeoutMs: e.FACILITATOR_TIMEOUT_MS },
    checkout: { maxTimeoutSeconds: e.CHECKOUT_MAX_TIMEOUT_SECONDS },
    manifestCacheSeconds: e.MANIFEST_CACHE_SECONDS,
    mockOrdersFile: e.MOCK_ORDERS_FILE,
    ordersFile: e.ORDERS_FILE,
  };
}
