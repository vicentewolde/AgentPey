/**
 * How a merchant's owner signs in to the portal (T105, VT-29): with the wallet
 * of their payout account, never a password or an email.
 *
 * 1. The portal hands out a one-time challenge, bound to the account that asked
 *    for it and to the portal's host, valid for a few minutes.
 * 2. The wallet signs it (SEP-0053) and the portal checks the signature with
 *    `verifyStellarMessage` from `@agentpass/core`, the neutral piece C-88
 *    allows Vitrinee to import. The challenge is consumed before the signature
 *    is looked at, so it can never be replayed, valid or not.
 * 3. A valid proof becomes a session cookie: an HMAC over the account and an
 *    expiry, under a key derived from the master key. It carries no `Domain`
 *    attribute, so the browser sends it back to the portal host only and never
 *    to a store's subdomain, which is public to agents (C-142).
 *
 * Challenges live in memory: one process serves the portal, and a restart
 * only costs an owner a second click.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { verifyStellarMessage } from "@agentpass/core";
import { VitrineeError, isStellarAccount } from "@vitrinee/core";

export const SESSION_COOKIE = "vitrinee_portal";
const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
/** A ceiling on pending challenges, so unauthenticated calls cannot grow memory without bound. */
const MAX_PENDING = 2_000;

export interface Challenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface WalletSessionOptions {
  /** 32 bytes, derived from the master key; never the master key itself. */
  sessionKey: Buffer;
  now?: () => number;
}

interface Pending {
  account: string;
  message: string;
  expiresAt: number;
}

export class WalletSessions {
  private readonly pending = new Map<string, Pending>();
  private readonly key: Buffer;
  private readonly clock: () => number;

  constructor(options: WalletSessionOptions) {
    if (options.sessionKey.length < 32) throw new VitrineeError("ConfigError", "the portal session key must be at least 32 bytes");
    this.key = options.sessionKey;
    this.clock = options.now ?? Date.now;
  }

  /** @throws VitrineeError `ValidationError` for something that is not a Stellar account. */
  issueChallenge(account: string, host: string): Challenge {
    if (!isStellarAccount(account)) throw new VitrineeError("ValidationError", "not a Stellar account public key (G...)");
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      throw new VitrineeError("NetworkError", "too many sign-ins in progress; try again in a minute");
    }
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = this.clock() + CHALLENGE_TTL_MS;
    const message = [
      "Sign in to Vitrinee",
      `Host: ${host}`,
      `Account: ${account}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    this.pending.set(nonce, { account, message, expiresAt });
    return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Consumes the challenge, then checks the wallet's signature over it.
   * @returns the account the session is for.
   * @throws VitrineeError `WalletProofInvalid` for an unknown, expired or used
   * challenge, another account, or a signature that does not verify.
   */
  verifyProof(account: string, nonce: string, signature: string): string {
    const found = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (found === undefined || found.expiresAt <= this.clock()) {
      throw new VitrineeError("WalletProofInvalid", "the sign-in challenge is unknown, expired or already used; start again");
    }
    if (found.account !== account) {
      throw new VitrineeError("WalletProofInvalid", "the challenge was issued to another account");
    }
    if (!verifyStellarMessage(account, found.message, signature)) {
      throw new VitrineeError("WalletProofInvalid", "the wallet signature does not verify for this account");
    }
    return account;
  }

  /** The `Set-Cookie` value that opens a session for `account`. */
  sessionCookie(account: string, secure: boolean): string {
    const expiresAt = this.clock() + SESSION_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ v: 1, sub: account, exp: expiresAt }), "utf8").toString("base64url");
    const value = `${payload}.${this.mac(payload)}`;
    // No `Domain`: host-only, so it never reaches `<slug>.vitrinee.agentpey.com`.
    return [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_TTL_MS / 1000}`, ...(secure ? ["Secure"] : [])].join("; ");
  }

  clearCookie(secure: boolean): string {
    return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
  }

  /** The account of a valid, unexpired session in `cookieHeader`, or `undefined`. Never throws. */
  readSession(cookieHeader: string | undefined): string | undefined {
    const raw = readCookie(cookieHeader, SESSION_COOKIE);
    if (raw === undefined) return undefined;
    const [payload, mac, ...rest] = raw.split(".");
    if (payload === undefined || mac === undefined || rest.length > 0) return undefined;
    const expected = Buffer.from(this.mac(payload), "utf8");
    const given = Buffer.from(mac, "utf8");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: unknown; sub?: unknown; exp?: unknown };
      if (claims.v !== 1 || typeof claims.sub !== "string" || typeof claims.exp !== "number") return undefined;
      if (claims.exp <= this.clock() || !isStellarAccount(claims.sub)) return undefined;
      return claims.sub;
    } catch {
      return undefined;
    }
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(`vitrinee-portal-session:${payload}`).digest("base64url");
  }

  private prune(): void {
    const now = this.clock();
    for (const [nonce, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(nonce);
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
