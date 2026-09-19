import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAgentPassError } from "@agentpass/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileMandateVault, type MandateVault } from "./vault.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mandate-vault-"));
  path = join(dir, "vault.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createFileMandateVault — SpendLedger port", () => {
  it("starts at zero for a subject that never spent", async () => {
    const vault = createFileMandateVault({ path });
    expect(await vault.spentOn("agent-1", "USDC", new Date("2026-09-04T00:00:00Z"))).toBe("0.0000000");
  });

  it("accumulates recorded amounts for the same subject/currency/day", async () => {
    const vault = createFileMandateVault({ path });
    const at = new Date("2026-09-04T10:00:00Z");
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await vault.record({ subject: "agent-1", intentId: "i2", currency: "USDC", amount: "2.25", at });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("3.7500000");
  });

  it("deduplicates a repeated intentId — first recording stands, second is a no-op (M-15)", async () => {
    const vault = createFileMandateVault({ path });
    const at = new Date("2026-09-04T10:00:00Z");
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.00", at });
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "999.00", at });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("1.0000000");
    expect(await vault.hasRecorded("i1")).toBe(true);
    expect(await vault.hasRecorded("i2")).toBe(false);
  });

  it("keeps days separate by UTC boundary", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({
      subject: "agent-1",
      intentId: "i1",
      currency: "USDC",
      amount: "1.00",
      at: new Date("2026-09-04T23:59:59.999Z"),
    });
    await vault.record({
      subject: "agent-1",
      intentId: "i2",
      currency: "USDC",
      amount: "1.00",
      at: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(await vault.spentOn("agent-1", "USDC", new Date("2026-09-04T12:00:00Z"))).toBe("1.0000000");
    expect(await vault.spentOn("agent-1", "USDC", new Date("2026-09-05T12:00:00Z"))).toBe("1.0000000");
  });

  it("rejects a malformed amount without appending anything, so a retry under the same intentId still works", async () => {
    const vault = createFileMandateVault({ path });
    const at = new Date("2026-09-04T10:00:00Z");
    await expect(
      vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "not-a-number", at }),
    ).rejects.toSatisfy((error: unknown) => isAgentPassError(error) && error.code === "InvalidAmount");
    expect(await vault.hasRecorded("i1")).toBe(false);
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.00", at });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("1.0000000");
  });
});

describe("createFileMandateVault — durability across restarts", () => {
  it("rebuilds spend totals and dedup state from the file on a fresh construction", async () => {
    const at = new Date("2026-09-04T10:00:00Z");
    const first = createFileMandateVault({ path });
    await first.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "5.00", at });

    const second = createFileMandateVault({ path });
    expect(await second.spentOn("agent-1", "USDC", at)).toBe("5.0000000");
    expect(await second.hasRecorded("i1")).toBe(true);
    await second.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "999.00", at });
    expect(await second.spentOn("agent-1", "USDC", at)).toBe("5.0000000");
  });

  it("creates the containing directory if it does not exist yet", async () => {
    const nested = join(dir, "a", "b", "vault.jsonl");
    const vault = createFileMandateVault({ path: nested });
    await vault.record({
      subject: "agent-1",
      intentId: "i1",
      currency: "USDC",
      amount: "1.00",
      at: new Date("2026-09-04T00:00:00Z"),
    });
    expect(readFileSync(nested, "utf8")).toContain("\"i1\"");
  });
});

describe("createFileMandateVault — refusals", () => {
  it("records a refusal without affecting spentOn or hasRecorded", async () => {
    const vault = createFileMandateVault({ path });
    await vault.recordRefusal({
      subject: "agent-1",
      intentId: "i1",
      code: "ScopeAmountExceeded",
      reason: "over perTx",
      details: { limit: "10.00", total: "20.00" },
    });
    expect(await vault.hasRecorded("i1")).toBe(false);
    expect(await vault.spentOn("agent-1", "USDC", new Date())).toBe("0.0000000");

    const [record] = vault.list("agent-1");
    expect(record?.entry.kind).toBe("refused");
    expect(record?.entry).toMatchObject({ code: "ScopeAmountExceeded", intentId: "i1" });
  });

  it("keeps every refusal, even repeated ones for the same intentId — unlike a grant, a refusal is not deduplicated", async () => {
    const vault = createFileMandateVault({ path });
    await vault.recordRefusal({ subject: "agent-1", intentId: "i1", code: "X", reason: "r", details: {} });
    await vault.recordRefusal({ subject: "agent-1", intentId: "i1", code: "X", reason: "r", details: {} });
    expect(vault.list("agent-1")).toHaveLength(2);
  });
});

