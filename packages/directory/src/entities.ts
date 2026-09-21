/**
 * The shapes this directory stores, as zod schemas.
 *
 * Every row that comes back from Postgres is parsed through one of these
 * before it is handed to a caller — the same rule the rest of the project
 * applies to anything crossing a boundary. A database is a boundary: a
 * column added by hand, a migration half-applied, or a `json` column holding
 * something from an older shape all arrive here as `unknown`, and the parse
 * is what turns "probably fine" into "checked".
 */
import { stellarAddressSchema, stellarContractIdSchema, stellarDidSchema } from "@agentpass/core";
import { z } from "zod";

import { ID_PREFIXES, ULID_LENGTH } from "./ids.js";

const CROCKFORD_CLASS = "[0-9ABCDEFGHJKMNPQRSTVWXYZ]";

function idSchema(kind: keyof typeof ID_PREFIXES) {
  return z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${CROCKFORD_CLASS}{${ULID_LENGTH}}$`), {
    message: `expected a ${kind} id (${ID_PREFIXES[kind]}_...)`,
  });
}

export const partnerIdSchema = idSchema("partner");
export const apiKeyIdSchema = idSchema("apiKey");
export const principalIdSchema = idSchema("principal");
export const bindingIdSchema = idSchema("binding");
export const agentIdSchema = idSchema("agent");
export const credentialIdSchema = idSchema("credential");
export const mandateIdSchema = idSchema("mandate");
export const consentSessionIdSchema = idSchema("consentSession");
export const purchaseIdSchema = idSchema("purchase");
export const webhookEndpointIdSchema = idSchema("webhookEndpoint");


export const tenantIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIXES.partner}_${CROCKFORD_CLASS}{${ULID_LENGTH}}:${CROCKFORD_CLASS}{${ULID_LENGTH}}$`), {
    message: "expected a tenant id (ptn_...:...)",
  });

/**
 * A partner is archived, never deleted: every tenant, mandate and vault
 * record under it stays readable, which is the whole promise of the
 * evidence chain.
 */
export const partnerStatusSchema = z.enum(["active", "suspended", "archived"]);
export const tenantStatusSchema = z.enum(["active", "suspended"]);
export const agentStatusSchema = z.enum(["active", "retired"]);

/**
 * Whether this agent's derived identity exists on Stellar yet (`C-21`).
 * `derived` is the normal state of the overwhelming majority of agents: the
 * keypair is computed, and nothing has been paid for.
 */
export const onchainStateSchema = z.enum(["derived", "funded"]);

/** How a mandate was signed — the two paths T35 left in place. */
export const mandateSignatureKindSchema = z.enum(["wallet-sep53", "platform-jws"]);

/**
 * Same four values `@agentpey/partner-api`'s `consentSessionStatusSchema`
 * freezes (T45) — not imported, the dependency runs the other way. This
 * package only ever writes `pending` and `completed`; `expired` is computed
 * at read time from `expires_at` (`computeConsentSessionStatus`, T51), the
 * same way a mandate's status is never stored. `cancelled` is reserved,
 * unused until something needs it — same posture as an `ApiScope` nobody can
 * be granted yet.
 */
export const consentSessionStatusSchema = z.enum(["pending", "completed", "expired", "cancelled"]);

