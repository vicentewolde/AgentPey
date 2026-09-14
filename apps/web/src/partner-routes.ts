/**
 * The `/v1` partner API, wired for real against `@agentpey/directory` — T49.
 *
 * `routePartnerRequest` is pure apart from the `Directory` calls it makes
 * through an injected, narrowly-typed dependency (same seam
 * `tenant-agent.ts` already uses): it never touches `req`/`res`, so it is
 * tested the same way `session-documents.ts`/`session-rehydration.ts` are —
 * with a fake, no HTTP server, no Postgres. `server.ts` calls this once for
 * every `/v1/*` request and translates the `{status, body}` it returns into
 * `sendJson`.
 *
 * Every route that reads or lists by id checks tenant ownership explicitly
 * and answers `404` (never `403`) when the resource belongs to a different
 * partner — the same "don't confirm existence to someone who shouldn't see
 * it" rule `InvalidApiKey` already applies to a revoked key.
 */
import { AgentPassError, isAgentPassError } from "@agentpass/core";
import type { AgentInstance, ConsentSessionRecord, Directory, MandateRecord, PurchaseRecord, Tenant } from "@agentpey/directory";
import {
  authorizeRequest,
  createConsentSessionRequestSchema,
  createTenantRequestSchema,
  hashRequestBody,
  requireAllowedReturnUrl,
  resolveIdempotency,
  successEnvelope,
  toAgentResource,
  toConsentSessionResource,
  toErrorEnvelope,
  toMandateResource,
  toPurchaseResource,
  toTenantResource,
  createPurchaseRequestSchema,
  type ApiScope,
  type PurchaseResource,
} from "@agentpey/partner-api";
import { z } from "zod";

export type PartnerRoutesDirectory = Pick<
  Directory,
  | "createPurchase"
  | "findPurchase"
  | "authenticate"
  | "createTenant"
  | "findTenant"
  | "findTenantByExternalRef"
  | "listAgents"
  | "findMandateById"
  | "listMandates"
  | "findIdempotentResponse"
  | "recordIdempotentResponse"
  | "createConsentSession"
  | "findConsentSession"
  // T81: the return-URL allowlist is the partner's own data, so the route
  // reads the partner to apply it.
  | "findPartner"
>;

/**
 * What a purchase needs, as this layer sees it: one call, one answer.
 *
 * Injected rather than imported so `partner-routes.ts` stays what its own
 * docstring promises — pure apart from narrowly-typed dependencies, testable
 * with a fake and no HTTP server, no Postgres, no Stellar. Everything the
 * real implementation needs (a master seed, a reserve key, an RPC client)
 * lives on the far side of this one function, and none of it leaks into the
 * routing layer.
 */
export type ExecutePurchase = (request: {
  readonly tenantId: string;
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  readonly maxTotal?: string;
  readonly routeParams?: Readonly<Record<string, string | number>>;
}) => Promise<
  | {
      readonly kind: "settled";
      readonly agentId: string;
      readonly intentId: string;
      readonly total: string;
      readonly asset: string;
      readonly payTo: string | undefined;
      readonly transactionHash: string | undefined;
      readonly resourceUrl: string;
      readonly resource: unknown;
    }
  | {
      readonly kind: "refused";
      readonly agentId: string | null;
      readonly code: string;
      readonly reason: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly intentId: string | undefined;
    }
>;

/** Reads one tenant's activity. Strictly read-only on both sides of the port. */
export type ReadActivity = (tenantId: string) => Promise<unknown>;

export interface PartnerRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly authorizationHeader: string | undefined;
  readonly idempotencyKeyHeader: string | undefined;
  readonly body: unknown;
  readonly directory: PartnerRoutesDirectory;
  /** This deployment's own origin, e.g. `https://agentpey.com` — used to build a `consent_url`. Only read by `POST /v1/consent_sessions`. */
  readonly baseUrl: string;
  /** Runs one purchase. Only read by `POST /v1/purchases`. */
  readonly executePurchase: ExecutePurchase;
  /**
   * Reads everything a tenant may be shown about their own agent. Only read
   * by `GET /v1/tenants/{id}/activity`, and injected for the same reason
   * `executePurchase` is: Postgres, the vault and a Stellar RPC client all
   * stay on the far side of it, and this layer stays testable with a fake.
   */
  readonly readActivity: ReadActivity;
  readonly now?: Date;
}

