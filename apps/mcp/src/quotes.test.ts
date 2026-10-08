import type { PurchaseIntent, UcpQuote, VenueId } from "@agentpey/agent";
import { describe, expect, it } from "vitest";

import { QuoteBook } from "./quotes.js";

const quote = { checkoutId: "chk_1" } as unknown as UcpQuote;
const intentUntil = (iso: string) => ({ expiresAt: iso }) as unknown as PurchaseIntent;
const venueId = "vitrinee-agentcommerce:GABC" as VenueId;

describe("QuoteBook (T128)", () => {
  it("pays a quote once: the second take finds nothing", () => {
    const book = new QuoteBook({ now: () => new Date("2026-10-03T12:00:00Z") });
    const entry = book.issue({ quote, venueId, intent: intentUntil("2026-10-03T12:15:00Z") });
    expect(book.take(entry.id)).toBe(entry);
    expect(() => book.take(entry.id)).toThrow(expect.objectContaining({ code: "QuoteNotFound" }));
  });

  it("refuses an unknown id", () => {
    expect(() => new QuoteBook().take("q_nope")).toThrow(expect.objectContaining({ code: "QuoteNotFound" }));
  });

  it("expires at its window, never later than its intent", () => {
    const clock = { now: new Date("2026-10-03T12:00:00Z") };
    const book = new QuoteBook({ ttlMs: 10 * 60_000, now: () => clock.now });
    const short = book.issue({ quote, venueId, intent: intentUntil("2026-10-03T12:05:00Z") });
    expect(short.expiresAt.toISOString()).toBe("2026-10-03T12:05:00.000Z");
    const long = book.issue({ quote, venueId, intent: intentUntil("2026-10-03T13:00:00Z") });
    expect(long.expiresAt.toISOString()).toBe("2026-10-03T12:10:00.000Z");
    clock.now = new Date("2026-10-03T12:10:00Z");
    expect(() => book.take(long.id)).toThrow(expect.objectContaining({ code: "QuoteExpired" }));
    // An expired quote is dropped, not left to be retried.
    expect(() => book.take(long.id)).toThrow(expect.objectContaining({ code: "QuoteNotFound" }));
  });

  it("keeps at most `max` quotes, dropping the oldest", () => {
    const book = new QuoteBook({ max: 2, now: () => new Date("2026-10-03T12:00:00Z") });
    const until = intentUntil("2026-10-03T12:15:00Z");
    const first = book.issue({ quote, venueId, intent: until });
    book.issue({ quote, venueId, intent: until });
    book.issue({ quote, venueId, intent: until });
    expect(book.size).toBe(2);
    expect(() => book.take(first.id)).toThrow(expect.objectContaining({ code: "QuoteNotFound" }));
  });

  it("tells onDrop about every quote that leaves unpaid, and never about one taken to be paid (T150 review)", async () => {
    const clock = { now: new Date("2026-10-03T12:00:00Z") };
    const dropped: Array<[string, string]> = [];
    const book = new QuoteBook({ max: 2, ttlMs: 60_000, now: () => clock.now, onDrop: (entry, reason) => void dropped.push([entry.id, reason]) });
    const until = intentUntil("2026-10-03T13:00:00Z");
    const paid = book.issue({ quote, venueId, intent: until });
    book.take(paid.id);
    const evicted = book.issue({ quote, venueId, intent: until });
    const kept = book.issue({ quote, venueId, intent: until });
    book.issue({ quote, venueId, intent: until });
    expect(dropped).toEqual([[evicted.id, "evicted"]]);

    clock.now = new Date("2026-10-03T12:01:00Z");
    expect(() => book.take(kept.id)).toThrow(expect.objectContaining({ code: "QuoteExpired" }));
    await book.sweep();
    expect(dropped.map(([, reason]) => reason)).toEqual(["evicted", "expired", "expired"]);
    expect(dropped.some(([id]) => id === paid.id)).toBe(false);
  });

  it("waits for onDrop when sweeping, so a reservation is back before the next decision", async () => {
    const clock = { now: new Date("2026-10-03T12:00:00Z") };
    let released = false;
    const book = new QuoteBook({
      ttlMs: 1000,
      now: () => clock.now,
      onDrop: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        released = true;
      },
    });
    book.issue({ quote, venueId, intent: intentUntil("2026-10-03T13:00:00Z") });
    clock.now = new Date("2026-10-03T12:00:02Z");
    await book.sweep();
    expect(released).toBe(true);
  });
});

