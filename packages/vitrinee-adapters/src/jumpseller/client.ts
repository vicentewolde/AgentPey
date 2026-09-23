/**
 * Thin HTTP client for the Jumpseller REST API v1.
 *
 * Auth is HTTP Basic with `login:authtoken`, which is what the official
 * OpenAPI documents; the `login`/`authtoken` query parameters still work but
 * are deprecated, and they would put the credentials in every URL. Either
 * way this file is the only place credentials are touched: nothing it throws
 * carries them, and callers see a path, never a full URL.
 */
import { VitrineeError } from "@vitrinee/core";

const API_BASE = "https://api.jumpseller.com/v1";

export interface JumpsellerCredentials {
  login: string;
  authtoken: string;
}

export interface JumpsellerClientOptions {
  credentials: JumpsellerCredentials;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number>;
  body?: unknown;
}

/** Any non-2xx response. Carries the status so callers can branch on it. */
export class JumpsellerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly apiMessage: string,
  ) {
    super(`Jumpseller responded ${status} on ${path}: ${apiMessage}`);
    this.name = "JumpsellerHttpError";
  }
}

export class JumpsellerClient {
  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: JumpsellerClientOptions) {
    const { login, authtoken } = options.credentials;
    this.authorization = `Basic ${Buffer.from(`${login}:${authtoken}`, "utf8").toString("base64")}`;
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const method = options.method ?? "GET";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: this.authorization,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // The cause is dropped on purpose: a fetch error can echo the request URL.
      throw new VitrineeError("NetworkError", `Jumpseller unreachable on ${method} ${path}`, {
        details: { path, method },
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new JumpsellerHttpError(response.status, path, apiMessage(text));
    }
    if (text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new VitrineeError("AdapterError", `Jumpseller returned invalid JSON on ${method} ${path}`, {
        details: { path, method },
      });
    }
  }
}

/** Pulls Jumpseller's own `message`/`error` out of a body, else a clipped excerpt. */
function apiMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["message", "error"]) {
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
