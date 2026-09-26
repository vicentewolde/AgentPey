/**
 * Thin client for the Shopify Admin GraphQL API, authenticated the way Shopify
 * requires for new apps since 2026-01-01: a Dev Dashboard app's client
 * credentials are exchanged for an access token that lives 24 hours (VT-33).
 * The token is cached in memory and renewed a minute before it expires, or
 * once when the API answers 401.
 *
 * This file is the only place the client secret and the token are touched:
 * nothing it throws carries them, and callers see a path, never a full URL.
 * The shop host is checked against `*.myshopify.com` before anything is sent,
 * because the client secret travels to that host.
 */
import { VitrineeError } from "@vitrinee/core";

export const SHOPIFY_API_VERSION = "2026-07";

export interface ShopifyCredentials {
  /** The store's `<handle>.myshopify.com` host. */
  shop: string;
  clientId: string;
  clientSecret: string;
}

export interface ShopifyClientOptions {
  credentials: ShopifyCredentials;
  apiVersion?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const SHOP_HOST_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isShopifyShopHost(value: string): boolean {
  return SHOP_HOST_RE.test(value);
}

/** A non-2xx response. `stage` says whether it came from the token exchange or from the API. */
export class ShopifyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly apiMessage: string,
    readonly stage: "token" | "api",
  ) {
    super(`Shopify responded ${status} on ${path}: ${apiMessage}`);
    this.name = "ShopifyHttpError";
  }
}

/** The API answered 200 with a top-level `errors` list (the way GraphQL reports failures). */
export class ShopifyGraphqlError extends Error {
  constructor(
    readonly messages: string[],
    readonly codes: string[],
  ) {
    super(`Shopify GraphQL error: ${messages.join("; ")}`);
    this.name = "ShopifyGraphqlError";
  }
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class ShopifyClient {
  private readonly credentials: ShopifyCredentials;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private token: CachedToken | undefined;

  constructor(options: ShopifyClientOptions) {
    if (!isShopifyShopHost(options.credentials.shop)) {
      throw new VitrineeError("ValidationError", "the Shopify store must be its <name>.myshopify.com address", {
        details: { field: "shop" },
      });
    }
    this.credentials = options.credentials;
    this.apiVersion = options.apiVersion ?? SHOPIFY_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /** The store's handle, the part before `.myshopify.com`. */
  get handle(): string {
    return this.credentials.shop.slice(0, -".myshopify.com".length);
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.graphqlOnce<T>(query, variables);
    } catch (error) {
      // A token can be revoked before its 24 hours are up; renew and retry once.
      if (error instanceof ShopifyHttpError && error.stage === "api" && error.status === 401) {
        this.token = undefined;
        return this.graphqlOnce<T>(query, variables);
      }
      throw error;
    }
  }

  private async graphqlOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const path = `/admin/api/${this.apiVersion}/graphql.json`;
    const token = await this.accessToken();
    const text = await this.send(path, "api", {
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    let parsed: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new VitrineeError("AdapterError", `Shopify returned invalid JSON on ${path}`, { details: { path } });
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      throw new ShopifyGraphqlError(
        parsed.errors.map((e) => e.message ?? "(no message)"),
        parsed.errors.map((e) => e.extensions?.code ?? ""),
      );
    }
    if (parsed.data === undefined) {
      throw new VitrineeError("AdapterError", `Shopify returned no data on ${path}`, { details: { path } });
    }
    return parsed.data;
  }

  private async accessToken(): Promise<string> {
    if (this.token !== undefined && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const path = "/admin/oauth/access_token";
    const text = await this.send(path, "token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }).toString(),
    });
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new VitrineeError("AdapterError", "Shopify returned invalid JSON on the token exchange", { details: { path } });
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
      throw new VitrineeError("AdapterError", "Shopify's token exchange answered without an access token", { details: { path } });
    }
    const seconds = typeof parsed.expires_in === "number" ? parsed.expires_in : 86_399;
    this.token = { value: parsed.access_token, expiresAt: this.now() + seconds * 1000 };
    return this.token.value;
  }

  private async send(path: string, stage: "token" | "api", init: { headers: Record<string, string>; body: string }): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${this.credentials.shop}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // The cause is dropped on purpose: a fetch error can echo the request URL.
      throw new VitrineeError("NetworkError", `Shopify unreachable on POST ${path}`, { details: { path, method: "POST" } });
    }
    const text = await response.text();
    if (!response.ok) throw new ShopifyHttpError(response.status, path, apiMessage(text), stage);
    return text;
  }
}

/** Shopify's own `error_description`/`error`/`errors` out of a body, else a clipped excerpt. */
function apiMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["error_description", "error", "errors"]) {
        const value = record[key];
        if (typeof value === "string" && value !== "") return value;
      }
    }
  } catch {
    // not JSON; fall through to the excerpt
  }
  const trimmed = text.trim();
  return trimmed === "" ? "(empty response body)" : trimmed.slice(0, 200);
}
