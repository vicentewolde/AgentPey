/** A thin, validated native-fetch client for AgentPey's partner `/v1` API. */
import { AgentPassError, type AgentPassErrorCode } from "@agentpass/core";
import {
  agentResourceSchema,
  consentSessionResourceSchema,
  createConsentSessionRequestSchema,
  createTenantRequestSchema,
  errorEnvelopeSchema,
  mandateResourceSchema,
  createWebhookEndpointRequestSchema,
  previewPurchaseRequestSchema,
  purchasePreviewResourceSchema,
  webhookEndpointResourceSchema,
  tenantResourceSchema,
  type AgentResource,
  type ConsentSessionResource,
  type CreateConsentSessionRequest,
  type CreateTenantRequest,
  type MandateResource,
  type PreviewPurchaseRequest,
  type CreateWebhookEndpointRequest,
  type PurchasePreviewResource,
  type WebhookEndpointResource,
  type TenantResource,
} from "@agentpey/partner-api";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface PartnerClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Abort a request after this duration. Defaults to ten seconds. */
  readonly timeoutMs?: number;
}

export interface IdempotentRequestOptions {
  readonly idempotencyKey?: string;
}

export interface PartnerClient {
  createTenant(input: CreateTenantRequest, options?: IdempotentRequestOptions): Promise<TenantResource>;
  getTenant(id: string): Promise<TenantResource>;
  listAgents(tenantId: string): Promise<readonly AgentResource[]>;
  createConsentSession(
    input: CreateConsentSessionRequest,
    options?: IdempotentRequestOptions,
  ): Promise<ConsentSessionResource>;
  getConsentSession(id: string): Promise<ConsentSessionResource>;
  getMandate(id: string): Promise<MandateResource>;
  listMandates(tenantId: string): Promise<readonly MandateResource[]>;
  /**
   * Asks whether a purchase would be allowed, reserving nothing and paying
   * nothing (T93). Needs the `payments:preview` scope.
   *
   * No `Idempotency-Key`: the route creates nothing, so there is nothing a
   * replay could duplicate.
   *
   * **`would_settle: true` is not a promise.** Nothing is reserved, so the
   * budget it saw may be gone by the time the real purchase runs; and no
   * merchant invoice was fetched, so `reconciled` is always `false` — a real
   * purchase still reconciles price, asset and payee against the signed
   * Mandate, and can refuse there.
   *
   * There is deliberately no `createPurchase` here yet: `POST /v1/purchases`
   * is reachable over plain HTTP and its absence from this client is a
   * tracked gap, not a statement that a partner should only ever preview.
   */
  previewPurchase(input: PreviewPurchaseRequest): Promise<PurchasePreviewResource>;
  /**
   * Registers where to send this partner's events (T94). Needs the
   * `webhooks:write` scope.
   *
   * **The returned `secret` is the only copy.** Every later read of this
   * endpoint has `secret: null`, exactly like an API key. Store it before the
   * promise's value goes out of scope; a partner that loses it registers a new
   * endpoint.
   */
  createWebhookEndpoint(
    input: CreateWebhookEndpointRequest,
    options?: IdempotentRequestOptions,
  ): Promise<WebhookEndpointResource>;
  /** This partner's live endpoints. Needs `webhooks:read`. Never carries a secret. */
  listWebhookEndpoints(): Promise<readonly WebhookEndpointResource[]>;
  /** Stops new events going to `id`. Needs `webhooks:write`. Already-queued events still go. */
  deleteWebhookEndpoint(id: string): Promise<void>;
}

function configError(message: string): AgentPassError {
  return new AgentPassError("ConfigError", message);
}

function parseBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw configError("baseUrl must use http or https");
    }
    return url;
  } catch (error) {
    if (error instanceof AgentPassError) throw error;
    throw configError("baseUrl must be a valid URL");
  }
}

function parseRequest<T>(schema: z.ZodType<T>, input: unknown, operation: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new AgentPassError("InvalidArguments", `${operation} input does not match the partner API contract`, {
    cause: result.error,
  });
}

function successEnvelopeSchema<T>(resourceSchema: z.ZodType<T>) {
  return z.strictObject({ ok: z.literal(true), data: resourceSchema });
}

function toRemoteError(code: string, message: string, details: unknown): AgentPassError {
  return new AgentPassError(code as AgentPassErrorCode, message, { details: { remote: details } });
}

function responseError(message: string, status: number, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details: { status } });
}

