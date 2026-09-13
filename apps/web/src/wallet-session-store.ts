/**
 * The rest of `G12`: `walletChallenges`, `pendingWalletSessions`,
 * `pendingConsentSessions`, and the wallet-address lookups
 * (`wallet-session.ts`'s `createExpiringStore`, and two plain `Map`s in
 * `server.ts`) move to Postgres — same reasoning T67/T68 already worked
 * through for `Registry`'s pending writes (`C-69`, `C-70`): nothing stored
 * here is a secret. `PendingWalletSession`'s `issuerSecret`/`paymentSecret`/
 * `agentKeypair` never crossed this boundary in the first place (`C-69`
 * showed they are either static env values or deterministically
 * re-derivable) — this module's payload types simply do not have those
 * fields.
 *
 * Same shape as `pending-write-store.ts`: one `Pool`, T62's TLS posture,
 * errors logged with `logError` (T63) and re-thrown as a typed
 * `ConfigError`. Every row read back is validated with zod
 * (`agentPassCredentialSchema`/`agentPayMandateSchema`/
 * `credentialRequestSchema`, all already used elsewhere in this codebase for
 * exactly this reason) rather than cast — the same discipline
 * `@agentpey/directory` already applies to its own Postgres rows.
 */
import { AgentPassError, agentPassCredentialSchema, credentialRequestSchema } from "@agentpass/core";
import { agentPayMandateSchema } from "@agentpey/mandate";
import { Pool } from "pg";
import { z } from "zod";

import { logError } from "./logging.js";

export interface WalletSessionStoreOptions {
  readonly connectionString: string;
}

const pendingWalletSessionPayloadSchema = z.strictObject({
  issuedCredentialJws: z.string(),
  credentialHash: z.string(),
  credentialAnchorTx: z.string(),
  credential: agentPassCredentialSchema,
  mandate: agentPayMandateSchema,
  walletAddress: z.string(),
  demoScope: credentialRequestSchema,
  baseUrl: z.string(),
  /** Only ever read as an id (`wallet-anchor`'s `supersedesId`) — no reason to carry the full record. */
  supersedesId: z.string().optional(),
  signature: z.string().optional(),
  requestId: z.string().optional(),
});
export type PendingWalletSessionPayload = z.infer<typeof pendingWalletSessionPayloadSchema>;

const pendingConsentSessionPayloadSchema = z.strictObject({
  issuedCredentialJws: z.string(),
  credentialHash: z.string(),
  credentialAnchorTx: z.string(),
  credential: agentPassCredentialSchema,
  mandate: agentPayMandateSchema,
  walletAddress: z.string(),
  tenantId: z.string(),
  signature: z.string().optional(),
  requestId: z.string().optional(),
});
export type PendingConsentSessionPayload = z.infer<typeof pendingConsentSessionPayloadSchema>;

export interface PendingSessionPatch {
  readonly signature?: string;
  readonly requestId?: string;
}

export interface WalletSessionStore {
  /** Single-use — see `takeChallenge`. */
  issueChallenge(nonce: string, ttlMs: number): Promise<void>;
  /** Reads and consumes. `true` iff a live (unexpired) challenge existed. */
  takeChallenge(nonce: string): Promise<boolean>;

  setPendingWalletSession(sessionId: string, payload: PendingWalletSessionPayload, ttlMs: number): Promise<void>;
  /** Reads without consuming — both wallet-consent and wallet-anchor need this without ending the flow. */
  getPendingWalletSession(sessionId: string): Promise<PendingWalletSessionPayload | undefined>;
  /** Merges `patch` into the stored payload — `signature`/`requestId`, set after the row already exists. */
  updatePendingWalletSession(sessionId: string, patch: PendingSessionPatch): Promise<void>;
  deletePendingWalletSession(sessionId: string): Promise<void>;

  setPendingConsentSession(consentSessionId: string, payload: PendingConsentSessionPayload, ttlMs: number): Promise<void>;
  getPendingConsentSession(consentSessionId: string): Promise<PendingConsentSessionPayload | undefined>;
  updatePendingConsentSession(consentSessionId: string, patch: PendingSessionPatch): Promise<void>;
  deletePendingConsentSession(consentSessionId: string): Promise<void>;

  /** No TTL — mirrors the plain `Map` this replaces: a session's own lifetime is what actually bounds it. */
  setWalletAddressForSession(sessionId: string, address: string): Promise<void>;
  getWalletAddressForSession(sessionId: string): Promise<string | undefined>;

