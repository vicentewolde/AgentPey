/**
 * The store's `purchase-escrow`, checked before the store opens (Fase 9, T160).
 *
 * With `ESCROW_CONTRACT_ID` set, both checkout doors charge into that contract
 * instead of the payout account, and every purchase is recorded there with
 * `hold` (T159). Before a single buyer is asked to pay, the store reads the
 * contract's own `config()` on chain and refuses to open unless it is this
 * store's escrow: the code AgentPey knows, the signing account as `operator`
 * (it signs `hold`, X-4), the payout account as `payee` (a release pays it)
 * and USDC as the token. A misconfigured escrow never falls back to charging
 * the payout account directly: the store stays closed and says why.
 */
import { EscrowClient, PURCHASE_ESCROW_WASM_HASHES, type EscrowReader } from "@vitrinee/anchor";
import { USDC_TESTNET, VitrineeError } from "@vitrinee/core";

import type { GatewayConfig, StoreEscrow } from "./config.js";

/**
 * The config with its escrow verified, ready for `createApp`. A store without
 * an escrow comes back unchanged. A Soroban RPC that cannot be reached throws
 * as the reader does: the platform tries again on the next request.
 *
 * @throws VitrineeError `ConfigError` when the contract is not this store's escrow
 */
export async function verifyStoreEscrow(config: GatewayConfig, reader?: Pick<EscrowReader, "config">): Promise<GatewayConfig> {
  if (config.escrowId === undefined) return config;
  const escrow = reader ?? new EscrowClient({ contractId: config.escrowId, rpcUrl: config.stellar.rpcUrl, networkPassphrase: config.stellar.networkPassphrase });
  const onChain = await escrow.config();
  const problems: string[] = [];
  if (onChain.wasmHash === null || !PURCHASE_ESCROW_WASM_HASHES.includes(onChain.wasmHash)) problems.push("it does not run the purchase-escrow code AgentPey knows");
  if (onChain.operator !== config.signing.account) problems.push("its operator is not the store's signing account");
  if (onChain.payee !== config.merchant.stellarAccount) problems.push("its payee is not the store's payout account");
  if (onChain.token !== USDC_TESTNET.contractId) problems.push("its token is not USDC");
  if (problems.length > 0) {
    throw new VitrineeError("ConfigError", `ESCROW_CONTRACT_ID is not this store's escrow: ${problems.join("; ")}`, {
      details: { escrow: config.escrowId, problems },
    });
  }
  const verified: StoreEscrow = {
    contract: config.escrowId,
    payee: onChain.payee,
    arbiter: onChain.arbiter,
    releaseWindowSeconds: onChain.releaseWindowSeconds,
    responseWindowSeconds: onChain.responseWindowSeconds,
    resolveWindowSeconds: onChain.resolveWindowSeconds,
  };
  return { ...config, escrow: verified };
}

/** Where a payment to this store goes: its escrow when it has one, its payout account otherwise. */
export function payToOf(config: GatewayConfig): string {
  return config.escrow?.contract ?? config.merchant.stellarAccount;
}
