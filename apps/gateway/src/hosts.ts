/**
 * Which internal app answers for which public hostname, and exactly which of
 * this container's environment variables that app is allowed to see (T86).
 *
 * **Why this exists.** Render bills per service, and each of the three
 * services (`agentpey-web`, `agentpey-realops`, `agentpey-signaldesk`) cost
 * their own Starter plan to stay warm — three payments for one pilot. This
 * package folds them into one Render service, reachable at three subdomains
 * of `agentpey.com`, without folding them into one *process*: `server.ts`
 * spawns each app as its own child, and this module is the map from a
 * request's `Host` header to which child answers it and what that child may
 * read from `process.env`.
 *
 * **Why a fixed map, not a prefix rule.** `host.startsWith("realops.")` would
 * let `realops.attacker.example` — a domain an attacker registered and named
 * to *start with* the right word — match the same target as the real one.
 * This project already found and fixed that exact mistake once, for the same
 * reason, in the credits-account schema (`apps/signaldesk/src/catalog.ts`,
 * `accountSchema`, T85): a prefix or substring check on an attacker-chosen
 * label is a check the attacker can pass by naming their own thing correctly.
 * A hostname this map does not know gets a 404, not a guess.
 *
 * **Why `envKeys` is a fixed list per app, not "give it everything".** The
 * whole reason `SignalDesk` is credible as a merchant that could not reach
 * into AgentPey's authorisation even if it wanted to (`C-88`) is that it
 * holds none of AgentPey's keys — "own keys, own process, own tables". Under
 * one Render service there is only one place secrets are configured, so
 * without this list every child's `process.env` would contain every secret
 * for all three apps, and that property would be gone in practice even
 * though no code imports across the boundary. `envKeys` is what keeps it
 * true: `AGENT_SECRET_KEY` and `MASTER_MNEMONIC` are never copied into
 * SignalDesk's environment, and `SIGNALDESK_SECRET_KEY` is never copied into
 * the other two's — see `env-filter.ts`, which does the actual copying.
 */

export type AppName = "web" | "realops" | "signaldesk" | "vitrinee";

export interface AppTarget {
  readonly name: AppName;
  /** The port this app's own process listens on. Never reachable from outside the container — only the gateway's own port is. */
  readonly port: number;
  /** This app's entry file, relative to the repo root — what `spawnApp` runs with `tsx`. */
  readonly entry: string;
  /**
   * Exactly the environment variable names this app may read. Mirrors the
   * per-service `envVars` block `render.yaml` had for this app before T86
   * merged three Render services into one — nothing added, nothing shared
   * that was not already shared (`DATABASE_URL` is the one name that
   * legitimately appears more than once: the pilot's one Postgres, read by
   * all three, same as when they were three separate services).
   */
  readonly envKeys: readonly string[];
  /**
   * Variables this app reads under a generic name, stored in the container
   * under a prefixed one: `{ childName: containerName }` (T102, `C-136`).
   *
   * Vitrinee was written as its own service and reads `PORT`, `ADAPTER`,
   * `PUBLIC_BASE_URL`, `MERCHANT_SIGNING_SECRET`… One Render service has one
   * value per name, and `PUBLIC_BASE_URL` is already a name `apps/web` may
   * read. So in the container its variables carry a `VITRINEE_` prefix, and
   * only this app's child receives them, renamed back. No other app lists a
   * `VITRINEE_` secret, which is what keeps the receipt-signing key out of
   * their reach.
   */
  readonly envAliases?: Readonly<Record<string, string>>;
  /**
   * Container variables that must be present for this app to be started at
   * all. Missing one, the gateway does not spawn it and its host answers
   * `503`: an app started without its secrets would exit at once, and a
   * critical exit takes the whole service down (`server.ts`).
   */
  readonly requiredEnv?: readonly string[];
  /**
   * Whether this app exiting brings the whole gateway down (the T86 policy).
   * `false` only for a merchant the pilot can run without: a store that
   * crashed must not take AgentPey, RealOps and SignalDesk with it.
   */
  readonly critical: boolean;
}

export const WEB_TARGET: AppTarget = {
  name: "web",
  port: 4101,
  entry: "apps/web/src/server.ts",
  envKeys: [
    "ISSUER_SECRET_KEY",
    "AGENT_SECRET_KEY",
    "AGENT_REGISTRY_CONTRACT_ID",
    "ADMIN_SECRET_KEY",
    "DATABASE_URL",
    "MASTER_MNEMONIC",
    "BAZAAR_BASE_URL",
    "POLICY_RAIL_CONTRACT_ID",
    "POLICY_RAIL_WASM_HASH",
    "RESERVE_ADDRESS",
    // Not set today (the app infers its origin from the request's own Host
    // header, which the gateway preserves — see proxy.ts) but a legitimate
    // override, so it is allowed through if it is ever set.
    "PUBLIC_BASE_URL",
  ],
  critical: true,
};

export const REALOPS_TARGET: AppTarget = {
  name: "realops",
  port: 4102,
  entry: "apps/realops/src/server.ts",
  envKeys: [
    "DATABASE_URL",
    "RESEND_API_KEY",
    "REALOPS_MAIL_FROM",
    "REALOPS_PUBLIC_URL",
    "SIGNALDESK_PUBLIC_URL",
    "PILOT_VENUE_ID",
    "PILOT_ASSET_ID",
    "PILOT_PAY_TO",
    // T100: the Vitrinee store RealOps reads live and proposes grants for.
    // Public values, like the three above; no secret of Vitrinee's is here.
    "VITRINEE_BASE_URL",
    "VITRINEE_VENUE_ID",
    "VITRINEE_PAY_TO",
    "REALOPS_AGENTPEY_API_KEY",
    "AGENTPEY_BASE_URL",
  ],
  critical: true,
};

