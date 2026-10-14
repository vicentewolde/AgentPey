/**
 * A store's `purchase-escrow` (Fase 9, T157–T159): the store records a paid
 * purchase with `hold`, and a verifier reads it back to tie a receipt to the
 * one payment it was issued for (brecha 10).
 *
 * Reads go straight to the ledger with `getLedgerEntries` on hand-encoded
 * keys, like `receipt-registry` (`scval.ts`) and `agent-resolve`: no
 * simulation, no source account, no key held. `hold` is the one write, signed
 * and paid by the store's signing account (the escrow's `operator`, `X-4`).
 *
 * This mirrors `contracts/purchase-escrow/src/lib.rs` (`DataKey`, `Config`,
 * `Purchase`, `Status`, STORAGE_SCHEMA_VERSION 1). A test pins it to that
 * source; if the contract's layout changes, bump the version on both sides.
 */
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { VitrineeError } from "@vitrinee/core";
import { z } from "zod";

import { hashToBytes } from "./scval.js";

export const ESCROW_STORAGE_SCHEMA_VERSION = 1;

/**
 * The `purchase-escrow` code a verifier trusts: the SHA-256 of the deployed
 * wasm (`deployments/testnet.json`, `purchaseEscrows`). A contract that merely
 * stores the same layout would pass every other read; this is what makes "held"
 * mean the contract's own rules apply. The retired `d0d1d877…` is left out: it
 * could freeze a refund (`X-19`). A test pins this list to the deployments.
 */
export const PURCHASE_ESCROW_WASM_HASHES: readonly string[] = ["f5c6bbb6a54a017b71efd62e1aa87bd9b1babf5a688c74e253100586d6602fc5"];

export const ESCROW_STATUSES = ["held", "shipped", "released", "disputed", "responded", "resolved", "expired"] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export interface EscrowConfig {
  /** The store's signing account: records and ships purchases. */
  operator: string;
  /** The store's payout account: answers disputes and receives releases. */
  payee: string;
  arbiter: string;
  token: string;
  releaseWindowSeconds: number;
  responseWindowSeconds: number;
  resolveWindowSeconds: number;
  /** SHA-256 of the code the contract runs, hex; `null` when it is not a wasm contract. */
  wasmHash: string | null;
}

export interface EscrowPurchase {
  orderRef: string;
  payer: string;
  amountAtomic: bigint;
  txHash: string;
  receiptHash: string;
  status: EscrowStatus;
  heldAt: number;
  /** Unix seconds; `null` until shipped. */
  shippedAt: number | null;
  claimHash: string | null;
  /** Unix seconds; `null` until a dispute opens. */
  openedAt: number | null;
  responseHash: string | null;
  verdictHash: string | null;
  refundAtomic: bigint;
  /** A refund the payer could not receive yet (`X-19`). */
  refundOwedAtomic: bigint;
  /** Unix seconds; `null` while the purchase is open. */
  closedAt: number | null;
}

/** What verification needs: read-only, so a verifier never holds a key. */
export interface EscrowReader {
  readonly contractId: string;
  config(): Promise<EscrowConfig>;
  get(orderRef: string): Promise<EscrowPurchase | null>;
  /** The purchase a settled payment backs, if any. */
  byTx(txHash: string): Promise<EscrowPurchase | null>;
}

/** Builds a reader for whichever escrow a receipt names. */
export type EscrowReaderFactory = (contractId: string) => EscrowReader;

export interface HoldInput {
  orderRef: string;
  payer: string;
  amount: bigint;
  txHash: string;
  receiptHash: string;
}

export interface HoldResult {
  /** `undefined` when an earlier attempt already held this exact purchase. */
  txHash: string | undefined;
  ledger: number;
  alreadyHeld: boolean;
}

/** The part of `rpc.Server` the client uses: tests pass a fake. */
export type EscrowRpc = Pick<rpc.Server, "getLedgerEntries" | "getAccount" | "prepareTransaction" | "sendTransaction" | "pollTransaction">;

export interface EscrowClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  server?: EscrowRpc;
}

/** `DataKey::Purchase(Bytes)`: a contracttype enum encodes as `Vec[Symbol, ..fields]`. */
export function purchaseKey(orderRef: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Purchase"), xdr.ScVal.scvBytes(Buffer.from(orderRef, "utf8"))]);
}

/** `DataKey::Payment(BytesN<32>)`: payment transaction hash → order reference. */
export function paymentKey(txHash: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Payment"), xdr.ScVal.scvBytes(hashToBytes(txHash))]);
}

/** `DataKey::Config`, a unit variant: `Vec[Symbol]`. */
export function configKey(): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Config")]);
}

const bytes32 = z.instanceof(Uint8Array).refine((value) => value.length === 32, "expected 32 bytes");
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const seconds = z.union([z.bigint(), z.number().int()]).transform((value) => Number(value)).refine((value) => value >= 0, "a negative time");
const atomic = z.bigint().nonnegative();
const positiveSeconds = z.union([z.bigint(), z.number().int()]).transform((value) => Number(value)).refine((value) => value > 0, "a window of zero");