export interface PartnerRouteResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Every `/v1`-relevant `AgentPassError` code this route layer can produce or pass through, mapped to its HTTP status. Anything else is a 500 — an error this layer did not anticipate should never masquerade as a client mistake. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  MissingApiKey: 401,
  InvalidApiKey: 401,
  ScopeNotGranted: 403,
  IdempotencyKeyRequired: 400,
  IdempotencyKeyConflict: 409,
  InvalidArguments: 400,
  InvalidExternalRef: 400,
  TenantAlreadyExists: 409,
  PartnerNotFound: 404,
  TenantNotFound: 404,
  AgentNotFound: 404,
  MandateNotFound: 404,
  ConsentSessionNotFound: 404,
  ConsentSessionExpired: 410,
  ConsentSessionAlreadyCompleted: 409,
  /** T81: the partner asked to redirect somewhere it never registered. Their mistake, not ours. */
  ReturnUrlNotAllowed: 400,
  PurchaseNotFound: 404,
  /**
   * T73 froze the execution routes before T75 implements them. `501` and not
   * `404`: the route exists, is authenticated, and validates its body — what
   * it cannot do yet is act. An integrator reading `404` would conclude the
   * endpoint was never coming.
   */
  NotImplemented: 501,
};

export function statusForError(error: unknown): number {
  if (isAgentPassError(error)) return STATUS_BY_CODE[error.code] ?? 500;
  return 500;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AgentPassError("InvalidArguments", "request body does not match the expected shape", { cause: result.error });
  }
  return result.data;
}

function requireQueryParam(searchParams: URLSearchParams, name: string): string {
  const value = searchParams.get(name);
  if (value === null || value.trim().length === 0) {
    throw new AgentPassError("InvalidArguments", `missing required query parameter '${name}'`, { details: { name } });
  }
  return value;
}

/** `404`, never `403`, when the tenant exists but belongs to another partner. */
async function requireOwnedTenant(directory: PartnerRoutesDirectory, tenantId: string, partnerId: string): Promise<Tenant> {
  const tenant = await directory.findTenant(tenantId);
  if (tenant === undefined || tenant.partnerId !== partnerId) {
    throw new AgentPassError("TenantNotFound", "no tenant with that id", { details: { tenantId } });
  }
  return tenant;
}

async function requireOwnedMandate(directory: PartnerRoutesDirectory, mandateId: string, partnerId: string): Promise<MandateRecord> {
  const mandate = await directory.findMandateById(mandateId);
  if (mandate === undefined) {
    throw new AgentPassError("MandateNotFound", "no mandate with that id", { details: { mandateId } });
  }
  const tenant = await directory.findTenant(mandate.tenantId);
  if (tenant === undefined || tenant.partnerId !== partnerId) {
    throw new AgentPassError("MandateNotFound", "no mandate with that id", { details: { mandateId } });
  }
  return mandate;
}

async function requireOwnedConsentSession(
  directory: PartnerRoutesDirectory,
  id: string,
  partnerId: string,
): Promise<ConsentSessionRecord> {
  const session = await directory.findConsentSession(id);
  if (session === undefined) {
    throw new AgentPassError("ConsentSessionNotFound", "no consent session with that id", { details: { consentSessionId: id } });
  }
  const tenant = await directory.findTenant(session.tenantId);
  if (tenant === undefined || tenant.partnerId !== partnerId) {
    throw new AgentPassError("ConsentSessionNotFound", "no consent session with that id", { details: { consentSessionId: id } });
  }
  return session;
}

async function respondOrCache(
  directory: PartnerRoutesDirectory,
  partnerId: string,
  idempotencyKey: string,
  body: unknown,
  execute: () => Promise<PartnerRouteResponse>,
): Promise<PartnerRouteResponse> {
  const result = await execute().catch((error: unknown) => ({ status: statusForError(error), body: toErrorEnvelope(error) }));
  await directory.recordIdempotentResponse({
    partnerId,
    key: idempotencyKey,
    requestHash: hashRequestBody(body),
    responseStatus: result.status,
    responseBody: result.body,
  });
  return result;
}

