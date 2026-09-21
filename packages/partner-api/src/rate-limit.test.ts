import { AgentPassError, hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import {
  RATE_LIMITS,
  enforceRateLimit,
  rateLimitHeaders,
  tierForScope,
  windowStartFor,
  type RateLimiter,
} from "./rate-limit.js";
import { API_SCOPES } from "./scopes.js";

const NOW = new Date("2026-09-20T12:00:30.000Z");

/** A limiter whose counter always answers `count`. */
function counting(count: number): RateLimiter {
  return { count: async () => count, now: () => NOW };
}

describe("tierForScope", () => {
  it("puts the three scopes that cost something real in the tight bucket", () => {
    // A Stellar transaction and testnet USDC, a signable invitation, and an
    // outbound connection to an address the partner chose.
    expect(tierForScope("payments:authorize")).toBe("costly");
    expect(tierForScope("consent_sessions:write")).toBe("costly");
    expect(tierForScope("webhooks:write")).toBe("costly");
  });

  it("puts everything else in the standard bucket, including the preview that spends nothing", () => {
    for (const scope of API_SCOPES.filter(
      (s) => !["payments:authorize", "consent_sessions:write", "webhooks:write"].includes(s),
    )) {
      expect(tierForScope(scope), scope).toBe("standard");
    }
  });

  it("has a tier for every scope there is — a new permission cannot fall through", () => {
    for (const scope of API_SCOPES) {
      expect(["standard", "costly"]).toContain(tierForScope(scope));
    }
  });
});

describe("windowStartFor", () => {
  it("is the same minute for every instant inside it, on every process", () => {
    expect(windowStartFor(new Date("2026-09-20T12:00:00.000Z"))).toEqual(new Date("2026-09-20T12:00:00.000Z"));
    expect(windowStartFor(new Date("2026-09-20T12:00:59.999Z"))).toEqual(new Date("2026-09-20T12:00:00.000Z"));
    expect(windowStartFor(new Date("2026-09-20T12:01:00.000Z"))).toEqual(new Date("2026-09-20T12:01:00.000Z"));
  });
});

describe("enforceRateLimit", () => {
  it("lets a request at the limit through", async () => {
    await expect(enforceRateLimit(counting(RATE_LIMITS.costly), "apk_1", "payments:authorize")).resolves.toBeUndefined();
    await expect(enforceRateLimit(counting(RATE_LIMITS.standard), "apk_1", "tenants:read")).resolves.toBeUndefined();
  });

  it("refuses the first request over it, with what a caller needs to back off", async () => {
    try {
      await enforceRateLimit(counting(RATE_LIMITS.costly + 1), "apk_1", "payments:authorize");
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(hasErrorCode(error, "RateLimited")).toBe(true);
      expect((error as AgentPassError).details).toEqual({
        tier: "costly",
        limit: 10,
        resetAt: "2026-09-20T12:01:00.000Z",
        // 30 s into the window, so 30 s until it resets.
        retryAfterSeconds: 30,
      });
    }
  });

  it("counts against the tier the scope implies, not a flat limit", async () => {
    // 11 standard requests in a minute is nothing; 11 purchases is a loop.
    await expect(enforceRateLimit(counting(11), "apk_1", "tenants:read")).resolves.toBeUndefined();
    await expect(enforceRateLimit(counting(11), "apk_1", "payments:authorize")).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "RateLimited"),
    );
  });

  it("counts each key separately, under the tier the scope names", async () => {
    const seen: Array<{ apiKeyId: string; tier: string; windowStart: Date }> = [];
    const limiter: RateLimiter = {
      count: async (input) => {
        seen.push({ ...input });
        return 1;
      },
      now: () => NOW,
    };
    await enforceRateLimit(limiter, "apk_a", "payments:authorize");
    await enforceRateLimit(limiter, "apk_b", "tenants:read");
    expect(seen).toEqual([
      { apiKeyId: "apk_a", tier: "costly", windowStart: new Date("2026-09-20T12:00:00.000Z") },
      { apiKeyId: "apk_b", tier: "standard", windowStart: new Date("2026-09-20T12:00:00.000Z") },
    ]);
  });

  it("never tells a client to retry immediately into the same window", async () => {
    // One millisecond before the reset still rounds up to a whole second.
    const limiter: RateLimiter = { count: async () => 99, now: () => new Date("2026-09-20T12:00:59.999Z") };
    try {
      await enforceRateLimit(limiter, "apk_1", "payments:authorize");
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as AgentPassError).details.retryAfterSeconds).toBe(1);
    }
  });

  describe("when the counter itself fails", () => {
    const broken: RateLimiter = {
      count: async () => {
        throw new Error("postgres is down");
      },
      now: () => NOW,
    };

    it("refuses a costly route rather than let a purchase through uncounted", async () => {
      await expect(enforceRateLimit(broken, "apk_1", "payments:authorize")).rejects.toSatisfy((error: unknown) =>
        hasErrorCode(error, "RateLimiterUnavailable"),
      );
      await expect(enforceRateLimit(broken, "apk_1", "webhooks:write")).rejects.toSatisfy((error: unknown) =>
        hasErrorCode(error, "RateLimiterUnavailable"),
      );
    });

    it("lets a standard route through, so a broken limiter does not take down every read", async () => {
      await expect(enforceRateLimit(broken, "apk_1", "tenants:read")).resolves.toBeUndefined();
      await expect(enforceRateLimit(broken, "apk_1", "payments:preview")).resolves.toBeUndefined();
    });
  });
});

describe("rateLimitHeaders", () => {
  it("carries Retry-After and the RateLimit trio, from the error's own details", () => {
    const error = new AgentPassError("RateLimited", "x", {
      details: { tier: "costly", limit: 10, resetAt: "2026-09-20T12:01:00.000Z", retryAfterSeconds: 30 },
    });
    expect(rateLimitHeaders(error)).toEqual({
      "retry-after": "30",
      "ratelimit-limit": "10",
      "ratelimit-remaining": "0",
      "ratelimit-reset": "30",
      "x-ratelimit-reset-at": "2026-09-20T12:01:00.000Z",
    });
  });
});
