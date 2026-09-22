import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { USDC_TESTNET, signReceipt, stellarDid, type ReceiptClaims } from "@vitrinee/core";
import { describe, expect, it } from "vitest";

import { anchorArgs, countKey, decodeRecord, isAlreadyAnchored, receiptKey, type AnchoredRecord } from "./scval.js";
import { checkSettlement } from "./settlement.js";
import { verifyReceipt } from "./verify.js";

const signer = Keypair.random();
const PAYER = "GAGRRWU5CEYAMHUMVO6DZBXAV7YTQTO2QE7R2KO3TUEN6QR7GRVXQPOM";
const MERCHANT = "GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII";
const TX = "ef86ca2fb6b3fbbe32e89b23c7159a4b13dc02e251bb83a7e75e0ac68f86080f";

function claims(): ReceiptClaims {
  return {
    typ: "vitrinee-receipt/0.1",
    orderId: "ord_test0001",
    platformOrderId: "mock-0001",
    platform: "mock",
    merchantDid: stellarDid(signer.publicKey()),
    merchantAccount: MERCHANT,
    payerAccount: PAYER,
    network: "stellar:testnet",
    asset: USDC_TESTNET.contractId,
    amountUSDC: "9.4631579",
    amountUSDCAtomic: "94631579",
    settlementTxHash: TX,
    items: [{ productId: "cafe-nunoa-250", sku: "CAF-NUN-250", name: "Café", quantity: 1, unitPriceUSDC: "9.4631579", unitPriceUSDCAtomic: "94631579" }],
    issuedAt: "2026-09-22T14:20:30.000Z",
    refundWindowEndsAt: "2026-10-02T14:20:30.000Z",
  };
}