describe("createFileMandateVault — anchors (T28/T29)", () => {
  it("records an anchor without affecting spentOn or hasRecorded", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({
      subject: "agent-1",
      intentId: "i1",
      currency: "USDC",
      amount: "0.001",
      at: new Date("2026-09-04T00:00:00Z"),
    });
    await vault.recordAnchor({
      subject: "agent-1",
      intentId: "i1",
      paymentTx: "pay-tx",
      linkHash: "link-hash",
      anchorTx: "anchor-tx",
    });

    const records = vault.list("agent-1");
    expect(records).toHaveLength(2);
    expect(records[1]?.entry).toMatchObject({
      kind: "anchored",
      intentId: "i1",
      paymentTx: "pay-tx",
      linkHash: "link-hash",
      anchorTx: "anchor-tx",
    });
    expect(await vault.spentOn("agent-1", "USDC", new Date("2026-09-04T00:00:00Z"))).toBe("0.0010000");
  });

  it("chains an anchor record onto whatever came before it, and survives a restart", async () => {
    const at = new Date("2026-09-04T00:00:00Z");
    const first = createFileMandateVault({ path });
    await first.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.00", at });
    await first.recordAnchor({ subject: "a", intentId: "i1", paymentTx: "tx", linkHash: "h", anchorTx: "atx" });

    const reopened = createFileMandateVault({ path });
    expect(reopened.verify()).toEqual({ ok: true });
    expect(reopened.list("a").map((r) => r.entry.kind)).toEqual(["granted", "anchored"]);
  });
});

describe("createFileMandateVault — the chain", () => {
  it("assigns sequential seq numbers and links each record's prevHash to the last hash", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({
      subject: "a",
      intentId: "i1",
      currency: "USDC",
      amount: "1.00",
      at: new Date("2026-09-04T00:00:00Z"),
    });
    await vault.recordRefusal({ subject: "a", intentId: "i2", code: "X", reason: "r", details: {} });

    const [first, second] = vault.list();
    expect(first?.seq).toBe(0);
    expect(first?.prevHash).toBe("");
    expect(second?.seq).toBe(1);
    expect(second?.prevHash).toBe(first?.hash);
    expect(vault.head()).toBe(second?.hash);
  });

  it("list(subject) returns only that subject's records, in order", async () => {
    const vault = createFileMandateVault({ path });
    const at = new Date("2026-09-04T00:00:00Z");
    await vault.record({ subject: "a", intentId: "i1", currency: "USDC", amount: "1.00", at });
    await vault.record({ subject: "b", intentId: "i2", currency: "USDC", amount: "1.00", at });
    await vault.record({ subject: "a", intentId: "i3", currency: "USDC", amount: "1.00", at });

    expect(vault.list("a").map((r) => r.entry.intentId)).toEqual(["i1", "i3"]);
    expect(vault.list("b").map((r) => r.entry.intentId)).toEqual(["i2"]);
    expect(vault.list()).toHaveLength(3);
  });

  it("head() is undefined for an empty vault", () => {
    const vault = createFileMandateVault({ path });
    expect(vault.head()).toBeUndefined();
  });
});

describe("createFileMandateVault — verify()", () => {
  async function seeded(): Promise<MandateVault> {
    const vault = createFileMandateVault({ path });
    await vault.record({
      subject: "a",
      intentId: "i1",
      currency: "USDC",
      amount: "1.00",
      at: new Date("2026-09-04T00:00:00Z"),
    });
    await vault.recordRefusal({ subject: "a", intentId: "i2", code: "X", reason: "r", details: {} });
    await vault.record({
      subject: "a",
      intentId: "i3",
      currency: "USDC",
      amount: "2.00",
      at: new Date("2026-09-04T00:00:00Z"),
    });
    return vault;
  }

  it("reports ok on an untouched chain", async () => {
    await seeded();
    const reopened = createFileMandateVault({ path });
    expect(reopened.verify()).toEqual({ ok: true });
  });

  it("detects an edited field in an old record — every hash after it breaks too", async () => {
    await seeded();

    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    const tampered = JSON.parse(lines[0] as string) as { entry: { amount: string } };
    tampered.entry.amount = "999.00";
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const reopened = createFileMandateVault({ path });
    const result = reopened.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(0);
  });

  it("throws VaultCorrupted when reopening a file with an unparseable line", () => {
    writeFileSync(path, "not json\n", "utf8");
    expect(() => createFileMandateVault({ path })).toThrow(
      expect.objectContaining({ code: "VaultCorrupted" }),
    );
  });
});