async function handleCreateTenant(input: PartnerRouteRequest, now: Date): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "tenants:write" satisfies ApiScope, input.directory.authenticate);

  const outcome = await resolveIdempotency({
    partnerId: auth.partnerId,
    idempotencyKeyHeader: input.idempotencyKeyHeader,
    body: input.body,
    lookup: input.directory.findIdempotentResponse,
    now,
  });
  if (outcome.kind === "replay") return { status: outcome.record.responseStatus, body: outcome.record.responseBody };

  return respondOrCache(input.directory, auth.partnerId, input.idempotencyKeyHeader!, input.body, async () => {
    const request = parseBody(createTenantRequestSchema, input.body);
    try {
      const tenant = await input.directory.createTenant({
        partnerId: auth.partnerId,
        externalRef: request.external_ref,
        label: request.label ?? undefined,
      });
      return { status: 201, body: successEnvelope(toTenantResource(tenant)) };
    } catch (error) {
      // Re-creating a tenant your own partner already registered for this
      // external_ref is not an error at the business level — it is the same
      // fact asserted twice. Idempotent on the natural key, in addition to
      // (and independent of) the Idempotency-Key mechanism above.
      if (isAgentPassError(error) && error.code === "TenantAlreadyExists") {
        const existing = await input.directory.findTenantByExternalRef(auth.partnerId, request.external_ref);
        if (existing !== undefined) return { status: 200, body: successEnvelope(toTenantResource(existing)) };
      }
      throw error;
    }
  });
}

async function handleGetTenant(input: PartnerRouteRequest, tenantId: string): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "tenants:read" satisfies ApiScope, input.directory.authenticate);
  const tenant = await requireOwnedTenant(input.directory, tenantId, auth.partnerId);
  return { status: 200, body: successEnvelope(toTenantResource(tenant)) };
}

async function handleListAgents(input: PartnerRouteRequest): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "agents:read" satisfies ApiScope, input.directory.authenticate);
  const tenantId = requireQueryParam(input.searchParams, "tenant_id");
  await requireOwnedTenant(input.directory, tenantId, auth.partnerId);
  const agents: readonly AgentInstance[] = await input.directory.listAgents(tenantId);
  return { status: 200, body: successEnvelope(agents.map(toAgentResource)) };
}

async function handleGetMandate(input: PartnerRouteRequest, mandateId: string, now: Date): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "mandates:read" satisfies ApiScope, input.directory.authenticate);
  const mandate = await requireOwnedMandate(input.directory, mandateId, auth.partnerId);
  return { status: 200, body: successEnvelope(toMandateResource(mandate, now)) };
}

async function handleListMandates(input: PartnerRouteRequest, now: Date): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "mandates:read" satisfies ApiScope, input.directory.authenticate);
  const tenantId = requireQueryParam(input.searchParams, "tenant_id");
  await requireOwnedTenant(input.directory, tenantId, auth.partnerId);
  const mandates: readonly MandateRecord[] = await input.directory.listMandates(tenantId);
  return { status: 200, body: successEnvelope(mandates.map((mandate) => toMandateResource(mandate, now))) };
}

/** How long a partner's invitation link stays signable. Distinct from the grant's own `valid_until`. */
const CONSENT_SESSION_TTL_MS = 60 * 60 * 1000;

