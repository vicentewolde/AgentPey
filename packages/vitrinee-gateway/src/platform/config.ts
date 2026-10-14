/**
 * Configuration of the multi-merchant platform (T103, C-140).
 *
 * The platform runs when both `DATABASE_URL` (Vitrinee's own role, C-143) and
 * `MASTER_KEY` (VT-27) are set; with neither, `main.ts` runs the single-store
 * gateway exactly as before T103. One without the other is a mistake and
 * refuses to start.
 *
 * A comercio's store is configured by the same `loadConfig` the single-store
 * gateway uses, fed the platform's environment with the merchant's own values
 * laid over it. Every rule `loadConfig` enforces (CLP only, signing key not the
 * payout key, credentials present for Jumpseller…) applies to every comercio.
 */
import { VitrineeError, stellarContractIdSchema } from "@vitrinee/core";
import { z } from "zod";

import { loadConfig, type GatewayConfig } from "../config.js";
import type { Comercio, ComercioSecrets } from "./comercios.js";
import { isComercioSlug } from "./hosts.js";

export interface PlatformSettings {
  port: number;
  databaseUrl: string;
  masterKey: string;
  /** `vitrinee.agentpey.com` in production: the portal; its subdomains are the stores (C-142). */
  platformHost: string;
  /**
   * The comercio the portal host still serves as a store, while AgentPey and
   * RealOps point at the root (until T104 moves them to the directory). Unset,
   * the root serves only the platform's own routes.
   */
  rootComercio: string | undefined;
  /** Each comercio's `purchase-escrow`, by slug (T160): `COMERCIO_ESCROWS`. A comercio not listed is paid directly. */
  escrows: ReadonlyMap<string, string>;
}

/**
 * `COMERCIO_ESCROWS`, as `<slug>=<contract id>` pairs separated by commas (T160). It is the platform's switch for an
 * escrow: one store's contract, assigned to that store alone, set and removed without a deploy. A malformed value
 * stops the platform from starting rather than leaving a store charging where nobody meant it to.
 *
 * @throws VitrineeError `ConfigError` on a malformed pair, a repeated slug, or a contract given to two stores
 */
export function parseComercioEscrows(value: string | undefined): Map<string, string> {
  const escrows = new Map<string, string>();
  if (value === undefined || value.trim() === "") return escrows;
  for (const pair of value.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const [slug, contract, ...rest] = pair.split("=").map((part) => part.trim());
    if (slug === undefined || contract === undefined || rest.length > 0 || !isComercioSlug(slug) || !stellarContractIdSchema.safeParse(contract).success) {
      throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_ESCROWS: expected <slug>=<contract id>, comma separated", { details: { pair: slug ?? "" } });
    }
    if (escrows.has(slug) || [...escrows.values()].includes(contract)) {
      throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_ESCROWS: one escrow per store, and one store per escrow (X-11)", { details: { slug } });
    }
    escrows.set(slug, contract);
  }
  return escrows;
}

const settingsSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4021),
  DATABASE_URL: z.string().min(1),
  MASTER_KEY: z.string().min(1),
  PLATFORM_HOST: z
    .string()
    .regex(/^[a-z0-9.-]+$/, "a lowercase hostname, no scheme or port")
    .optional(),
  PUBLIC_BASE_URL: z.url().optional(),
  ROOT_COMERCIO: z.string().refine(isComercioSlug, "a comercio slug").optional(),
  COMERCIO_ESCROWS: z.string().optional(),
});

/** The keys of the single-store environment that belong to one merchant, never to the platform. */
const MERCHANT_KEYS = [
  "ADAPTER",
  "JUMPSELLER_LOGIN",
  "JUMPSELLER_AUTHTOKEN",
  "SHOPIFY_SHOP",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "PUBLIC_BASE_URL",
  "MERCHANT_NAME",
  "MERCHANT_STELLAR_ACCOUNT",
  "MERCHANT_SIGNING_SECRET",
  "MERCHANT_COUNTRY",
  "MERCHANT_CURRENCY",
  // One store's escrow (T159): never inherited from the platform's environment, or every store would name it.
  // A store gets one only through COMERCIO_ESCROWS, by its slug (T160).
  "ESCROW_CONTRACT_ID",
  "ORDERS_FILE",
  "MOCK_ORDERS_FILE",
  "DATABASE_URL",
  "MASTER_KEY",
] as const;

const blank = (value: string | undefined) => value === undefined || value.trim() === "";

/** `undefined` when neither platform variable is set: run the single-store gateway. */
export function loadPlatformSettings(env: NodeJS.ProcessEnv): PlatformSettings | undefined {
  const hasDb = !blank(env["DATABASE_URL"]);
  const hasKey = !blank(env["MASTER_KEY"]);
  if (!hasDb && !hasKey) return undefined;
  if (hasDb !== hasKey) {
    throw new VitrineeError("ConfigError", "the platform needs both DATABASE_URL and MASTER_KEY; only one is set");
  }
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => !blank(value)));
  const parsed = settingsSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new VitrineeError("ConfigError", `invalid platform environment: ${problems.join("; ")}`, { details: { problems } });
  }
  const e = parsed.data;
  const platformHost = e.PLATFORM_HOST ?? (e.PUBLIC_BASE_URL === undefined ? "vitrinee.agentpey.com" : new URL(e.PUBLIC_BASE_URL).hostname);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    masterKey: e.MASTER_KEY,
    platformHost,
    rootComercio: e.ROOT_COMERCIO,
    escrows: parseComercioEscrows(e.COMERCIO_ESCROWS),
  };
}

/**
 * One comercio's gateway config. `publicBaseUrl` is left unset on purpose: the
 * store builds its URLs from the request's own `Host`, so the same store is
 * correct at its subdomain and, during the transition, at the root.
 */
export function comercioConfig(env: NodeJS.ProcessEnv, comercio: Comercio, secrets: ComercioSecrets): GatewayConfig {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !(MERCHANT_KEYS as readonly string[]).includes(key)) base[key] = value;
  }
  const merchant: Record<string, string> = {
    ADAPTER: comercio.platform,
    MERCHANT_NAME: comercio.name,
    MERCHANT_STELLAR_ACCOUNT: comercio.payTo,
    MERCHANT_SIGNING_SECRET: secrets.signingSecret,
    MERCHANT_COUNTRY: comercio.country,
    MERCHANT_CURRENCY: comercio.currency,
  };
  // The platform's own list names this store's escrow (T160); `ESCROW_CONTRACT_ID` itself is never inherited.
  const escrow = parseComercioEscrows(env["COMERCIO_ESCROWS"]).get(comercio.slug);
  if (escrow !== undefined) merchant["ESCROW_CONTRACT_ID"] = escrow;
  if (secrets.credentials.kind === "jumpseller-api") {
    merchant["JUMPSELLER_LOGIN"] = secrets.credentials.login;
    merchant["JUMPSELLER_AUTHTOKEN"] = secrets.credentials.authtoken;
  }
  if (secrets.credentials.kind === "shopify-app") {
    merchant["SHOPIFY_SHOP"] = secrets.credentials.shop;
    merchant["SHOPIFY_CLIENT_ID"] = secrets.credentials.clientId;
    merchant["SHOPIFY_CLIENT_SECRET"] = secrets.credentials.clientSecret;
  }
  return loadConfig({ ...base, ...merchant });
}
