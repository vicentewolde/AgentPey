export {
  API_SCOPES,
  apiScopeCovers,
  apiScopeSchema,
  areValidApiScopes,
  type ApiScope,
} from "./scopes.js";

export {
  API_KEY_SECRET_PATTERN,
  AUTHORIZATION_HEADER,
  authorizeRequest,
  type AuthenticateApiKey,
  type AuthorizedRequest,
} from "./auth.js";

export {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_TTL_MS,
  canonicalize,
  hashRequestBody,
  idempotencyRecordSchema,
  resolveIdempotency,
  type IdempotencyLookup,
  type IdempotencyOutcome,
  type IdempotencyRecord,
  type ResolveIdempotencyInput,
} from "./idempotency.js";

export { errorEnvelopeSchema, successEnvelope, toErrorEnvelope, type ErrorEnvelope } from "./envelope.js";

export {
  requireAllowedReturnUrl,
  returnOriginSchema,
  returnOriginsSchema,
} from "./return-urls.js";

export {
  signWebhookPayload,
  verifyWebhookSignature,
  webhookEventSchema,
  webhookEventTypeSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_REPLAY_WINDOW_MS,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookVerification,
} from "./webhooks.js";

export {
  createTenantRequestSchema,
  tenantResourceSchema,
  toTenantResource,
  type CreateTenantRequest,
  type TenantResource,
} from "./resources/tenants.js";

export { agentResourceSchema, toAgentResource, type AgentResource } from "./resources/agents.js";

export {
  computeMandateStatus,
  mandateResourceSchema,
  mandateStatusSchema,
  toMandateResource,
  type MandateResource,
  type MandateStatus,
} from "./resources/mandates.js";

export {
  computeConsentSessionStatus,
  consentSessionIdSchema,
  consentSessionResourceSchema,
  consentSessionStatusSchema,
  createConsentSessionRequestSchema,
  toConsentSessionResource,
  type ConsentSessionResource,
  type ConsentSessionStatus,
  type CreateConsentSessionRequest,
} from "./resources/consent-sessions.js";

export {
  createPurchaseRequestSchema,
  previewPurchaseRequestSchema,
  purchaseDeliverySchema,
  purchaseIdSchema,
  purchaseOutcomeSchema,
  purchasePreviewResourceSchema,
  purchaseResourceSchema,
  toPurchaseResource,
  venueIdSchema,
  type CreatePurchaseRequest,
  type PreviewPurchaseRequest,
  type PurchaseDelivery,
  type PurchaseOutcome,
  type PurchasePreviewResource,
  type PurchaseResource,
} from "./resources/purchases.js";

export {
  activeMandateSchema,
  perDayUsageSchema,
  railStatusSchema,
  refusalSchema,
  tenantActivityResourceSchema,
  type ActiveMandate,
  type PerDayUsage,
  type RailStatus,
  type Refusal,
  type TenantActivityResource,
} from "./resources/activity.js";
