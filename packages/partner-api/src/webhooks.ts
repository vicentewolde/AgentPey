/**
 * The webhook contract: event names, the envelope every event ships in, and
 * the signing scheme — `PLATAFORMA-PARTNERS.md` §2.7's "firmados con secreto
 * por endpoint, con timestamp y ventana de replay de cinco minutos", made
 * concrete. Published now, ahead of T49, specifically to unblock T48: that
 * ticket builds the *delivery* worker (POST, backoff, retries), and needs a
 * shape and a signature to deliver — it does not need, and this file does
 * not define, *when* a given event fires. That decision stays wherever the
 * mandate/payment logic that would trigger it lives (T49 or later), per
 * `PLATAFORMA-PARTNERS.md` § 6.1: Codex builds the mechanical *how*, never
 * the *when* of something this security-relevant.
 *
 * `data` is deliberately `z.record(z.string(), z.unknown())` rather than a
 * per-event schema: `mandate.*` events could be typed today against
 * `mandateResourceSchema`, but `payment.*` events describe a resource F7
 * (generic commerce) has not designed yet. Freezing four of seven event
 * payloads now and leaving three as `unknown` would be a worse contract than
 * freezing the envelope and letting every payload firm up when the code that
 * emits it is built.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const WEBHOOK_EVENT_TYPES = [
  "mandate.activated",
  "mandate.revoked",
  "mandate.expiring",
  "payment.authorized",
  "payment.refused",
  "payment.settled",
  "agent.retired",
] as const;

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;

/**
 * The subset of {@link WEBHOOK_EVENT_TYPES} that something in this system
 * actually emits — T94.
 *
 * T45 froze seven names on the reasoning that the routes would arrive later.
 * Four of them now have exactly one write each that can fire them
 * (`recordMandate`, `revokeMandate`, and `createPurchase` for both outcomes).
 * The other three do not. `mandate.expiring` needs a sweep that notices a
 * window closing, and `agent.retired` needs a route that retires an agent —
 * neither exists. `payment.authorized` is different and more interesting: the
 * moment it would describe is real (`PolicyRail.authorise` granting), but it
 * happens mid-purchase, before the merchant's invoice is reconciled, so an
 * event fired there would announce purchases that then get refused at the
 * `402`. It stays unsubscribable until there is a reason to want it, rather
 * than being wired to the nearest plausible line.
 *
 * A partner may only subscribe to these four, and the reason is the one
 * `scopes.ts` already gives for not listing a permission no route checks: a
 * subscription that can never fire is worse than no subscription, because it
 * looks wired. An integrator who subscribes to `mandate.expiring` and builds a
 * renewal reminder on it would be waiting for a message this system has no
 * code to send.
 *
 * The frozen list above is untouched. When something emits `mandate.expiring`,
 * it moves here; nothing has to be renamed.
 */
export const DELIVERABLE_WEBHOOK_EVENT_TYPES = [
  "mandate.activated",
  "mandate.revoked",
  "payment.settled",
  "payment.refused",
] as const satisfies readonly WebhookEventType[];

export const deliverableWebhookEventTypeSchema = z.enum(DELIVERABLE_WEBHOOK_EVENT_TYPES);

export type DeliverableWebhookEventType = z.infer<typeof deliverableWebhookEventTypeSchema>;

export const webhookEventSchema = z.strictObject({
  id: z.string().min(1),
  type: webhookEventTypeSchema,
  created_at: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** Carries the signature; the timestamp is signed over, not carried separately, so a header cannot be swapped without invalidating it. */
export const WEBHOOK_SIGNATURE_HEADER = "agentpay-signature";

/** `PLATAFORMA-PARTNERS.md` §2.7: "ventana de replay de cinco minutos". */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * `AgentPay-Signature: t=<unix ms>,v1=<hex hmac>` — modelled on Stripe's
 * webhook header, a shape partner integrators are likely to already have
 * tooling for. `v1` signs `${t}.${rawBody}`, so a timestamp cannot be
 * replayed against a different signature or vice versa.
 */
export function signWebhookPayload(secret: string, timestampMs: number, rawBody: string): string {
  const signature = createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampMs},v1=${signature}`;
}

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "malformed-header" | "bad-signature" | "stale-timestamp" };

/**
 * Verifies a received webhook: the header parses, the HMAC matches, and the
 * timestamp is inside the replay window relative to `now`. All three must
 * hold — a valid signature over a five-minute-old timestamp is still a
 * replay, and a fresh timestamp with a wrong signature is still a forgery.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  now: number = Date.now(),
): WebhookVerification {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (match?.[1] === undefined || match[2] === undefined) return { ok: false, reason: "malformed-header" };

  const timestampMs = Number(match[1]);
  const expected = createHmac("sha256", secret).update(`${timestampMs}.${rawBody}`, "utf8").digest("hex");

  const provided = Buffer.from(match[2], "hex");
  const wanted = Buffer.from(expected, "hex");
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return { ok: false, reason: "bad-signature" };
  }

  if (Math.abs(now - timestampMs) > WEBHOOK_REPLAY_WINDOW_MS) return { ok: false, reason: "stale-timestamp" };

  return { ok: true };
}
