import { hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { createInMemorySpendLedger, utcDayKey } from "./spend-ledger.js";

const DAY_1 = new Date("2026-09-03T10:00:00.000Z");
const DAY_1_LATER = new Date("2026-09-03T23:59:59.999Z");
const DAY_2 = new Date("2026-09-04T00:00:00.000Z");

describe("utcDayKey", () => {
  it("is the UTC calendar date, not the local one", () => {
    expect(utcDayKey(new Date("2026-09-03T00:00:00.000Z"))).toBe("2026-09-03");
    expect(utcDayKey(new Date("2026-09-03T23:59:59.999Z"))).toBe("2026-09-03");
    expect(utcDayKey(new Date("2026-09-04T00:00:00.000Z"))).toBe("2026-09-04");
  });
});

describe("a fresh ledger", () => {
  it("reports zero spent for anything it has never seen", async () => {
    const ledger = createInMemorySpendLedger();
    expect(await ledger.spentOn("agent-1", "USDC", DAY_1)).toBe("0.0000000");
  });
});

describe("recording", () => {
  it("accumulates multiple entries on the same day", async () => {
    const ledger = createInMemorySpendLedger();

    await ledger.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "18.50", at: DAY_1 });
    await ledger.record({ subject: "agent-1", intentId: "i2", currency: "USDC", amount: "12.00", at: DAY_1_LATER });

    expect(await ledger.spentOn("agent-1", "USDC", DAY_1)).toBe("30.5000000");
  });

  it("keeps the arithmetic exact where a float would drift", async () => {
    const ledger = createInMemorySpendLedger();

    for (let i = 0; i < 3; i += 1) {
      await ledger.record({ subject: "a", intentId: `i${i}`, currency: "USDC", amount: "0.1", at: DAY_1 });
    }

    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("0.3000000");
  });

  it("is idempotent by intentId: recording the same intent twice counts once", async () => {
    const ledger = createInMemorySpendLedger();

    await ledger.record({ subject: "a", intentId: "same", currency: "USDC", amount: "50.00", at: DAY_1 });
    await ledger.record({ subject: "a", intentId: "same", currency: "USDC", amount: "50.00", at: DAY_1 });
    await ledger.record({ subject: "a", intentId: "same", currency: "USDC", amount: "999.00", at: DAY_1 });

    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("50.0000000");
  });

  it("hasRecorded tells whether an intentId was already recorded", async () => {
    const ledger = createInMemorySpendLedger();

    expect(await ledger.hasRecorded("i1")).toBe(false);
    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "10.00", at: DAY_1 });
    expect(await ledger.hasRecorded("i1")).toBe(true);
    expect(await ledger.hasRecorded("i2")).toBe(false);
  });

  it("rejects an unusable amount, and the intentId stays retryable", async () => {
    const ledger = createInMemorySpendLedger();

    await expect(
      ledger.record({ subject: "a", intentId: "bad", currency: "USDC", amount: "not-a-number", at: DAY_1 }),
    ).rejects.toSatisfy((error) => hasErrorCode(error, "InvalidAmount"));

    // The rejected attempt must not have been marked as seen.
    await ledger.record({ subject: "a", intentId: "bad", currency: "USDC", amount: "10.00", at: DAY_1 });
    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("10.0000000");
  });
});

describe("the UTC day boundary", () => {
  it("resets the total across midnight UTC", async () => {
    const ledger = createInMemorySpendLedger();

    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "50.00", at: DAY_1_LATER });

    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("50.0000000");
    expect(await ledger.spentOn("a", "USDC", DAY_2)).toBe("0.0000000");
  });
});

describe("isolation", () => {
  it("keeps different subjects separate", async () => {
    const ledger = createInMemorySpendLedger();

    await ledger.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "50.00", at: DAY_1 });

    expect(await ledger.spentOn("agent-1", "USDC", DAY_1)).toBe("50.0000000");
    expect(await ledger.spentOn("agent-2", "USDC", DAY_1)).toBe("0.0000000");
  });

  it("keeps different currencies separate, even for the same subject and day", async () => {
    const ledger = createInMemorySpendLedger();

    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "50.00", at: DAY_1 });

    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("50.0000000");
    expect(await ledger.spentOn("a", "EURC", DAY_1)).toBe("0.0000000");
  });
});

describe("createInMemorySpendLedger — release (C-113, T92)", () => {
  it("gives a recorded spend back, exactly and only that one", async () => {
    const ledger = createInMemorySpendLedger();
    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.50", at: DAY_1 });
    await ledger.record({ subject: "a", intentId: "i2", currency: "USDC", amount: "2.50", at: DAY_1 });

    await ledger.release({ intentId: "i1", reason: "MerchantRejectedRequest" });

    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("2.5000000");
  });

  it("subtracts from the day the spend went into, across a UTC midnight", async () => {
    const ledger = createInMemorySpendLedger();
    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.50", at: DAY_1_LATER });

    await ledger.release({ intentId: "i1", reason: "MerchantRejectedRequest" });

    expect(await ledger.spentOn("a", "USDC", DAY_1_LATER)).toBe("0.0000000");
    expect(await ledger.spentOn("a", "USDC", DAY_2)).toBe("0.0000000");
  });

  it("is idempotent", async () => {
    const ledger = createInMemorySpendLedger();
    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.50", at: DAY_1 });
    await ledger.release({ intentId: "i1", reason: "x" });
    await ledger.release({ intentId: "i1", reason: "x" });
    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("0.0000000");
  });

  it("refuses an intent it never recorded, with SpendNotRecorded", async () => {
    const ledger = createInMemorySpendLedger();
    await expect(ledger.release({ intentId: "nope", reason: "x" })).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "SpendNotRecorded"),
    );
  });

  it("makes hasRecorded false again, so the same intent authorised later counts again", async () => {
    const ledger = createInMemorySpendLedger();
    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.50", at: DAY_1 });
    await ledger.release({ intentId: "i1", reason: "x" });
    expect(await ledger.hasRecorded("i1")).toBe(false);

    await ledger.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.50", at: DAY_1 });
    expect(await ledger.spentOn("a", "USDC", DAY_1)).toBe("1.5000000");
  });
});