async function handleCreateConsentSession(input: PartnerRouteRequest, now: Date): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "consent_sessions:write" satisfies ApiScope, input.directory.authenticate);

  const outcome = await resolveIdempotency({
    partnerId: auth.partnerId,
    idempotencyKeyHeader: input.idempotencyKeyHeader,
    body: input.body,
    lookup: input.directory.findIdempotentResponse,
    now,
  });
  if (outcome.kind === "replay") return { status: outcome.record.responseStatus, body: outcome.record.responseBody };

  return respondOrCache(input.directory, auth.partnerId, input.idempotencyKeyHeader!, input.body, async () => {
    const request = parseBody(createConsentSessionRequestSchema, input.body);
    await requireOwnedTenant(input.directory, request.tenant_id, auth.partnerId);

    const validFrom = request.valid_from === undefined ? now : new Date(request.valid_from);

    // T81: checked here, when the session is created, and not when the
    // redirect happens. The integrator finds out while integrating, with a
    // typed error; and nothing unvalidated is ever written, so whatever
    // renders the redirect can trust the stored value.
    let returnUrl: string | null = null;
    if (request.return_url !== undefined) {
      const partner = await input.directory.findPartner(auth.partnerId);
      if (partner === undefined) {
        throw new AgentPassError("PartnerNotFound", `no partner with id "${auth.partnerId}"`, {
          details: { partnerId: auth.partnerId },
        });
      }
      returnUrl = requireAllowedReturnUrl(request.return_url, partner.returnOrigins);
    }

    const session = await input.directory.createConsentSession({
      tenantId: request.tenant_id,
      grant: request.grant,
      validFrom,
      validUntil: new Date(request.valid_until),
      expiresAt: new Date(now.getTime() + CONSENT_SESSION_TTL_MS),
      returnUrl,
    });

    const consentUrl = `${input.baseUrl}/consent/${session.id}`;
    return { status: 201, body: successEnvelope(toConsentSessionResource(session, now, consentUrl)) };
  });
}

async function handleGetConsentSession(input: PartnerRouteRequest, id: string, now: Date): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "consent_sessions:read" satisfies ApiScope, input.directory.authenticate);
  const session = await requireOwnedConsentSession(input.directory, id, auth.partnerId);
  const consentUrl = `${input.baseUrl}/consent/${session.id}`;
  return { status: 200, body: successEnvelope(toConsentSessionResource(session, now, consentUrl)) };
}

/**
 * `POST /v1/purchases` — authenticated, scoped, idempotent and validated
 * today; able to actually buy something in T75.
 *
 * Everything before the execution is deliberately wired now rather than with
 * the execution: the checks an integrator builds against — is my key allowed
 * to spend, is this tenant mine, does my body parse, is my `Idempotency-Key`
 * being honoured — are exactly the ones that must not change underneath them
 * later. What is missing is the part that moves money, and it says so with a
 * code rather than a `404`.
 *
 * Note the order: authorise, then check the tenant is this partner's, then
 * parse. A request for another partner's tenant gets the same `404` a
 * nonexistent one does, before this route reveals whether its body was even
 * well-formed.
 */
async function handleCreatePurchase(input: PartnerRouteRequest, now: Date): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "payments:authorize" satisfies ApiScope, input.directory.authenticate);

  const outcome = await resolveIdempotency({
    partnerId: auth.partnerId,
    idempotencyKeyHeader: input.idempotencyKeyHeader,
    body: input.body,
    lookup: input.directory.findIdempotentResponse,
    now,
  });
  if (outcome.kind === "replay") return { status: outcome.record.responseStatus, body: outcome.record.responseBody };

  return respondOrCache(input.directory, auth.partnerId, input.idempotencyKeyHeader!, input.body, async () => {
    const request = parseBody(createPurchaseRequestSchema, input.body);
    await requireOwnedTenant(input.directory, request.tenant_id, auth.partnerId);

    const result = await input.executePurchase({
      tenantId: request.tenant_id,
      venue: request.venue,
      productId: request.product_id,
      quantity: request.quantity,
      maxTotal: request.max_total,
      routeParams: request.route_params,
    });

    // Settled or refused, the attempt is recorded. A design that only stored
    // successes would make "why did my agent not buy this?" unanswerable —
    // the question a system like this most needs to answer.
    const record = await input.directory.createPurchase({
      tenantId: request.tenant_id,
      agentId: result.agentId,
      partnerId: auth.partnerId,
      outcome: result.kind,
      code: result.kind === "refused" ? result.code : null,
      reason: result.kind === "refused" ? result.reason : null,
      venue: request.venue,
      productId: request.product_id,
      quantity: request.quantity,
      intentId: result.intentId ?? null,
      total: result.kind === "settled" ? result.total : null,
      asset: result.kind === "settled" ? result.asset : null,
      payTo: result.kind === "settled" ? (result.payTo ?? null) : null,
      transactionHash: result.kind === "settled" ? (result.transactionHash ?? null) : null,
      delivery:
        result.kind === "settled"
          ? { resource_url: result.resourceUrl, resource: result.resource }
          : null,
    });

    // `201` for both outcomes. A Mandate saying no is this system working;
    // reporting it as a client error would file "your consent does not cover
    // this" alongside "your JSON is malformed".
    return { status: 201, body: successEnvelope(toPurchaseResource(record)) };
  });
}