const statusMap = { Held: "held", Shipped: "shipped", Released: "released", Disputed: "disputed", Responded: "responded", Resolved: "resolved", Expired: "expired" } as const;

/** `Purchase` as `scValToNative` decodes it. A unit enum variant (`Status::Held`) arrives as `["Held"]`. */
const purchaseScSchema = z
  .object({
    order_ref: z.instanceof(Uint8Array).refine((value) => value.length >= 1 && value.length <= 64, "an order reference of 1 to 64 bytes"),
    payer: z.string(),
    amount: z.bigint().positive(),
    tx_hash: bytes32,
    receipt_hash: bytes32,
    status: z.tuple([z.enum(["Held", "Shipped", "Released", "Disputed", "Responded", "Resolved", "Expired"])]),
    held_at: seconds,
    shipped_at: seconds,
    claim_hash: bytes32.nullable().optional(),
    opened_at: seconds,
    response_hash: bytes32.nullable().optional(),
    verdict_hash: bytes32.nullable().optional(),
    refund: atomic,
    refund_owed: atomic,
    closed_at: seconds,
  })
  // The contract never refunds more than the purchase, nor owes more than it refunded.
  .refine((p) => p.refund <= p.amount && p.refund_owed <= p.refund, "refund above the purchase");

const configScSchema = z.object({
  operator: z.string(),
  payee: z.string(),
  arbiter: z.string(),
  token: z.string(),
  release_window: positiveSeconds,
  response_window: positiveSeconds,
  resolve_window: positiveSeconds,
});

const orNull = (value: number): number | null => (value === 0 ? null : value);

export function decodePurchase(value: xdr.ScVal): EscrowPurchase {
  const parsed = purchaseScSchema.safeParse(scValToNative(value));
  if (!parsed.success) {
    throw new VitrineeError("EscrowError", "purchase-escrow entry does not look like a Purchase", { details: { issues: parsed.error.issues.map((issue) => issue.message) } });
  }
  const p = parsed.data;
  return {
    orderRef: Buffer.from(p.order_ref).toString("utf8"),
    payer: p.payer,
    amountAtomic: p.amount,
    txHash: hex(p.tx_hash),
    receiptHash: hex(p.receipt_hash),
    status: statusMap[p.status[0]],
    heldAt: p.held_at,
    shippedAt: orNull(p.shipped_at),
    claimHash: p.claim_hash == null ? null : hex(p.claim_hash),
    openedAt: orNull(p.opened_at),
    responseHash: p.response_hash == null ? null : hex(p.response_hash),
    verdictHash: p.verdict_hash == null ? null : hex(p.verdict_hash),
    refundAtomic: p.refund,
    refundOwedAtomic: p.refund_owed,
    closedAt: orNull(p.closed_at),
  };
}

export function decodeEscrowConfig(value: xdr.ScVal, wasmHash: string | null = null): EscrowConfig {
  const parsed = configScSchema.safeParse(scValToNative(value));
  if (!parsed.success) {
    throw new VitrineeError("EscrowError", "purchase-escrow instance does not hold a Config", { details: { issues: parsed.error.issues.map((issue) => issue.message) } });
  }
  const c = parsed.data;
  return {
    operator: c.operator,
    payee: c.payee,
    arbiter: c.arbiter,
    token: c.token,
    releaseWindowSeconds: c.release_window,
    responseWindowSeconds: c.response_window,
    resolveWindowSeconds: c.resolve_window,
    wasmHash,
  };
}

