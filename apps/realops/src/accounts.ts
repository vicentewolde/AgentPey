/**
 * RealOps' own data: who signed up, their sessions, their magic links, and the
 * agents they configured.
 *
 * **This is the only place an email exists in the whole pilot.** AgentPey never
 * receives one — a RealOps account is represented there by
 * {@link externalRefFor}, a random `rop_<ulid>` with no relationship to the
 * address it stands for. That last part is the whole point and it is worth
 * being explicit about why a hash would not do: a hash of an email is still an
 * identifier *of that person*, and a dictionary of common addresses reverses it
 * in seconds. A random id cannot be reversed because it never encoded anything.
 *
 * `packages/directory/src/external-ref.ts` refuses an `external_ref` shaped
 * like an email, a RUT or a phone number. F9 does not need to build that
 * defence — it needs to not require it, by never having anything personal to
 * send.
 *
 * **A magic link is stored as a hash, never as itself.** The token goes to the
 * person; a SHA-256 of it goes to the database. Someone who reads the table
 * cannot sign in with what they find there — the same reasoning the API keys in
 * `directory_api_keys` already use.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AgentPassError, ulid } from "@agentpass/core";
import { z } from "zod";

/** A pilot session lasts a week; a magic link, fifteen minutes and one use. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** An account with no activity for this long has its email erased by the sweep. */
export const EMAIL_RETENTION_DAYS = 90;

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "expected an email address");

export const aliasSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\u0000-\u001F\u007F]+$/, "an alias may not contain control characters");

/**
 * The agents the pilot offers. Not a free-form string: an agent is one of these.
 *
 * `bazaar_shopper` (T96) is the first kind named after a *merchant* rather than
 * a product family. The two SignalDesk kinds each buy one fixed thing; this one
 * shops a catalogue that the merchant publishes and can change. That difference
 * is the point of the screen it feeds: what the catalogue offers and what a
 * signed Mandate covers are two different sets, and the gap between them is
 * visible instead of being a wall the person walks into.
 *
 * `vitrinee_shopper` (T100) buys physical goods from a real store connected
 * through Vitrinee (`C-130`). Like the bazaar kind it is named after a merchant
 * and shops a live catalogue; unlike it, every product needs a shipping
 * address, so its purchases always go through the catalogue's form.
 */
