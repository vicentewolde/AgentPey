/**
 * A {@link MandateVault} backed by Postgres — Fase 6, T33. The append-only,
 * hash-chained shape is identical to {@link createFileMandateVault}; the only
 * thing that changes is where the records live.
 *
 * Motive: `createFileMandateVault` writes JSON Lines to a path on local
 * disk, which is exactly what breaks on Render's free tier — the
 * filesystem is wiped on every redeploy and every scale-to-zero restart, so
 * a vault built that way loses its evidence the moment the pilot's host
 * restarts, not just when someone deletes it on purpose. Postgres survives
 * that restart; this is the only difference that matters for the fix.
 *
 * `tenantId` scopes the chain: every row this instance writes or reads
 * carries the same `tenant_id`, so one shared Postgres database can hold
 * many independent vaults (one per `apps/web` session today, one per real
 * partner once T34 gives each tenant its own funded Stellar identity) in one
 * table, the same way `createFileMandateVault`'s `path` scopes one vault to
 * one file.
 */
import { AgentPassError } from "@agentpass/core";
import { Pool } from "pg";

import { computeHash, scaleAmount, utcDayKey, unscaleAmount } from "./internal/amount.js";
import type {
  LockedVaultLedger,
  MandateVault,
  ReleaseSpendInput,
  VaultEntry,
  VaultLedgerEntry,
  VaultRecord,
} from "./vault.js";

