/**
 * Reads `receipt-registry` and AgentResolve entries for many receipt hashes in
 * two `getLedgerEntries` calls, one per contract (T151), through
 * `@vitrinee/anchor`'s own batched readers: its keys and decoding, its copy
 * of the Stellar SDK (two copies' `xdr` objects do not mix).
 */
import { AgentResolveReader, ReceiptRegistryClient } from "@vitrinee/anchor";

import type { DisputeEntry, ReceiptEntry } from "./live-activity.js";

export function createLedgerReader(config: { rpcUrl: string; networkPassphrase: string; registryId: string; resolveId: string }) {
  const registry = new ReceiptRegistryClient({ contractId: config.registryId, rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase });
  const resolve = new AgentResolveReader({ contractId: config.resolveId, rpcUrl: config.rpcUrl });
  return async function readLedger(hashes: readonly string[]): Promise<{ receipts: Map<string, ReceiptEntry>; disputes: Map<string, DisputeEntry> }> {
    const valid = [...new Set(hashes)].filter((hash) => /^[0-9a-f]{64}$/.test(hash)).slice(0, 200);
    const [receipts, disputes] = await Promise.all([registry.getMany(valid), resolve.getMany(valid)]);
    return { receipts, disputes };
  };
}
