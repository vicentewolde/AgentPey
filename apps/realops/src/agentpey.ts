/**
 * RealOps' client for AgentPey's `/v1` — the entirety of what this platform
 * can do to the payment system.
 *
 * Reading this file is the fastest way to check the claim the pilot rests on.
 * There are five calls: create a tenant, create a consent session, read a
 * consent session, list mandates, and ask for a purchase. Every one of them
 * **asks**. None of them grants anything, and there is no key here that could.
 *
 * Note what is *not* here and cannot be: revoking a Mandate. `scopes.ts` keeps
 * `mandates:revoke` out of the scope list on purpose — revocation is a
 * wallet-signed act the principal takes themselves, not something a partner's
 * API key can do on their behalf.
 *
 * **The grant is passed through, not rebuilt.** `translatePermissions` produced
 * the object the review screen displayed; this sends that same object. A second
 * construction here would be a second thing to drift.
 *
 * **And AgentPey does not take it on faith either.** It re-resolves the venue
 * against its own `venues.json`, asks the merchant for the invoice itself, and
 * compares everything against what the person actually signed. The worst a
 * broken or hostile RealOps can do through this file is propose a grant nobody
 * signs, or ask for a purchase that gets refused.
 */
import { AgentPassError } from "@agentpass/core";

import type { ProposedGrant } from "./permissions.js";

