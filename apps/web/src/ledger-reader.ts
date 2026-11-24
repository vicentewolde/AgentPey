/**
 * Reads `receipt-registry` and AgentResolve entries for many receipt hashes in
 * two `getLedgerEntries` calls, one per contract (T151), through
 * `@vitrinee/anchor`'s own batched readers: its keys and decoding, its copy
 * of the Stellar SDK (two copies' `xdr` objects do not mix).
 */
import { AgentResolveReader, ReceiptRegistryClient, escrowReaders } from "@vitrinee/anchor";

import type { DisputeEntry, EscrowEntry, ReceiptEntry } from "./live-activity.js";

export function createLedgerReader(config: { rpcUrl: string; networkPassphrase: string; registryId: string; resolveId: string }) {
  const registry = new ReceiptRegistryClient({ contractId: config.registryId, rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase });
  const resolve = new AgentResolveReader({ contractId: config.resolveId, rpcUrl: config.rpcUrl });
  return async function readLedger(hashes: readonly string[]): Promise<{ receipts: Map<string, ReceiptEntry>; disputes: Map<string, DisputeEntry> }> {
    const valid = [...new Set(hashes)].filter((hash) => /^[0-9a-f]{64}$/.test(hash)).slice(0, 200);
    const [receipts, disputes] = await Promise.all([registry.getMany(valid), resolve.getMany(valid)]);
    return { receipts, disputes };
  };
}

/**
 * Reads one purchase from a store's `purchase-escrow` by its order (T195). The contract is the one the store's signed
 * receipt names; nothing is trusted from the store itself. One reader per contract, kept.
 */
export function createEscrowEntryReader(config: { rpcUrl: string; networkPassphrase: string }) {
  const readers = escrowReaders(config);
  const byContract = new Map<string, ReturnType<typeof readers>>();
  return async function readEscrow(contractId: string, orderRef: string): Promise<EscrowEntry | null> {
    let reader = byContract.get(contractId);
    if (reader === undefined) {
      reader = readers(contractId);
      byContract.set(contractId, reader);
    }
    const purchase = await reader.get(orderRef);
    if (purchase === null) return null;
    return {
      status: purchase.status,
      amountAtomic: purchase.amountAtomic,
      refundAtomic: purchase.refundAtomic,
      confirmedAt: purchase.confirmedAt ?? null,
      closedAt: purchase.closedAt,
    };
  };
}
