/**
 * A `PendingWriteStore` (`@agentpass/sdk`, T67/G12) backed by Postgres —
 * what lets a wallet's `prepareAnchor`/`prepareRevoke` and its later
 * `submitSigned` land on two different `apps/web` instances instead of
 * requiring the same `Registry` object to survive between them.
 *
 * Same shape as `@agentpey/vault`'s `createPostgresMandateVault`: one small
 * table, TLS posture matching T62 (`POSTGRES_CA_CERT`), errors logged and
 * re-thrown as a typed `ConfigError` rather than vanishing into a stack
 * trace nobody reads on a host like Render.
 */
import { AgentPassError } from "@agentpass/core";
import type { PendingWrite, PendingWriteStore } from "@agentpass/sdk";
import { Pool } from "pg";

import { logError } from "./logging.js";

export interface PostgresPendingWriteStoreOptions {
  readonly connectionString: string;
}

/**
 * `PendingWriteStore` (the port `@agentpass/sdk` defines) plus a sweep this
 * Postgres implementation alone offers. Kept local rather than added to the
 * shared port: the in-memory default already prunes expired entries
 * opportunistically on every `save`/`take` (cheap for a `Map`), so the port
 * itself doesn't need this method — only a Postgres-backed store, where an
 * abandoned two-phase write (`prepareAnchor`/`prepareRevoke` never followed
 * by `submitSigned`) would otherwise sit in `sdk_pending_writes` forever.
 */
export interface PostgresPendingWriteStore extends PendingWriteStore {
  sweepExpired(): Promise<{ readonly deleted: number }>;
}

const CREATE_TABLE_SQL = `
  create table if not exists sdk_pending_writes (
    request_id text        not null primary key,
    payload     jsonb       not null,
    expires_at  timestamptz not null
  )
`;

interface PendingWriteRow {
  readonly payload: PendingWrite;
}

export async function createPostgresPendingWriteStore(
  options: PostgresPendingWriteStoreOptions,
): Promise<PostgresPendingWriteStore> {
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
  pool.on("error", (error) => logError("[pending-write-store] idle Postgres client failed", error));

  try {
    await pool.query(CREATE_TABLE_SQL);
  } catch (error) {
    logError("[pending-write-store] could not reach or initialise Postgres", error);
    throw new AgentPassError("ConfigError", "could not reach or initialise the pending-write store's Postgres database", {
      cause: error,
    });
  }

  return {
    async save(requestId, write, ttlMs) {
      try {
        await pool.query(
          "insert into sdk_pending_writes (request_id, payload, expires_at) values ($1, $2, $3)",
          [requestId, JSON.stringify(write), new Date(Date.now() + ttlMs)],
        );
      } catch (error) {
        logError("[pending-write-store] could not save a pending write", error);
        throw new AgentPassError("ConfigError", "could not save the pending write to Postgres", { cause: error });
      }
    },

    // One statement, not select-then-delete: two concurrent `submitSigned`
    // calls for the same requestId must not both see it as present — this
    // is the row's own single-use guarantee, not something a caller has to
    // coordinate.
    async take(requestId) {
      let rows: readonly PendingWriteRow[];
      try {
        ({ rows } = await pool.query<PendingWriteRow>(
          "delete from sdk_pending_writes where request_id = $1 and expires_at > now() returning payload",
          [requestId],
        ));
      } catch (error) {
        logError("[pending-write-store] could not read a pending write", error);
        throw new AgentPassError("ConfigError", "could not read the pending write from Postgres", { cause: error });
      }
      return rows[0]?.payload;
    },

    async sweepExpired() {
      try {
        const { rowCount } = await pool.query("delete from sdk_pending_writes where expires_at <= now()");
        return { deleted: rowCount ?? 0 };
      } catch (error) {
        logError("[pending-write-store] could not sweep expired pending writes", error);
        throw new AgentPassError("ConfigError", "could not sweep expired pending writes in Postgres", { cause: error });
      }
    },
  };
}
