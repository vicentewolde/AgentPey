/**
 * Reading a dispute from AgentPey's `agent-resolve` contract (Fase 7, T127).
 *
 * A UCP order shows whether its receipt is disputed, and how that ended. The
 * contract keys disputes by receipt hash, so a storefront reads one with
 * `getLedgerEntries` on a hand-encoded key, exactly like `receipt-registry`
 * (`scval.ts`): no simulation, no source account, no key held.
 *
 * This mirrors `contracts/agent-resolve/src/lib.rs` (`DataKey::Dispute`,
 * `Dispute`, `Status`, STORAGE_SCHEMA_VERSION 1). A test pins it to that
 * source; if the contract's layout changes, bump the version on both sides.
 */
import { Contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { VitrineeError } from "@vitrinee/core";
import { z } from "zod";

import { hashOfKey, hashToBytes } from "./scval.js";

export const AGENT_RESOLVE_STORAGE_SCHEMA_VERSION = 1;

export interface DisputeRecord {
  status: "open" | "resolved";
  /** The merchant account of the anchored receipt (its signing key, VT-8). */
  merchant: string;
  /** Who receives any refund: the receipt's payer. */
  payer: string;
  /** `sha256` of the signed claim, lowercase hex. */
  claimHash: string;
  /** Locked in the merchant's guarantee while open, in the receipt asset's atomic units. */
  amountAtomic: bigint;
  /** Unix seconds, ledger time. */
  openedAt: number;
  /** `sha256` of the verdict, set when resolved. */
  verdictHash: string | null;
  /** Paid back to the payer, atomic units. 0 while open, and when the claim was rejected. */
  refundAtomic: bigint;
  /** Unix seconds; `null` while open. */
  resolvedAt: number | null;
}

/** What a UCP order needs: read-only, keyed by receipt hash. */
export interface DisputeReader {
  readonly contractId: string;
  get(receiptHash: string): Promise<DisputeRecord | null>;
}

/** `DataKey::Dispute(BytesN<32>)`: a contracttype enum encodes as `Vec[Symbol, ..fields]`. */
export function disputeKey(receiptHash: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Dispute"), xdr.ScVal.scvBytes(hashToBytes(receiptHash))]);
}

const bytes32 = z.instanceof(Uint8Array).refine((value) => value.length === 32, "expected 32 bytes");
/** Ledger seconds, up to the last second a date can print (9999-12-31): beyond that `toISOString` throws. */
const MAX_SECONDS = 253_402_300_799n;
const u64 = z
  .union([z.bigint(), z.number().int()])
  .transform((value) => BigInt(value))
  .refine((value) => value >= 0n && value <= MAX_SECONDS, "a time outside any date")
  .transform((value) => Number(value));
const atomic = z.bigint().nonnegative();

/** `Dispute` as `scValToNative` decodes it. A unit enum variant (`Status::Open`) arrives as `["Open"]`. */
const disputeScSchema = z.object({
  merchant: z.string(),
  payer: z.string(),
  claim_hash: bytes32,
  amount: atomic,
  opened_at: u64,
  status: z.tuple([z.enum(["Open", "Resolved"])]),
  verdict_hash: bytes32.nullable().optional(),
  refund: atomic,
  resolved_at: u64,
})
  // The contract never pays back more than it locked (`RefundExceedsClaim`); a reader holds it to that too.
  .refine((d) => d.refund <= d.amount, "refund above the disputed amount");

export function decodeDispute(value: xdr.ScVal): DisputeRecord {
  const parsed = disputeScSchema.safeParse(scValToNative(value));
  if (!parsed.success) {
    throw new VitrineeError("AnchorError", "agent-resolve entry does not look like a Dispute", { details: { issues: parsed.error.issues.map((issue) => issue.message) } });
  }
  const d = parsed.data;
  const resolved = d.status[0] === "Resolved";
  return {
    status: resolved ? "resolved" : "open",
    merchant: d.merchant,
    payer: d.payer,
    claimHash: Buffer.from(d.claim_hash).toString("hex"),
    amountAtomic: d.amount,
    openedAt: d.opened_at,
    verdictHash: d.verdict_hash == null ? null : Buffer.from(d.verdict_hash).toString("hex"),
    refundAtomic: d.refund,
    resolvedAt: resolved ? d.resolved_at : null,
  };
}

export interface AgentResolveReaderConfig {
  contractId: string;
  rpcUrl: string;
}

/** Soroban RPC reader for `agent-resolve` disputes. */
export class AgentResolveReader implements DisputeReader {
  readonly contractId: string;
  private readonly server: rpc.Server;
  private readonly contract: Contract;

  constructor(config: AgentResolveReaderConfig) {
    this.contractId = config.contractId;
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
    this.contract = new Contract(config.contractId);
  }

  async get(receiptHash: string): Promise<DisputeRecord | null> {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: this.contract.address().toScAddress(),
        key: disputeKey(receiptHash),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const { entries } = await this.server.getLedgerEntries(ledgerKey);
    const entry = entries[0];
    if (entry === undefined || entry.val.type !== "contractData") return null;
    return decodeDispute(entry.val.contractData.val);
  }

  /** Many disputes in one `getLedgerEntries` call (T151); a receipt with no dispute is absent from the map. At most 200. */
  async getMany(receiptHashes: readonly string[]): Promise<Map<string, DisputeRecord>> {
    const unique = [...new Set(receiptHashes)];
    if (unique.length > 200) throw new VitrineeError("ValidationError", "at most 200 disputes per read", { details: { count: unique.length } });
    const found = new Map<string, DisputeRecord>();
    if (unique.length === 0) return found;
    const keys = unique.map((hash) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({ contract: this.contract.address().toScAddress(), key: disputeKey(hash), durability: xdr.ContractDataDurability.persistent }),
      ),
    );
    const { entries } = await this.server.getLedgerEntries(...keys);
    for (const entry of entries) {
      if (entry.val.type !== "contractData") continue;
      const hash = hashOfKey(entry.val.contractData.key, "Dispute");
      if (hash === null) continue;
      try {
        found.set(hash, decodeDispute(entry.val.contractData.val));
      } catch {
        // Left out rather than shown half-read.
      }
    }
    return found;
  }
}
