import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { signStellarMessage } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpApp } from "../http.js";
import type { Shopper } from "../shopper.js";
import { createOAuthServer } from "./server.js";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const SECRET = "test-secret-that-is-at-least-32-bytes-long!!";

interface Started {
  url: string;
  resource: string;
  wallet: Keypair;
  logs: string[];
  clock: { now: Date };
  close(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function start(options: { fetchImpl?: typeof fetch; resourcePath?: string; issuer?: string; wallet?: Keypair; walletKitIntegrity?: () => string | undefined } = {}): Promise<Started> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // `issuer` lets a second server share the first one's issuer, to test what only the resource or the wallet changes.
  const issuer = options.issuer ?? url;
  const resource = `${issuer}${options.resourcePath ?? "/mcp"}`;
  const wallet = options.wallet ?? Keypair.random();
  const logs: string[] = [];
  const clock = { now: new Date() };
  const log = (message: string, fields?: Record<string, unknown>) => logs.push(JSON.stringify({ message, ...fields }));
  // The wallet layer's integrity is fixed here: tests do not depend on the bundle being built (T143).
  const oauth = createOAuthServer({
    publicUrl: issuer,
    resource,
    allowedWallet: wallet.publicKey(),
    secret: SECRET,
    now: () => clock.now,
    log,
    walletKitIntegrity: options.walletKitIntegrity ?? (() => "sha384-TESTKIT"),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  // Tools are never called here: only `tools/list`, which does not touch the shopper.
  const app = createMcpApp({ shopper: {} as unknown as Shopper, log, auth: { oauth, resource, allowInsecureIssuer: true } });
  server.on("request", app);
  return { url, resource, wallet, logs, clock, close: () => new Promise((done) => server.close(() => done())) };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function post(url: string, body: unknown, form = false): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function register(s: Started, redirect = CLAUDE): Promise<string> {
  const { status, json } = await post(`${s.url}/register`, { redirect_uris: [redirect], client_name: "Claude" });
  expect(status).toBe(201);
  return json["client_id"] as string;
}

async function authorizePage(s: Started, clientId: string, challenge: string, extra: Record<string, string> = {}): Promise<Response> {
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", scope: "shop", resource: s.resource, ...extra });
  return fetch(`${s.url}/authorize?${query.toString()}`, { redirect: "manual" });
}

const requestOf = (html: string): string => {
  const match = /const DATA = (\{.*?\});/s.exec(html);
  if (match === null) throw new TypeError("no request in the page");
  return (JSON.parse(match[1]!) as { request: string }).request;
};

/** The whole sign-in, as the page and the app do it: a code for this wallet. */
async function signIn(s: Started, signer: Keypair = s.wallet) {
  const clientId = await register(s);
  const { verifier, challenge } = pkce();
  const page = await authorizePage(s, clientId, challenge);
  const request = requestOf(await page.text());
  const asked = await post(`${s.url}/authorize/challenge`, { request, account: s.wallet.publicKey() });
  const approved = await post(`${s.url}/authorize/approve`, { request, account: s.wallet.publicKey(), challenge: asked.json["challenge"], signature: signStellarMessage(signer, asked.json["message"] as string) });
  return { clientId, verifier, approved };
}

async function tokens(s: Started) {
  const { clientId, verifier, approved } = await signIn(s);
  const redirect = new URL(approved.json["redirect"] as string);
  const exchange = await post(`${s.url}/token`, { grant_type: "authorization_code", code: redirect.searchParams.get("code")!, code_verifier: verifier, redirect_uri: CLAUDE, client_id: clientId, resource: s.resource }, true);
  return { clientId, redirect, exchange, code: redirect.searchParams.get("code")!, verifier };
}

const listTools = (s: Started, token?: string) =>
  fetch(`${s.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("the MCP server's own OAuth (T128, R-7)", () => {
  it("answers /mcp without a token with 401 and where to find its metadata", async () => {
    const s = await start();
    const res = await listTools(s);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${s.url}/.well-known/oauth-protected-resource/mcp"`);
    const prm = (await (await fetch(`${s.url}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: s.resource, authorization_servers: [`${s.url}/`].map((u) => expect.stringMatching(new RegExp(`^${u.replace(/\/$/, "")}/?$`))) });
    const as = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: s.url, code_challenge_methods_supported: ["S256"], registration_endpoint: `${s.url}/register`, client_id_metadata_document_supported: true });
  });

  it("signs in the allowed wallet and lets its token list the tools", async () => {
    const s = await start();
    const { redirect, exchange } = await tokens(s);
    expect(redirect.origin + redirect.pathname).toBe(CLAUDE);
    expect(redirect.searchParams.get("state")).toBe("st-1");
    expect(redirect.searchParams.get("iss")).toBe(s.url);
    expect(exchange.status).toBe(200);
    expect(exchange.json).toMatchObject({ token_type: "Bearer", scope: "shop", expires_in: 3600 });
    const res = await listTools(s, exchange.json["access_token"] as string);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("search_products");
  });

  it("refreshes once per refresh token, and the new token works", async () => {
    const s = await start();
    const { clientId, exchange } = await tokens(s);
    const refresh = (token: string) => post(`${s.url}/token`, { grant_type: "refresh_token", refresh_token: token, client_id: clientId }, true);
    const refreshed = await refresh(exchange.json["refresh_token"] as string);
    expect(refreshed.status).toBe(200);
    expect((await listTools(s, refreshed.json["access_token"] as string)).status).toBe(200);
    // The old one is spent; its replacement works, once.
    expect((await refresh(exchange.json["refresh_token"] as string)).json).toMatchObject({ error: "invalid_grant" });
    expect((await refresh(refreshed.json["refresh_token"] as string)).status).toBe(200);
  });

  it("refuses a refresh, and the access token, once the allowed wallet changed", async () => {
    const s = await start();
    const { clientId, exchange } = await tokens(s);
    const other = await start({ issuer: s.url, wallet: Keypair.random() });
    const refused = await post(`${other.url}/token`, { grant_type: "refresh_token", refresh_token: exchange.json["refresh_token"] as string, client_id: clientId }, true);
    expect(refused.json).toMatchObject({ error: "invalid_grant" });
    expect((await listTools(other, exchange.json["access_token"] as string)).status).toBe(401);
  });

  it("never takes one kind of token for another", async () => {
    const s = await start();
    const { clientId, exchange, code } = await tokens(s);
    const request = requestOf(await (await authorizePage(s, clientId, pkce().challenge)).text());
    const challenge = (await post(`${s.url}/authorize/challenge`, { request, account: s.wallet.publicKey() })).json["challenge"] as string;
    for (const notAccess of [exchange.json["refresh_token"] as string, code, clientId, request, challenge]) expect((await listTools(s, notAccess)).status).toBe(401);
    for (const notRefresh of [exchange.json["access_token"] as string, code, clientId, challenge]) {
      expect((await post(`${s.url}/token`, { grant_type: "refresh_token", refresh_token: notRefresh, client_id: clientId }, true)).json).toMatchObject({ error: "invalid_grant" });
    }
  });

  it("lets anyone ask for challenges without locking the owner out", async () => {
    const s = await start();
    const clientId = await register(s);
    const request = requestOf(await (await authorizePage(s, clientId, pkce().challenge)).text());
    const asks = await Promise.all(Array.from({ length: 600 }, () => post(`${s.url}/authorize/challenge`, { request, account: s.wallet.publicKey() })));
    expect(asks.every((ask) => ask.status === 200)).toBe(true);
    expect((await signIn(s)).approved.status).toBe(200);
  });

  it("refuses another wallet, and a signature by another key for the allowed one", async () => {
    const s = await start();
    const clientId = await register(s);
    const request = requestOf(await (await authorizePage(s, clientId, pkce().challenge)).text());
    const other = await post(`${s.url}/authorize/challenge`, { request, account: Keypair.random().publicKey() });
    expect(other).toMatchObject({ status: 403, json: { error: "access_denied" } });
    const { approved } = await signIn(s, Keypair.random());
    expect(approved).toMatchObject({ status: 403, json: { error: "access_denied" } });
  });

  it("answers a challenge once", async () => {
    const s = await start();
    const clientId = await register(s);
    const request = requestOf(await (await authorizePage(s, clientId, pkce().challenge)).text());
    const asked = await post(`${s.url}/authorize/challenge`, { request, account: s.wallet.publicKey() });
    const body = { request, account: s.wallet.publicKey(), challenge: asked.json["challenge"], signature: signStellarMessage(s.wallet, asked.json["message"] as string) };
    // A wrong signature does not use the challenge up: a stranger cannot spend the owner's sign-in.
    expect((await post(`${s.url}/authorize/approve`, { ...body, signature: signStellarMessage(Keypair.random(), asked.json["message"] as string) })).status).toBe(403);
    expect((await post(`${s.url}/authorize/approve`, body)).status).toBe(200);
    expect((await post(`${s.url}/authorize/approve`, body)).json).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a wrong PKCE verifier, and a code used twice", async () => {
    const s = await start();
    const { clientId, code, verifier } = await tokens(s);
    const again = await post(`${s.url}/token`, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, client_id: clientId }, true);
    expect(again.json).toMatchObject({ error: "invalid_grant" });
    const fresh = await signIn(s);
    const freshCode = new URL(fresh.approved.json["redirect"] as string).searchParams.get("code")!;
    const wrong = await post(`${s.url}/token`, { grant_type: "authorization_code", code: freshCode, code_verifier: pkce().verifier, redirect_uri: CLAUDE, client_id: fresh.clientId }, true);
    expect(wrong.json).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses, over HTTP, a token issued for another resource, an expired one and an altered one", async () => {
    const s = await start();
    const { exchange } = await tokens(s);
    const token = exchange.json["access_token"] as string;
    // Same secret, same issuer, same wallet, another resource: its /mcp must not open with this token.
    const elsewhere = await start({ issuer: s.url, wallet: s.wallet, resourcePath: "/other" });
    const res = await listTools(elsewhere, token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    s.clock.now = new Date(s.clock.now.getTime() + 2 * 60 * 60_000);
    expect((await listTools(s, token)).status).toBe(401);
    expect((await listTools(s, `${token}x`)).status).toBe(401);
  });

  it("registers only redirect URIs it trusts, and never redirects to one it does not know", async () => {
    const s = await start();
    expect((await post(`${s.url}/register`, { redirect_uris: ["https://attacker.example/callback"] })).json).toMatchObject({ error: "invalid_redirect_uri" });
    expect((await post(`${s.url}/register`, { redirect_uris: ["http://127.0.0.1:33418/callback"] })).status).toBe(201);
    const clientId = await register(s);
    const res = await authorizePage(s, clientId, pkce().challenge, { redirect_uri: "https://attacker.example/callback" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const forged = await authorizePage(s, `${clientId}x`, pkce().challenge);
    expect(forged.status).toBe(400);
  });

  it("refuses a token request for another resource, and an authorization for another resource", async () => {
    const s = await start();
    const clientId = await register(s);
    const res = await authorizePage(s, clientId, pkce().challenge, { resource: "https://elsewhere.example/mcp" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("iss")).toBe(s.url);
    const { clientId: client, verifier, approved } = await signIn(s);
    const code = new URL(approved.json["redirect"] as string).searchParams.get("code")!;
    const token = await post(`${s.url}/token`, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, client_id: client, resource: "https://elsewhere.example/mcp" }, true);
    expect(token.json).toMatchObject({ error: "invalid_target" });
  });

  it("sends the person back with access_denied when they cancel", async () => {
    const s = await start();
    const request = requestOf(await (await authorizePage(s, await register(s), pkce().challenge)).text());
    const denied = await post(`${s.url}/authorize/deny`, { request });
    const back = new URL(denied.json["redirect"] as string);
    expect(back.origin + back.pathname).toBe(CLAUDE);
    expect(Object.fromEntries(back.searchParams)).toMatchObject({ error: "access_denied", state: "st-1", iss: s.url });
    expect((await post(`${s.url}/authorize/deny`, { request: "nope" })).status).toBe(400);
  });

  it("answers a malformed body with a JSON error, never a page with a stack", async () => {
    const s = await start();
    for (const path of ["/token", "/register", "/authorize/challenge"]) {
      const res = await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toMatch(/<pre>|SyntaxError|at JSON\.parse/);
      expect(JSON.parse(text)).toMatchObject({ error: "invalid_request" });
    }
  });

  it("gives two identical registrations two client ids, and advertises iss in its metadata", async () => {
    const s = await start();
    const [a, b] = await Promise.all([register(s), register(s)]);
    expect(a).not.toBe(b);
    const as = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as["authorization_response_iss_parameter_supported"]).toBe(true);
  });

  it("reads a client metadata document only from a host it already trusts, once, and not when it is huge", async () => {
    const fetched: string[] = [];
    const docs: typeof fetch = async (input) => {
      fetched.push(String(input));
      if (String(input).endsWith("huge.json")) return new Response(JSON.stringify({ client_id: String(input), redirect_uris: [CLAUDE], pad: "x".repeat(100_000) }));
      return Response.json({ client_id: String(input), client_name: "Claude", redirect_uris: [CLAUDE] });
    };
    const s = await start({ fetchImpl: docs });
    expect((await authorizePage(s, "https://claude.ai/oauth/mcp-client.json", pkce().challenge)).status).toBe(200);
    expect((await authorizePage(s, "https://claude.ai/oauth/mcp-client.json", pkce().challenge)).status).toBe(200);
    expect((await authorizePage(s, "https://attacker.example/client.json", pkce().challenge)).status).toBe(400);
    expect((await authorizePage(s, "https://claude.ai/oauth/huge.json", pkce().challenge)).status).toBe(400);
    expect(fetched).toEqual(["https://claude.ai/oauth/mcp-client.json", "https://claude.ai/oauth/huge.json"]);
  });

  it("matches Claude Code's loopback redirect on any port, and warns that a local app is asking", async () => {
    const cimd = "https://claude.ai/oauth/claude-code-client-metadata";
    const docs: typeof fetch = async () => Response.json({ client_id: cimd, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] });
    const s = await start({ fetchImpl: docs });
    const page = await authorizePage(s, cimd, pkce().challenge, { redirect_uri: "http://localhost:3118/callback" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-t="local"');
    const otherPath = await authorizePage(s, cimd, pkce().challenge, { redirect_uri: "http://localhost:3118/elsewhere" });
    expect(otherPath.status).toBe(400);
  });

  it("serves the sign-in page with a strict policy and its own wallet layer pinned by integrity (T143)", async () => {
    const s = await start();
    const page = await authorizePage(s, await register(s), pkce().challenge);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'; script-src 'nonce-[^']+' 'self'; style-src 'unsafe-inline'; img-src https:\/\/stellar\.creit\.tech data:; connect-src 'self';/);
    const html = await page.text();
    expect(html).toContain('<script src="/wallet-kit.js" data-needs="message" integrity="sha384-TESTKIT" crossorigin="anonymous"></script>');
    expect(html).not.toMatch(/unpkg|freighter-api/);
    expect(html).toContain("Continue only if you started this connection yourself");
  });

  it("does not serve the sign-in page without the pinned wallet layer, and says why", async () => {
    const s = await start({ walletKitIntegrity: () => undefined });
    const page = await authorizePage(s, await register(s), pkce().challenge);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("the wallet layer is not built");
    expect((await fetch(`${s.url}/wallet-kit.js`)).status).toBe(503);
  });

  it("never writes a token or the secret to its logs", async () => {
    const s = await start();
    const { exchange } = await tokens(s);
    await listTools(s, exchange.json["access_token"] as string);
    const logs = s.logs.join("\n");
    expect(logs).not.toContain(exchange.json["access_token"] as string);
    expect(logs).not.toContain(exchange.json["refresh_token"] as string);
    expect(logs).not.toContain(SECRET);
  });
});
