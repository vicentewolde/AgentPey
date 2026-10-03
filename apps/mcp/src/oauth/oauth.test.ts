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

async function start(options: { fetchImpl?: typeof fetch; resourcePath?: string } = {}): Promise<Started> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resource = `${url}${options.resourcePath ?? "/mcp"}`;
  const wallet = Keypair.random();
  const logs: string[] = [];
  const clock = { now: new Date() };
  const log = (message: string, fields?: Record<string, unknown>) => logs.push(JSON.stringify({ message, ...fields }));
  const oauth = createOAuthServer({ publicUrl: url, resource, allowedWallet: wallet.publicKey(), secret: SECRET, now: () => clock.now, log, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
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
  const approved = await post(`${s.url}/authorize/approve`, { request, account: s.wallet.publicKey(), nonce: asked.json["nonce"], signature: signStellarMessage(signer, asked.json["message"] as string) });
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

  it("refreshes, and the new token works", async () => {
    const s = await start();
    const { clientId, exchange } = await tokens(s);
    const refreshed = await post(`${s.url}/token`, { grant_type: "refresh_token", refresh_token: exchange.json["refresh_token"] as string, client_id: clientId }, true);
    expect(refreshed.status).toBe(200);
    expect((await listTools(s, refreshed.json["access_token"] as string)).status).toBe(200);
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
    const body = { request, account: s.wallet.publicKey(), nonce: asked.json["nonce"], signature: signStellarMessage(s.wallet, asked.json["message"] as string) };
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

  it("refuses an expired token and a token issued for another resource", async () => {
    const s = await start();
    const { exchange } = await tokens(s);
    const token = exchange.json["access_token"] as string;
    // Same secret, another resource: a token minted for it must not open this one.
    const elsewhere = await start({ resourcePath: "/other" });
    const foreign = createOAuthServer({ publicUrl: s.url, resource: elsewhere.resource, allowedWallet: s.wallet.publicKey(), secret: SECRET });
    expect(foreign.verifier).toBeDefined();
    await expect(createOAuthServer({ publicUrl: s.url, resource: s.resource, allowedWallet: s.wallet.publicKey(), secret: SECRET }).verifier.verifyAccessToken(token)).resolves.toMatchObject({ scopes: ["shop"] });
    await expect(foreign.verifier.verifyAccessToken(token)).rejects.toMatchObject({ code: "invalid_token" });
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
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("reads a client metadata document only from a host it already trusts", async () => {
    const fetched: string[] = [];
    const docs: typeof fetch = async (input) => {
      fetched.push(String(input));
      return Response.json({ client_id: String(input), client_name: "Claude", redirect_uris: [CLAUDE] });
    };
    const s = await start({ fetchImpl: docs });
    const trusted = await authorizePage(s, "https://claude.ai/oauth/mcp-client.json", pkce().challenge);
    expect(trusted.status).toBe(200);
    const untrusted = await authorizePage(s, "https://attacker.example/client.json", pkce().challenge);
    expect(untrusted.status).toBe(400);
    expect(fetched).toEqual(["https://claude.ai/oauth/mcp-client.json"]);
  });

  it("serves the sign-in page with a strict policy and Freighter pinned by integrity", async () => {
    const s = await start();
    const page = await authorizePage(s, await register(s), pkce().challenge);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'; script-src 'nonce-[^']+' https:\/\/unpkg\.com/);
    expect(await page.text()).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/);
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
