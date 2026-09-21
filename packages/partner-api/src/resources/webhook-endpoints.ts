/**
 * `POST`, `GET` and `DELETE /v1/webhook_endpoints` — where a partner says
 * where to send events, T94.
 *
 * Until this milestone the only way to learn that a principal had signed, or
 * that a purchase had settled, was to poll `/v1/consent_sessions/{id}` and
 * `/v1/purchases/{id}`. `@agentpey/webhooks` (T48) could already deliver and
 * sign an event; `webhooks.ts` next door already froze the event names and the
 * signature header. What was missing was both ends: somewhere to register a
 * URL, and something that creates an event.
 *
 * **The events are thin, and that is a decision, not an omission.** An event
 * carries the ids of what changed and nothing else; the partner reads the
 * resource itself through `/v1` with its own key. Two reasons, in order of
 * weight: a delivery that goes astray — a stale endpoint, a partner's own
 * misrouting — leaks only identifiers, never a Mandate's terms or a delivery's
 * artifact URL; and the resource a partner reads back is the current one,
 * rather than whatever was true at the instant the event was queued.
 */
import { agentIdSchema, mandateIdSchema, purchaseIdSchema, tenantIdSchema, webhookEndpointIdSchema } from "@agentpey/directory";
import { z } from "zod";

import { deliverableWebhookEventTypeSchema } from "../webhooks.js";

export { webhookEndpointIdSchema };

export const createWebhookEndpointRequestSchema = z.strictObject({
  /**
   * Where to POST. Checked for shape here, and again — by re-resolving the
   * host — every time an event is actually sent (`webhook-url.ts`).
   */
  url: z.url().max(2048),
  /**
   * Which events this endpoint wants. At least one, and only names something
   * actually emits: subscribing to a name that can never fire looks wired
   * when it is not.
   */
  events: z.array(deliverableWebhookEventTypeSchema).min(1),
});

export type CreateWebhookEndpointRequest = z.infer<typeof createWebhookEndpointRequestSchema>;

export const webhookEndpointResourceSchema = z.strictObject({
  id: webhookEndpointIdSchema,
  url: z.url(),
  events: z.array(deliverableWebhookEventTypeSchema),
  created_at: z.iso.datetime(),
  /**
   * The signing secret, **and only on the response that creates it**.
   *
   * `null` on every later read, exactly like an API key: a partner that loses
   * it registers a new endpoint rather than asking for it back. The difference
   * from an API key is that this one is stored recoverably, because every
   * delivery has to be signed with it — see the note on
   * `directory_webhook_endpoints` for why that is forced rather than chosen.
   */
  secret: z.string().min(1).nullable(),
});

export type WebhookEndpointResource = z.infer<typeof webhookEndpointResourceSchema>;

/**
 * What `mandate.activated` and `mandate.revoked` carry.
 *
 * `agent_id` is here and the Mandate's terms are not, on purpose: knowing
 * *which* agent's consent changed is what lets a partner route the event
 * without a round trip, while the terms are exactly the part that should not
 * travel.
 */
export const mandateEventDataSchema = z.strictObject({
  mandate_id: mandateIdSchema,
  tenant_id: tenantIdSchema,
  agent_id: agentIdSchema,
});

/**
 * What `payment.settled` and `payment.refused` carry.
 *
 * The outcome is duplicated into the event type *and* left out of the body:
 * the type already says which of the two it is, and a body that repeated it
 * would be one more thing that could disagree with itself.
 */
export const paymentEventDataSchema = z.strictObject({
  purchase_id: purchaseIdSchema,
  tenant_id: tenantIdSchema,
});
