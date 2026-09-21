/**
 * The half of webhooks that actually sends them — T94.
 *
 * `@agentpey/webhooks` (T48) has been able to sign and POST an event since the
 * day it was written, and nothing ever called it: no `package.json` in this
 * repo depended on it. `directory_webhook_deliveries` (schema version 10) is
 * now filled by the same statements that record a Mandate, revoke one, or
 * write a purchase. This is what empties it.
 *
 * **Why an outbox and not a call at the point of change.** Sending inside the
 * request that caused the change would put a partner's slow endpoint on the
 * hot path of a purchase, and would lose the event outright if the process
 * died between the commit and the POST. Writing the row in the same statement
 * as the change and sending later means the event exists exactly when the
 * change does — and survives a restart, which is the property the pilot's host
 * takes away roughly whenever it feels like it.
 *
 * **One attempt per pass.** `deliverWebhook` can retry in-process, and this
 * deliberately does not use that: its retries live in memory and block, so a
 * restart loses them and five slow endpoints hold each other up. The retry
 * state belongs in the row (`attempts`, `next_attempt_at`), where it survives
 * anything.
 */
import { AgentPassError, isAgentPassError } from "@agentpass/core";
import type { DueWebhookDelivery } from "@agentpey/directory";
import { assertWebhookUrlResolvesPublicly, webhookEventSchema, type ResolveHost } from "@agentpey/partner-api";
import { deliverWebhook } from "@agentpey/webhooks";

/**
 * How many times an event is attempted before it is given up on.
 *
 * Six attempts with the backoff below spans a little over two hours
 * (1 + 3 + 9 + 27 + 81 minutes between them), which covers a partner's
 * ordinary deploy or restart without holding a dead endpoint's events
 * forever.
 */
export const MAX_WEBHOOK_ATTEMPTS = 6;

/** How many deliveries one pass takes. Small: a pass runs often and a partner's endpoint is not ours to hammer. */
export const WEBHOOK_DRAIN_BATCH = 20;

/**
 * Backoff after `attempts` failed attempts, in milliseconds: 1, 3, 9, 27, 81
 * and then 135 minutes, where the cap bites. Deliberately longer than the
 * two-minute lease
 * `claimDueWebhookDeliveries` takes, so the lease only ever governs a drain
 * that died mid-delivery — never the ordinary retry schedule.
 */
export function webhookBackoffMs(attempts: number): number {
  const minutes = Math.min(1 * 3 ** Math.max(attempts - 1, 0), 135);
  return minutes * 60_000;
}

/** The slice of `Directory` a drain touches. Read plus exactly three writes, none of which can change a decision. */
export interface WebhookDrainDirectory {
  claimDueWebhookDeliveries(limit: number, now?: Date): Promise<readonly DueWebhookDelivery[]>;
  markWebhookDelivered(id: string, at?: Date): Promise<void>;
  markWebhookFailed(input: {
    readonly id: string;
    readonly lastError: string;
    readonly giveUp: boolean;
    readonly nextAttemptAt?: Date;
    readonly at?: Date;
  }): Promise<void>;
}

export interface WebhookDrainDeps {
  readonly directory: WebhookDrainDirectory;
  /** Resolves a hostname to addresses. Injected so a test needs no DNS. */
  readonly resolveHost: ResolveHost;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export interface WebhookDrainSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly gaveUp: number;
}

/**
 * Sends one delivery, or records why it could not be.
 *
 * The URL policy runs **here**, not only when the endpoint was registered: the
 * hostname belongs to the partner, who may repoint it at any moment, so the
 * question "does this name resolve somewhere we are willing to connect to?"
 * has to be asked at the moment of connecting. A name that has gone private is
 * treated as permanent — it is not a transient failure, and retrying it for
 * two hours would be two hours of this process probing its own network.
 */
async function deliverOne(deps: WebhookDrainDeps, due: DueWebhookDelivery): Promise<"delivered" | "retry" | "gave-up"> {
  const now = deps.now ?? (() => new Date());

  try {
    await assertWebhookUrlResolvesPublicly(new URL(due.url).hostname, deps.resolveHost);
  } catch (error) {
    await deps.directory.markWebhookFailed({
      id: due.id,
      lastError: isAgentPassError(error) ? `${error.code}: ${error.message}` : String(error),
      giveUp: true,
      at: now(),
    });
    return "gave-up";
  }

  // Parsed rather than passed through: the payload was built by SQL
  // (`json_build_object`), and this is the one place that can still catch a
  // row whose shape does not match the frozen event contract — before it is
  // signed and sent to a third party as if it did.
  const event = webhookEventSchema.parse(due.event);

  const result = await deliverWebhook({
    url: due.url,
    secret: due.secret,
    event,
    maxAttempts: 1,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  if (result.delivered) {
    await deps.directory.markWebhookDelivered(due.id, now());
    return "delivered";
  }

  // `due.attempts` already counts this one: the claim incremented it.
  const giveUp = !result.retryable || due.attempts >= MAX_WEBHOOK_ATTEMPTS;
  await deps.directory.markWebhookFailed({
    id: due.id,
    lastError: result.lastError,
    giveUp,
    ...(giveUp ? {} : { nextAttemptAt: new Date(now().getTime() + webhookBackoffMs(due.attempts)) }),
    at: now(),
  });
  return giveUp ? "gave-up" : "retry";
}

/**
 * One pass: claim what is due, try each once, record what happened.
 *
 * Deliveries run **sequentially**. A pass is small and frequent, and doing
 * them one at a time bounds how many outbound connections this process opens
 * on partners' behalf at once — which matters more here than pass latency,
 * because the destinations are chosen by someone else.
 *
 * Never throws for one delivery's sake: a partner whose endpoint is broken
 * must not stop the rest of the batch.
 */
export async function drainWebhooks(deps: WebhookDrainDeps): Promise<WebhookDrainSummary> {
  const now = deps.now ?? (() => new Date());
  const due = await deps.directory.claimDueWebhookDeliveries(deps.batchSize ?? WEBHOOK_DRAIN_BATCH, now());

  let delivered = 0;
  let retrying = 0;
  let gaveUp = 0;

  for (const delivery of due) {
    try {
      const outcome = await deliverOne(deps, delivery);
      if (outcome === "delivered") delivered += 1;
      if (outcome === "retry") retrying += 1;
      if (outcome === "gave-up") gaveUp += 1;
    } catch (error) {
      // Something this function did not anticipate — a malformed payload, the
      // directory refusing a write. The lease already pushed
      // `next_attempt_at` forward, so leaving the row alone is a retry, and
      // the batch goes on.
      retrying += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[webhooks] delivery ${delivery.id} failed unexpectedly: ${message}`);
    }
  }

  return { claimed: due.length, delivered, retrying, gaveUp };
}

/** Node's DNS, in the shape {@link assertWebhookUrlResolvesPublicly} wants. */
export async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import("node:dns/promises");
  try {
    const results = await lookup(hostname, { all: true });
    return results.map((result) => result.address);
  } catch (error) {
    throw new AgentPassError("WebhookUrlNotAllowed", "could not resolve that host", {
      cause: error,
      details: { host: hostname },
    });
  }
}