export interface AgentPeyConfig {
  readonly baseUrl: string;
  /** The partner API key. The only credential RealOps holds. */
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface TenantResource {
  readonly id: string;
  readonly external_ref: string;
}

export interface ConsentSessionResource {
  readonly id: string;
  readonly status: "pending" | "completed" | "expired" | "cancelled";
  readonly consent_url: string | null;
  readonly return_url: string | null;
  readonly mandate_id: string | null;
  readonly expires_at: string;
}

export interface MandateResource {
  readonly id: string;
  readonly status: string;
  readonly valid_until: string;
}

export interface PurchaseDelivery {
  readonly delivery_id: string | null;
  readonly artifact_url: string | null;
  readonly receipt_hash: string | null;
}

export interface PurchaseResource {
  readonly id: string;
  /** The Mandate the purchase went through (T90). `null` for purchases before T90 and refusals before one was resolved. */
  readonly mandate_id?: string | null;
  readonly outcome: "settled" | "refused";
  /** The typed code of whichever layer refused. `null` when settled. */
  readonly code: string | null;
  /** AgentPey's own sentence. RealOps rewrites it for a person; see `refusals.ts`. */
  readonly reason: string | null;
  readonly product_id: string;
  readonly total: string | null;
  readonly asset: string | null;
  readonly transaction_hash: string | null;
  readonly explorer_url: string | null;
  readonly delivery: PurchaseDelivery | null;
  readonly created_at: string;
}

export interface Refusal {
  readonly at: string;
  readonly code: string;
  readonly reason: string;
  readonly intent_id: string | null;
}

export interface PerDayUsage {
  readonly limit: string;
  readonly spent_today: string;
  readonly remaining: string;
  readonly currency: string;
  readonly near_limit: boolean;
}

export interface RailStatus {
  readonly contract_id: string;
  readonly balance: string;
  readonly asset: string;
  readonly sponsored: boolean;
}

export interface TenantActivity {
  readonly tenant_id: string;
  readonly mandate: { readonly id: string; readonly status: string; readonly valid_until: string } | null;
  readonly per_day: PerDayUsage | null;
  readonly rail: RailStatus | null;
  readonly purchases: readonly PurchaseResource[];
  readonly refusals: readonly Refusal[];
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * How long a purchase is given. Not the default: a tenant's first purchase
 * deploys and funds its `policy_rail`, asks the merchant for the invoice, pays
 * and waits for settlement on testnet — measured at 20–40 s in the deployed
 * pilot (T84). At 15 s RealOps told people "no se pudo hablar con AgentPey"
 * while AgentPey went on to settle the payment.
 */
export const PURCHASE_TIMEOUT_MS = 120_000;

function failed(message: string, details: Record<string, unknown>, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details });
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`; some runtimes surface it as `AbortError`. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export interface AgentPeyClient {
  /**
   * The tenant for this account, created on first use.
   *
   * Safe to call on every request: `external_ref` is unique per partner and
   * `POST /v1/tenants` answers `200` with the existing tenant when the same
   * reference is asserted again. That matters because this runs behind a
   * person clicking a button twice.
   */
  ensureTenant(externalRef: string): Promise<TenantResource>;
  createConsentSession(input: {
    readonly tenantId: string;
    readonly grant: ProposedGrant;
    readonly returnUrl: string;
    readonly idempotencyKey: string;
  }): Promise<ConsentSessionResource>;
  readConsentSession(id: string): Promise<ConsentSessionResource>;
  listMandates(tenantId: string): Promise<readonly MandateResource[]>;
  /**
   * Asks for one purchase.
   *
   * A refusal comes back as a `201` with `outcome: "refused"` and a typed
   * `code`, not as a thrown error — the Mandate saying no is the system
   * working, and this client keeps that distinction rather than flattening it
   * into an exception the caller would have to re-classify.
   */
  purchase(input: {
    readonly tenantId: string;
    readonly venue: string;
    readonly productId: string;
    readonly quantity: number;
    readonly routeParams?: Readonly<Record<string, string | number>>;
    /**
     * The Mandate of the agent the person chose (T90). AgentPey checks it is
     * this tenant's and goes through exactly that one; it never widens what
     * that Mandate permits.
     */
    readonly mandateId?: string;
    readonly idempotencyKey: string;
  }): Promise<PurchaseResource>;
  readActivity(tenantId: string): Promise<TenantActivity>;
}

export function createAgentPeyClient(config: AgentPeyConfig): AgentPeyClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    method: string,
    path: string,
    options: { readonly body?: unknown; readonly idempotencyKey?: string; readonly timeoutMs?: number } = {},
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
      });
    } catch (error) {
      // A timeout is not "AgentPey is unreachable": the request may still be
      // running there, and for a purchase it may still settle. Callers need to
      // tell the two apart to say the truth to a person.
      if (isTimeout(error)) throw failed("AgentPey no respondió a tiempo", { path, timedOut: true }, error);
      throw failed("no se pudo hablar con AgentPey", { path }, error);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      // The abort can also land while the body is still arriving.
      if (isTimeout(error)) throw failed("AgentPey no respondió a tiempo", { path, timedOut: true }, error);
      throw failed("AgentPey no respondió JSON", { path, status: response.status }, error);
    }
    return { status: response.status, body: parsed };
  }

  /** Unwraps `/v1`'s envelope, turning `{ ok: false, code }` into a typed error. */
  function unwrap<T>(result: { readonly status: number; readonly body: unknown }, path: string): T {
    const body = result.body as { ok?: boolean; data?: T; code?: string; message?: string };
    if (body.ok === true && body.data !== undefined) return body.data;
    throw new AgentPassError("CommandFailed", body.message ?? "AgentPey rechazó la petición", {
      // The code is carried through unchanged: a refusal is only useful to the
      // person if the reason survives the hop.
      details: { path, status: result.status, code: body.code ?? "unknown" },
    });
  }

  return {
    async ensureTenant(externalRef) {
      // One call, and no branch for "already exists": `POST /v1/tenants`
      // answers `200` with the existing tenant when this partner already
      // registered that `external_ref`, because asserting the same fact twice
      // is not an error. A client that reimplemented that as a catch-and-read
      // would be guessing at behaviour the route already defines — which is
      // exactly what the first draft of this file did, before the route was
      // read instead of assumed.
      const created = await call("POST", "/v1/tenants", {
        body: { external_ref: externalRef },
        idempotencyKey: `tenant-${externalRef}`,
      });
      return unwrap<TenantResource>(created, "/v1/tenants");
    },

    async createConsentSession(input) {
      // `ProposedGrant` carries `validFrom`/`validUntil` inside the grant
      // object because the review screen needs them there to show "hasta
      // cuándo vale" next to the rest of what will be signed. But
      // `mandateGrantSchema` (`packages/mandate`) is a `strictObject` with no
      // such fields — the validity window is a sibling of `grant` in the
      // wire request, not part of it (`createConsentSessionRequestSchema`).
      // Sending `input.grant` verbatim smuggles two extra keys into a strict
      // schema and AgentPey refuses the whole request with `InvalidArguments`.
      // Found by running the real flow end to end, not by reading: no test
      // here ever builds the actual wire body, only the fake client's
      // in-memory `ProposedGrant`.
      const { validFrom: _validFrom, validUntil, ...grant } = input.grant;
      const result = await call("POST", "/v1/consent_sessions", {
        body: {
          tenant_id: input.tenantId,
          grant,
          valid_until: validUntil,
          return_url: input.returnUrl,
        },
        idempotencyKey: input.idempotencyKey,
      });
      return unwrap<ConsentSessionResource>(result, "/v1/consent_sessions");
    },

    async readConsentSession(id) {
      const result = await call("GET", `/v1/consent_sessions/${encodeURIComponent(id)}`);
      return unwrap<ConsentSessionResource>(result, "/v1/consent_sessions/{id}");
    },

    async listMandates(tenantId) {
      const result = await call("GET", `/v1/mandates?tenant_id=${encodeURIComponent(tenantId)}`);
      return unwrap<readonly MandateResource[]>(result, "/v1/mandates");
    },

    async purchase(input) {
      const result = await call("POST", "/v1/purchases", {
        body: {
          tenant_id: input.tenantId,
          venue: input.venue,
          product_id: input.productId,
          quantity: input.quantity,
          ...(input.routeParams === undefined ? {} : { route_params: input.routeParams }),
          ...(input.mandateId === undefined ? {} : { mandate_id: input.mandateId }),
        },
        idempotencyKey: input.idempotencyKey,
        timeoutMs: PURCHASE_TIMEOUT_MS,
      });
      // `201` for both outcomes, so `unwrap` returns the refusal too and the
      // caller reads `outcome` instead of catching.
      return unwrap<PurchaseResource>(result, "/v1/purchases");
    },

    async readActivity(tenantId) {
      const result = await call("GET", `/v1/tenants/${encodeURIComponent(tenantId)}/activity`);
      return unwrap<TenantActivity>(result, "/v1/tenants/{id}/activity");
    },
  };
}