export const partnerSchema = z.strictObject({
  id: partnerIdSchema,
  name: z.string().min(1).max(200),
  status: partnerStatusSchema,
  /**
   * Origins this partner may send a principal back to after signing (T81).
   *
   * Empty means "may not use `return_url` at all" — the fail-closed reading of
   * an empty list this project has applied since `B-1`. Origins only: scheme,
   * host and port, compared exactly.
   */
  returnOrigins: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const apiKeySchema = z.strictObject({
  id: apiKeyIdSchema,
  partnerId: partnerIdSchema,
  name: z.string().min(1).max(200),
  /** `sha256` of the secret, hex. The secret itself is shown once and never stored. */
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(z.string().min(1)),
  createdAt: z.date(),
  revokedAt: z.date().nullable(),
});

export const tenantSchema = z.strictObject({
  id: tenantIdSchema,
  partnerId: partnerIdSchema,
  /** Opaque, partner-scoped, validated non-PII — see `external-ref.ts`. */
  externalRef: z.string().min(1).max(128),
  label: z.string().max(200).nullable(),
  status: tenantStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const principalSchema = z.strictObject({
  id: principalIdSchema,
  address: stellarAddressSchema,
  did: stellarDidSchema,
  createdAt: z.date(),
});

/**
 * One wallet's consent to act inside one tenant, with the proof it gave.
 *
 * The nonce and signature are kept because "this wallet proved control at
 * this time" is a claim someone may need to re-verify later, and a claim
 * whose evidence was thrown away is just an assertion.
 */
export const principalBindingSchema = z.strictObject({
  id: bindingIdSchema,
  tenantId: tenantIdSchema,
  principalId: principalIdSchema,
  proofNonce: z.string().min(1),
  proofSignature: z.string().min(1),
  boundAt: z.date(),
  revokedAt: z.date().nullable(),
});

export const agentInstanceSchema = z.strictObject({
  id: agentIdSchema,
  tenantId: tenantIdSchema,
  /**
   * The SEP-0005 index this agent's keypair derives from — allocated once,
   * globally monotonic, never reused. Per **agent**, not per tenant: a tenant
   * may hold several agents, and each needs a key of its own.
   */
  keyIndex: z.number().int().nonnegative(),
  address: stellarAddressSchema,
  did: stellarDidSchema,
  label: z.string().max(200).nullable(),
  status: agentStatusSchema,
  onchainState: onchainStateSchema,
  /**
   * This tenant's own `policy_rail` (F6/T58) — `null` until it pays for the
   * first time. Deployed lazily, same cost reasoning `onchainState` already
   * applies to the classic account (`C-21`): most agents in this pilot never
   * spend enough to justify one.
   */
  policyRailContractId: stellarContractIdSchema.nullable(),
  /**
   * When this rail actually received its sponsored balance (T77). `null` for
   * a rail that has been deployed but not yet funded — a state that exists
   * for a few seconds normally, and for longer if a funding transfer failed.
   * Distinct from a zero balance on purpose: "never funded" and "spent it
   * all" must not be confused, or the reserve would pay twice.
   */
  policyRailFundedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const credentialRecordSchema = z.strictObject({
  id: credentialIdSchema,
  agentId: agentIdSchema,
  /**
   * Which tenant this credential was issued for. Added in schema version 2
   * (T39) precisely because `agentId` alone does not scope it: before F4
   * wires a distinct Stellar identity per tenant, every tenant's credential
   * names the same shared `agentId` (`C-33`), so finding "the credential for
   * this tenant" needs its own column, not a join through the agent.
   */
  tenantId: tenantIdSchema,
  /** `sha256(compact JWS)`, hex — the value anchored in `agent_registry`. */
  credentialHash: z.string().regex(/^[0-9a-f]{64}$/),
  issuerDid: stellarDidSchema,
  principalDid: stellarDidSchema,
  jws: z.string().min(1),
  validFrom: z.date(),
  validUntil: z.date(),
  anchorTx: z.string().min(1),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});

export const mandateRecordSchema = z.strictObject({
  id: mandateIdSchema,
  tenantId: tenantIdSchema,
  agentId: agentIdSchema,
  principalId: principalIdSchema,
  mandateHash: z.string().regex(/^[0-9a-f]{64}$/),
  signatureKind: mandateSignatureKindSchema,
  /**
   * The `AgentPayMandate` exactly as it was signed. Typed as an object here
   * rather than re-validated against the mandate schema: `@agentpey/mandate`
   * owns that shape, and this package deliberately does not depend on it —
   * storing a document is not the same job as deciding it is valid.
   */
  document: z.record(z.string(), z.unknown()),
  /** SEP-0053 signature, for a wallet-signed mandate. */
  signature: z.string().nullable(),
  /** Compact JWS, for a platform-signed mandate. */
  jws: z.string().nullable(),
  validFrom: z.date(),
  validUntil: z.date(),
  anchorTx: z.string().min(1),
  /** The mandate this one renews, if any — a renewal never creates an agent. */
  supersedesId: mandateIdSchema.nullable(),
  revokedAt: z.date().nullable(),
  revokeTx: z.string().nullable(),
  createdAt: z.date(),
});

/**
 * A partner's hosted-consent invitation (T51): a proposed grant, waiting for
 * a principal to sign it into a real Mandate. `expiresAt` is the
 * invitation's own window — separate from `validUntil`, the window the
 * *resulting Mandate* would carry once signed. `grant` is `json`, same
 * reasoning as `mandateRecordSchema.document` (`C-5`): nothing hashes this
 * value, but nothing benefits from Postgres reordering it either, since
 * `GET /v1/consent_sessions/{id}` hands it back exactly as stored.
 */
export const consentSessionRecordSchema = z.strictObject({
  id: consentSessionIdSchema,
  tenantId: tenantIdSchema,
  status: consentSessionStatusSchema,
  /**
   * The `MandateGrant` the partner proposed. Typed as an object, not
   * re-validated against `@agentpey/mandate`'s schema, for the same reason
   * `mandateRecordSchema.document` is: this package stores documents, it
   * does not judge them.
   */
  grant: z.record(z.string(), z.unknown()),
  validFrom: z.date(),
  validUntil: z.date(),
  /**
   * Where the principal is sent after signing (T81), or `null`.
   *
   * Stored already validated: `requireAllowedReturnUrl` runs against the
   * partner's registered origins before this row is written, so whatever
   * renders the redirect can trust it without re-deriving the allowlist.
   */
  returnUrl: z.string().nullable(),
  /** Set once a principal signs — the Mandate this consent session produced. */
  mandateId: mandateIdSchema.nullable(),
  createdAt: z.date(),
  expiresAt: z.date(),
});

/**
 * One purchase a partner asked for, and what happened — settled or refused
 * (T75/F9).
 *
 * **A refusal is a row, not an absence.** `PILOTO-F9.md` §6 requires that a
 * person can see their rejected attempts with an understandable reason, and
 * §7 requires every acceptance case to leave durable evidence. A design that
 * only stored successes would make "why did my agent not buy this?"
 * unanswerable, which is the question a system like this most needs to
 * answer.
 *
 * The vault already records refusals the *authorisation* layers produced
 * (Fase 5). This table is not a duplicate of that: the vault records
 * decisions about intents, this records requests a partner made. They differ
 * exactly where it matters — a request refused before any intent existed (an
 * unregistered venue, a tenant with no mandate) leaves no vault record at
 * all, and those are precisely the refusals an integrator needs to see.
 */
export const purchaseRecordSchema = z.strictObject({
  id: purchaseIdSchema,
  tenantId: tenantIdSchema,
  /** `null` when the refusal happened before this tenant's agent was resolved. */
  agentId: agentIdSchema.nullable(),
  /**
   * The Mandate this purchase went through, whether the partner named it or
   * the platform chose it (T90). `null` when the refusal happened before a
   * Mandate was resolved, and for every row written before schema version 9.
   */
  mandateId: mandateIdSchema.nullable(),
  /** Which partner asked, so a purchase can never be read across the boundary. */
  partnerId: partnerIdSchema,
  outcome: z.enum(["settled", "refused"]),
  /** The typed `AgentPassError` code of whichever layer refused. `null` when settled. */
  code: z.string().nullable(),
  reason: z.string().nullable(),
  venue: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().min(1),
  intentId: z.string().nullable(),
  total: z.string().nullable(),
  asset: z.string().nullable(),
  payTo: z.string().nullable(),
  transactionHash: z.string().nullable(),
  /** What the merchant released, as it released it. `json`, same `C-5` reasoning. */
  delivery: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
});

/**
 * A cached `/v1` response, keyed by `(partnerId, key)` — the storage side of
 * `@agentpey/partner-api`'s `resolveIdempotency`. Field names match that
 * package's own `IdempotencyRecord` exactly (not imported — the dependency
 * runs the other way, `partner-api` depends on `directory`), so
 * `findIdempotentResponse` can be passed straight in as `resolveIdempotency`'s
 * `lookup` without any conversion at the call site.
 */
export const idempotencyRecordSchema = z.strictObject({
  partnerId: partnerIdSchema,
  key: z.string().min(1).max(255),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  responseStatus: z.number().int().min(200).max(599),
  responseBody: z.unknown(),
  createdAt: z.date(),
});

export type Partner = z.infer<typeof partnerSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type Tenant = z.infer<typeof tenantSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type PrincipalBinding = z.infer<typeof principalBindingSchema>;
export type AgentInstance = z.infer<typeof agentInstanceSchema>;
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;
export type MandateRecord = z.infer<typeof mandateRecordSchema>;
export type PartnerStatus = z.infer<typeof partnerStatusSchema>;
export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type OnchainState = z.infer<typeof onchainStateSchema>;
export type MandateSignatureKind = z.infer<typeof mandateSignatureKindSchema>;
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
export type ConsentSessionRecord = z.infer<typeof consentSessionRecordSchema>;
export type ConsentSessionStatus = z.infer<typeof consentSessionStatusSchema>;
export type PurchaseRecord = z.infer<typeof purchaseRecordSchema>;

// ---- webhooks (T94) ---------------------------------------------------------

/**
 * Where a partner asked for events to be sent.
 *
 * `secret` is deliberately **not** on this record. The plaintext exists in the
 * table, because every delivery has to be signed with it, but it leaves the
 * directory only through `createWebhookEndpoint`'s own return value — once, on
 * the call that minted it — and through the drain, which needs it to sign.
 * Nothing that merely *lists* endpoints ever carries it.
 */
export const webhookEndpointSchema = z.strictObject({
  id: webhookEndpointIdSchema,
  partnerId: partnerIdSchema,
  url: z.url(),
  events: z.array(z.string().min(1)).min(1),
  createdAt: z.date(),
  /** Soft-deleted, never removed: a delivery row references it. */
  deletedAt: z.date().nullable(),
});

export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/**
 * One event owed to one endpoint.
 *
 * Carries `secret` and `url` because the drain reads them together with the
 * payload — one query rather than a lookup per delivery — and because an
 * endpoint deleted after the event was queued must not change where that
 * event was destined.
 */
export const dueWebhookDeliverySchema = z.strictObject({
  /** `<event id>:<endpoint id>` — internal, and never crosses the `/v1` boundary. */
  id: z.string().min(1),
  endpointId: webhookEndpointIdSchema,
  partnerId: partnerIdSchema,
  url: z.url(),
  secret: z.string().min(1),
  /** The event as it goes on the wire: `{ id, type, created_at, data }`. */
  event: z.strictObject({
    id: z.string().min(1),
    type: z.string().min(1),
    created_at: z.iso.datetime(),
    data: z.record(z.string(), z.unknown()),
  }),
  attempts: z.number().int().min(0),
});

export type DueWebhookDelivery = z.infer<typeof dueWebhookDeliverySchema>;