async function handleGetPurchase(input: PartnerRouteRequest, id: string): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "payments:read" satisfies ApiScope, input.directory.authenticate);
  const record = await input.directory.findPurchase(id);
  // `404`, never `403`, for another partner's purchase — the rule this file
  // has applied to every resource since T49.
  if (record === undefined || record.partnerId !== auth.partnerId) {
    throw new AgentPassError("PurchaseNotFound", "no purchase with that id", { details: { purchaseId: id } });
  }
  return { status: 200, body: successEnvelope(toPurchaseResource(record)) };
}

/**
 * `GET /v1/tenants/{id}/activity` — strictly read-only, and guarded by
 * `vault:read` rather than by anything that can spend.
 */
async function handleGetTenantActivity(input: PartnerRouteRequest, tenantId: string): Promise<PartnerRouteResponse> {
  const auth = await authorizeRequest(input.authorizationHeader, "vault:read" satisfies ApiScope, input.directory.authenticate);
  // Ownership first: another partner's tenant gets the same `404` a
  // nonexistent one does, before a single figure about it is read.
  await requireOwnedTenant(input.directory, tenantId, auth.partnerId);
  return { status: 200, body: successEnvelope(await input.readActivity(tenantId)) };
}

function notFound(method: string, pathname: string): PartnerRouteResponse {
  return { status: 404, body: { ok: false, code: "NotFound", message: `no /v1 route for ${method} ${pathname}`, details: {} } };
}

/**
 * Dispatches one `/v1` request. Never throws — every error, from
 * authentication through a database failure, comes back as `{status, body}`
 * so `server.ts` never needs its own try/catch around this call.
 */
export async function routePartnerRequest(input: PartnerRouteRequest): Promise<PartnerRouteResponse> {
  const now = input.now ?? new Date();
  try {
    if (input.method === "POST" && input.pathname === "/v1/tenants") {
      return await handleCreateTenant(input, now);
    }

    const tenantActivityMatch = /^\/v1\/tenants\/([^/]+)\/activity$/.exec(input.pathname);
    if (input.method === "GET" && tenantActivityMatch?.[1] !== undefined) {
      return await handleGetTenantActivity(input, decodeURIComponent(tenantActivityMatch[1]));
    }

    const tenantMatch = /^\/v1\/tenants\/([^/]+)$/.exec(input.pathname);
    if (input.method === "GET" && tenantMatch?.[1] !== undefined) {
      return await handleGetTenant(input, decodeURIComponent(tenantMatch[1]));
    }

    if (input.method === "GET" && input.pathname === "/v1/agents") {
      return await handleListAgents(input);
    }

    if (input.method === "POST" && input.pathname === "/v1/consent_sessions") {
      return await handleCreateConsentSession(input, now);
    }

    const consentSessionMatch = /^\/v1\/consent_sessions\/([^/]+)$/.exec(input.pathname);
    if (input.method === "GET" && consentSessionMatch?.[1] !== undefined) {
      return await handleGetConsentSession(input, decodeURIComponent(consentSessionMatch[1]), now);
    }

    const mandateMatch = /^\/v1\/mandates\/([^/]+)$/.exec(input.pathname);
    if (input.method === "GET" && mandateMatch?.[1] !== undefined) {
      return await handleGetMandate(input, decodeURIComponent(mandateMatch[1]), now);
    }

    if (input.method === "GET" && input.pathname === "/v1/mandates") {
      return await handleListMandates(input, now);
    }

    if (input.method === "POST" && input.pathname === "/v1/purchases") {
      return await handleCreatePurchase(input, now);
    }

    const purchaseMatch = /^\/v1\/purchases\/([^/]+)$/.exec(input.pathname);
    if (input.method === "GET" && purchaseMatch?.[1] !== undefined) {
      return await handleGetPurchase(input, decodeURIComponent(purchaseMatch[1]));
    }

    return notFound(input.method, input.pathname);
  } catch (error) {
    return { status: statusForError(error), body: toErrorEnvelope(error) };
  }
}