export function createPartnerClient(options: PartnerClientOptions): PartnerClient {
  if (options.apiKey.length === 0) throw configError("apiKey must not be empty");
  const baseUrl = parseBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw configError("timeoutMs must be a positive finite number");

  /**
   * A route that answers `204` with no body — `DELETE /v1/webhook_endpoints/{id}`
   * is the first (T94).
   *
   * Separate from {@link request} rather than a flag on it, because every line
   * of that function after the fetch is about reading a body: a `204` has
   * none, and `response.json()` on one throws. The two share the auth header,
   * the timeout and the error-envelope handling, which is the part that must
   * not drift.
   */
  async function requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;

    try {
      response = await fetch(new URL(path, baseUrl), {
        ...init,
        headers: { Authorization: `Bearer ${options.apiKey}`, ...init.headers },
        signal: controller.signal,
      });
    } catch (error) {
      throw new AgentPassError("NetworkError", "could not reach the partner API", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 204) return;

    // Anything else carries an error envelope, and the same typed failure a
    // body-bearing route would produce.
    const body: unknown = await response.json().catch(() => undefined);
    const errorEnvelope = errorEnvelopeSchema.safeParse(body);
    if (errorEnvelope.success) {
      throw toRemoteError(errorEnvelope.data.code, errorEnvelope.data.message, errorEnvelope.data.details);
    }
    throw responseError("the partner API returned an unexpected response to a delete", response.status);
  }

  async function request<T>(
    path: string,
    resourceSchema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;

    try {
      response = await fetch(new URL(path, baseUrl), {
        ...init,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...init.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new AgentPassError("NetworkError", "could not reach the partner API", { cause: error });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw responseError("the partner API returned unreadable JSON", response.status, error);
    } finally {
      clearTimeout(timeout);
    }

    const errorEnvelope = errorEnvelopeSchema.safeParse(body);
    if (errorEnvelope.success) {
      throw toRemoteError(errorEnvelope.data.code, errorEnvelope.data.message, errorEnvelope.data.details);
    }

    if (!response.ok) {
      throw responseError("the partner API returned an invalid error response", response.status);
    }

    const successEnvelope = successEnvelopeSchema(resourceSchema).safeParse(body);
    if (!successEnvelope.success) {
      throw responseError("the partner API returned a response outside its contract", response.status, successEnvelope.error);
    }
    return successEnvelope.data.data;
  }

  function encodedPathSegment(value: string): string {
    return encodeURIComponent(value);
  }

  function tenantQuery(tenantId: string): string {
    return new URLSearchParams({ tenant_id: tenantId }).toString();
  }

  return {
    createTenant: async (input, requestOptions = {}) => {
      const body = parseRequest(createTenantRequestSchema, input, "createTenant");
      const idempotencyKey = requestOptions.idempotencyKey ?? randomUUID();
      return request("/v1/tenants", tenantResourceSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    getTenant: (id) => request(`/v1/tenants/${encodedPathSegment(id)}`, tenantResourceSchema),
    listAgents: (tenantId) => request(`/v1/agents?${tenantQuery(tenantId)}`, z.array(agentResourceSchema)),
    createConsentSession: async (input, requestOptions = {}) => {
      const body = parseRequest(createConsentSessionRequestSchema, input, "createConsentSession");
      const idempotencyKey = requestOptions.idempotencyKey ?? randomUUID();
      return request("/v1/consent_sessions", consentSessionResourceSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    getConsentSession: (id) => request(`/v1/consent_sessions/${encodedPathSegment(id)}`, consentSessionResourceSchema),
    getMandate: (id) => request(`/v1/mandates/${encodedPathSegment(id)}`, mandateResourceSchema),
    listMandates: (tenantId) => request(`/v1/mandates?${tenantQuery(tenantId)}`, z.array(mandateResourceSchema)),
    createWebhookEndpoint: async (input, requestOptions = {}) => {
      const body = parseRequest(createWebhookEndpointRequestSchema, input, "createWebhookEndpoint");
      const idempotencyKey = requestOptions.idempotencyKey ?? randomUUID();
      return request("/v1/webhook_endpoints", webhookEndpointResourceSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
    },
    listWebhookEndpoints: () => request("/v1/webhook_endpoints", z.array(webhookEndpointResourceSchema)),
    deleteWebhookEndpoint: async (id) => {
      await requestNoContent(`/v1/webhook_endpoints/${encodedPathSegment(id)}`, { method: "DELETE" });
    },
    previewPurchase: async (input) => {
      const body = parseRequest(previewPurchaseRequestSchema, input, "previewPurchase");
      return request("/v1/purchases/preview", purchasePreviewResourceSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}
