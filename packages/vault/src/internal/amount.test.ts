import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import type { VaultEntry, VaultGrantedEntry } from "../vault.js";
import { computeHash, invalidAmount, scaleAmount, unscaleAmount, utcDayKey } from "./amount.js";

const ENTRY: VaultGrantedEntry = {
  kind: "granted",
  subject: "agent-1",
  intentId: "intent-1",
  currency: "USDC",
  amount: "1.00",
  at: "2026-09-10T12:00:00.000Z",
};

describe("scaleAmount and unscaleAmount", () => {
  it.each([
    ["1.00", "1.0000000"],
    ["0.001", "0.0010000"],
    ["12.3", "12.3000000"],
    ["12.3456789", "12.3456789"],
    ["0", "0.0000000"],
  ])("round-trips %s", (amount, expected) => {
    expect(unscaleAmount(scaleAmount(amount))).toBe(expected);
  });
});

describe("computeHash", () => {
  it("is deterministic for the same record", () => {
    expect(computeHash(3, "previous-hash", ENTRY)).toBe(computeHash(3, "previous-hash", ENTRY));
  });

  it("changes when the sequence number or previous hash changes", () => {
    const hash = computeHash(3, "previous-hash", ENTRY);

    expect(computeHash(4, "previous-hash", ENTRY)).not.toBe(hash);
    expect(computeHash(3, "other-previous-hash", ENTRY)).not.toBe(hash);
  });

  const entryChanges: ReadonlyArray<readonly [string, VaultEntry]> = [
    [
      "kind",
      {
        kind: "refused",
        subject: ENTRY.subject,
        intentId: ENTRY.intentId,
        code: "ScopeAmountExceeded",
        reason: "over limit",
        details: {},
        at: ENTRY.at,
      },
    ],
    ["subject", { ...ENTRY, subject: "agent-2" }],
    ["intentId", { ...ENTRY, intentId: "intent-2" }],
    ["currency", { ...ENTRY, currency: "EURC" }],
    ["amount", { ...ENTRY, amount: "2.00" }],
    ["at", { ...ENTRY, at: "2026-09-10T12:00:01.000Z" }],
  ];

  it.each(entryChanges)("changes when entry.%s changes", (_field, changedEntry) => {
    expect(computeHash(3, "previous-hash", changedEntry)).not.toBe(computeHash(3, "previous-hash", ENTRY));
  });
});

describe("utcDayKey", () => {
  it("returns the same key for dates on the same UTC day", () => {
    expect(utcDayKey(new Date("2026-09-10T00:00:00.000Z"))).toBe(
      utcDayKey(new Date("2026-09-10T23:59:59.999Z")),
    );
  });

  it("changes at the UTC midnight boundary", () => {
    expect(utcDayKey(new Date("2026-09-10T23:59:59.999Z"))).not.toBe(
      utcDayKey(new Date("2026-09-11T00:00:00.000Z")),
    );
  });
});

describe("invalidAmount", () => {
  it("returns an AgentPassError with the InvalidAmount code", () => {
    const error = invalidAmount("not-an-amount");

    expect(isAgentPassError(error)).toBe(true);
    expect(error).toBeInstanceOf(AgentPassError);
    expect(error).toMatchObject({ name: "AgentPassError", code: "InvalidAmount" });
  });
});
