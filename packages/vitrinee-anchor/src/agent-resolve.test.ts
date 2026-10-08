import { readFileSync } from "node:fs";

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { AGENT_RESOLVE_STORAGE_SCHEMA_VERSION, AgentResolveReader, decodeDispute, disputeKey } from "./agent-resolve.js";
import { ReceiptRegistryClient } from "./registry.js";
import { countKey, hashOfKey, receiptKey } from "./scval.js";

const RECEIPT = "fe3c5730884a59a72760217ae192757b7bb376bb1467f1e2d2ea7a6047c0f076";
const CLAIM = "12075d85a757b96394b63a52e19dc18842b335eb4f6a3d321b408202d9f7d37f";
const VERDICT = "ff3ef9b02f6f6791aa00bb11cc22dd33ee44ff5566778899aabbccddeeff0011";
const MERCHANT = "GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ";
const PAYER = "CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP";

const CONTRACT_SOURCE = readFileSync(new URL("../../../contracts/agent-resolve/src/lib.rs", import.meta.url), "utf8");

/** A `Dispute` as the contract stores it: a contracttype struct is a map with symbol keys, sorted. */
function disputeScVal(status: "Open" | "Resolved", verdict: string | null, refund: bigint, resolvedAt: number): xdr.ScVal {
  const fields: Array<[string, xdr.ScVal]> = [
    ["amount", nativeToScVal(15_684_211n, { type: "i128" })],
    ["claim_hash", xdr.ScVal.scvBytes(Buffer.from(CLAIM, "hex"))],
    ["merchant", new Address(MERCHANT).toScVal()],
    ["opened_at", nativeToScVal(1_791_000_000, { type: "u64" })],
    ["payer", new Address(PAYER).toScVal()],
    ["refund", nativeToScVal(refund, { type: "i128" })],
    ["resolved_at", nativeToScVal(resolvedAt, { type: "u64" })],
    ["status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(status)])],
    ["verdict_hash", verdict === null ? xdr.ScVal.scvVoid() : xdr.ScVal.scvBytes(Buffer.from(verdict, "hex"))],
  ];
  return xdr.ScVal.scvMap(fields.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })));
}

describe("reading a dispute from agent-resolve (T127)", () => {
  it("keys it as DataKey::Dispute(receipt hash)", () => {
    const key = scValToNative(disputeKey(RECEIPT)) as [string, Uint8Array];
    expect(key[0]).toBe("Dispute");
    expect(Buffer.from(key[1]).toString("hex")).toBe(RECEIPT);
    expect(() => disputeKey("not-a-hash")).toThrow();
  });

  it("decodes an open dispute: nothing refunded, no verdict, no resolution time", () => {
    expect(decodeDispute(disputeScVal("Open", null, 0n, 0))).toEqual({
      status: "open",
      merchant: MERCHANT,
      payer: PAYER,
      claimHash: CLAIM,
      amountAtomic: 15_684_211n,
      openedAt: 1_791_000_000,
      verdictHash: null,
      refundAtomic: 0n,
      resolvedAt: null,
    });
  });

  it("decodes a resolved one with its verdict hash, refund and time", () => {
    expect(decodeDispute(disputeScVal("Resolved", VERDICT, 7_000_000n, 1_791_003_600))).toMatchObject({
      status: "resolved",
      verdictHash: VERDICT,
      refundAtomic: 7_000_000n,
      resolvedAt: 1_791_003_600,
    });
  });

  it("refuses an entry that is not a Dispute, with a typed error", () => {
    expect(() => decodeDispute(xdr.ScVal.scvSymbol("nope"))).toThrow(expect.objectContaining({ code: "AnchorError" }));
  });
});

describe("the reader mirrors the contract's storage layout", () => {
  it("names the same key, struct fields, statuses and storage version as contracts/agent-resolve", () => {
    expect(CONTRACT_SOURCE).toMatch(/pub enum DataKey \{[^}]*\bDispute\(BytesN<32>\)/);
    const struct = /pub struct Dispute \{([\s\S]*?)\n\}/.exec(CONTRACT_SOURCE)?.[1] ?? "";
    const fields = [...struct.matchAll(/^\s+pub (\w+): ([^,]+),/gm)].map(([, name, type]) => [name, type]);
    expect(fields).toEqual([
      ["merchant", "Address"],
      ["payer", "Address"],
      ["claim_hash", "BytesN<32>"],
      ["amount", "i128"],
      ["opened_at", "u64"],
      ["status", "Status"],
      ["verdict_hash", "Option<BytesN<32>>"],
      ["refund", "i128"],
      ["resolved_at", "u64"],
    ]);
    // Read from persistent storage: under any other durability the ledger key differs and every order would say "no dispute".
    expect(CONTRACT_SOURCE).toContain("env.storage().persistent().get(&DataKey::Dispute(receipt))");
    expect(CONTRACT_SOURCE).toMatch(/pub enum Status \{\s*Open,\s*Resolved,\s*\}/);
    expect(CONTRACT_SOURCE).toContain(`pub const STORAGE_SCHEMA_VERSION: u32 = ${AGENT_RESOLVE_STORAGE_SCHEMA_VERSION};`);
  });

});

