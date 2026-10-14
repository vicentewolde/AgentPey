import { readFileSync } from "node:fs";

import { Account, Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  ESCROW_STORAGE_SCHEMA_VERSION,
  EscrowClient,
  PURCHASE_ESCROW_WASM_HASHES,
  configKey,
  decodeEscrowConfig,
  decodePurchase,
  paymentKey,
  purchaseKey,
  sameHold,
  type EscrowPurchase,
  type EscrowReader,
  type EscrowRpc,
} from "./escrow.js";
import { checkSettlement } from "./settlement.js";
import { checkHeld } from "./verify.js";

const ESCROW = "CCTVYTWFGOBD23UF7A2AX6CMCKF7ACHENU6YNFJPG6S3O5P3FBKCYLDO";
const TX = "97e71975214447036128a8e80465e88936f0d8aa1a0c0c0e9637c3489f8c9c95";
const RECEIPT = "b49473be9003c769ace21ac7bf08e9e06511c0bfcb94c3696a5a87b8bd84ac4f";
const CLAIM = "63acdd917dde21964974b5485cffea010201ba5bc3a745385f8e712c44ae033a";
const PAYER = "CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA";
const OPERATOR = "GARBTKFQEX325HDOWL3KQT7PDCENLOYMXF7D6B6SB54LDKCHCRYFUY2K";
const PAYEE = "GCTTRJIYYRHAOYTEG2YWKYSBKIQOMX7RX7SAJXQAM3QY2J7J453BOZD6";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const CONTRACT_SOURCE = readFileSync(new URL("../../../contracts/purchase-escrow/src/lib.rs", import.meta.url), "utf8");

const map = (fields: Array<[string, xdr.ScVal]>): xdr.ScVal =>
  xdr.ScVal.scvMap(fields.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })));
const bytes = (hex: string): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const u64 = (value: number): xdr.ScVal => nativeToScVal(value, { type: "u64" });
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" });

/** A `Purchase` as the contract stores it: a contracttype struct is a map with symbol keys, sorted. */
function purchaseScVal(overrides: Partial<Record<string, xdr.ScVal>> = {}): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    amount: i128(500_000n),
    claim_hash: bytes(CLAIM),
    closed_at: u64(1_792_005_157),
    held_at: u64(1_792_005_132),
    opened_at: u64(1_792_005_142),
    order_ref: xdr.ScVal.scvBytes(Buffer.from("rehearsal-mv8hh8i3-f", "utf8")),
    payer: new Address(PAYER).toScVal(),
    receipt_hash: bytes(RECEIPT),
    refund: i128(500_000n),
    refund_owed: i128(0n),
    response_hash: xdr.ScVal.scvVoid(),
    shipped_at: u64(0),
    status: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Resolved")]),
    tx_hash: bytes(TX),
    verdict_hash: bytes("68ac4270e0dc7df70939ff4154963ae1ab889231b88492a1ec5b99ad3c7f8179"),
    ...overrides,
  };
  return map(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)) as Array<[string, xdr.ScVal]>);
}