export const agentKindSchema = z.enum(["market_brief", "ai_credits", "bazaar_shopper", "vitrinee_shopper"]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export interface Account {
  readonly id: string;
  /** Lowercased for lookup. The only personal datum in the pilot. */
  readonly email: string | null;
  readonly alias: string;
  /** What AgentPey knows this person as. Random, and never derived from the email. */
  readonly externalRef: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface Session {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: Date;
}

export interface MagicLink {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface AgentConfig {
  readonly id: string;
  readonly accountId: string;
  readonly kind: AgentKind;
  readonly label: string;
  /** What the person chose in the UI, before it becomes a grant. */
  readonly permissions: AgentPermissions;
  /** Filled in once AgentPey has a tenant for this account. */
  readonly tenantId: string | null;
  readonly consentSessionId: string | null;
  readonly mandateId: string | null;
  /**
   * For a store shopper (`vitrinee_shopper`, T104): the slug of the one Vitrinee
   * store it buys at, fixed when it is hired from that store's card. `null` for
   * every other kind, and for a store shopper hired before T104, whose grant
   * names the old single-store venue that AgentPey no longer pays.
   */
  readonly comercio: string | null;
  readonly createdAt: Date;
}

/** The controls the person actually sees. Deliberately small — every one maps to a signed field. */
export const agentPermissionsSchema = z.strictObject({
  /** Decimal USDC, as a string end to end — no float ever touches a limit. */
  perTx: z.string().regex(/^\d+(\.\d{1,7})?$/, "expected a decimal amount"),
  perDay: z.string().regex(/^\d+(\.\d{1,7})?$/, "expected a decimal amount"),
  /** How long the mandate is valid for, in days. */
  validForDays: z.number().int().min(1).max(90),
});

export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;

/**
 * A fresh opaque reference for AgentPey.
 *
 * Random, not derived. See this module's header for why that distinction is
 * the whole privacy boundary and not a detail of taste.
 */
export function externalRefFor(): string {
  return `rop_${ulid()}`;
}

export interface IssuedMagicLink {
  /** Goes in the link. Never stored. */
  readonly token: string;
  readonly link: MagicLink;
}

/** Mints a single-use token and the row that will later recognise it. */
export function issueMagicLink(accountId: string, now: Date = new Date()): IssuedMagicLink {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    link: {
      tokenHash: hashToken(token),
      accountId,
      expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
      usedAt: null,
    },
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time, so a timing signal cannot be used to guess a token hash. */
export function tokenMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type MagicLinkRejection = "unknown" | "expired" | "already-used";

export interface MagicLinkCheck {
  readonly ok: boolean;
  readonly reason?: MagicLinkRejection;
}

/**
 * Whether a stored link may be redeemed now.
 *
 * The three refusals stay distinct because they mean different things to the
 * person holding the link: one was never real, one waited too long, one is
 * being replayed. Collapsing them into "invalid link" is how a pilot produces
 * a support question it cannot answer.
 */
export function checkMagicLink(link: MagicLink | undefined, now: Date = new Date()): MagicLinkCheck {
  if (link === undefined) return { ok: false, reason: "unknown" };
  if (link.usedAt !== null) return { ok: false, reason: "already-used" };
  if (link.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true };
}

export function newSession(accountId: string, now: Date = new Date()): Session {
  return {
    id: randomBytes(32).toString("base64url"),
    accountId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
}

export function sessionIsLive(session: Session | undefined, now: Date = new Date()): boolean {
  return session !== undefined && session.expiresAt.getTime() > now.getTime();
}

/** Everything RealOps persists. AgentPey has no access to any of it. */
export interface RealOpsStore {
  findAccountByEmail(email: string): Promise<Account | undefined>;
  findAccount(id: string): Promise<Account | undefined>;
  createAccount(email: string, alias: string): Promise<Account>;
  touchAccount(id: string, now: Date): Promise<void>;
  /** Erases the email and alias, keeping the row so `externalRef` stays stable. */
  forgetAccount(id: string): Promise<void>;

  saveMagicLink(link: MagicLink): Promise<void>;
  findMagicLink(tokenHash: string): Promise<MagicLink | undefined>;
  /** Marks it used. Must be the write that decides, not a read followed by one. */
  redeemMagicLink(tokenHash: string, now: Date): Promise<boolean>;

  saveSession(session: Session): Promise<void>;
  findSession(id: string): Promise<Session | undefined>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsFor(accountId: string): Promise<void>;

  saveAgent(agent: AgentConfig): Promise<void>;
  listAgents(accountId: string): Promise<readonly AgentConfig[]>;
  findAgent(accountId: string, agentId: string): Promise<AgentConfig | undefined>;
  /**
   * Finds an agent by the consent session AgentPey minted for it.
   *
   * Scoped by account like every other read here: the return from signing
   * arrives as a request from a browser, and a browser is never trusted to
   * say whose agent it is talking about.
   */
  findAgentByConsentSession(accountId: string, consentSessionId: string): Promise<AgentConfig | undefined>;
}

export function newAccount(email: string, alias: string, now: Date = new Date()): Account {
  return {
    id: `rac_${ulid()}`,
    email: email.toLowerCase(),
    alias,
    externalRef: externalRefFor(),
    createdAt: now,
    lastSeenAt: now,
  };
}

export function newAgent(
  accountId: string,
  kind: AgentKind,
  label: string,
  permissions: AgentPermissions,
  now: Date = new Date(),
  comercio: string | null = null,
): AgentConfig {
  return {
    id: `rag_${ulid()}`,
    accountId,
    kind,
    label,
    permissions,
    tenantId: null,
    consentSessionId: null,
    mandateId: null,
    comercio,
    createdAt: now,
  };
}

/** For tests and a local run with no database. */
export function createMemoryStore(): RealOpsStore {
  const accounts = new Map<string, Account>();
  const byEmail = new Map<string, string>();
  const links = new Map<string, MagicLink>();
  const sessions = new Map<string, Session>();
  const agents = new Map<string, AgentConfig>();

  return {
    async findAccountByEmail(email) {
      const id = byEmail.get(email.toLowerCase());
      return id === undefined ? undefined : accounts.get(id);
    },
    async findAccount(id) {
      return accounts.get(id);
    },
    async createAccount(email, alias) {
      const account = newAccount(email, alias);
      accounts.set(account.id, account);
      byEmail.set(account.email!, account.id);
      return account;
    },
    async touchAccount(id, now) {
      const account = accounts.get(id);
      if (account !== undefined) accounts.set(id, { ...account, lastSeenAt: now });
    },
    async forgetAccount(id) {
      const account = accounts.get(id);
      if (account === undefined) return;
      if (account.email !== null) byEmail.delete(account.email);
      accounts.set(id, { ...account, email: null, alias: "cuenta borrada" });
    },
    async saveMagicLink(link) {
      links.set(link.tokenHash, link);
    },
    async findMagicLink(tokenHash) {
      return links.get(tokenHash);
    },
    async redeemMagicLink(tokenHash, now) {
      const link = links.get(tokenHash);
      if (link === undefined || link.usedAt !== null) return false;
      links.set(tokenHash, { ...link, usedAt: now });
      return true;
    },
    async saveSession(session) {
      sessions.set(session.id, session);
    },
    async findSession(id) {
      return sessions.get(id);
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async deleteSessionsFor(accountId) {
      for (const [id, session] of sessions) if (session.accountId === accountId) sessions.delete(id);
    },
    async saveAgent(agent) {
      agents.set(agent.id, agent);
    },
    async listAgents(accountId) {
      return [...agents.values()].filter((agent) => agent.accountId === accountId);
    },
    async findAgent(accountId, agentId) {
      const agent = agents.get(agentId);
      return agent?.accountId === accountId ? agent : undefined;
    },
    async findAgentByConsentSession(accountId, consentSessionId) {
      return [...agents.values()].find(
        (agent) => agent.accountId === accountId && agent.consentSessionId === consentSessionId,
      );
    },
  };
}

export function invalidInput(message: string, details: Record<string, unknown> = {}): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details });
}
