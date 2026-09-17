/**
 * `/v1/consent_sessions` — the hosted flow `PLATAFORMA-PARTNERS.md` §2.5/§3
 * describes: a partner proposes a grant, gets back a `consent_url`, redirects
 * the principal there to connect a wallet and sign the Mandate, and polls or
 * gets a webhook when it resolves.
 *
 * T45 froze the request/response shape before `@agentpey/directory` had a
 * `consent_sessions` table at all — `consentSessionIdSchema` and
 * `consentSessionStatusSchema` were hand-rolled here for that reason.
 * T51 gives the table a home, so this file now imports both from
 * `@agentpey/directory` instead (same pattern `tenants.ts`/`agents.ts`
 * already use) and adds the mapping from a stored record to the public
 * resource — the piece T45's own doc comment had explicitly left for
 * "whichever ticket builds the route".
 *
 * The proposed grant is `@agentpey/mandate`'s `mandateGrantSchema` rather than
 * a re-description of `actions`/`venues`/`assets`/`limits`/`payTo`: a consent
 * session is proposing exactly the grant a Mandate will carry, and a second
 * definition of the same shape is a second place for the two to drift apart.
 *
 * One difference, on purpose (`C-123`): here `payTo` is required with at least
 * one payee. Without it `reconcileTerms` skips the payee check, so the agent
 * could pay whatever account a 402 names. The Mandate document keeps `payTo`
 * optional, so Mandates already signed without it still verify.
 */
import { consentSessionIdSchema, consentSessionStatusSchema, tenantIdSchema, mandateIdSchema, type ConsentSessionRecord } from "@agentpey/directory";
import { mandateGrantSchema } from "@agentpey/mandate";
import { z } from "zod";

export { consentSessionIdSchema, consentSessionStatusSchema };
export type ConsentSessionStatus = z.infer<typeof consentSessionStatusSchema>;

const proposedGrantSchema = mandateGrantSchema.extend({
  payTo: mandateGrantSchema.shape.payTo.unwrap().min(1),
});

export const createConsentSessionRequestSchema = z.strictObject({
  tenant_id: tenantIdSchema,
  grant: proposedGrantSchema,
  /** Defaults to now, same as `@agentpey/mandate`'s `createMandate`. */
  valid_from: z.iso.datetime().optional(),
  valid_until: z.iso.datetime(),
  /**
   * Where to send the principal once they have signed (T81).
   *
   * Only a URL whose **origin** the partner registered in advance is accepted,
   * and the check runs here, when the session is created — see
   * `return-urls.ts` for why it is an allowlist and not a parameter. A shape
   * check is all this schema does; the allowlist lives with the partner's own
   * data and is applied by the route.
   */
  return_url: z.url().max(2048).optional(),
});

export type CreateConsentSessionRequest = z.infer<typeof createConsentSessionRequestSchema>;

export const consentSessionResourceSchema = z.strictObject({
  id: consentSessionIdSchema,
  tenant_id: tenantIdSchema,
  status: consentSessionStatusSchema,
  /** The page to redirect the principal to. Present only while `"pending"`. */
  consent_url: z.url().nullable(),
  /** Where the principal is sent after signing, if the partner asked for one and it was allowed. */
  return_url: z.url().nullable(),
  /** Set once the principal signs and the Mandate is anchored. */
  mandate_id: mandateIdSchema.nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});

export type ConsentSessionResource = z.infer<typeof consentSessionResourceSchema>;

/**
 * `directory_consent_sessions` never stores `"expired"` — same posture as a
 * mandate's status (`computeMandateStatus`): a stored `"completed"` is
 * permanent, but `"pending"` is only true until `expiresAt` passes, and
 * nothing needs to write that transition, only compute it at read time.
 */
export function computeConsentSessionStatus(
  session: Pick<ConsentSessionRecord, "status" | "expiresAt">,
  now: Date,
): ConsentSessionStatus {
  if (session.status !== "pending") return session.status;
  return now > session.expiresAt ? "expired" : "pending";
}

/**
 * `consentUrl` is supplied by the caller, not derived here: it depends on
 * `apps/web`'s own base URL, which this transport-agnostic package has no
 * business knowing. It is only ever shown while the session is still
 * `"pending"` — a completed, expired, or cancelled invitation has nothing
 * left to redirect anyone to.
 */
export function toConsentSessionResource(
  session: ConsentSessionRecord,
  now: Date,
  consentUrl: string,
): ConsentSessionResource {
  const status = computeConsentSessionStatus(session, now);
  return consentSessionResourceSchema.parse({
    id: session.id,
    tenant_id: session.tenantId,
    status,
    consent_url: status === "pending" ? consentUrl : null,
    return_url: session.returnUrl,
    mandate_id: session.mandateId,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  });
}
