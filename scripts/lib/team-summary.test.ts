import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileMandateVault, type MandateVault } from "@agentpey/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentMonth, fromUnits, summarizeMonth, toUnits } from "./team-summary.js";

const SUBJECT = "did:stellar:testnet:GTEAM";
let dir: string;
let vault: MandateVault;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "team-summary-"));
  vault = createFileMandateVault({ path: join(dir, "vault.jsonl") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function grant(intentId: string, amount: string, at: string): Promise<void> {
  await vault.record({ subject: SUBJECT, intentId, currency: "USDC", amount, at: new Date(at) });
}

describe("amounts", () => {
  it("adds seven-decimal amounts exactly", () => {
    expect(fromUnits(toUnits("0.10") * 3n)).toBe("0.3000000");
    expect(fromUnits(toUnits("0.1") + toUnits("0.2"))).toBe("0.3000000");
    expect(() => toUnits("0.12345678")).toThrow();
    expect(() => toUnits("-1")).toThrow();
  });

  it("names the UTC month a date falls in", () => {
    expect(currentMonth(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
  });
});

describe("summarizeMonth", () => {
  it("is empty for a month with nothing in it", () => {
    expect(summarizeMonth(vault.list(), "2026-10")).toEqual({
      month: "2026-10",
      payments: [],
      refusals: [],
      spent: "0.0000000",
      currency: null,
      activeDays: 0,
    });
  });

  it("adds the month's payments, with each one's settlement once it was anchored", async () => {
    await grant("i1", "0.10", "2026-10-07T12:00:00Z");
    await grant("i2", "0.10", "2026-10-07T12:01:00Z");
    await grant("i3", "0.10", "2026-10-08T09:00:00Z");
    await vault.recordAnchor({ subject: SUBJECT, intentId: "i1", paymentTx: "p".repeat(64), linkHash: "l".repeat(64), anchorTx: "a".repeat(64) });

    const summary = summarizeMonth(vault.list(), "2026-10");
    expect(summary.spent).toBe("0.3000000");
    expect(summary.currency).toBe("USDC");
    expect(summary.activeDays).toBe(2);
    expect(summary.payments.map((p) => [p.intentId, p.paymentTx])).toEqual([
      ["i1", "p".repeat(64)],
      ["i2", null],
      ["i3", null],
    ]);
  });

  it("subtracts a released payment and keeps it listed as released", async () => {
    await grant("i1", "0.10", "2026-10-07T12:00:00Z");
    await grant("i2", "0.10", "2026-10-07T12:01:00Z");
    await vault.release({ intentId: "i2", reason: "PaymentNotCreated" });

    const summary = summarizeMonth(vault.list(), "2026-10");
    expect(summary.spent).toBe("0.1000000");
    expect(summary.payments.find((p) => p.intentId === "i2")?.released).toBe(true);
  });

  it("lists the month's refusals with their code", async () => {
    await vault.recordRefusal(
      { subject: SUBJECT, intentId: "i4", code: "MandateDailyLimitExceeded", reason: "over the day's budget", details: {} },
      new Date("2026-10-07T12:03:00Z"),
    );
    const summary = summarizeMonth(vault.list(), "2026-10");
    expect(summary.refusals).toEqual([{ intentId: "i4", code: "MandateDailyLimitExceeded", reason: "over the day's budget", at: "2026-10-07T12:03:00.000Z" }]);
    expect(summary.spent).toBe("0.0000000");
  });

  it("does not count another month", async () => {
    await grant("sep", "0.10", "2026-09-30T23:59:59Z");
    await grant("oct", "0.10", "2026-10-01T00:00:00Z");
    expect(summarizeMonth(vault.list(), "2026-10").payments.map((p) => p.intentId)).toEqual(["oct"]);
    expect(summarizeMonth(vault.list(), "2026-09").spent).toBe("0.1000000");
  });

  it("refuses a month that is not YYYY-MM", () => {
    expect(() => summarizeMonth([], "2026-13")).toThrow(expect.objectContaining({ code: "InvalidArguments" }));
    expect(() => summarizeMonth([], "octubre")).toThrow(expect.objectContaining({ code: "InvalidArguments" }));
  });
});