/** A Horizon that knows exactly one transaction. */
function fakeHorizon(effects: Array<Record<string, string>>, successful = true): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(`/transactions/${TX}`)) return Response.json({ successful, ledger: 4812648, created_at: "2026-09-22T14:20:27Z" });
    if (url.includes(`/transactions/${TX}/effects`)) return Response.json({ _embedded: { records: effects } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const GOOD_EFFECTS = [
  { type: "account_debited", account: PAYER, amount: "9.4631579", asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
  { type: "account_credited", account: MERCHANT, amount: "9.4631579", asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
];

function registryWith(records: Record<string, AnchoredRecord>) {
  return { contractId: "CTEST", get: async (hash: string) => records[hash] ?? null };
}

describe("scval encoding", () => {
  it("encodes DataKey variants as Vec[Symbol, field]", () => {
    const key = scValToNative(receiptKey("ab".repeat(32))) as [string, Uint8Array];
    expect(key[0]).toBe("Receipt");
    expect(Buffer.from(key[1]).toString("hex")).toBe("ab".repeat(32));
    expect(scValToNative(countKey(MERCHANT))).toEqual(["Count", MERCHANT]);
    expect(() => receiptKey("AB".repeat(32))).toThrow(/lowercase hex/);
  });

  it("builds anchor args in the contract's order and refuses non-positive amounts", () => {
    const args = anchorArgs({ hash: "cd".repeat(32), merchant: MERCHANT, amount: 94631579n, orderRef: "ord_1" });
    expect(args.map((a) => a.type)).toEqual(["scvBytes", "scvAddress", "scvI128", "scvBytes"]);
    const native = args.map((a) => scValToNative(a) as unknown);
    expect(native[1]).toBe(MERCHANT);
    expect(native[2]).toBe(94631579n);
    expect(Buffer.from(native[3] as Uint8Array).toString("utf8")).toBe("ord_1");
    expect(() => anchorArgs({ hash: "cd".repeat(32), merchant: MERCHANT, amount: 0n, orderRef: "x" })).toThrow(/positive/);
  });

  it("decodes a ReceiptRecord map", () => {
    const value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(94631579n, { type: "i128" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("ledger"), val: xdr.ScVal.scvU32(4812700) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("merchant"), val: nativeToScVal(MERCHANT, { type: "address" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("order_ref"), val: xdr.ScVal.scvBytes(Buffer.from("ord_1")) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("timestamp"), val: xdr.ScVal.scvU64(1790000000n) }),
    ]);
    expect(decodeRecord(value)).toEqual({ merchant: MERCHANT, amount: 94631579n, orderRef: "ord_1", ledger: 4812700, timestamp: 1790000000 });
  });

  it("recognises the contract's AlreadyAnchored error", () => {
    expect(isAlreadyAnchored(new Error("HostError: Error(Contract, #1)\n..."))).toBe(true);
    expect(isAlreadyAnchored(new Error("HostError: Error(Contract, #2)"))).toBe(false);
  });
});

describe("checkSettlement", () => {
  it("passes when the payer was debited and the merchant credited the exact amount", async () => {
    expect(await checkSettlement(claims(), { horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) })).toMatchObject({ ok: true, ledger: 4812648 });
  });

  it("fails on a missing, failed or mismatching transaction", async () => {
    const missing = await checkSettlement({ ...claims(), settlementTxHash: "0".repeat(64) }, { horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(missing).toMatchObject({ ok: false, reason: expect.stringMatching(/not found/) });
    const failed = await checkSettlement(claims(), { horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS, false) });
    expect(failed).toMatchObject({ ok: false, reason: expect.stringMatching(/failed on chain/) });
    const less = await checkSettlement({ ...claims(), amountUSDCAtomic: "94631580" }, { horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(less).toMatchObject({ ok: false, reason: expect.stringMatching(/payer was not debited/) });
    const elsewhere = await checkSettlement({ ...claims(), merchantAccount: PAYER }, { horizonUrl: "https://h", fetchImpl: fakeHorizon([GOOD_EFFECTS[0]!]) });
    expect(elsewhere).toMatchObject({ ok: false, reason: expect.stringMatching(/merchant was not credited/) });
  });
});

describe("verifyReceipt", () => {
  const { jws, hash } = signReceipt(claims(), signer.secret());
  const record: AnchoredRecord = { merchant: signer.publicKey(), amount: 94631579n, orderRef: "ord_test0001", ledger: 4812700, timestamp: 1790000000 };

  it("is valid when all three checks pass", async () => {
    const result = await verifyReceipt(jws, { registry: registryWith({ [hash]: record }), horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(result.valid).toBe(true);
    expect(result.checks.signature).toEqual({ ok: true, signer: signer.publicKey() });
    expect(result.checks.anchored).toMatchObject({ ok: true, registry: "CTEST", record: { ledger: 4812700, amount: "94631579" } });
    expect(result.checks.settlement.ok).toBe(true);
    expect(result.receipt?.orderId).toBe("ord_test0001");
  });

  it("goes red on signature and anchor when one byte changes", async () => {
    const parts = jws.split(".");
    parts[1] = parts[1]!.slice(0, 20) + (parts[1]![20] === "A" ? "B" : "A") + parts[1]!.slice(21);
    const result = await verifyReceipt(parts.join("."), { registry: registryWith({ [hash]: record }), horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(result.valid).toBe(false);
    expect(result.checks.signature.ok).toBe(false);
    expect(result.checks.anchored).toMatchObject({ ok: false, reason: expect.stringMatching(/not anchored/) });
  });

  it("goes red when the anchor names another merchant or amount", async () => {
    const other = await verifyReceipt(jws, { registry: registryWith({ [hash]: { ...record, merchant: MERCHANT } }), horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(other.checks.anchored).toMatchObject({ ok: false, reason: expect.stringMatching(/different merchant/) });
    const cheaper = await verifyReceipt(jws, { registry: registryWith({ [hash]: { ...record, amount: 1n } }), horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(cheaper.checks.anchored).toMatchObject({ ok: false, reason: expect.stringMatching(/amount differs/) });
  });

  it("reports a missing registry instead of pretending", async () => {
    const result = await verifyReceipt(jws, { registry: null, horizonUrl: "https://h", fetchImpl: fakeHorizon(GOOD_EFFECTS) });
    expect(result.valid).toBe(false);
    expect(result.checks.anchored).toEqual({ ok: false, reason: "no receipt registry configured", registry: null });
  });
});
