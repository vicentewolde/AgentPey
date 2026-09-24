/**
 * RealOps' durable storage — its own tables, holding the one thing AgentPey
 * must never receive.
 *
 * Table names are prefixed `realops_`, and nothing in this file reads a row
 * outside that prefix. Sharing a Postgres instance with the rest of the pilot
 * is a Render constraint, not a design: separate databases is a deployment
 * change, not a code change.
 *
 * Two writes here are deliberately *conditional updates* rather than
 * read-then-write, for the reason `C-82` spelled out on the funding path — a
 * decision made by reading and confirmed by a later write has a window in it:
 *
 * - `redeemMagicLink` marks the token used **only if** it is unused, and
 *   reports whether this caller was the one that marked it. Two clicks on the
 *   same link cannot both win.
 * - `forgetAccount` nulls the email in one statement; it never reads it first.
 */
import type {
  Account,
  AgentConfig,
  AgentPermissions,
  MagicLink,
  RealOpsStore,
  Session,
} from "./accounts.js";
import { newAccount, newAgent } from "./accounts.js";

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export const REALOPS_SCHEMA_SQL: readonly string[] = [
  `create table if not exists realops_accounts (
     id           text        primary key,
     email        text        unique,
     alias        text        not null,
     external_ref text        not null unique,
     created_at   timestamptz not null default now(),
     last_seen_at timestamptz not null default now()
   )`,

  `create table if not exists realops_magic_links (
     token_hash text        primary key,
     account_id text        not null references realops_accounts(id),
     expires_at timestamptz not null,
     used_at    timestamptz
   )`,

  `create index if not exists realops_magic_links_expiry_idx on realops_magic_links (expires_at)`,

  `create table if not exists realops_sessions (
     id         text        primary key,
     account_id text        not null references realops_accounts(id),
     expires_at timestamptz not null
   )`,

  `create index if not exists realops_sessions_account_idx on realops_sessions (account_id)`,

  `create table if not exists realops_agents (
     id                 text        primary key,
     account_id         text        not null references realops_accounts(id),
     kind               text        not null,
     label              text        not null,
     permissions        json        not null,
     tenant_id          text,
     consent_session_id text,
     mandate_id         text,
     created_at         timestamptz not null default now()
   )`,

  `create index if not exists realops_agents_account_idx on realops_agents (account_id)`,

  // T104: the Vitrinee store a store shopper buys at. Null for every other kind
  // and for a store shopper hired before the platform existed.
  `alter table realops_agents add column if not exists comercio text`,
];

interface AccountRow {
  readonly id: string;
  readonly email: string | null;
  readonly alias: string;
  readonly external_ref: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    alias: row.alias,
    externalRef: row.external_ref,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

interface AgentRow {
  readonly id: string;
  readonly account_id: string;
  readonly kind: string;
  readonly label: string;
  readonly permissions: AgentPermissions;
  readonly tenant_id: string | null;
  readonly consent_session_id: string | null;
  readonly mandate_id: string | null;
  readonly comercio: string | null;
  readonly created_at: Date;
}

function toAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind as AgentConfig["kind"],
    label: row.label,
    permissions: row.permissions,
    tenantId: row.tenant_id,
    consentSessionId: row.consent_session_id,
    mandateId: row.mandate_id,
    comercio: row.comercio ?? null,
    createdAt: row.created_at,
  };
}