/** What `pool` and a checked-out `client` have in common — the only thing the query helpers below need. */
interface Queryable {
  query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export interface PostgresMandateVaultOptions {
  readonly connectionString: string;
  readonly tenantId: string;
}

interface VaultRow {
  readonly seq: number;
  readonly prev_hash: string;
  readonly hash: string;
  readonly entry: VaultEntry;
}

// `entry` is `json`, not `jsonb`, on purpose: Postgres's `jsonb` type
// normalises object key order on write, while `json` preserves the exact
// text it was given. `computeHash` recomputes over `JSON.stringify(entry)`,
// which is order-sensitive — a `jsonb` round trip silently reorders keys and
// makes `verify()` report tampering that never happened (found by this
// package's own integration test, not read from documentation).
const CREATE_TABLE_SQL = `
  create table if not exists vault_records (
    tenant_id  text        not null,
    seq        integer     not null,
    prev_hash  text        not null,
    hash       text        not null,
    entry      json        not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, seq)
  )
`;

interface SharedPool {
  readonly pool: Pool;
  /** The table exists. Resolved once per pool, not once per vault. */
  readonly ready: Promise<void>;
}

const sharedPools = new Map<string, SharedPool>();

/**
 * One pool per process per database, shared by every vault instance — T84.
 *
 * Before this, every `createPostgresMandateVault` call opened its own `Pool`
 * and nothing ever closed it. `apps/web` builds a vault per request (two per
 * `GET /v1/tenants/{id}/activity`, one per purchase) and so does the status
 * dashboard, so connections piled up against Supabase's session-mode pooler
 * until new ones queued: one activity read took 73 s in the deployed pilot,
 * against 0.4 s for a tenant with no vault. The connections leaked; the chain
 * never did.
 *
 * **Sharing the pool changes nothing about enforcement.** `withOwnLock` takes
 * the advisory lock inside a transaction on a client checked out for that
 * section alone, so two vault instances — same tenant or not — still hold two
 * separate connections and still serialise on the database lock, exactly as
 * with two pools. And nothing inside `atomically`'s work asks the pool for a
 * second client while the lock is held: `LocalPolicyRail.authorise()` uses
 * only the locked client, and `withVault` records a refusal after the critical
 * section has committed. A nested checkout is what would make a shared, bounded
 * pool able to wait on itself; there is none.
 *
 * Keyed on the CA as well as the URL, because the CA decides whether TLS
 * verifies the server, and a pool opened under one posture must not serve the
 * other. A failed initialisation is not kept: the next call tries again rather
 * than inheriting a broken pool for the life of the process.
 */
function sharedPoolFor(connectionString: string): SharedPool {
  // Supabase (this project's documented choice, .env.example) requires TLS
  // for external connections; `pg` does not negotiate it on its own from a
  // plain `postgresql://` string. A supplied provider CA makes TLS verify the
  // server certificate. Without one, retain the pilot's existing encrypted
  // but unverified connection for providers whose chain Node does not ship.
  const postgresCa = process.env.POSTGRES_CA_CERT;
  // JSON, not a separator character: unambiguous whatever either value contains.
  const key = JSON.stringify([connectionString, postgresCa ?? ""]);
  const existing = sharedPools.get(key);
  if (existing !== undefined) return existing;

  const pool = new Pool({
    connectionString,
    ssl:
      postgresCa === undefined || postgresCa === ""
        ? { rejectUnauthorized: false }
        : { ca: postgresCa, rejectUnauthorized: true },
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => {
    console.error(`[vault] idle Postgres client failed: ${error.message}`);
  });

  const ready = pool.query(CREATE_TABLE_SQL).then(
    () => undefined,
    async (error: unknown) => {
      sharedPools.delete(key);
      await pool.end().catch(() => undefined);
      // The underlying driver error (wrong password, SSL required, host
      // unreachable, ...) used to vanish here — logged nowhere, shown nowhere.
      // Both the server log (for a host like Render, where that's the only
      // place to look) and the details this bubbles up to the caller now carry
      // the real message, not just this function's own generic one.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[vault] could not reach or initialise Postgres: ${message}`);
      throw new AgentPassError("ConfigError", "could not reach or initialise the vault's Postgres database", {
        cause: error,
        details: { cause: message },
      });
    },
  );

  // Set before anything is awaited, so two vaults created at the same moment
  // share this pool instead of each opening one.
  const shared: SharedPool = { pool, ready };
  sharedPools.set(key, shared);
  return shared;
}

/**
 * @throws AgentPassError `ConfigError` if `connectionString` cannot be
 * reached at all (the caller almost certainly wants that to be loud, not a
 * vault that silently behaves as if it were empty).
 */
export async function createPostgresMandateVault(options: PostgresMandateVaultOptions): Promise<MandateVault> {
  const { connectionString, tenantId } = options;
  const { pool, ready } = sharedPoolFor(connectionString);
  await ready;

  let rows: readonly VaultRow[];
  try {
    ({ rows } = await pool.query<VaultRow>(
      "select seq, prev_hash, hash, entry from vault_records where tenant_id = $1 order by seq asc",
      [tenantId],
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[vault] could not load vault_records for tenant ${tenantId}: ${message}`);
    throw new AgentPassError("ConfigError", "could not read this tenant's vault records from Postgres", {
      cause: error,
      details: { cause: message },
    });
  }

  const records: VaultRecord[] = rows.map((row) => ({
    seq: row.seq,
    prevHash: row.prev_hash,
    hash: row.hash,
    entry: row.entry,
  }));

  // The one query `spentOn` runs, against either `pool` (a plain read, no
  // lock needed) or a `client` already holding this tenant's advisory lock
  // (inside `atomically`) — same SQL either way, so the two never drift.
  //
  // `released` entries count too, with the opposite sign (`C-113`): a spend
  // given back because its purchase never reached the network is not part of
  // the day's total. A release carries its *grant's* day in `at`, so this
  // day filter puts both sides of the pair in the same bucket by
  // construction.
  async function spentOnVia(queryable: Queryable, subject: string, currency: string, at: Date): Promise<string> {
    const { rows } = await queryable.query<{ entry: VaultEntry }>(
      `select entry from vault_records
       where tenant_id = $1
         and entry->>'kind' in ('granted', 'released')
         and entry->>'subject' = $2
         and entry->>'currency' = $3
         and left(entry->>'at', 10) = $4`,
      [tenantId, subject, currency, utcDayKey(at)],
    );
    let total = 0n;
    for (const row of rows) {
      if (row.entry.kind === "granted") total += scaleAmount(row.entry.amount);
      if (row.entry.kind === "released") total -= scaleAmount(row.entry.amount);
    }
    return unscaleAmount(total);
  }

  /** The latest `granted` entry for `intentId`, and whether anything has happened to it since. */
  async function grantStateVia(
    queryable: Queryable,
    intentId: string,
  ): Promise<{ granted?: VaultEntry & { kind: "granted" }; released: boolean; anchored: boolean }> {
    const { rows } = await queryable.query<{ entry: VaultEntry }>(
      `select entry from vault_records
       where tenant_id = $1
         and entry->>'intentId' = $2
         and entry->>'kind' in ('granted', 'released', 'anchored')
       order by seq asc`,
      [tenantId, intentId],
    );
    let granted: (VaultEntry & { kind: "granted" }) | undefined;
    let released = false;
    let anchored = false;
    for (const row of rows) {
      // In `seq` order, so a grant written *after* a release (the same intent
      // authorised again) clears the release, exactly as the file vault does.
      if (row.entry.kind === "granted") {
        granted = row.entry;
        released = false;
      }
      if (row.entry.kind === "released") released = true;
      if (row.entry.kind === "anchored") anchored = true;
    }
    return { ...(granted === undefined ? {} : { granted }), released, anchored };
  }

  // `hasRecorded`'s real check, against either `pool` or a locked `client`.
  //
  // There is deliberately no in-memory shortcut here. An earlier version kept
  // a `seenIntents` set and returned `true` straight from it, which was both
  // stale across processes (the same staleness `spentOn` had before `G4`) and,
  // once `release` existed, wrong even within one: a released intent has a
  // `granted` row and must still answer `false`, so that authorising it again
  // counts again (`C-113`).
  async function hasRecordedVia(queryable: Queryable, intentId: string): Promise<boolean> {
    const state = await grantStateVia(queryable, intentId);
    return state.granted !== undefined && !state.released;
  }

  /**
   * The append itself, against a `client` that already holds this tenant's
   * advisory lock — shared by `append()` below (which takes the lock itself)
   * and `atomically()` (which already holds it for the whole critical
   * section). `seq`/`prevHash` used to come from this instance's own local
   * `records` array (`records.length`, `records.at(-1)`), which is exactly
   * what let two live instances of this same tenant's vault both compute
   * `seq = 0` and collide on the table's own primary key the moment both
   * tried to append (found writing this ticket's own test, not by
   * inspection). Reading the real, current tail of the chain always happens
   * inside the lock, so no other writer can move it out from under this
   * insert.
   */
  async function appendVia(client: Queryable, entry: VaultEntry): Promise<VaultRecord> {
    const { rows: tail } = await client.query<{ seq: number; hash: string }>(
      "select seq, hash from vault_records where tenant_id = $1 order by seq desc limit 1",
      [tenantId],
    );
    const seq = (tail[0]?.seq ?? -1) + 1;
    const prevHash = tail[0]?.hash ?? "";
    const record: VaultRecord = { seq, prevHash, hash: computeHash(seq, prevHash, entry), entry };

    await client.query(
      "insert into vault_records (tenant_id, seq, prev_hash, hash, entry) values ($1, $2, $3, $4, $5)",
      [tenantId, record.seq, record.prevHash, record.hash, JSON.stringify(record.entry)],
    );
    records.push(record);
    return record;
  }

  /**
   * Opens its own locked transaction and runs `work` inside it — the shape
   * every caller but `atomically` wants (which already has one open).
   */
  async function withOwnLock<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [tenantId]);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function append(entry: VaultEntry): Promise<VaultRecord> {
    return withOwnLock((client) => appendVia(client, entry));
  }

  /** The `granted`-entry shape `atomically`'s scoped `record` writes — same fields `record()` below builds. */
  async function recordVia(client: Queryable, entry: VaultLedgerEntry): Promise<void> {
    if (await hasRecordedVia(client, entry.intentId)) return;
    scaleAmount(entry.amount); // validates before anything is written, same rule as record() below
    await appendVia(client, {
      kind: "granted",
      subject: entry.subject,
      intentId: entry.intentId,
      currency: entry.currency,
      amount: entry.amount,
      at: entry.at.toISOString(),
    });
  }

  /**
   * The release itself, against a `client` that already holds this tenant's
   * advisory lock — shared by `release()` and `atomically()`'s scoped
   * `release`, for the same reason `recordVia`/`appendVia` are shared: one
   * caller inside a critical section and one outside must not drift into two
   * different notions of what releasing means.
   */
  async function releaseVia(client: Queryable, input: ReleaseSpendInput): Promise<void> {
    const state = await grantStateVia(client, input.intentId);
    if (state.released) return;
    if (state.granted === undefined) {
      throw new AgentPassError("SpendNotRecorded", "no granted spend to release for that intent", {
        details: { intentId: input.intentId },
      });
    }
    if (state.anchored) {
      throw new AgentPassError(
        "SpendAlreadySettled",
        "that intent's payment is anchored on-chain and cannot be released",
        { details: { intentId: input.intentId } },
      );
    }
    const { granted } = state;
    await appendVia(client, {
      kind: "released",
      subject: granted.subject,
      intentId: granted.intentId,
      currency: granted.currency,
      amount: granted.amount,
      // The grant's own day, copied verbatim — never `now`.
      at: granted.at,
      reason: input.reason,
    });
  }

  return {
    // G4: reads the running total straight from Postgres on every call,
    // instead of an in-memory cache built once at construction — two
    // processes (two Render instances, or this same process before and
    // after a restart) share one source of truth for `perDay`, not one
    // cache each that never learns about the other's writes. `checkDailyLimit`
    // itself is untouched (M-10 / this ticket's own scope): only where the
    // total it is handed comes from changes.
    async spentOn(subject, currency, at) {
      return spentOnVia(pool, subject, currency, at);
    },

    /**
     * G4-followup: the read of `spentOn`, the caller's limit decision, and
     * this `record` all happen inside one transaction holding this tenant's
     * advisory lock — the same lock `append` already takes for the chain's
     * own integrity, now held for the whole critical section instead of just
     * the insert. `pnpm run loadtest:perday` is what found that `append`'s
     * fix alone was not enough: four real, separate Node processes each read
     * `spentOn` before any of them wrote, so all four decided "under the
     * limit" and all four recorded — 12.00 against a 10.00 reference limit,
     * with the chain itself intact throughout (the write collision T61 fixed
     * stayed fixed; the decision race was a different gap, one layer up).
     * `LocalPolicyRail.authorise()` (`apps/agent`) is the only caller.
     */
    // `subject` is part of the port's shape (an in-memory fallback keys its
    // queue by it) but unused here: the chain's `seq` is one sequence per
    // *tenant*, already serialised on `tenantId` by every write, so locking
    // on that same key — not `subject` — is what `append`'s own lock does too.
    async atomically(_subject, work) {
      return withOwnLock((client) => {
        const locked: LockedVaultLedger = {
          spentOn: (lockedSubject, currency, at) => spentOnVia(client, lockedSubject, currency, at),
          hasRecorded: (intentId) => hasRecordedVia(client, intentId),
          record: (entry) => recordVia(client, entry),
          release: (input) => releaseVia(client, input),
        };
        return work(locked);
      });
    },

    // Dedup and the append share `recordVia`/`appendVia` with `atomically`'s
    // scoped `record` on purpose: one caller outside a critical section
    // (this method) and one caller already inside one (`atomically`) must
    // not risk drifting into two different notions of "already recorded".
    async record(entry) {
      await withOwnLock((client) => recordVia(client, entry));
    },

    async hasRecorded(intentId) {
      return hasRecordedVia(pool, intentId);
    },

    // Takes this tenant's advisory lock for itself, like `record` — a release
    // reads the grant it undoes and appends against the chain's current tail,
    // and both have to be inside the same lock as every other writer (`C-113`).
    async release(input) {
      await withOwnLock((client) => releaseVia(client, input));
    },

    async recordRefusal(input, at) {
      await append({
        kind: "refused",
        subject: input.subject,
        intentId: input.intentId,
        code: input.code,
        reason: input.reason,
        details: input.details,
        at: (at ?? new Date()).toISOString(),
      });
    },

    async recordAnchor(input, at) {
      await append({
        kind: "anchored",
        subject: input.subject,
        intentId: input.intentId,
        paymentTx: input.paymentTx,
        linkHash: input.linkHash,
        anchorTx: input.anchorTx,
        at: (at ?? new Date()).toISOString(),
      });
    },

    list(subject) {
      return subject === undefined ? records.slice() : records.filter((r) => r.entry.subject === subject);
    },

    head() {
      return records.at(-1)?.hash;
    },

    verify() {
      let prevHash = "";
      for (const record of records) {
        const expected = computeHash(record.seq, prevHash, record.entry);
        if (record.hash !== expected || record.prevHash !== prevHash) {
          return { ok: false, brokenAtSeq: record.seq };
        }
        prevHash = record.hash;
      }
      return { ok: true };
    },
  };
}
