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
import { parseBlockedPayers, parsePayerLimit } from "../payer-guard.js";
import { parseAllowedPlatforms } from "../ucp/platform-policy.js";
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

/**
 * `COMERCIO_BLOCKED_PAYERS`, as `<slug>=<account>[,<account>…]` entries separated by semicolons (T172, VT-49): the
 * payer accounts each store refuses, for example `agentcommerce=GAAA…,GBBB…;mycokit=GCCC…`. Set and removed without
 * a deploy. A malformed value stops the platform from starting, so a typo never leaves a store open that was meant
 * to be closed to an account.
 *
 * @throws VitrineeError `ConfigError` on a malformed entry, a repeated slug or a bad account
 */
export function parseComercioBlockedPayers(value: string | undefined): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  if (value === undefined || value.trim() === "") return blocked;
  for (const entry of value.split(";").map((e) => e.trim()).filter((e) => e !== "")) {
    const [slug, accounts, ...rest] = entry.split("=").map((part) => part.trim());
    if (slug === undefined || accounts === undefined || rest.length > 0 || !isComercioSlug(slug) || blocked.has(slug)) {
      throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_BLOCKED_PAYERS: expected <slug>=<account>[,<account>], one entry per store, separated by semicolons", { details: { entry: slug ?? "" } });
    }
    blocked.set(slug, parseBlockedPayers(accounts, "COMERCIO_BLOCKED_PAYERS"));
  }
  return blocked;
}

/**
 * `COMERCIO_PAYER_LIMITS`, as `<slug or *>=<max>/<window seconds>` entries separated by commas (T172, VT-49): how
 * many purchases one payer account may make in the window, for example `*=10/3600,agentcommerce=3/3600`. `*` is
 * every store that has no entry of its own. Stores with neither have no limit.
 *
 * @throws VitrineeError `ConfigError` on a malformed entry, a repeated key or a bad limit
 */
export function parseComercioPayerLimits(value: string | undefined): Map<string, string> {
  const limits = new Map<string, string>();
  if (value === undefined || value.trim() === "") return limits;
  for (const entry of value.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    const [key, limit, ...rest] = entry.split("=").map((part) => part.trim());
    if (key === undefined || limit === undefined || rest.length > 0 || (key !== "*" && !isComercioSlug(key)) || limits.has(key)) {
      throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_PAYER_LIMITS: expected <slug or *>=<max>/<window seconds>, comma separated", { details: { entry: key ?? "" } });
    }
    const parsed = parsePayerLimit(limit, "COMERCIO_PAYER_LIMITS");
    if (parsed === undefined) {
      throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_PAYER_LIMITS: a limit is needed after the =", { details: { entry: key } });
    }
    limits.set(key, `${parsed.max}/${parsed.windowSeconds}`);
  }
  return limits;
}

/**
 * `COMERCIO_ALLOWED_PLATFORMS`, as `<slug>=<https URL>[,<https URL>…]` entries separated by semicolons (T172, VT-49):
 * the platforms whose profiles may open a checkout at each store. A store with no entry lets any platform open one.
 *
 * @throws VitrineeError `ConfigError` on a malformed entry, a repeated slug or a URL that is not https
 */
export function parseComercioAllowedPlatforms(value: string | undefined): Map<string, string[]> {
  const allowed = new Map<string, string[]>();
  if (value === undefined || value.trim() === "") return allowed;
  for (const entry of value.split(";").map((e) => e.trim()).filter((e) => e !== "")) {
    const [slug, urls, ...rest] = entry.split("=").map((part) => part.trim());
    if (slug === undefined || urls === undefined || rest.length > 0 || !isComercioSlug(slug) || allowed.has(slug)) {
      throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_ALLOWED_PLATFORMS: expected <slug>=<https URL>[,<https URL>], one entry per store, separated by semicolons", { details: { entry: slug ?? "" } });
    }
    allowed.set(slug, parseAllowedPlatforms(urls, "COMERCIO_ALLOWED_PLATFORMS"));
  }
  return allowed;
}

/**
 * `COMERCIO_REQUIRE_AP2`: the stores that open a checkout only for a platform that negotiated AP2 (T172, VT-49), as
 * slugs separated by commas, or `*` for every store.
 *
 * @throws VitrineeError `ConfigError` on anything that is not a slug or `*`
 */
export function parseComercioRequireAp2(value: string | undefined): { all: boolean; slugs: ReadonlySet<string> } {
  const slugs = new Set<string>();
  let all = false;
  if (value === undefined || value.trim() === "") return { all, slugs };
  for (const item of value.split(",").map((i) => i.trim()).filter((i) => i !== "")) {
    if (item === "*") all = true;
    else if (isComercioSlug(item)) slugs.add(item);
    else throw new VitrineeError("ConfigError", "invalid platform environment: COMERCIO_REQUIRE_AP2: expected store slugs separated by commas, or *", { details: { item } });
  }
  return { all, slugs };
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
  COMERCIO_BLOCKED_PAYERS: z.string().optional(),
  COMERCIO_PAYER_LIMITS: z.string().optional(),
  COMERCIO_ALLOWED_PLATFORMS: z.string().optional(),
  COMERCIO_REQUIRE_AP2: z.string().optional(),
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
  // Who may pay one store (T172): never inherited either. A store gets them only by its slug, through
  // COMERCIO_BLOCKED_PAYERS and COMERCIO_PAYER_LIMITS.
  "BLOCKED_PAYERS",
  "PAYER_LIMIT",
  "ALLOWED_PLATFORMS",
  "REQUIRE_AP2",
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
  validatePayerGuardEnv(e);
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

/** Both lists are read once at startup so that a malformed value stops the platform there, not at a store's first purchase. */
function validatePayerGuardEnv(e: { COMERCIO_BLOCKED_PAYERS?: string | undefined; COMERCIO_PAYER_LIMITS?: string | undefined; COMERCIO_ALLOWED_PLATFORMS?: string | undefined; COMERCIO_REQUIRE_AP2?: string | undefined }): void {
  parseComercioBlockedPayers(e.COMERCIO_BLOCKED_PAYERS);
  parseComercioPayerLimits(e.COMERCIO_PAYER_LIMITS);
  parseComercioAllowedPlatforms(e.COMERCIO_ALLOWED_PLATFORMS);
  parseComercioRequireAp2(e.COMERCIO_REQUIRE_AP2);
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
  // Who may pay this store (T172, VT-49): the accounts it refuses, and its limit (its own entry, else `*`).
  const blocked = parseComercioBlockedPayers(env["COMERCIO_BLOCKED_PAYERS"]).get(comercio.slug);
  if (blocked !== undefined && blocked.length > 0) merchant["BLOCKED_PAYERS"] = blocked.join(",");
  const limits = parseComercioPayerLimits(env["COMERCIO_PAYER_LIMITS"]);
  const limit = limits.get(comercio.slug) ?? limits.get("*");
  if (limit !== undefined) merchant["PAYER_LIMIT"] = limit;
  // Which platforms may open a checkout here (T172, VT-49).
  const platforms = parseComercioAllowedPlatforms(env["COMERCIO_ALLOWED_PLATFORMS"]).get(comercio.slug);
  if (platforms !== undefined && platforms.length > 0) merchant["ALLOWED_PLATFORMS"] = platforms.join(",");
  const requireAp2 = parseComercioRequireAp2(env["COMERCIO_REQUIRE_AP2"]);
  if (requireAp2.all || requireAp2.slugs.has(comercio.slug)) merchant["REQUIRE_AP2"] = "true";
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