export function createPostgresStore(client: SqlClient): RealOpsStore {
  return {
    async findAccountByEmail(email) {
      const { rows } = await client.query(`select * from realops_accounts where email = $1`, [email.toLowerCase()]);
      const row = rows[0] as AccountRow | undefined;
      return row === undefined ? undefined : toAccount(row);
    },

    async findAccount(id) {
      const { rows } = await client.query(`select * from realops_accounts where id = $1`, [id]);
      const row = rows[0] as AccountRow | undefined;
      return row === undefined ? undefined : toAccount(row);
    },

    async createAccount(email, alias) {
      const account = newAccount(email, alias);
      await client.query(
        `insert into realops_accounts (id, email, alias, external_ref, created_at, last_seen_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [account.id, account.email, account.alias, account.externalRef, account.createdAt, account.lastSeenAt],
      );
      return account;
    },

    async touchAccount(id, now) {
      await client.query(`update realops_accounts set last_seen_at = $2 where id = $1`, [id, now]);
    },

    async forgetAccount(id) {
      // One statement, no read: there is nothing to race with, and the email
      // is never loaded into this process in order to erase it.
      await client.query(
        `update realops_accounts set email = null, alias = 'cuenta borrada' where id = $1`,
        [id],
      );
    },

    async saveMagicLink(link) {
      await client.query(
        `insert into realops_magic_links (token_hash, account_id, expires_at, used_at)
         values ($1, $2, $3, null)
         on conflict (token_hash) do nothing`,
        [link.tokenHash, link.accountId, link.expiresAt],
      );
    },

    async findMagicLink(tokenHash) {
      const { rows } = await client.query(
        `select token_hash, account_id, expires_at, used_at from realops_magic_links where token_hash = $1`,
        [tokenHash],
      );
      const row = rows[0] as
        | { token_hash: string; account_id: string; expires_at: Date; used_at: Date | null }
        | undefined;
      return row === undefined
        ? undefined
        : { tokenHash: row.token_hash, accountId: row.account_id, expiresAt: row.expires_at, usedAt: row.used_at };
    },

    async redeemMagicLink(tokenHash, now) {
      // The claim *is* the write: `used_at is null` in the where clause means
      // exactly one concurrent caller can come back with a row.
      const { rowCount } = await client.query(
        `update realops_magic_links set used_at = $2
           where token_hash = $1 and used_at is null and expires_at > $2`,
        [tokenHash, now],
      );
      return (rowCount ?? 0) > 0;
    },

    async saveSession(session) {
      await client.query(
        `insert into realops_sessions (id, account_id, expires_at) values ($1, $2, $3)
         on conflict (id) do nothing`,
        [session.id, session.accountId, session.expiresAt],
      );
    },

    async findSession(id) {
      const { rows } = await client.query(
        `select id, account_id, expires_at from realops_sessions where id = $1`,
        [id],
      );
      const row = rows[0] as { id: string; account_id: string; expires_at: Date } | undefined;
      return row === undefined ? undefined : { id: row.id, accountId: row.account_id, expiresAt: row.expires_at };
    },

    async deleteSession(id) {
      await client.query(`delete from realops_sessions where id = $1`, [id]);
    },

    async deleteSessionsFor(accountId) {
      await client.query(`delete from realops_sessions where account_id = $1`, [accountId]);
    },

    async saveAgent(agent) {
      await client.query(
        `insert into realops_agents
           (id, account_id, kind, label, permissions, tenant_id, consent_session_id, mandate_id, created_at, comercio)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do update
           set label = excluded.label, permissions = excluded.permissions,
               tenant_id = excluded.tenant_id, consent_session_id = excluded.consent_session_id,
               mandate_id = excluded.mandate_id`,
        [
          agent.id,
          agent.accountId,
          agent.kind,
          agent.label,
          JSON.stringify(agent.permissions),
          agent.tenantId,
          agent.consentSessionId,
          agent.mandateId,
          agent.createdAt,
          agent.comercio,
        ],
      );
    },

    async listAgents(accountId) {
      const { rows } = await client.query(
        `select * from realops_agents where account_id = $1 order by created_at`,
        [accountId],
      );
      return (rows as AgentRow[]).map(toAgent);
    },

    async findAgentByConsentSession(accountId, consentSessionId) {
      const { rows } = await client.query(
        `select * from realops_agents where account_id = $1 and consent_session_id = $2`,
        [accountId, consentSessionId],
      );
      const row = rows[0] as AgentRow | undefined;
      return row === undefined ? undefined : toAgent(row);
    },

    async findAgent(accountId, agentId) {
      // Scoped by account in the query itself, so "another person's agent"
      // cannot come back and then be filtered out by a caller who forgot to.
      const { rows } = await client.query(
        `select * from realops_agents where id = $1 and account_id = $2`,
        [agentId, accountId],
      );
      const row = rows[0] as AgentRow | undefined;
      return row === undefined ? undefined : toAgent(row);
    },
  };
}

export { newAgent };

/**
 * Deletes what has expired, rather than merely stopping reading it — the same
 * distinction T70 drew for AgentPey's own ephemeral rows, and the reason it
 * built a sweep instead of relying on expiry checks at read time.
 */
export async function sweepExpired(client: SqlClient, now: Date): Promise<{ links: number; sessions: number }> {
  const links = await client.query(`delete from realops_magic_links where expires_at < $1`, [now]);
  const sessions = await client.query(`delete from realops_sessions where expires_at < $1`, [now]);
  return { links: links.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
}

/**
 * Erases the email of any account untouched for `days` — the retention promise
 * the pilot notice makes, run rather than described.
 */
export async function sweepStaleEmails(client: SqlClient, now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { rowCount } = await client.query(
    `update realops_accounts set email = null, alias = 'cuenta inactiva'
       where email is not null and last_seen_at < $1`,
    [cutoff],
  );
  return rowCount ?? 0;
}
