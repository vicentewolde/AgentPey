import { describe, expect, it } from "vitest";

import { PayerGuard, parseBlockedPayers, parsePayerLimit } from "./payer-guard.js";

const A = "GD7O7GEOP4Y3YG4JHSGOH5FOBZGLZUZWRMADELTRNPC3IYYQ4H7CINQ7";
const B = "GBJDXLBZAZ3KCANJSPED6JJ7CQJ55FBNNJDRIOCBSS57JOKWVOSQVOUF";
const RAIL = "CANSQJH7KPQTBUXPA42BBWZGZRKLWQZUFVF3SLQOUWKHEX4L3JP7YEDA";

function guardAt(settings: ConstructorParameters<typeof PayerGuard>[0], start = 1_000_000, seed: { payer: string; at: number }[] = []) {
  let now = start;
  const guard = new PayerGuard(settings, () => now, seed);
  return { guard, advance: (ms: number) => void (now += ms) };
}

describe("PayerGuard", () => {
  it("is inactive, and admits everyone, when neither switch is set", () => {
    const { guard } = guardAt({ blocked: [], limit: undefined });
    expect(guard.active).toBe(false);
    for (let i = 0; i < 50; i += 1) expect(guard.admit(A)).toEqual({ ok: true });
  });

  it("refuses a blocked payer outright and leaves the others alone", () => {
    const { guard } = guardAt({ blocked: [A], limit: undefined });
    expect(guard.active).toBe(true);
    expect(guard.admit(A)).toEqual({ ok: false, code: "payer_blocked" });
    expect(guard.admit(B)).toEqual({ ok: true });
  });

  it("limits each payer on its own, over a sliding window", () => {
    const { guard, advance } = guardAt({ blocked: [], limit: { max: 2, windowSeconds: 60 } });
    expect(guard.admit(A)).toEqual({ ok: true });
    advance(10_000);
    expect(guard.admit(A)).toEqual({ ok: true });
    // The third, 10 s in: the first leaves the window 50 s from now.
    advance(10_000);
    expect(guard.admit(A)).toEqual({ ok: false, code: "payer_rate_limited", retryAfterSeconds: 40 });
    // Another payer has its own count.
    expect(guard.admit(B)).toEqual({ ok: true });
    // 41 s later the first purchase has left the window.
    advance(41_000);
    expect(guard.admit(A)).toEqual({ ok: true });
  });

  it("counts a payment still settling, so two arriving together cannot both pass", () => {
    const { guard } = guardAt({ blocked: [], limit: { max: 1, windowSeconds: 60 } });
    expect(guard.admit(A)).toEqual({ ok: true });
    expect(guard.admit(A).ok).toBe(false);
  });

  it("gives the place back when the payment is refused", () => {
    const { guard } = guardAt({ blocked: [], limit: { max: 1, windowSeconds: 60 } });
    expect(guard.admit(A)).toEqual({ ok: true });
    guard.release(A);
    expect(guard.admit(A)).toEqual({ ok: true });
  });

  it("remembers the purchases the store already has, so a restart does not reset the window", () => {
    const start = 5_000_000;
    const { guard } = guardAt({ blocked: [], limit: { max: 2, windowSeconds: 3_600 } }, start, [
      { payer: A, at: start - 60_000 },
      { payer: A, at: start - 120_000 },
      { payer: B, at: start - 7_200_000 },
    ]);
    expect(guard.admit(A).ok).toBe(false);
    expect(guard.admit(B)).toEqual({ ok: true });
  });

  it("admits a payer it could not read: its payment cannot settle anyway", () => {
    const { guard } = guardAt({ blocked: [A], limit: { max: 1, windowSeconds: 60 } });
    expect(guard.admit(undefined)).toEqual({ ok: true });
  });

  it("treats a smart account payer like any other (AgentPey's policy_rail)", () => {
    const { guard } = guardAt({ blocked: [RAIL], limit: undefined });
    expect(guard.admit(RAIL)).toEqual({ ok: false, code: "payer_blocked" });
  });
});

describe("parseBlockedPayers", () => {
  it("reads accounts separated by commas, once each", () => {
    expect(parseBlockedPayers(` ${A}, ${B} ,${A}`)).toEqual([A, B]);
    expect(parseBlockedPayers(undefined)).toEqual([]);
    expect(parseBlockedPayers("  ")).toEqual([]);
  });

  it("refuses anything that is not a Stellar account", async () => {
    expect(() => parseBlockedPayers(`${A},not-an-account`)).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });
});

describe("parsePayerLimit", () => {
  it("reads <max>/<window seconds>", () => {
    expect(parsePayerLimit("3/3600")).toEqual({ max: 3, windowSeconds: 3_600 });
    expect(parsePayerLimit(undefined)).toBeUndefined();
    expect(parsePayerLimit(" ")).toBeUndefined();
  });

  it("refuses a zero, a missing half and text", () => {
    for (const bad of ["0/60", "3/0", "3", "three/60", "3/60/1", "-1/60"]) {
      expect(() => parsePayerLimit(bad)).toThrow(expect.objectContaining({ code: "ConfigError" }));
    }
  });
});
