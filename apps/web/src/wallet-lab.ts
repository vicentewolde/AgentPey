/**
 * The wallet lab (T143): what `/wallet-lab.html` asks the server, to fill the wallet-by-wallet table. Each wallet
 * signs a SEP-53 message and a test transaction; the server checks both with the code the real screens use, and
 * **sends nothing**: the transaction is built, its signature verified, and it is dropped.
 *
 * The message check is `verifyStellarMessage` of `@agentpass/core` (`sep53.ts`), the one every sign-in uses, over
 * a challenge from the same store; unlike `/api/wallet/verify` it creates no tenant, so a test leaves no trace.
 */
import { verifyStellarMessage } from "@agentpass/core";
import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { z } from "zod";

const accountSchema = z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "a Stellar account (G...)");

export const labMessageSchema = z.object({ address: accountSchema, nonce: z.string().min(1).max(200), signature: z.string().min(1).max(200) });
export const labTransactionSchema = z.object({ address: accountSchema });
export const labTransactionCheckSchema = z.object({ address: accountSchema, xdr: z.string().min(1).max(10_000) });

/** The manage-data entry the test transaction would write, if anyone ever sent it. Nobody does. */
export const LAB_DATA_NAME = "agentpey-wallet-lab";

export type LabResult = { readonly ok: true; readonly [key: string]: unknown } | { readonly ok: false; readonly code: string; readonly message: string };

/** Checks a wallet's SEP-53 signature over the challenge `nonce` was issued for. The caller has already taken the nonce. */
export function checkLabMessage(input: z.infer<typeof labMessageSchema>, message: string): LabResult {
  return verifyStellarMessage(input.address, message, input.signature)
    ? { ok: true, verified: true, address: input.address }
    : { ok: false, code: "InvalidSignature", message: "the signature does not verify as SEP-53 for that account" };
}

/**
 * An unsigned testnet transaction with `address` as its source: one manage-data operation, five minutes of
 * validity. `sequence` is the account's, when it exists on testnet; a wallet can sign it either way.
 */
export function buildLabTransaction(address: string, sequence: string, now: Date = new Date()): { xdr: string; hash: string } {
  const tx = new TransactionBuilder(new Account(address, sequence), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageData({ name: LAB_DATA_NAME, value: "1" }))
    .setTimebounds(Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000) + 300)
    .build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}

/** Whether `xdr` is the lab transaction for `address`, signed by `address`'s key. Never submitted. */
export function checkLabTransaction(input: z.infer<typeof labTransactionCheckSchema>): LabResult {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(input.xdr, Networks.TESTNET);
    if (!("source" in parsed) || "innerTransaction" in parsed) throw new TypeError("not a plain transaction");
    tx = parsed;
  } catch {
    return { ok: false, code: "InvalidArguments", message: "that is not a testnet transaction envelope" };
  }
  const isLab = tx.source === input.address && tx.operations.length === 1 && tx.operations[0]?.type === "manageData" && (tx.operations[0] as { name?: string }).name === LAB_DATA_NAME;
  if (!isLab) return { ok: false, code: "InvalidArguments", message: "that is not the lab's test transaction for this account" };
  const key = Keypair.fromPublicKey(input.address);
  const hint = Buffer.from(key.signatureHint());
  const hash = Buffer.from(tx.hash());
  const signed = tx.signatures.some((decorated) => {
    const wire = decorated.toXdrObject();
    return Buffer.from(wire.hint).equals(hint) && key.verify(hash, Buffer.from(wire.signature));
  });
  return signed ? { ok: true, verified: true, hash: hash.toString("hex") } : { ok: false, code: "InvalidSignature", message: "the transaction carries no valid signature by that account" };
}
