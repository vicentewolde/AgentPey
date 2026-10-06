/**
 * AgentPey's MCP server as its own OAuth 2.1 authorization server (`R-2`,
 * `R-7`): minimal, one person, no database.
 *
 * - Clients register by DCR (`POST /register`), and the client id is the
 *   registration itself, signed; or they present a Client ID Metadata
 *   Document (CIMD), fetched only from hosts this server already trusts to
 *   receive codes, and cached a few minutes. Either way a redirect URI must
 *   be one of the allowed ones: Claude's, ChatGPT's, or a loopback address
 *   for local clients, matched without its port (RFC 8252 §7.3; Claude Code
 *   uses a new port each session).
 * - `GET /authorize` shows a page where the person signs a message with their
 *   wallet (SEP-53). Only the configured wallet, the principal of the MCP's
 *   spending account, gets a code. The challenge to sign is itself a signed
 *   token, so asking for one costs the server no memory; it is spent only
 *   when a valid signature answers it.
 * - `POST /token` trades the code for an access token bound to this MCP
 *   resource (PKCE S256 required), and refreshes it. Each refresh token works
 *   once and is replaced in the same answer (OAuth 2.1 §4.3.1).
 * - `verifier` checks access tokens for the `/mcp` route: signature, kind,
 *   audience, expiry, and that the subject is still the allowed wallet.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { verifyStellarMessage } from "@agentpass/core";
import { WALLET_KIT_BUNDLE, WALLET_KIT_IMAGE_HOSTS, WALLET_KIT_PATH, walletKitIntegrity as walletKitIntegrityOf } from "@agentpey/wallet-kit";
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { StrKey } from "@stellar/stellar-sdk";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";

import { loginPage } from "./login-page.js";
import { RedeemedCodes, TokenSigner, TOKEN_TTL_SECONDS } from "./tokens.js";

export const MCP_SCOPE = "shop";

/** Where Claude and ChatGPT send people back after signing in (their docs, read 2026-10-03). */
export const DEFAULT_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect"] as const;

export interface OAuthServerOptions {
  /** This server's public origin, e.g. `https://mcp.agentpey.com`. The issuer. */
  readonly publicUrl: string;
  /** The protected resource, e.g. `https://mcp.agentpey.com/mcp`. Every access token's audience. */
  readonly resource: string;
  /** The only Stellar account that can sign in: the principal of the MCP's rail. */
  readonly allowedWallet: string;
  readonly secret: string;
  /** Exact redirect URIs a client may register, besides loopback ones. Defaults to Claude's and ChatGPT's. */
  readonly redirectUris?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** The wallet layer's integrity, `undefined` when it is not built. Defaults to the built bundle's (T143); tests set it. */
  readonly walletKitIntegrity?: () => string | undefined;
}

const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_CACHE_MS = 5 * 60_000;
const CIMD_CACHE_MAX = 50;

interface Client {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string().url()).min(1).max(5),
  client_name: z.string().trim().min(1).max(100).optional(),
});

const cimdSchema = z.looseObject({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(100).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
});

const authorizeQuerySchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(4000),
  redirect_uri: z.string().url(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(1000).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().url().optional(),
});

const requestClaimsSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  state: z.string().optional(),
  scope: z.string(),
});

const challengeClaimsSchema = z.object({ account: z.string(), request_hash: z.string(), client_name: z.string(), nonce: z.string(), expires: z.string(), exp: z.number() });
const codeClaimsSchema = z.object({ client_id: z.string(), redirect_uri: z.string(), code_challenge: z.string(), scope: z.string(), sub: z.string(), jti: z.string(), exp: z.number() });
const refreshClaimsSchema = z.object({ client_id: z.string(), scope: z.string(), sub: z.string(), jti: z.string(), exp: z.number() });
const accessClaimsSchema = z.object({ client_id: z.string(), scope: z.string(), sub: z.string(), exp: z.number() });

const challengeBodySchema = z.object({ request: z.string().min(1).max(8000), account: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value)) });
const approveBodySchema = challengeBodySchema.extend({ challenge: z.string().min(1).max(4000), signature: z.string().min(1).max(200) });
const denyBodySchema = z.object({ request: z.string().min(1).max(8000) });

const tokenBodySchema = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("authorization_code"), code: z.string().min(1).max(4000), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), redirect_uri: z.string(), client_id: z.string().min(1).max(4000), resource: z.string().optional() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string().min(1).max(4000), client_id: z.string().min(1).max(4000), resource: z.string().optional() }),
]);

