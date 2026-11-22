import { describe, expect, it } from "vitest";

import { deadline, nightSummary, policyTargets, retryBusy } from "./noche.js";

describe("the night shift's store list", () => {
  const now = new Date("2026-11-22T04:00:00Z");
  const c = (id: string, products: number, triedAt?: string) => ({ id, products, triedAt });

  it("takes stores never tried first, catalogue stores before the rest and bigger ones first", () => {
    const out = policyTargets([c("a", 0), c("b", 50), c("c", 900), c("d", 10, "2026-10-01T00:00:00Z")], now, 30);
    expect(out.map((x) => x.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("skips stores tried within the last days, whatever the result was", () => {
    const out = policyTargets([c("recent", 100, "2026-11-20T00:00:00Z"), c("old", 100, "2026-10-01T00:00:00Z")], now, 30);
    expect(out.map((x) => x.id)).toEqual(["old"]);
  });

  it("stops at --max", () => {
    expect(policyTargets([c("a", 3), c("b", 2), c("c", 1)], now, 30, 2).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("the stop hour", () => {
  it("is later the same day, or the next morning when the hour has passed", () => {
    const evening = new Date(2026, 10, 22, 23, 0);
    expect(deadline(evening, "06:30")).toEqual(new Date(2026, 10, 23, 6, 30));
    const night = new Date(2026, 10, 23, 0, 30);
    expect(deadline(night, "06:30")).toEqual(new Date(2026, 10, 23, 6, 30));
  });

  it("refuses a malformed hour instead of running without one", () => {
    expect(deadline(new Date(), "25:00")).toBeUndefined();
    expect(deadline(new Date(), "6.30")).toBeUndefined();
  });
});

describe("the night's summary", () => {
  it("says how long it ran, how many Claude calls per hour and why it stopped", () => {
    const s = nightSummary({ start: new Date("2026-11-22T03:00:00Z"), end: new Date("2026-11-22T05:00:00Z"), tried: 50, saved: 40, empty: 8, failed: 2, calls: 42, reason: "límite del plan", detail: "claude -p: You've hit your limit" });
    expect(s).toContain("120 min");
    expect(s).toContain("40 con política guardada");
    expect(s).toContain("21.0 por hora");
    expect(s).toContain("se detuvo por: límite del plan (claude -p: You've hit your limit)");
  });
});

describe("a write while the database is busy", () => {
  it("waits and tries again, then gives up after the last try", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const out = await retryBusy(() => {
      if (++calls < 3) throw new Error("database is locked");
      return "ok";
    }, 5, 100, sleep);
    expect(out).toBe("ok");
    expect(waits).toEqual([100, 100]);
    await expect(retryBusy(() => { throw new Error("SQLITE_BUSY"); }, 2, 1, sleep)).rejects.toThrow("SQLITE_BUSY");
  });

  it("does not retry any other error", async () => {
    let calls = 0;
    await expect(retryBusy(() => { calls++; throw new Error("no such table"); }, 5, 1, async () => {})).rejects.toThrow("no such table");
    expect(calls).toBe(1);
  });
});
