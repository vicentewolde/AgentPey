import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { VitrineeError } from "@vitrinee/core";

import { anchorArgs, countKey, decodeRecord, isAlreadyAnchored, receiptKey, type AnchoredRecord } from "./scval.js";

export interface RegistryConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

/** What verification needs: read-only, so a verifier never holds a key. */
export interface RegistryReader {
  get(hashHex: string): Promise<AnchoredRecord | null>;
}

export interface AnchorInput {
  hash: string;
  amount: bigint;
  orderRef: string;
}

export interface AnchorResult {
  /** `undefined` when the hash was already anchored by an earlier attempt. */
  txHash: string | undefined;
  ledger: number;
  alreadyAnchored: boolean;
}

/** Soroban RPC client for `receipt-registry`. */
export class ReceiptRegistryClient implements RegistryReader {
  readonly contractId: string;
  private readonly server: rpc.Server;
  private readonly contract: Contract;

  constructor(private readonly config: RegistryConfig) {
    this.contractId = config.contractId;
    this.server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
    this.contract = new Contract(config.contractId);
  }

  private async readPersistent(key: xdr.ScVal): Promise<xdr.ScVal | null> {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: this.contract.address().toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const { entries } = await this.server.getLedgerEntries(ledgerKey);
    const entry = entries[0];
    if (entry === undefined) return null;
    const data = entry.val;
    if (data.type !== "contractData") return null;
    return data.contractData.val;
  }

  async get(hashHex: string): Promise<AnchoredRecord | null> {
    const value = await this.readPersistent(receiptKey(hashHex));
    return value === null ? null : decodeRecord(value);
  }

  async count(merchant: string): Promise<number> {
    const value = await this.readPersistent(countKey(merchant));
    return value === null ? 0 : Number(scValToNative(value));
  }

  /**
   * Anchors a receipt hash, signed and paid by the merchant's signing key
   * (source-account auth satisfies `merchant.require_auth()`). Idempotent:
   * a hash an earlier attempt already anchored is reported, not retried.
   */
  async anchor(input: AnchorInput, signingSecret: string): Promise<AnchorResult> {
    const signer = Keypair.fromSecret(signingSecret);
    const merchant = signer.publicKey();
    const account = await this.server.getAccount(merchant);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.config.networkPassphrase })
      .addOperation(this.contract.call("anchor", ...anchorArgs({ ...input, merchant })))
      .setTimeout(60)
      .build();

    let prepared;
    try {
      prepared = await this.server.prepareTransaction(tx);
    } catch (error) {
      if (isAlreadyAnchored(error)) return this.existing(input.hash);
      throw new VitrineeError("AnchorError", `simulation of anchor failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`, { cause: error });
    }
    prepared.sign(signer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      throw new VitrineeError("AnchorError", `anchor submission ${sent.status}`, {
        details: { status: sent.status, hash: sent.hash, error: sent.errorResult?.result.type },
      });
    }
    const final = await this.server.pollTransaction(sent.hash, { attempts: 30 });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new VitrineeError("AnchorError", `anchor transaction ${final.status}`, { details: { hash: sent.hash, status: final.status } });
    }
    return { txHash: sent.hash, ledger: final.ledger, alreadyAnchored: false };
  }

  private async existing(hashHex: string): Promise<AnchorResult> {
    const record = await this.get(hashHex);
    if (record === null) {
      throw new VitrineeError("AnchorError", "contract reported AlreadyAnchored but the record is not readable", { details: { hash: hashHex } });
    }
    return { txHash: undefined, ledger: record.ledger, alreadyAnchored: true };
  }
}