describe("a dispute the contract could never hold is refused, not shown", () => {
  it.each([
    ["a negative refund", disputeScVal("Resolved", VERDICT, -1n, 1_791_003_600)],
    ["a refund above the disputed amount", disputeScVal("Resolved", VERDICT, 15_684_212n, 1_791_003_600)],
    ["a time no date can hold", disputeScVal("Resolved", VERDICT, 0n, 99_999_999_999_999)],
  ])("%s", (_name, value) => {
    expect(() => decodeDispute(value)).toThrow(expect.objectContaining({ code: "AnchorError" }));
  });
});

describe("hashOfKey (T151)", () => {
  const hash = "ab".repeat(32);

  it("reads the receipt hash a Receipt or Dispute key names", () => {
    expect(hashOfKey(receiptKey(hash), "Receipt")).toBe(hash);
    expect(hashOfKey(disputeKey(hash), "Dispute")).toBe(hash);
  });

  it("refuses the other variant, a count key, and anything that is not a two-part key with 32 bytes", () => {
    expect(hashOfKey(receiptKey(hash), "Dispute")).toBeNull();
    expect(hashOfKey(disputeKey(hash), "Receipt")).toBeNull();
    expect(hashOfKey(countKey("GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ"), "Receipt")).toBeNull();
    expect(hashOfKey(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Receipt"), xdr.ScVal.scvBytes(Buffer.alloc(16))]), "Receipt")).toBeNull();
    expect(hashOfKey(xdr.ScVal.scvSymbol("Receipt"), "Receipt")).toBeNull();
  });
});

/** A fake RPC answering `getLedgerEntries` with `found` entries only, in the order given. */
function fakeRpc(found: Array<{ key: xdr.ScVal; val: xdr.ScVal }>) {
  const calls: unknown[][] = [];
  return {
    calls,
    getLedgerEntries: async (...keys: unknown[]) => {
      calls.push(keys);
      return { entries: found.map(({ key, val }) => ({ val: { type: "contractData", contractData: { key, val } } })) };
    },
  };
}

function receiptScVal(orderRef: string): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(15_684_211n, { type: "i128" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("ledger"), val: xdr.ScVal.scvU32(4_900_000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("merchant"), val: new Address(MERCHANT).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("order_ref"), val: xdr.ScVal.scvBytes(Buffer.from(orderRef)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("timestamp"), val: xdr.ScVal.scvU64(1_791_000_000n) }),
  ]);
}

describe("getMany (T151)", () => {
  const one = "11".repeat(32);
  const two = "22".repeat(32);
  const config = { contractId: "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5", rpcUrl: "https://rpc.test", networkPassphrase: "Test SDF Network ; September 2015" };

  it("reads many receipts in one call, matching entries that come back in any order and leaving out the missing", async () => {
    const client = new ReceiptRegistryClient(config);
    const rpcFake = fakeRpc([
      { key: receiptKey(two), val: receiptScVal("ord_two") },
      { key: receiptKey(one), val: receiptScVal("ord_one") },
    ]);
    (client as unknown as { server: unknown }).server = rpcFake;
    const found = await client.getMany([one, two, "33".repeat(32), one]);
    expect(rpcFake.calls).toHaveLength(1);
    expect(rpcFake.calls[0]).toHaveLength(3);
    expect([...found.entries()].map(([hash, record]) => [hash, record.orderRef]).sort()).toEqual([
      [one, "ord_one"],
      [two, "ord_two"],
    ]);
  });

  it("leaves out an entry that does not decode, and asks nothing for no hashes", async () => {
    const client = new ReceiptRegistryClient(config);
    const rpcFake = fakeRpc([{ key: receiptKey(one), val: xdr.ScVal.scvU32(7) }]);
    (client as unknown as { server: unknown }).server = rpcFake;
    expect((await client.getMany([one])).size).toBe(0);
    expect((await client.getMany([])).size).toBe(0);
    expect(rpcFake.calls).toHaveLength(1);
  });

  it("refuses more than 200 hashes with a typed error", async () => {
    const client = new ReceiptRegistryClient(config);
    const many = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(64, "0"));
    await expect(client.getMany(many)).rejects.toMatchObject({ code: "ValidationError" });
    const reader = new AgentResolveReader({ contractId: config.contractId, rpcUrl: config.rpcUrl });
    await expect(reader.getMany(many)).rejects.toMatchObject({ code: "ValidationError" });
  });

  it("reads many disputes in one call, keyed by receipt hash", async () => {
    const reader = new AgentResolveReader({ contractId: config.contractId, rpcUrl: config.rpcUrl });
    const rpcFake = fakeRpc([
      { key: disputeKey(one), val: disputeScVal("Resolved", "ab".repeat(32), 15_684_211n, 1_791_100_000) },
      // A receipt key in the answer is not a dispute.
      { key: receiptKey(two), val: receiptScVal("ord_two") },
    ]);
    (reader as unknown as { server: unknown }).server = rpcFake;
    const found = await reader.getMany([one, two]);
    expect([...found.keys()]).toEqual([one]);
    expect(found.get(one)).toMatchObject({ status: "resolved", refundAtomic: 15_684_211n });
  });
});
