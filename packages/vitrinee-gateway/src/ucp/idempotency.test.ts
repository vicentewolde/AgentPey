import { describe, expect, it } from "vitest";

import { IdempotencyCache, MAX_BYTES, MAX_ENTRIES, requestHash } from "./idempotency.js";

describe("the Idempotency-Key memory (T131, VT-42)", () => {
  const at = { now: new Date("2026-10-03T12:00:00Z") };
  const now = () => at.now;

  it("replays the same request, refuses another under the same key, and forgets after a day", () => {
    const cache = new IdempotencyCache(now);
    const hash = requestHash("POST", "/ucp/v1/checkout-sessions", { a: 1 });
    cache.remember("k", hash, 201, { id: "cs_1" });
    expect(cache.lookup("k", hash)).toEqual({ kind: "replay", status: 201, body: { id: "cs_1" } });
    expect(cache.lookup("k", requestHash("POST", "/ucp/v1/checkout-sessions", { a: 2 }))).toEqual({ kind: "conflict" });
    at.now = new Date("2026-10-04T12:00:01Z");
    expect(cache.lookup("k", hash)).toEqual({ kind: "new" });
  });

  it("keeps at most MAX_ENTRIES answers, dropping the oldest", () => {
    const cache = new IdempotencyCache(now);
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) cache.remember(`k${i}`, "h", 201, { i });
    expect(cache.size).toBe(MAX_ENTRIES);
    expect(cache.lookup("k0", "h")).toEqual({ kind: "new" });
    expect(cache.lookup(`k${MAX_ENTRIES + 49}`, "h").kind).toBe("replay");
  });

  it("keeps at most MAX_BYTES of answers, however few, and never one larger than that", () => {
    const cache = new IdempotencyCache(now);
    const big = "x".repeat(Math.floor(MAX_BYTES / 4));
    for (let i = 0; i < 10; i += 1) cache.remember(`k${i}`, "h", 201, { big });
    expect(cache.totalBytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(cache.size).toBeLessThan(10);
    cache.remember("huge", "h", 201, { big: "x".repeat(MAX_BYTES + 1) });
    expect(cache.lookup("huge", "h")).toEqual({ kind: "new" });
  });
});