/** The wasm hash of a contract instance's executable, in stellar-sdk 17's `{ type, <field> }` shape (Vitrinee rule 5). */
function wasmHashOf(executable: unknown): string | null {
  if (typeof executable !== "object" || executable === null) return null;
  const { type, wasmHash } = executable as { type?: unknown; wasmHash?: unknown };
  if (type !== "contractExecutableWasm" || typeof wasmHash !== "object" || wasmHash === null) return null;
  const hex = String((wasmHash as { toString(encoding: string): unknown }).toString("hex"));
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** The contract's own errors a `hold` can meet when an earlier attempt already landed. */
function isAlreadyHeld(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  // OrderAlreadyHeld = 4, PaymentAlreadyHeld = 5.
  return /Error\(Contract, #(4|5)\)/.test(text);
}

/** Soroban RPC client for one store's `purchase-escrow`. */
export class EscrowClient implements EscrowReader {
  readonly contractId: string;
  private readonly server: EscrowRpc;
  private readonly contract: Contract;

  constructor(private readonly config_: EscrowClientConfig) {
    this.contractId = config_.contractId;
    this.server = config_.server ?? new rpc.Server(config_.rpcUrl, { allowHttp: config_.rpcUrl.startsWith("http://") });
    this.contract = new Contract(config_.contractId);
  }

  private ledgerKey(key: xdr.ScVal): xdr.LedgerKey {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({ contract: this.contract.address().toScAddress(), key, durability: xdr.ContractDataDurability.persistent }),
    );
  }

  private async readPersistent(key: xdr.ScVal): Promise<xdr.ScVal | null> {
    const { entries } = await this.server.getLedgerEntries(this.ledgerKey(key));
    const data = entries[0]?.val;
    if (data === undefined || data.type !== "contractData") return null;
    return data.contractData.val;
  }

  async config(): Promise<EscrowConfig> {
    const instance = await this.readPersistent(xdr.ScVal.scvLedgerKeyContractInstance());
    // stellar-sdk 17: unions are `{ type, <field> }` objects (Vitrinee rule 5). Keys compare decoded: `DataKey::Config` is `["Config"]`.
    const storage = instance !== null && instance.type === "scvContractInstance" ? (instance.instance.storage ?? []) : [];
    const stored = storage.find((item) => JSON.stringify(scValToNative(item.key)) === JSON.stringify(["Config"]));
    if (stored === undefined) throw new VitrineeError("EscrowError", "this contract is not a deployed purchase-escrow", { details: { contractId: this.contractId } });
    return decodeEscrowConfig(stored.val, instance !== null && instance.type === "scvContractInstance" ? wasmHashOf(instance.instance.executable) : null);
  }

  async get(orderRef: string): Promise<EscrowPurchase | null> {
    const value = await this.readPersistent(purchaseKey(orderRef));
    return value === null ? null : decodePurchase(value);
  }

  async byTx(txHash: string): Promise<EscrowPurchase | null> {
    const ref = await this.readPersistent(paymentKey(txHash));
    if (ref === null) return null;
    const orderRef = scValToNative(ref) as unknown;
    if (!(orderRef instanceof Uint8Array)) throw new VitrineeError("EscrowError", "purchase-escrow payment index does not hold an order reference", { details: { txHash } });
    return this.get(Buffer.from(orderRef).toString("utf8"));
  }

  /**
   * Records a paid purchase, signed and paid by the store's signing account
   * (source-account auth satisfies `operator.require_auth()`). Idempotent: a
   * purchase an earlier attempt already held is reported, not retried; a
   * different purchase on the same payment or order is an error.
   */
  async hold(input: HoldInput, signingSecret: string): Promise<HoldResult> {
    const signer = Keypair.fromSecret(signingSecret);
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.config_.networkPassphrase })
      .addOperation(
        this.contract.call(
          "hold",
          nativeToScVal(Buffer.from(input.orderRef, "utf8"), { type: "bytes" }),
          new Address(input.payer).toScVal(),
          nativeToScVal(input.amount, { type: "i128" }),
          xdr.ScVal.scvBytes(hashToBytes(input.txHash)),
          xdr.ScVal.scvBytes(hashToBytes(input.receiptHash)),
        ),
      )
      .setTimeout(60)
      .build();

    let prepared;
    try {
      prepared = await this.server.prepareTransaction(tx);
    } catch (error) {
      if (isAlreadyHeld(error)) return this.existing(input);
      throw new VitrineeError("EscrowError", `simulation of hold failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`, { cause: error });
    }
    prepared.sign(signer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      throw new VitrineeError("EscrowError", `hold submission ${sent.status}`, { details: { status: sent.status, hash: sent.hash, error: sent.errorResult?.result.type } });
    }
    const final = await this.server.pollTransaction(sent.hash, { attempts: 30 });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new VitrineeError("EscrowError", `hold transaction ${final.status}`, { details: { hash: sent.hash, status: final.status } });
    }
    return { txHash: sent.hash, ledger: final.ledger, alreadyHeld: false };
  }

  private async existing(input: HoldInput): Promise<HoldResult> {
    const held = await this.byTx(input.txHash);
    if (held === null || !sameHold(held, input)) {
      throw new VitrineeError("EscrowError", "this payment or order is already held as a different purchase", {
        details: { orderRef: input.orderRef, txHash: input.txHash, held: held === null ? null : { orderRef: held.orderRef, receiptHash: held.receiptHash } },
      });
    }
    return { txHash: undefined, ledger: 0, alreadyHeld: true };
  }
}

/** Whether a purchase on chain is exactly the hold that was asked for. */
export function sameHold(held: EscrowPurchase, input: HoldInput): boolean {
  return held.orderRef === input.orderRef && held.payer === input.payer && held.amountAtomic === input.amount && held.txHash === input.txHash && held.receiptHash === input.receiptHash;
}

/**
 * A factory for verifiers: a client for whichever escrow a receipt names. No
 * cache: anyone can ask a store to verify a receipt naming any contract, and a
 * cache keyed by those would grow without bound.
 */
export function escrowReaders(options: { rpcUrl: string; networkPassphrase: string }): EscrowReaderFactory {
  return (contractId) => new EscrowClient({ contractId, ...options });
}
