/**
 * The contract's storage keys and records, encoded by hand. This mirrors
 * `contracts/receipt-registry/src/lib.rs` (`DataKey`, `ReceiptRecord`,
 * STORAGE_SCHEMA_VERSION 1) so reads need no simulation and no source account.
 */
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { VitrineeError } from "@vitrinee/core";

export interface AnchoredRecord {
  /** The merchant account that anchored (its signing key, V-8). */
  merchant: string;
  /** USDC atomic units. */
  amount: bigint;
  orderRef: string;
  ledger: number;
  /** Unix seconds, ledger close time. */
  timestamp: number;
}

export function hashToBytes(hashHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) {
    throw new VitrineeError("ValidationError", "receipt hash must be 64 lowercase hex characters", { details: { hash: hashHex } });
  }
  return Buffer.from(hashHex, "hex");
}

/** `DataKey::Receipt(BytesN<32>)` — a contracttype enum encodes as `Vec[Symbol, ..fields]`. */
export function receiptKey(hashHex: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Receipt"), xdr.ScVal.scvBytes(hashToBytes(hashHex))]);
}

/** `DataKey::Count(Address)` */
export function countKey(merchant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Count"), new Address(merchant).toScVal()]);
}

export function anchorArgs(input: { hash: string; merchant: string; amount: bigint; orderRef: string }): xdr.ScVal[] {
  if (input.amount <= 0n) {
    throw new VitrineeError("ValidationError", "anchored amount must be positive", { details: { amount: input.amount.toString() } });
  }
  return [
    xdr.ScVal.scvBytes(hashToBytes(input.hash)),
    new Address(input.merchant).toScVal(),
    nativeToScVal(input.amount, { type: "i128" }),
    xdr.ScVal.scvBytes(Buffer.from(input.orderRef, "utf8")),
  ];
}

export function decodeRecord(value: xdr.ScVal): AnchoredRecord {
  const native = scValToNative(value) as Record<string, unknown>;
  const merchant = native["merchant"];
  const amount = native["amount"];
  const orderRef = native["order_ref"];
  const ledger = native["ledger"];
  const timestamp = native["timestamp"];
  if (typeof merchant !== "string" || typeof amount !== "bigint" || !(orderRef instanceof Uint8Array) || typeof ledger !== "number") {
    throw new VitrineeError("AnchorError", "registry entry does not look like a ReceiptRecord", { details: { keys: Object.keys(native) } });
  }
  return {
    merchant,
    amount,
    orderRef: Buffer.from(orderRef).toString("utf8"),
    ledger,
    timestamp: Number(timestamp),
  };
}

/** Recognises the contract's `Error::AlreadyAnchored` (#1) in a simulation or submission failure. */
export function isAlreadyAnchored(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /Error\(Contract, #1\)/.test(text);
}