export function isLoopback(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/**
 * Whether `actual` is the redirect URI a client `registered`: exactly, or, for
 * a loopback address, the same host and path on any port (RFC 8252 §7.3).
 * Claude Code registers `http://localhost/callback` and redirects to a new
 * port each session.
 */
export function redirectMatches(registered: string, actual: string): boolean {
  if (registered === actual) return true;
  if (!isLoopback(registered) || !isLoopback(actual)) return false;
  const a = new URL(registered);
  const b = new URL(actual);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");

/** What the wallet signs. Rebuilt on approval from the signed challenge, never taken from the page. */
function challengeMessage(host: string, claims: { account: string; client_name: string; nonce: string; expires: string }): string {
  return [
    `${host} asks you to sign in with your Stellar account:`,
    claims.account,
    "",
    `Allow ${claims.client_name} to search, quote and pay in AgentPey stores for you, from your spending account on Stellar testnet, within its limits.`,
    "Continue only if you started this connection yourself, from your own Claude or ChatGPT.",
    "",
    `Nonce: ${claims.nonce}`,
    `Expires: ${claims.expires}`,
  ].join("\n");
}

/** Reads at most `max` bytes of a response body; `null` when it is longer. */
async function readCapped(res: globalThis.Response, max: number): Promise<string | null> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function oauthFail(res: Response, status: number, error: string, description: string): void {
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

export interface OAuthServer {
  readonly router: Router;
  readonly verifier: OAuthTokenVerifier;
  readonly metadata: OAuthMetadata;
}

export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  const now = options.now ?? (() => new Date());
  const issuer = options.publicUrl.replace(/\/+$/, "");
  const signer = new TokenSigner(options.secret, issuer, now);
  const redeemedCodes = new RedeemedCodes(now);
  const redeemedRefresh = new RedeemedCodes(now);
  const answeredChallenges = new RedeemedCodes(now);
  const allowedRedirects = new Set(options.redirectUris ?? DEFAULT_REDIRECT_URIS);
  const cimdHosts = new Set([...allowedRedirects].map((uri) => new URL(uri).host));
  const cimdCache = new Map<string, { client: Client; at: number }>();
  const issuerHost = new URL(issuer).host;
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;

  const redirectAllowed = (uri: string) => allowedRedirects.has(uri) || isLoopback(uri);

  const metadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  } as OAuthMetadata;

  /** A client from its id: a signed registration, or a metadata document on a trusted host. `null` if neither. */
  async function resolveClient(clientId: string): Promise<Client | null> {
    if (URL.canParse(clientId) && clientId.startsWith("https://")) {
      const url = new URL(clientId);
      if (!cimdHosts.has(url.host)) return null;
      const cached = cimdCache.get(clientId);
      if (cached !== undefined && now().getTime() - cached.at < CIMD_CACHE_MS) return cached.client;
      try {
        const res = await fetchImpl(clientId, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(CIMD_TIMEOUT_MS) });
        if (!res.ok) return null;
        const text = await readCapped(res, CIMD_MAX_BYTES);
        if (text === null) return null;
        const doc = cimdSchema.safeParse(JSON.parse(text));
        if (!doc.success || doc.data.client_id !== clientId) return null;
        const client = { clientId, name: doc.data.client_name ?? url.host, redirectUris: doc.data.redirect_uris };
        if (cimdCache.size >= CIMD_CACHE_MAX) cimdCache.clear();
        cimdCache.set(clientId, { client, at: now().getTime() });
        return client;
      } catch {
        return null;
      }
    }
    const payload = await signer.verify("client", clientId);
    const registered = registrationSchema.safeParse(payload);
    if (!registered.success) return null;
    return { clientId, name: registered.data.client_name ?? "An MCP client", redirectUris: registered.data.redirect_uris };
  }

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const payload = await signer.verify("access", token, { audience: options.resource });
      const claims = accessClaimsSchema.safeParse(payload);
      if (!claims.success || claims.data.sub !== options.allowedWallet) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "the access token is invalid, expired, or not for this resource");
      }
      return { token, clientId: claims.data.client_id, scopes: claims.data.scope.split(" "), expiresAt: claims.data.exp, resource: new URL(options.resource) };
    },
  };

  const router = express.Router();
  const kitIntegrity = options.walletKitIntegrity ?? walletKitIntegrityOf;
  router.use(["/register", "/token", "/authorize/challenge", "/authorize/approve", "/authorize/deny"], express.json({ limit: "32kb" }), express.urlencoded({ extended: false, limit: "32kb" }));

  router.post("/register", async (req: Request, res: Response) => {
    const body = registrationSchema.safeParse(req.body);
    if (!body.success) return oauthFail(res, 400, "invalid_client_metadata", "redirect_uris is required");
    const refused = body.data.redirect_uris.filter((uri) => !redirectAllowed(uri));
    if (refused.length > 0) return oauthFail(res, 400, "invalid_redirect_uri", "this server only sends people back to Claude, ChatGPT or a loopback address");
    // A `jti` so two identical registrations still get two ids (RFC 7591).
    const clientId = await signer.sign("client", { redirect_uris: body.data.redirect_uris, ...(body.data.client_name === undefined ? {} : { client_name: body.data.client_name }) }, { jti: randomUUID() });
    log("oauth client registered", { clientName: body.data.client_name ?? null });
    res.status(201).set("Cache-Control", "no-store").json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now().getTime() / 1000),
      redirect_uris: body.data.redirect_uris,
      ...(body.data.client_name === undefined ? {} : { client_name: body.data.client_name }),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // The wallet layer the sign-in page loads (T143), from this origin.
  router.get(WALLET_KIT_PATH, (_req: Request, res: Response) => {
    if (kitIntegrity() === undefined) {
      res.status(503).type("text/plain").send("the wallet layer is not built");
      return;
    }
    res.set({ "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" }).type("text/javascript").sendFile(WALLET_KIT_BUNDLE);
  });

  router.get("/authorize", async (req: Request, res: Response) => {
    const query = authorizeQuerySchema.safeParse(req.query);
    // Before the client is known, nothing is redirected: an error goes on the page, never to an unchecked URI.
    if (!query.success) return void res.status(400).type("text/plain").send("invalid authorization request: response_type=code, client_id, redirect_uri, code_challenge and code_challenge_method=S256 are required");
    const client = await resolveClient(query.data.client_id);
    if (client === null || !client.redirectUris.some((registered) => redirectMatches(registered, query.data.redirect_uri)) || !redirectAllowed(query.data.redirect_uri)) {
      return void res.status(400).type("text/plain").send("unknown client, or a redirect_uri it did not register");
    }
    if (query.data.resource !== undefined && query.data.resource !== options.resource) {
      return void res.redirect(errorRedirect(query.data.redirect_uri, "invalid_target", "this server only issues tokens for its own MCP resource", query.data.state, issuer));
    }
    const scope = query.data.scope ?? MCP_SCOPE;
    if (scope.split(" ").some((one) => one !== MCP_SCOPE)) {
      return void res.redirect(errorRedirect(query.data.redirect_uri, "invalid_scope", `the only scope is ${MCP_SCOPE}`, query.data.state, issuer));
    }
    const request = await signer.sign("request", {
      client_id: client.clientId,
      client_name: client.name,
      redirect_uri: query.data.redirect_uri,
      code_challenge: query.data.code_challenge,
      scope,
      ...(query.data.state === undefined ? {} : { state: query.data.state }),
    });
    // No sign-in page without the pinned wallet layer: a page that loaded an unpinned script would be worse.
    const walletKitIntegrity = kitIntegrity();
    if (walletKitIntegrity === undefined) {
      res.status(503).type("text/plain").send("The sign-in page is not available: the wallet layer is not built.");
      return;
    }
    const nonce = randomBytes(16).toString("base64");
    res
      .status(200)
      .set({
        "Cache-Control": "no-store",
        // The wallet layer is this origin's /wallet-kit.js, pinned by integrity in the page; its picker shows the
        // wallets' icons from their CDN (T143).
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline'; img-src ${WALLET_KIT_IMAGE_HOSTS.join(" ")} data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
      })
      .type("html")
      .send(
        loginPage(
          {
            request,
            clientName: client.name,
            redirectHost: new URL(query.data.redirect_uri).host,
            loopback: isLoopback(query.data.redirect_uri),
            walletHint: `${options.allowedWallet.slice(0, 6)}…${options.allowedWallet.slice(-6)}`,
            walletKitIntegrity,
          },
          nonce,
        ),
      );
  });

  async function readRequest(token: string): Promise<z.infer<typeof requestClaimsSchema> | null> {
    const claims = requestClaimsSchema.safeParse(await signer.verify("request", token));
    return claims.success ? claims.data : null;
  }

  router.post("/authorize/challenge", async (req: Request, res: Response) => {
    const body = challengeBodySchema.safeParse(req.body);
    if (!body.success) return oauthFail(res, 400, "invalid_request", "request and a Stellar account are required");
    const request = await readRequest(body.data.request);
    if (request === null) return oauthFail(res, 400, "invalid_request", "the authorization request expired; start again from the app");
    if (body.data.account !== options.allowedWallet) return oauthFail(res, 403, "access_denied", "this wallet cannot sign in here");
    // Nothing is stored: the challenge is a signed token, so asking for many costs the server nothing.
    const claims = {
      account: body.data.account,
      request_hash: sha256(body.data.request),
      client_name: request.client_name,
      nonce: randomBytes(16).toString("hex"),
      expires: new Date(now().getTime() + (TOKEN_TTL_SECONDS.challenge ?? 0) * 1000).toISOString(),
    };
    const challenge = await signer.sign("challenge", claims);
    res.set("Cache-Control", "no-store").json({ message: challengeMessage(issuerHost, claims), challenge });
  });

  router.post("/authorize/approve", async (req: Request, res: Response) => {
    const body = approveBodySchema.safeParse(req.body);
    if (!body.success) return oauthFail(res, 400, "invalid_request", "request, account, challenge and signature are required");
    const request = await readRequest(body.data.request);
    const challenge = challengeClaimsSchema.safeParse(await signer.verify("challenge", body.data.challenge));
    if (request === null || !challenge.success || challenge.data.request_hash !== sha256(body.data.request) || challenge.data.account !== body.data.account) {
      return oauthFail(res, 400, "invalid_request", "the sign-in expired; start again");
    }
    if (body.data.account !== options.allowedWallet || !verifyStellarMessage(body.data.account, challengeMessage(issuerHost, challenge.data), body.data.signature)) {
      log("oauth sign-in refused", { account: body.data.account });
      return oauthFail(res, 403, "access_denied", "the signature does not prove control of the allowed wallet");
    }
    // Spent only once the signature is valid: a stranger cannot use up the owner's challenge.
    if (!answeredChallenges.redeem(challenge.data.nonce, challenge.data.exp)) return oauthFail(res, 400, "invalid_request", "this sign-in was already used; start again");
    const code = await signer.sign(
      "code",
      { client_id: request.client_id, redirect_uri: request.redirect_uri, code_challenge: request.code_challenge, scope: request.scope },
      { subject: body.data.account, jti: randomUUID() },
    );
    log("oauth sign-in approved", { client: request.client_name });
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("code", code);
    if (request.state !== undefined) redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", issuer);
    res.set("Cache-Control", "no-store").json({ redirect: redirect.toString() });
  });

  router.post("/authorize/deny", async (req: Request, res: Response) => {
    const body = denyBodySchema.safeParse(req.body);
    const request = body.success ? await readRequest(body.data.request) : null;
    if (request === null) return oauthFail(res, 400, "invalid_request", "the authorization request expired");
    res.set("Cache-Control", "no-store").json({ redirect: errorRedirect(request.redirect_uri, "access_denied", "the person cancelled", request.state, issuer) });
  });

  router.post("/token", async (req: Request, res: Response) => {
    const body = tokenBodySchema.safeParse(req.body);
    if (!body.success) return oauthFail(res, 400, "invalid_request", "grant_type, and the code or refresh token with its fields, are required");
    if (body.data.resource !== undefined && body.data.resource !== options.resource) return oauthFail(res, 400, "invalid_target", "this server only issues tokens for its own MCP resource");
    const client = await resolveClient(body.data.client_id);
    if (client === null) return oauthFail(res, 401, "invalid_client", "unknown client");

    let subject: string;
    let scope: string;
    if (body.data.grant_type === "authorization_code") {
      const claims = codeClaimsSchema.safeParse(await signer.verify("code", body.data.code));
      if (!claims.success) return oauthFail(res, 400, "invalid_grant", "the code is invalid or expired");
      const code = claims.data;
      if (code.client_id !== body.data.client_id || code.redirect_uri !== body.data.redirect_uri) return oauthFail(res, 400, "invalid_grant", "the code was issued to another client or redirect_uri");
      if ((await s256(body.data.code_verifier)) !== code.code_challenge) return oauthFail(res, 400, "invalid_grant", "code_verifier does not match the code_challenge");
      if (!redeemedCodes.redeem(code.jti, code.exp)) return oauthFail(res, 400, "invalid_grant", "the code was already used");
      subject = code.sub;
      scope = code.scope;
    } else {
      const claims = refreshClaimsSchema.safeParse(await signer.verify("refresh", body.data.refresh_token, { audience: options.resource }));
      if (!claims.success || claims.data.client_id !== body.data.client_id) return oauthFail(res, 400, "invalid_grant", "the refresh token is invalid or expired");
      // One use each: the answer below carries its replacement (OAuth 2.1 §4.3.1).
      if (!redeemedRefresh.redeem(claims.data.jti, claims.data.exp)) return oauthFail(res, 400, "invalid_grant", "the refresh token was already used");
      subject = claims.data.sub;
      scope = claims.data.scope;
    }
    if (subject !== options.allowedWallet) return oauthFail(res, 400, "invalid_grant", "this wallet can no longer sign in here");

    const accessToken = await signer.sign("access", { client_id: client.clientId, scope }, { subject, audience: options.resource });
    const refreshToken = await signer.sign("refresh", { client_id: client.clientId, scope }, { subject, audience: options.resource, jti: randomUUID() });
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS.access,
      refresh_token: refreshToken,
      scope,
    });
  });

  return { router, verifier, metadata };
}

function errorRedirect(redirectUri: string, error: string, description: string, state: string | undefined, issuer: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}