  setWalletAddressForConsentSession(consentSessionId: string, address: string): Promise<void>;
  getWalletAddressForConsentSession(consentSessionId: string): Promise<string | undefined>;
  deleteWalletAddressForConsentSession(consentSessionId: string): Promise<void>;

  /**
   * Deletes rows past their own `expires_at` from the three tables that have
   * one (`wallet_challenges`, `pending_wallet_sessions`,
   * `pending_consent_sessions`) — every read here already filters by
   * `expires_at > now()`, but nothing removed the row itself for a flow that
   * never finished (an abandoned wallet connection, a challenge nobody
   * answered). Without this, those tables grow without bound. Deliberately
   * does not touch `wallet_address_by_session`/`wallet_address_by_consent_session`
   * — those have no `expires_at` by design (`C-71`: a session's own lifetime
   * bounds them, not a TTL). Returns how many rows each table lost, for
   * logging.
   */
  sweepExpired(): Promise<{
    readonly walletChallenges: number;
    readonly pendingWalletSessions: number;
    readonly pendingConsentSessions: number;
  }>;
}

const CREATE_TABLES_SQL = `
  create table if not exists wallet_challenges (
    nonce      text        not null primary key,
    expires_at timestamptz not null
  );
  create table if not exists pending_wallet_sessions (
    session_id text        not null primary key,
    payload    jsonb       not null,
    expires_at timestamptz not null
  );
  create table if not exists pending_consent_sessions (
    consent_session_id text        not null primary key,
    payload             jsonb       not null,
    expires_at          timestamptz not null
  );
  create table if not exists wallet_address_by_session (
    session_id     text not null primary key,
    wallet_address text not null
  );
  create table if not exists wallet_address_by_consent_session (
    consent_session_id text not null primary key,
    wallet_address      text not null
  )
`;