describe("reading a purchase-escrow (T159)", () => {
  it("keys purchases by order, payments by transaction hash, and its Config as a unit variant", () => {
    const purchase = scValToNative(purchaseKey("ord_1")) as [string, Uint8Array];
    expect([purchase[0], Buffer.from(purchase[1]).toString("utf8")]).toEqual(["Purchase", "ord_1"]);
    const payment = scValToNative(paymentKey(TX)) as [string, Uint8Array];
    expect([payment[0], Buffer.from(payment[1]).toString("hex")]).toEqual(["Payment", TX]);
    expect(scValToNative(configKey())).toEqual(["Config"]);
  });

  it("decodes a purchase: an unset time or hash reads as null", () => {
    expect(decodePurchase(purchaseScVal())).toEqual({
      orderRef: "rehearsal-mv8hh8i3-f",
      payer: PAYER,
      amountAtomic: 500_000n,
      txHash: TX,
      receiptHash: RECEIPT,
      status: "resolved",
      heldAt: 1_792_005_132,
      shippedAt: null,
      claimHash: CLAIM,
      openedAt: 1_792_005_142,
      responseHash: null,
      verdictHash: "68ac4270e0dc7df70939ff4154963ae1ab889231b88492a1ec5b99ad3c7f8179",
      refundAtomic: 500_000n,
      refundOwedAtomic: 0n,
      closedAt: 1_792_005_157,
    });
  });

  it("refuses a purchase the contract could never hold, with a typed error", () => {
    for (const bad of [
      purchaseScVal({ refund: i128(500_001n) }),
      purchaseScVal({ refund_owed: i128(1n), refund: i128(0n) }),
      purchaseScVal({ amount: i128(0n) }),
      purchaseScVal({ status: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Lost")]) }),
      purchaseScVal({ tx_hash: bytes("ab") }),
    ]) {
      expect(() => decodePurchase(bad)).toThrow(expect.objectContaining({ code: "EscrowError" }));
    }
  });

  it("decodes its Config, and refuses a window of zero", () => {
    const config = (release: number) =>
      map([
        ["arbiter", new Address("GAEB2EG3CSMEHLCYKHPPOMBRVISQOTBRS7T4K2D2EMNOA2AMUSJ32VV6").toScVal()],
        ["operator", new Address(OPERATOR).toScVal()],
        ["payee", new Address(PAYEE).toScVal()],
        ["release_window", u64(release)],
        ["resolve_window", u64(300)],
        ["response_window", u64(120)],
        ["token", new Address("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA").toScVal()],
      ]);
    expect(decodeEscrowConfig(config(120))).toMatchObject({ operator: OPERATOR, payee: PAYEE, releaseWindowSeconds: 120, responseWindowSeconds: 120, resolveWindowSeconds: 300 });
    expect(() => decodeEscrowConfig(config(0))).toThrow(expect.objectContaining({ code: "EscrowError" }));
  });

  it("names the same keys, struct fields, statuses and storage version as contracts/purchase-escrow", () => {
    expect(CONTRACT_SOURCE).toMatch(/pub enum DataKey \{\s*Config,\s*\/\/\/[^\n]*\n\s*Allocated,\s*Purchase\(Bytes\),\s*\/\/\/[^\n]*\n\s*Payment\(BytesN<32>\),\s*\}/);
    const struct = /pub struct Purchase \{([\s\S]*?)\n\}/.exec(CONTRACT_SOURCE)?.[1] ?? "";
    const fields = [...struct.matchAll(/^\s+pub (\w+): ([^,]+),/gm)].map(([, name, type]) => [name, type]);
    expect(fields).toEqual([
      ["order_ref", "Bytes"],
      ["payer", "Address"],
      ["amount", "i128"],
      ["tx_hash", "BytesN<32>"],
      ["receipt_hash", "BytesN<32>"],
      ["status", "Status"],
      ["held_at", "u64"],
      ["shipped_at", "u64"],
      ["claim_hash", "Option<BytesN<32>>"],
      ["opened_at", "u64"],
      ["response_hash", "Option<BytesN<32>>"],
      ["verdict_hash", "Option<BytesN<32>>"],
      ["refund", "i128"],
      ["refund_owed", "i128"],
      ["closed_at", "u64"],
    ]);
    const config = /pub struct Config \{([\s\S]*?)\n\}/.exec(CONTRACT_SOURCE)?.[1] ?? "";
    expect([...config.matchAll(/^\s+pub (\w+): /gm)].map(([, name]) => name)).toEqual(["operator", "payee", "arbiter", "token", "release_window", "response_window", "resolve_window"]);
    // Purchases and the payment index in persistent storage, the Config in the instance: what the reads ask for.
    expect(CONTRACT_SOURCE).toContain("env.storage().persistent().get(&DataKey::Purchase(order_ref))");
    expect(CONTRACT_SOURCE).toContain("env.storage().persistent().get(&DataKey::Payment(tx_hash))");
    expect(CONTRACT_SOURCE).toContain("env.storage().instance().set(&DataKey::Config, &config)");
    expect(CONTRACT_SOURCE).toMatch(/pub enum Status \{\s*Held,\s*Shipped,\s*Released,\s*Disputed,\s*Responded,\s*Resolved,\s*Expired,\s*\}/);
    expect(CONTRACT_SOURCE).toContain(`pub const STORAGE_SCHEMA_VERSION: u32 = ${ESCROW_STORAGE_SCHEMA_VERSION};`);
    // `hold` answers these two codes when an earlier attempt already landed; the client treats them as "maybe held".
    expect(CONTRACT_SOURCE).toMatch(/OrderAlreadyHeld = 4,/);
    expect(CONTRACT_SOURCE).toMatch(/PaymentAlreadyHeld = 5,/);
  });

  it("tells the exact hold that was asked for from another one on the same payment", () => {
    const held = decodePurchase(purchaseScVal());
    const input = { orderRef: held.orderRef, payer: held.payer, amount: held.amountAtomic, txHash: held.txHash, receiptHash: held.receiptHash };
    expect(sameHold(held, input)).toBe(true);
    expect(sameHold(held, { ...input, receiptHash: "e".repeat(64) })).toBe(false);
    expect(sameHold(held, { ...input, amount: 1n })).toBe(false);
  });
});

describe("check 4, held: one payment, one receipt (T159, brecha 10)", () => {
  const purchase: EscrowPurchase = decodePurchase(purchaseScVal());
  const claims = {
    escrow: { contract: ESCROW },
    settlementTxHash: TX,
    orderId: "rehearsal-mv8hh8i3-f",
    payerAccount: PAYER,
    amountUSDCAtomic: "500000",
    merchantDid: `did:stellar:testnet:${OPERATOR}`,
    merchantAccount: PAYEE,
  };
  const reader = (held: EscrowPurchase | null, payee = PAYEE, operator = OPERATOR, wasmHash: string | null = PURCHASE_ESCROW_WASM_HASHES[0] ?? null): EscrowReader => ({
    contractId: ESCROW,
    config: async () => ({ operator, payee, arbiter: OPERATOR, token: PAYER, releaseWindowSeconds: 1, responseWindowSeconds: 1, resolveWindowSeconds: 1, wasmHash }),
    get: async () => held,
    byTx: async (tx) => (tx === held?.txHash ? held : null),
  });

  it("passes when the escrow holds this receipt for this payment, order, payer and amount", async () => {
    expect(await checkHeld(claims, RECEIPT, () => reader(purchase))).toEqual({ ok: true, escrow: ESCROW, status: "resolved" });
  });

  it.each([
    ["another receipt on the same payment", { ...purchase, receiptHash: "e".repeat(64) }, "the escrow holds another receipt for this payment"],
    ["another order", { ...purchase, orderRef: "ord_other" }, "the escrow holds this payment for another order"],
    ["another payer", { ...purchase, payer: OPERATOR }, "the escrow names another payer"],
    ["another amount", { ...purchase, amountAtomic: 1n }, "the escrow holds another amount"],
  ])("fails for %s, with the reason", async (_name, held, reason) => {
    expect(await checkHeld(claims, RECEIPT, () => reader(held))).toMatchObject({ ok: false, reason });
  });

  it("fails for a receipt citing a payment the escrow does not hold", async () => {
    expect(await checkHeld({ ...claims, settlementTxHash: "0".repeat(64) }, RECEIPT, () => reader(purchase))).toMatchObject({ ok: false, reason: "the escrow holds no purchase for this payment" });
  });

  it("fails when the escrow is another store's: other operator, or other payee", async () => {
    expect(await checkHeld(claims, RECEIPT, () => reader(purchase, PAYEE, PAYEE))).toMatchObject({ ok: false, reason: "the escrow's operator is not the account that signed the receipt" });
    expect(await checkHeld(claims, RECEIPT, () => reader(purchase, OPERATOR))).toMatchObject({ ok: false, reason: "the escrow pays another account than the receipt's merchantAccount" });
  });

  it("fails for a look-alike contract: same layout, other code, or no wasm at all", async () => {
    const reason = "the escrow does not run the purchase-escrow code this verifier knows";
    expect(await checkHeld(claims, RECEIPT, () => reader(purchase, PAYEE, OPERATOR, "0".repeat(64)))).toMatchObject({ ok: false, reason });
    // The retired escrow code (d0d1d877…) could freeze a refund (X-19): it is not trusted either.
    expect(await checkHeld(claims, RECEIPT, () => reader(purchase, PAYEE, OPERATOR, "d0d1d877ac479aa6367833f467e35ff90be581236c4c2b688dd313ca4cf802c4"))).toMatchObject({ ok: false, reason });
    expect(await checkHeld(claims, RECEIPT, () => reader(purchase, PAYEE, OPERATOR, null))).toMatchObject({ ok: false, reason });
  });

  it("trusts exactly the code the deployed escrows run", () => {
    const deployments = JSON.parse(readFileSync(new URL("../../../deployments/testnet.json", import.meta.url), "utf8")) as { purchaseEscrows: Record<string, { wasmHash: string }> };
    expect([...new Set(Object.values(deployments.purchaseEscrows).map((e) => e.wasmHash))].sort()).toEqual([...PURCHASE_ESCROW_WASM_HASHES].sort());
  });

  it("fails closed without a reader, or when the escrow cannot be read", async () => {
    expect(await checkHeld(claims, RECEIPT, undefined)).toMatchObject({ ok: false, reason: "no escrow reader configured" });
    const broken = (): EscrowReader => ({ contractId: ESCROW, config: () => Promise.reject(new Error("rpc down")), get: async () => null, byTx: async () => null });
    expect(await checkHeld(claims, RECEIPT, broken)).toMatchObject({ ok: false, reason: "could not read the escrow: rpc down" });
  });
});

describe("check 3 for a receipt paid into an escrow (T159, X-14)", () => {
  const horizon = (credited: { type: string; account: string; contract?: string }) =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/transactions/${TX}`)) return Response.json({ successful: true, ledger: 5_194_404, created_at: "2026-10-14T16:33:27Z" });
      if (url.includes(`/transactions/${TX}/effects`)) {
        return Response.json({
          _embedded: {
            records: [
              { type: "contract_debited", account: "GASPBKBEJM3IVZ3WEQLFUHKCYMW52XCLLNSBDW4TSPIWKMDPBRPJGYOU", contract: PAYER, amount: "0.0500000", asset_code: "USDC", asset_issuer: USDC_ISSUER },
              { ...credited, amount: "0.0500000", asset_code: "USDC", asset_issuer: USDC_ISSUER },
            ],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  const claims = { settlementTxHash: TX, payerAccount: PAYER, merchantAccount: PAYEE, amountUSDCAtomic: "500000", escrow: { contract: ESCROW } };
  // As Horizon reports it: the contract in `contract`, the transaction's source in `account`.
  const toEscrow = { type: "contract_credited", account: "GASPBKBEJM3IVZ3WEQLFUHKCYMW52XCLLNSBDW4TSPIWKMDPBRPJGYOU", contract: ESCROW };

  it("passes when the escrow contract was credited", async () => {
    expect(await checkSettlement(claims, { horizonUrl: "https://h.test", fetchImpl: horizon(toEscrow) })).toMatchObject({ ok: true });
  });

  it("fails when the money reached the merchant directly, or another contract", async () => {
    const reason = "the store's escrow was not credited the receipt's USDC amount in that transaction";
    expect(await checkSettlement(claims, { horizonUrl: "https://h.test", fetchImpl: horizon({ type: "account_credited", account: PAYEE }) })).toMatchObject({ ok: false, reason });
    expect(await checkSettlement(claims, { horizonUrl: "https://h.test", fetchImpl: horizon({ ...toEscrow, contract: PAYER }) })).toMatchObject({ ok: false, reason });
  });

  it("does not read the transaction's source as the credited party", async () => {
    const sourceIsEscrow = { type: "contract_credited", account: ESCROW, contract: PAYER };
    expect(await checkSettlement(claims, { horizonUrl: "https://h.test", fetchImpl: horizon(sourceIsEscrow) })).toMatchObject({ ok: false });
  });

  it("leaves a receipt without an escrow on the merchant's account, as before", async () => {
    const direct = { settlementTxHash: TX, payerAccount: PAYER, merchantAccount: PAYEE, amountUSDCAtomic: "500000" };
    expect(await checkSettlement(direct, { horizonUrl: "https://h.test", fetchImpl: horizon({ type: "account_credited", account: PAYEE }) })).toMatchObject({ ok: true });
    expect(await checkSettlement(direct, { horizonUrl: "https://h.test", fetchImpl: horizon(toEscrow) })).toMatchObject({ ok: false });
  });
});

describe("EscrowClient.hold, when an earlier attempt already landed (T159)", () => {
  const operator = Keypair.random();
  const input = { orderRef: "rehearsal-mv8hh8i3-f", payer: PAYER, amount: 500_000n, txHash: TX, receiptHash: RECEIPT };
  const rpcRefusing = (message: string): EscrowRpc =>
    ({
      getAccount: async () => new Account(operator.publicKey(), "1"),
      prepareTransaction: () => Promise.reject(new Error(message)),
    }) as unknown as EscrowRpc;
  const client = (message: string) => new EscrowClient({ contractId: ESCROW, rpcUrl: "https://rpc.test", networkPassphrase: "Test SDF Network ; September 2015", server: rpcRefusing(message) });
  const simulation = (code: number) => `HostError: Error(Contract, #${code})\nEvent log (newest first): ["contract call failed", hold]`;

  it.each([4, 5])("reports the same purchase as already held when the contract answers #%i", async (code) => {
    const c = client(simulation(code));
    vi.spyOn(c, "byTx").mockResolvedValue(decodePurchase(purchaseScVal()));
    expect(await c.hold(input, operator.secret())).toEqual({ txHash: undefined, ledger: 0, alreadyHeld: true });
  });

  it("refuses when the payment is held as a different purchase", async () => {
    const c = client(simulation(5));
    vi.spyOn(c, "byTx").mockResolvedValue({ ...decodePurchase(purchaseScVal()), receiptHash: "e".repeat(64) });
    await expect(c.hold(input, operator.secret())).rejects.toMatchObject({ code: "EscrowError", message: "this payment or order is already held as a different purchase" });
  });

  it("refuses when the order is held with another payment: nothing on chain backs this one", async () => {
    const c = client(simulation(4));
    vi.spyOn(c, "byTx").mockResolvedValue(null);
    await expect(c.hold(input, operator.secret())).rejects.toMatchObject({ code: "EscrowError" });
  });

  it("does not read any other contract error as already held", async () => {
    const c = client(simulation(6)); // InsufficientUnallocated
    const byTx = vi.spyOn(c, "byTx");
    await expect(c.hold(input, operator.secret())).rejects.toMatchObject({ code: "EscrowError", message: expect.stringContaining("simulation of hold failed") });
    expect(byTx).not.toHaveBeenCalled();
    await expect(client(simulation(45)).hold(input, operator.secret())).rejects.toMatchObject({ message: expect.stringContaining("simulation of hold failed") });
  });
});