export const SIGNALDESK_TARGET: AppTarget = {
  name: "signaldesk",
  port: 4103,
  entry: "apps/signaldesk/src/server.ts",
  envKeys: ["SIGNALDESK_SECRET_KEY", "SIGNALDESK_FACILITATOR_SECRET", "DATABASE_URL", "SIGNALDESK_PUBLIC_URL"],
  critical: true,
};

/**
 * Vitrinee (T102, `C-134`, `C-136`): the store gateway that turns a real
 * Jumpseller shop into an x402 merchant. It holds the key that signs receipts
 * and pays their anchors, and the facilitator's API key; neither reaches any
 * other app, and none of AgentPey's keys reach it. Every variable comes
 * through `envAliases`: it reads no container name directly, not even
 * `DATABASE_URL`, because it keeps its orders in its own file.
 */
export const VITRINEE_TARGET: AppTarget = {
  name: "vitrinee",
  port: 4104,
  entry: "packages/vitrinee-gateway/src/main.ts",
  envKeys: [],
  envAliases: {
    ADAPTER: "VITRINEE_ADAPTER",
    PUBLIC_BASE_URL: "VITRINEE_PUBLIC_BASE_URL",
    JUMPSELLER_LOGIN: "VITRINEE_JUMPSELLER_LOGIN",
    JUMPSELLER_AUTHTOKEN: "VITRINEE_JUMPSELLER_AUTHTOKEN",
    MERCHANT_NAME: "VITRINEE_MERCHANT_NAME",
    MERCHANT_STELLAR_ACCOUNT: "VITRINEE_MERCHANT_STELLAR_ACCOUNT",
    MERCHANT_SIGNING_SECRET: "VITRINEE_MERCHANT_SIGNING_SECRET",
    MERCHANT_COUNTRY: "VITRINEE_MERCHANT_COUNTRY",
    MERCHANT_CURRENCY: "VITRINEE_MERCHANT_CURRENCY",
    FX_RATE_CLP_USD: "VITRINEE_FX_RATE_CLP_USD",
    SHIPPING_COUNTRIES: "VITRINEE_SHIPPING_COUNTRIES",
    FACILITATOR_URL: "VITRINEE_FACILITATOR_URL",
    FACILITATOR_API_KEY: "VITRINEE_FACILITATOR_API_KEY",
    RECEIPT_REGISTRY_ID: "VITRINEE_RECEIPT_REGISTRY_ID",
    ORDERS_FILE: "VITRINEE_ORDERS_FILE",
  },
  requiredEnv: [
    "VITRINEE_MERCHANT_STELLAR_ACCOUNT",
    "VITRINEE_MERCHANT_SIGNING_SECRET",
    "VITRINEE_FACILITATOR_API_KEY",
    "VITRINEE_JUMPSELLER_LOGIN",
    "VITRINEE_JUMPSELLER_AUTHTOKEN",
  ],
  critical: false,
};

/** Every app this gateway runs, in the order they are started. */
export const APP_TARGETS: readonly AppTarget[] = [WEB_TARGET, REALOPS_TARGET, SIGNALDESK_TARGET, VITRINEE_TARGET];

/**
 * The required variables `env` is missing for `target`, by name, never by
 * value. Empty means the app can be started.
 */
export function missingEnv(target: AppTarget, env: NodeJS.ProcessEnv): readonly string[] {
  return (target.requiredEnv ?? []).filter((key) => env[key] === undefined || env[key] === "");
}

export interface HostMapConfig {
  readonly agentpeyHost: string;
  readonly realopsHost: string;
  readonly signaldeskHost: string;
  readonly vitrineeHost: string;
}

export type HostMap = ReadonlyMap<string, AppTarget>;

/**
 * @throws Error if two of the configured hostnames collide (case-insensitively) —
 * a config that would make one app permanently unreachable, so it fails at startup rather than silently.
 */
export function buildHostMap(config: HostMapConfig): HostMap {
  const entries: readonly (readonly [string, AppTarget])[] = [
    [config.agentpeyHost, WEB_TARGET],
    [config.realopsHost, REALOPS_TARGET],
    [config.signaldeskHost, SIGNALDESK_TARGET],
    [config.vitrineeHost, VITRINEE_TARGET],
  ];
  const map = new Map<string, AppTarget>();
  for (const [host, target] of entries) {
    const key = host.toLowerCase();
    if (map.has(key)) {
      throw new Error(`two apps are configured for the same host "${key}" — one of them would never be reachable`);
    }
    map.set(key, target);
  }
  return map;
}

/** Strips a `:port` suffix and lowercases — the normalised form of what a browser's `Host` header actually carries. */
export function normaliseHost(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader === "") return undefined;
  const host = hostHeader.split(":")[0];
  return host === undefined || host === "" ? undefined : host.toLowerCase();
}

/** `undefined` for a `Host` header this map does not recognise — the caller's job to turn that into a 404, not a guess. */
export function resolveTarget(hostMap: HostMap, hostHeader: string | undefined): AppTarget | undefined {
  const host = normaliseHost(hostHeader);
  return host === undefined ? undefined : hostMap.get(host);
}
