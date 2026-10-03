/**
 * AgentPey's MCP server as its own OAuth 2.1 authorization server (`R-2`,
 * `R-7`): minimal, one person, no database.
 *
 * - Clients register by DCR (`POST /register`), and the client id is the
 *   registration itself, signed; or they present a Client ID Metadata
 *   Document (CIMD), fetched only from hosts this server already trusts to
 *   receive codes. Either way a redirect URI must be one of the allowed ones:
 *   Claude's, ChatGPT's, or a loopback address for local clients.
 * - `GET /authorize` shows a page where the person signs a message with their
 *   wallet (SEP-53). Only the configured wallet, the principal of the MCP's
 *   spending account, gets a code.
 * - `POST /token` trades the code for an access token bound to this MCP
 *   resource (PKCE S256 required), and refreshes it.
 * - `verifier` checks access tokens for the `/mcp` route: signature, kind,
 *   audience, expiry, and that the subject is still the allowed wallet.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { verifyStellarMessage } from "@agentpass/core";
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
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PENDING_CHALLENGES = 500;
const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;

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

const codeClaimsSchema = z.object({ client_id: z.string(), redirect_uri: z.string(), code_challenge: z.string(), scope: z.string(), sub: z.string(), jti: z.string(), exp: z.number() });
const refreshClaimsSchema = z.object({ client_id: z.string(), scope: z.string(), sub: z.string() });
const accessClaimsSchema = z.object({ client_id: z.string(), scope: z.string(), sub: z.string(), exp: z.number() });

const challengeBodySchema = z.object({ request: z.string().min(1).max(8000), account: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value)) });
const approveBodySchema = challengeBodySchema.extend({ nonce: z.string().regex(/^[0-9a-f]{32}$/), signature: z.string().min(1).max(200) });

const tokenBodySchema = z.discriminatedUnion("grant_type", [
  z.object({ grant_type: z.literal("authorization_code"), code: z.string().min(1).max(4000), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), redirect_uri: z.string(), client_id: z.string().min(1).max(4000), resource: z.string().optional() }),
  z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string().min(1).max(4000), client_id: z.string().min(1).max(4000), resource: z.string().optional() }),
]);

function isLoopback(uri: string): boolean {
  if (!URL.canParse(uri)) return false;
  const url = new URL(uri);
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
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
  const redeemed = new RedeemedCodes(now);
  const allowedRedirects = new Set(options.redirectUris ?? DEFAULT_REDIRECT_URIS);
  const cimdHosts = new Set([...allowedRedirects].map((uri) => new URL(uri).host));
  const challenges = new Map<string, { account: string; requestHash: string; message: string; expires: number }>();
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
  } as OAuthMetadata;

  /** A client from its id: a signed registration, or a metadata document on a trusted host. `null` if neither. */
  async function resolveClient(clientId: string): Promise<Client | null> {
    if (URL.canParse(clientId) && clientId.startsWith("https://")) {
      const url = new URL(clientId);
      if (!cimdHosts.has(url.host)) return null;
      try {
        const res = await fetchImpl(clientId, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(CIMD_TIMEOUT_MS) });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.length > CIMD_MAX_BYTES) return null;
        const doc = cimdSchema.safeParse(JSON.parse(text));
        if (!doc.success || doc.data.client_id !== clientId) return null;
        return { clientId, name: doc.data.client_name ?? url.host, redirectUris: doc.data.redirect_uris };
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
  router.use(["/register", "/token", "/authorize/challenge", "/authorize/approve", "/authorize/deny"], express.json({ limit: "32kb" }), express.urlencoded({ extended: false, limit: "32kb" }));

  router.post("/register", async (req: Request, res: Response) => {
    const body = registrationSchema.safeParse(req.body);
    if (!body.success) return oauthFail(res, 400, "invalid_client_metadata", "redirect_uris is required");
    const refused = body.data.redirect_uris.filter((uri) => !redirectAllowed(uri));
    if (refused.length > 0) return oauthFail(res, 400, "invalid_redirect_uri", "this server only sends people back to Claude, ChatGPT or a loopback address");
    const clientId = await signer.sign("client", { redirect_uris: body.data.redirect_uris, ...(body.data.client_name === undefined ? {} : { client_name: body.data.client_name }) });
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

  router.get("/authorize", async (req: Request, res: Response) => {
    const query = authorizeQuerySchema.safeParse(req.query);
    // Before the client is known, nothing is redirected: an error goes on the page, never to an unchecked URI.
    if (!query.success) return void res.status(400).type("text/plain").send("invalid authorization request: response_type=code, client_id, redirect_uri, code_challenge and code_challenge_method=S256 are required");
    const client = await resolveClient(query.data.client_id);
    if (client === null || !client.redirectUris.includes(query.data.redirect_uri) || !redirectAllowed(query.data.redirect_uri)) {
      return void res.status(400).type("text/plain").send("unknown client, or a redirect_uri it did not register");
    }
    if (query.data.resource !== undefined && query.data.resource !== options.resource) {
      return void res.redirect(errorRedirect(query.data.redirect_uri, "invalid_target", "this server only issues tokens for its own MCP resource", query.data.state));
    }
    const scope = query.data.scope ?? MCP_SCOPE;
    if (scope.split(" ").some((one) => one !== MCP_SCOPE)) {
      return void res.redirect(errorRedirect(query.data.redirect_uri, "invalid_scope", `the only scope is ${MCP_SCOPE}`, query.data.state));
    }
    const request = await signer.sign("request", {
      client_id: client.clientId,
      client_name: client.name,
      redirect_uri: query.data.redirect_uri,
      code_challenge: query.data.code_challenge,
      scope,
      ...(query.data.state === undefined ? {} : { state: query.data.state }),
    });
    const nonce = randomBytes(16).toString("base64");
    res
      .status(200)
      .set({
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://unpkg.com; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
      })
      .type("html")
      .send(loginPage({ request, clientName: client.name, redirectHost: new URL(query.data.redirect_uri).host, walletHint: `${options.allowedWallet.slice(0, 6)}…${options.allowedWallet.slice(-6)}` }, nonce));
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
    for (const [id, pending] of challenges) if (pending.expires < now().getTime()) challenges.delete(id);
    if (challenges.size >= MAX_PENDING_CHALLENGES) return oauthFail(res, 503, "temporarily_unavailable", "too many sign-ins in progress");
    const nonce = randomBytes(16).toString("hex");
    const expires = now().getTime() + CHALLENGE_TTL_MS;
    const message = [
      `${new URL(issuer).host} asks you to sign in with your Stellar account:`,
      body.data.account,
      "",
      `Allow ${request.client_name} to search, quote and pay in AgentPey stores for you, from your spending account on Stellar testnet, within its limits.`,
      "",
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expires).toISOString()}`,
    ].join("\n");
    challenges.set(nonce, { account: body.data.account, requestHash: body.data.request, message, expires });
    res.set("Cache-Control", "no-store").json({ message, nonce });
  });

  router.post("/authorize/approve", async (req: Request, res: Response) => {
    const body = approveBodySchema.safeParse(req.body);
    if (!body.success) return oauthFail(res, 400, "invalid_request", "request, account, nonce and signature are required");
    // Consumed before anything else is looked at: a challenge answers once, right or wrong.
    const pending = challenges.get(body.data.nonce);
    challenges.delete(body.data.nonce);
    const request = await readRequest(body.data.request);
    if (request === null || pending === undefined || pending.expires < now().getTime() || pending.requestHash !== body.data.request || pending.account !== body.data.account) {
      return oauthFail(res, 400, "invalid_request", "the sign-in expired; start again");
    }
    if (body.data.account !== options.allowedWallet || !verifyStellarMessage(body.data.account, pending.message, body.data.signature)) {
      log("oauth sign-in refused", { account: body.data.account });
      return oauthFail(res, 403, "access_denied", "the signature does not prove control of the allowed wallet");
    }
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
    const request = await readRequest(String((req.body as { request?: unknown } | undefined)?.request ?? ""));
    if (request === null) return oauthFail(res, 400, "invalid_request", "the authorization request expired");
    res.set("Cache-Control", "no-store").json({ redirect: errorRedirect(request.redirect_uri, "access_denied", "the person cancelled", request.state) });
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
      if (!redeemed.redeem(code.jti, code.exp)) return oauthFail(res, 400, "invalid_grant", "the code was already used");
      subject = code.sub;
      scope = code.scope;
    } else {
      const claims = refreshClaimsSchema.safeParse(await signer.verify("refresh", body.data.refresh_token, { audience: options.resource }));
      if (!claims.success || claims.data.client_id !== body.data.client_id) return oauthFail(res, 400, "invalid_grant", "the refresh token is invalid or expired");
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

function errorRedirect(redirectUri: string, error: string, description: string, state: string | undefined): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
}
