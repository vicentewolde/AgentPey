/**
 * The identifiers this directory hands out.
 *
 * Every id is a ULID behind a three-letter prefix that names its kind, so an
 * id read out of a log, a URL or an error's `details` says what it is without
 * a lookup. The prefix is not decoration: mixing up a partner id and a tenant
 * id in a query that scopes access is exactly the class of bug the prefix
 * makes visible at a glance.
 *
 * The ULID itself moved to `@agentpass/core` in T79, when SignalDesk — a
 * merchant, deliberately not part of AgentPey — needed to number its own
 * deliveries without depending on this package. Re-exported here so every
 * existing importer keeps working, and so there is still exactly one
 * implementation.
 */
import { AgentPassError, CROCKFORD_ALPHABET, ULID_LENGTH, ulid } from "@agentpass/core";

export { ULID_LENGTH, ulid };

/** What each kind of entity's id is prefixed with. */
export const ID_PREFIXES = {
  partner: "ptn",
  apiKey: "apk",
  principal: "prc",
  binding: "bnd",
  agent: "agt",
  credential: "crd",
  mandate: "mdt",
  webhookEndpoint: "whe",
  webhookEvent: "evt",
  consentSession: "cns",
  /** A purchase a partner asked for through `POST /v1/purchases` (T73/F9). */
  purchase: "pur",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ULID_PATTERN = new RegExp(`^[${CROCKFORD_ALPHABET}]{${ULID_LENGTH}}$`);

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

export function isId(kind: IdKind, value: string): boolean {
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ULID_PATTERN.test(value.slice(prefix.length));
}

/**
 * A tenant id is `<partner id>:<ULID>` — `D4`/`C-25`, replacing the
 * `sha256(wallet address)` of T34.
 *
 * The partner is *inside* the id rather than only in a column because this
 * value is what scopes a tenant's rows in `vault_records`, and the failure it
 * has to make impossible is one wallet used with two partners landing on one
 * shared vault. Two partners cannot produce the same tenant id, whatever
 * their users do with their wallets.
 */
export function newTenantId(partnerId: string, now?: number): string {
  if (!isId("partner", partnerId)) {
    throw new AgentPassError("InvalidArguments", "a tenant id must be built on a well-formed partner id", {
      details: { partnerId },
    });
  }
  return `${partnerId}:${ulid(now)}`;
}

export interface ParsedTenantId {
  readonly tenantId: string;
  readonly partnerId: string;
}

/**
 * Reads the partner back out of a tenant id.
 *
 * @throws AgentPassError `InvalidArguments` — a tenant id that does not parse
 * is never treated as "some tenant of an unknown partner": that would be a
 * request whose scope cannot be established, which fails closed like every
 * other ambiguity in this project.
 */
export function parseTenantId(value: string): ParsedTenantId {
  const separator = value.indexOf(":");
  if (separator === -1) {
    throw new AgentPassError("InvalidArguments", "a tenant id must be `<partner id>:<ULID>`", {
      details: { tenantId: value },
    });
  }
  const partnerId = value.slice(0, separator);
  const suffix = value.slice(separator + 1);
  if (!isId("partner", partnerId) || !ULID_PATTERN.test(suffix)) {
    throw new AgentPassError("InvalidArguments", "a tenant id must be `<partner id>:<ULID>`", {
      details: { tenantId: value },
    });
  }
  return { tenantId: value, partnerId };
}
