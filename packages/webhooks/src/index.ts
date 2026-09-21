/** Reliable delivery for webhook events already created by the caller. */
import { AgentPassError } from "@agentpass/core";
import {
  signWebhookPayload,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from "@agentpey/partner-api";

const DEFAULT_MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const JITTER_MAX_MS = 250;

export interface WebhookDeliveryInput {
  readonly url: string;
  readonly secret: string;
  /** This event is already validated by the caller. */
  readonly event: WebhookEvent;
  readonly maxAttempts?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface DeliveredWebhook {
  readonly delivered: true;
  readonly attempts: number;
  readonly status: number;
}

export interface FailedWebhookDelivery {
  readonly delivered: false;
  readonly attempts: number;
  readonly lastError: string;
  /**
   * Whether trying again could plausibly work — T94.
   *
   * T48 could leave this out because it retried in-process and the caller
   * only ever saw the final verdict. A durable outbox drains with
   * `maxAttempts: 1` and keeps the retry state itself, so it has to be told
   * *why* an attempt failed: a `5xx` or a timeout is worth another pass,
   * while a `4xx` means the endpoint read the request and rejected it, and
   * re-sending the same body to the same URL will be rejected the same way.
   */
  readonly retryable: boolean;
}

export type WebhookDeliveryResult = DeliveredWebhook | FailedWebhookDelivery;

export interface QueuedFailedDelivery extends FailedWebhookDelivery {
  readonly url: string;
  readonly event: WebhookEvent;
  readonly failedAt: string;
}

export interface FailedDeliveryQueue {
  deliver(input: WebhookDeliveryInput): Promise<WebhookDeliveryResult>;
  list(): readonly QueuedFailedDelivery[];
  clear(): void;
}

interface AttemptFailure {
  readonly retryable: boolean;
  readonly lastError: string;
}

function validateMaxAttempts(value: number | undefined): number {
  const maxAttempts = value ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new AgentPassError("InvalidArguments", "maxAttempts must be a positive integer");
  }
  return maxAttempts;
}

function backoffMs(completedAttempt: number): number {
  const exponentialDelay = Math.min(BACKOFF_BASE_MS * 2 ** (completedAttempt - 1), BACKOFF_MAX_MS);
  return exponentialDelay + Math.floor(Math.random() * (JITTER_MAX_MS + 1));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "unknown network error";
}

async function deliverAttempt(
  input: WebhookDeliveryInput,
  rawBody: string,
  fetchImpl: typeof fetch,
): Promise<Response | AttemptFailure> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const signature = signWebhookPayload(input.secret, Date.now(), rawBody);

  try {
    return await fetchImpl(input.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
      // A redirect is not followed, it is an error — T94. The URL policy
      // (`webhook-url.ts`) resolves the host and refuses private addresses
      // before this runs, and following a redirect would hand that decision
      // straight back to whoever answered: `200` from a public address, then
      // `302` to `169.254.169.254`. There is no legitimate reason for a
      // webhook receiver to redirect a POST it asked to receive.
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    return {
      retryable: true,
      lastError: controller.signal.aborted ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isAttemptFailure(value: Response | AttemptFailure): value is AttemptFailure {
  return "retryable" in value;
}

/** Delivers a pre-built event. It never decides whether an event should be emitted. */
export async function deliverWebhook(input: WebhookDeliveryInput): Promise<WebhookDeliveryResult> {
  const maxAttempts = validateMaxAttempts(input.maxAttempts);
  const fetchImpl = input.fetchImpl ?? fetch;
  const rawBody = JSON.stringify(input.event);
  let lastError = "delivery was not attempted";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await deliverAttempt(input, rawBody, fetchImpl);

    if (!isAttemptFailure(outcome)) {
      if (outcome.status >= 200 && outcome.status < 300) {
        return { delivered: true, attempts: attempt, status: outcome.status };
      }

      lastError = `HTTP ${outcome.status}`;
      // Anything below 500 that is not a success: the endpoint answered, and
      // answered no. Re-sending the identical body will get the identical
      // answer.
      if (outcome.status < 500) {
        return { delivered: false, attempts: attempt, lastError, retryable: false };
      }
    } else {
      lastError = outcome.lastError;
    }

    if (attempt < maxAttempts) await wait(backoffMs(attempt));
  }

  // Ran out of attempts against a `5xx`, a timeout or a network failure —
  // all of which are worth another pass from a caller that keeps its own
  // retry state.
  return { delivered: false, attempts: maxAttempts, lastError, retryable: true };
}

/** Creates an in-memory record of deliveries that exhausted the retry policy. */
export function createFailedDeliveryQueue(): FailedDeliveryQueue {
  const failedDeliveries: QueuedFailedDelivery[] = [];

  return {
    async deliver(input) {
      const result = await deliverWebhook(input);
      const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (!result.delivered && result.attempts === maxAttempts) {
        failedDeliveries.push({
          ...result,
          url: input.url,
          event: input.event,
          failedAt: new Date().toISOString(),
        });
      }
      return result;
    },
    list: () => [...failedDeliveries],
    clear: () => {
      failedDeliveries.length = 0;
    },
  };
}
