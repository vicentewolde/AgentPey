/**
 * How many `/v1` requests an API key may make — T95.
 *
 * `perDay` has always limited what one Mandate may spend. Nothing limited how
 * often a partner could *ask*: an integration bug that called
 * `POST /v1/purchases` in a loop would have spent the shared rail's testnet
 * USDC one Stellar transaction at a time, on a single Render Starter instance,
 * until something ran out. And since T94 there is a route whose effect is to
 * make this process open outbound connections on a partner's behalf.
 *
 * **The tier follows from the permission, not from a list of paths.** A route
 * that demands `payments:authorize`, `consent_sessions:write` or
 * `webhooks:write` is one that spends money, creates a signable invitation, or
 * points this process's network somewhere; it gets the tight bucket. Deriving
 * it from the scope means a route added later cannot land in the wrong tier by
 * someone forgetting to list it — its tier is whatever the permission it
 * already has to name says it is.
 *
 * **A fixed one-minute window, counted in Postgres.** In memory would not
 * survive two processes, which is the lesson `perDay` taught in F8 (T64). A
 * token bucket would be smoother and needs more state per key. The cost of the
 * fixed window, said plainly: right at the boundary between two windows, a
 * key can spend both budgets back to back, so a burst of up to twice the
 * limit can land in a short span. For a pilot's abuse brake that is fine; it
 * is not a precise meter.
 */
import { AgentPassError } from "@agentpass/core";

import type { ApiScope } from "./scopes.js";

export type RateLimitTier = "standard" | "costly";

/** Requests per window, per API key, per tier. Chosen with the user (T95). */
export const RATE_LIMITS: Readonly<Record<RateLimitTier, number>> = {
  // RealOps, the only real partner, makes a handful of calls per thing a
  // person does. 120 a minute leaves room for several people at once.
  standard: 120,
  // Far above what a person can trigger by hand, and low enough to stop a
  // loop before it drains the shared rail.
  costly: 10,
};

export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * The scopes whose routes cost something real: a Stellar transaction and
 * testnet USDC, a signable invitation to a person, or an outbound connection
 * to an address the partner chose.
 */
const COSTLY_SCOPES: ReadonlySet<ApiScope> = new Set(["payments:authorize", "consent_sessions:write", "webhooks:write"]);

export function tierForScope(scope: ApiScope): RateLimitTier {
  return COSTLY_SCOPES.has(scope) ? "costly" : "standard";
}

/** The start of the window `at` falls in. Every process computes the same one. */
export function windowStartFor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS);
}

/**
 * Counts one request against `(apiKeyId, tier, windowStart)` and returns the
 * count **including** it. Must be atomic across processes — the Postgres
 * implementation is a single upsert.
 */
export type CountRequest = (input: {
  readonly apiKeyId: string;
  readonly tier: RateLimitTier;
  readonly windowStart: Date;
}) => Promise<number>;

export interface RateLimiter {
  readonly count: CountRequest;
  readonly now?: () => Date;
}

/**
 * Counts this request and refuses it if it is over the tier's limit.
 *
 * **When the counter itself fails, the tier decides** (chosen with the user,
 * T95). A costly route refuses: a purchase does not go through uncounted,
 * because that is the route that moves money. A standard route proceeds: a
 * broken limiter should not take down every read in `/v1`. In practice this
 * rarely happens on its own — the counter lives in the same database
 * `authenticate` just read from — but "rarely" is not a policy.
 *
 * @throws AgentPassError `RateLimited` over the limit, carrying what a caller
 * needs to back off.
 * @throws AgentPassError `RateLimiterUnavailable` when a costly route's
 * counter cannot be read.
 */
export async function enforceRateLimit(limiter: RateLimiter, apiKeyId: string, scope: ApiScope): Promise<void> {
  const tier = tierForScope(scope);
  const now = (limiter.now ?? (() => new Date()))();
  const windowStart = windowStartFor(now);

  let count: number;
  try {
    count = await limiter.count({ apiKeyId, tier, windowStart });
  } catch (error) {
    if (tier === "standard") return;
    throw new AgentPassError(
      "RateLimiterUnavailable",
      "could not count this request, so a route that spends or connects out is refused rather than let through uncounted",
      { cause: error, details: { tier } },
    );
  }

  const limit = RATE_LIMITS[tier];
  if (count <= limit) return;

  const resetAt = new Date(windowStart.getTime() + RATE_LIMIT_WINDOW_MS);
  throw new AgentPassError("RateLimited", `this api key made more than ${limit} ${tier} requests in a minute`, {
    details: {
      tier,
      limit,
      resetAt: resetAt.toISOString(),
      // Whole seconds, rounded up: `Retry-After: 0` would invite an immediate
      // retry into the same window.
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
    },
  });
}

/**
 * The response headers for a `429` — `Retry-After`, and the IETF draft's
 * `RateLimit-*` trio.
 *
 * Only on the `429`, not on every response. Emitting them on success would
 * mean threading the count back out of `authorizeRequest` through every
 * handler; the header a client actually needs to back off correctly is
 * `Retry-After`, and it arrives exactly when it is needed.
 */
export function rateLimitHeaders(error: AgentPassError): Readonly<Record<string, string>> {
  const { limit, resetAt, retryAfterSeconds } = error.details as {
    limit?: number;
    resetAt?: string;
    retryAfterSeconds?: number;
  };
  const headers: Record<string, string> = {};
  if (retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(retryAfterSeconds);
    headers["ratelimit-reset"] = String(retryAfterSeconds);
  }
  if (limit !== undefined) {
    headers["ratelimit-limit"] = String(limit);
    headers["ratelimit-remaining"] = "0";
  }
  if (resetAt !== undefined) headers["x-ratelimit-reset-at"] = resetAt;
  return headers;
}