function parsePayload<T>(schema: z.ZodType<T>, raw: unknown, table: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", `a row in ${table} does not match the expected shape`, {
      details: { table, issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return parsed.data;
}

export async function createPostgresWalletSessionStore(
  options: WalletSessionStoreOptions,
): Promise<WalletSessionStore> {
  const { connectionString } = options;
  const postgresCa = process.env.POSTGRES_CA_CERT;
  const pool = new Pool({
    connectionString,
    ssl:
      postgresCa === undefined || postgresCa === ""
        ? { rejectUnauthorized: false }
        : { ca: postgresCa, rejectUnauthorized: true },
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => logError("[wallet-session-store] idle Postgres client failed", error));

  try {
    await pool.query(CREATE_TABLES_SQL);
  } catch (error) {
    logError("[wallet-session-store] could not reach or initialise Postgres", error);
    throw new AgentPassError("ConfigError", "could not reach or initialise the wallet-session store's Postgres database", {
      cause: error,
    });
  }

  async function run<T>(action: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      logError(`[wallet-session-store] ${action} failed`, error);
      throw new AgentPassError("ConfigError", `could not ${action} in Postgres`, { cause: error });
    }
  }

  return {
    issueChallenge(nonce, ttlMs) {
      return run("save a wallet challenge", async () => {
        await pool.query("insert into wallet_challenges (nonce, expires_at) values ($1, $2)", [
          nonce,
          new Date(Date.now() + ttlMs),
        ]);
      });
    },

    takeChallenge(nonce) {
      return run("read a wallet challenge", async () => {
        const { rows } = await pool.query(
          "delete from wallet_challenges where nonce = $1 and expires_at > now() returning nonce",
          [nonce],
        );
        return rows.length > 0;
      });
    },

    setPendingWalletSession(sessionId, payload, ttlMs) {
      return run("save a pending wallet session", async () => {
        await pool.query(
          `insert into pending_wallet_sessions (session_id, payload, expires_at) values ($1, $2, $3)
           on conflict (session_id) do update set payload = excluded.payload, expires_at = excluded.expires_at`,
          [sessionId, JSON.stringify(payload), new Date(Date.now() + ttlMs)],
        );
      });
    },

    getPendingWalletSession(sessionId) {
      return run("read a pending wallet session", async () => {
        const { rows } = await pool.query<{ payload: unknown }>(
          "select payload from pending_wallet_sessions where session_id = $1 and expires_at > now()",
          [sessionId],
        );
        return rows[0] === undefined
          ? undefined
          : parsePayload(pendingWalletSessionPayloadSchema, rows[0].payload, "pending_wallet_sessions");
      });
    },

    updatePendingWalletSession(sessionId, patch) {
      return run("update a pending wallet session", async () => {
        await pool.query(
          "update pending_wallet_sessions set payload = payload || $2::jsonb where session_id = $1 and expires_at > now()",
          [sessionId, JSON.stringify(patch)],
        );
      });
    },

    deletePendingWalletSession(sessionId) {
      return run("delete a pending wallet session", async () => {
        await pool.query("delete from pending_wallet_sessions where session_id = $1", [sessionId]);
      });
    },

    setPendingConsentSession(consentSessionId, payload, ttlMs) {
      return run("save a pending consent session", async () => {
        await pool.query(
          `insert into pending_consent_sessions (consent_session_id, payload, expires_at) values ($1, $2, $3)
           on conflict (consent_session_id) do update set payload = excluded.payload, expires_at = excluded.expires_at`,
          [consentSessionId, JSON.stringify(payload), new Date(Date.now() + ttlMs)],
        );
      });
    },

    getPendingConsentSession(consentSessionId) {
      return run("read a pending consent session", async () => {
        const { rows } = await pool.query<{ payload: unknown }>(
          "select payload from pending_consent_sessions where consent_session_id = $1 and expires_at > now()",
          [consentSessionId],
        );
        return rows[0] === undefined
          ? undefined
          : parsePayload(pendingConsentSessionPayloadSchema, rows[0].payload, "pending_consent_sessions");
      });
    },

    updatePendingConsentSession(consentSessionId, patch) {
      return run("update a pending consent session", async () => {
        await pool.query(
          "update pending_consent_sessions set payload = payload || $2::jsonb where consent_session_id = $1 and expires_at > now()",
          [consentSessionId, JSON.stringify(patch)],
        );
      });
    },

    deletePendingConsentSession(consentSessionId) {
      return run("delete a pending consent session", async () => {
        await pool.query("delete from pending_consent_sessions where consent_session_id = $1", [consentSessionId]);
      });
    },

    setWalletAddressForSession(sessionId, address) {
      return run("save a wallet address for a session", async () => {
        await pool.query(
          `insert into wallet_address_by_session (session_id, wallet_address) values ($1, $2)
           on conflict (session_id) do update set wallet_address = excluded.wallet_address`,
          [sessionId, address],
        );
      });
    },

    getWalletAddressForSession(sessionId) {
      return run("read a wallet address for a session", async () => {
        const { rows } = await pool.query<{ wallet_address: string }>(
          "select wallet_address from wallet_address_by_session where session_id = $1",
          [sessionId],
        );
        return rows[0]?.wallet_address;
      });
    },

    setWalletAddressForConsentSession(consentSessionId, address) {
      return run("save a wallet address for a consent session", async () => {
        await pool.query(
          `insert into wallet_address_by_consent_session (consent_session_id, wallet_address) values ($1, $2)
           on conflict (consent_session_id) do update set wallet_address = excluded.wallet_address`,
          [consentSessionId, address],
        );
      });
    },

    getWalletAddressForConsentSession(consentSessionId) {
      return run("read a wallet address for a consent session", async () => {
        const { rows } = await pool.query<{ wallet_address: string }>(
          "select wallet_address from wallet_address_by_consent_session where consent_session_id = $1",
          [consentSessionId],
        );
        return rows[0]?.wallet_address;
      });
    },

    deleteWalletAddressForConsentSession(consentSessionId) {
      return run("delete a wallet address for a consent session", async () => {
        await pool.query("delete from wallet_address_by_consent_session where consent_session_id = $1", [consentSessionId]);
      });
    },

    sweepExpired() {
      return run("sweep expired wallet-session rows", async () => {
        const [challenges, walletSessions, consentSessions] = await Promise.all([
          pool.query("delete from wallet_challenges where expires_at <= now()"),
          pool.query("delete from pending_wallet_sessions where expires_at <= now()"),
          pool.query("delete from pending_consent_sessions where expires_at <= now()"),
        ]);
        return {
          walletChallenges: challenges.rowCount ?? 0,
          pendingWalletSessions: walletSessions.rowCount ?? 0,
          pendingConsentSessions: consentSessions.rowCount ?? 0,
        };
      });
    },
  };
}
