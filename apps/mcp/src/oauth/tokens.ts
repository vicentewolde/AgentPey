/**
 * Every value the authorization server hands out is a short JWT signed with
 * one server secret (HS256), so the server keeps no database (`R-7`): a
 * registered client, a pending authorization request, a code, an access
 * token and a refresh token. Each carries its own `typ`, checked on the way
 * back in, so one can never be presented as another.
 *
 * What does need memory is kept in memory, bounded: the id of a code, a
 * refresh token or a sign-in challenge once it is used, so it cannot be used
 * twice. A restart forgets those lists. A code lives one minute and a
 * challenge five; a refresh token lives a week, so a restart lets one already
 * used be used once more, until it expires (written in the README).
 */
import { AgentPassError } from "@agentpass/core";
import { SignJWT, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";

export const TOKEN_KINDS = ["client", "request", "challenge", "code", "access", "refresh"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const TOKEN_TTL_SECONDS: Readonly<Record<TokenKind, number | null>> = {
  /** A registered client does not expire: it is a description, not a grant. */
  client: null,
  request: 10 * 60,
  challenge: 5 * 60,
  code: 60,
  access: 60 * 60,
  /** A week, and each one redeems once: a leaked one is worth little and not for long. */
  refresh: 7 * 24 * 60 * 60,
};

export const MIN_SECRET_BYTES = 32;

export class TokenSigner {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = new TextEncoder().encode(secret);
    if (this.key.byteLength < MIN_SECRET_BYTES) {
      throw new AgentPassError("ConfigError", `MCP_OAUTH_SECRET must be at least ${MIN_SECRET_BYTES} bytes`, { details: { bytes: this.key.byteLength } });
    }
  }

  async sign(kind: TokenKind, claims: Record<string, unknown>, options: { subject?: string; audience?: string; jti?: string } = {}): Promise<string> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    let jwt = new SignJWT({ ...claims, kind }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(this.issuer).setIssuedAt(issuedAt);
    const ttl = TOKEN_TTL_SECONDS[kind];
    if (ttl !== null) jwt = jwt.setExpirationTime(issuedAt + ttl);
    if (options.subject !== undefined) jwt = jwt.setSubject(options.subject);
    if (options.audience !== undefined) jwt = jwt.setAudience(options.audience);
    if (options.jti !== undefined) jwt = jwt.setJti(options.jti);
    return jwt.sign(this.key);
  }

  /** The payload of a token of exactly this kind, issued here, unexpired; `null` otherwise. Never throws. */
  async verify(kind: TokenKind, token: string, options: { audience?: string } = {}): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: this.issuer,
        currentDate: this.now(),
        ...(options.audience === undefined ? {} : { audience: options.audience }),
      });
      return payload["kind"] === kind ? payload : null;
    } catch (error) {
      if (error instanceof joseErrors.JOSEError || error instanceof TypeError) return null;
      throw error;
    }
  }
}

/** Ids already used (codes, refresh tokens, challenges), until they would have expired anyway. */
export class RedeemedCodes {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly max = 10_000,
  ) {}

  /** `true` the first time `jti` is redeemed, `false` every time after. */
  redeem(jti: string, expiresAtSeconds: number): boolean {
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    for (const [id, until] of this.seen) if (until < nowSeconds) this.seen.delete(id);
    if (this.seen.has(jti)) return false;
    if (this.seen.size >= this.max) {
      // Full of unexpired codes means something is minting them in bulk: refuse rather than forget one.
      return false;
    }
    this.seen.set(jti, expiresAtSeconds);
    return true;
  }
}