describe("createFileMandateVault — release (C-113, T92)", () => {
  const at = new Date("2026-09-04T10:00:00Z");

  it("gives a recorded spend back, so the day's total drops by exactly that amount", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await vault.record({ subject: "agent-1", intentId: "i2", currency: "USDC", amount: "2.25", at });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("3.7500000");

    await vault.release({ intentId: "i1", reason: "MerchantRejectedRequest" });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("2.2500000");
  });

  it("appends rather than edits — the grant it undoes is still in the chain, and the chain still verifies", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await vault.release({ intentId: "i1", reason: "MerchantRejectedRequest" });

    const kinds = vault.list("agent-1").map((record) => record.entry.kind);
    expect(kinds).toEqual(["granted", "released"]);
    expect(vault.verify()).toEqual({ ok: true });
  });

  it("subtracts from the day the spend was recorded on, not the day it is released on", async () => {
    // The boundary case: recorded at 23:59 UTC, released two minutes later,
    // which is already the next UTC day. Releasing against "today" would
    // leave the first day still counting and push the second one negative.
    const vault = createFileMandateVault({ path });
    const lateAt = new Date("2026-09-04T23:59:00Z");
    const nextDay = new Date("2026-09-05T00:01:00Z");
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at: lateAt });

    await vault.release({ intentId: "i1", reason: "MerchantRejectedRequest" });

    expect(await vault.spentOn("agent-1", "USDC", lateAt)).toBe("0.0000000");
    expect(await vault.spentOn("agent-1", "USDC", nextDay)).toBe("0.0000000");
  });

  it("is idempotent — releasing twice gives the budget back once", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await vault.release({ intentId: "i1", reason: "MerchantRejectedRequest" });
    await vault.release({ intentId: "i1", reason: "MerchantRejectedRequest" });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("0.0000000");
  });

  it("refuses to release an intent that has no recorded spend, typed rather than silently", async () => {
    const vault = createFileMandateVault({ path });
    await expect(vault.release({ intentId: "never-seen", reason: "x" })).rejects.toSatisfy(
      (error: unknown) => isAgentPassError(error) && error.code === "SpendNotRecorded",
    );
  });

  it("refuses to release a payment that is anchored on-chain — the one case that must never be given back", async () => {
    const vault = createFileMandateVault({ path });
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await vault.recordAnchor({ subject: "agent-1", intentId: "i1", paymentTx: "tx", linkHash: "lh", anchorTx: "atx" });

    await expect(vault.release({ intentId: "i1", reason: "x" })).rejects.toSatisfy(
      (error: unknown) => isAgentPassError(error) && error.code === "SpendAlreadySettled",
    );
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("1.5000000");
  });

  it("makes hasRecorded false again, so authorising the same intent after a release counts again", async () => {
    // Without this, `LocalPolicyRail` would see `hasRecorded === true`, add
    // nothing to the day's total, and hand back budget for free.
    const vault = createFileMandateVault({ path });
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await vault.release({ intentId: "i1", reason: "MerchantRejectedRequest" });

    expect(await vault.hasRecorded("i1")).toBe(false);
    await vault.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    expect(await vault.spentOn("agent-1", "USDC", at)).toBe("1.5000000");
    expect(await vault.hasRecorded("i1")).toBe(true);
  });

  it("survives a restart: a vault rebuilt from the same file reads the release, not just the grant", async () => {
    const first = createFileMandateVault({ path });
    await first.record({ subject: "agent-1", intentId: "i1", currency: "USDC", amount: "1.50", at });
    await first.release({ intentId: "i1", reason: "MerchantRejectedRequest" });

    const reopened: MandateVault = createFileMandateVault({ path });
    expect(await reopened.spentOn("agent-1", "USDC", at)).toBe("0.0000000");
    expect(await reopened.hasRecorded("i1")).toBe(false);
    expect(reopened.verify()).toEqual({ ok: true });
  });
});
