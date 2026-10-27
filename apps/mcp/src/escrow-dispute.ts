/**
 * A claim from the chat opens the dispute in the store's escrow (T162, X-28).
 *
 * The receipt names the escrow, but the store signs the receipt: `Shopper.openClaim` first verifies that the payment
 * credited that escrow and that it is the store's own (`verifyReceipt`'s settlement and held checks), so a decoy escrow
 * cannot take the dispute while the money sits elsewhere. Then, before anything is signed, the escrow is read on chain
 * and must hold this exact purchase: the known `purchase-escrow` code, an arbiter the agent accepts, the same order,
 * receipt, payment and amount, paid from this agent's own account, with the claim window still open. Any difference is a typed error and nothing is sent. Then the rail's owner signs the
 * escrow's message (spec §4.3, `X-18`) and sends `open` itself, paying the fee: no arbiter in between (`X-26`). The
 * network checks the signature again against the rail's `owner()`; a refusal there comes back typed too.
 */
import { AgentPassError } from "@agentpass/core";
import { signEscrowOpen } from "@agentpey/resolve";
import {
  PURCHASE_ESCROW_WASM_HASHES,
  escrowContractError,
  isSignatureRefused,
  type EscrowConfig,
  type EscrowDisputeOpenerFactory,
  type EscrowPurchase,
  type EscrowReaderFactory,
} from "@vitrinee/anchor";
import { isVitrineeError, stellarExpertTxUrl } from "@vitrinee/core";
import type { Keypair } from "@stellar/stellar-sdk";

import { ESCROW_READ_TIMEOUT_MS } from "./escrow-state.js";

/** What the chat hears about a dispute it just opened. */
export interface OpenedDispute {
  escrow: string;
  status: "disputed";
  transaction: string;
  explorer_url: string;
  /** Until when the store may answer, read back from the escrow; null if that read failed (the dispute is open anyway). */
  respond_by: string | null;
  resolve_by: string | null;
}

export interface ClaimableEscrow {
  contract: string;
  purchase: EscrowPurchase;
  config: EscrowConfig;
  readers: EscrowReaderFactory;
  openers: EscrowDisputeOpenerFactory;
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

async function withTimeout<T>(work: Promise<T>, contract: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentPassError("NetworkError", `the escrow gave no answer in ${timeoutMs} ms`, { details: { contract, timeoutMs } })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the escrow holds this purchase and a claim can still open a dispute on it. Reads only.
 *
 * @param payer the account this agent pays from: its rail (`C…`) or, without one, its own classic account
 * @param arbiters the arbiters the agent accepts when paying into an escrow (`X-9`); undefined: escrows are not trusted here
 * @throws AgentPassError `ConfigError` (no way to reach escrows from here), `NetworkError`, `EscrowUnverified`,
 *   `ResolveReceiptInvalid`, `ResolveClaimantNotPayer`, `ResolveDisputeExists`, `ResolveClaimWindowClosed`
 */
export async function checkClaimableEscrow(input: {
  contract: string;
  orderId: string;
  receipt: { hash: string; txHash: string; amountAtomic: bigint };
  payer: string;
  arbiters: readonly string[] | undefined;
  readers: EscrowReaderFactory | undefined;
  openers: EscrowDisputeOpenerFactory | undefined;
  now: Date;
  timeoutMs?: number;
}): Promise<ClaimableEscrow> {
  const { contract, arbiters } = input;
  const details = { escrow: contract, orderId: input.orderId };
  const { readers, openers } = input;
  if (readers === undefined || openers === undefined || arbiters === undefined) {
    throw new AgentPassError("ConfigError", "this order was paid into the store's escrow, and this server cannot open a dispute there; nothing was sent", { details });
  }
  let purchase: EscrowPurchase | null;
  let config: EscrowConfig;
  try {
    const reader = readers(contract);
    [purchase, config] = await withTimeout(Promise.all([reader.get(input.orderId), reader.config()]), contract, input.timeoutMs ?? ESCROW_READ_TIMEOUT_MS);
  } catch (error) {
    throw new AgentPassError("NetworkError", "could not read the store's escrow on Stellar; nothing was sent, try again in a minute", { cause: error, details });
  }
  // The same barrier as before paying (X-9): "held" only means the contract's rules apply if it runs the known code.
  if (config.wasmHash === null || !PURCHASE_ESCROW_WASM_HASHES.includes(config.wasmHash)) {
    throw new AgentPassError("EscrowUnverified", "the receipt's escrow does not run the purchase-escrow code AgentPey knows; nothing was sent", { details });
  }
  // The arbiter decides where the held money goes: only one the agent accepted when paying (X-9).
  if (!arbiters.includes(config.arbiter)) {
    throw new AgentPassError("EscrowUnverified", "the receipt's escrow names an arbiter AgentPey does not accept; nothing was sent", { details });
  }
  if (purchase === null) {
    throw new AgentPassError("ResolveReceiptInvalid", "the store has not recorded this purchase in its escrow yet, so a dispute cannot be opened there; nothing was sent", { details });
  }
  if (purchase.orderRef !== input.orderId || purchase.receiptHash !== input.receipt.hash || purchase.txHash !== input.receipt.txHash || purchase.amountAtomic !== input.receipt.amountAtomic) {
    throw new AgentPassError("ResolveReceiptInvalid", "the store's escrow holds a different purchase for this order than the signed receipt says; nothing was sent", { details });
  }
  if (purchase.payer !== input.payer) {
    throw new AgentPassError("ResolveClaimantNotPayer", "this purchase was paid from an account this agent does not control, so it cannot open the dispute; nothing was sent", {
      details: { ...details, payer: purchase.payer },
    });
  }
  const nowS = Math.floor(input.now.getTime() / 1000);
  switch (purchase.status) {
    case "held":
      break;
    case "shipped": {
      const releaseAfter = (purchase.shippedAt ?? 0) + config.releaseWindowSeconds;
      // The contract's own rule (X-15): open is refused from the second the release window closes.
      if (nowS >= releaseAfter) {
        throw new AgentPassError("ResolveClaimWindowClosed", `the claim window closed on ${iso(releaseAfter)}: the payment can only be released to the store now; nothing was sent`, { details });
      }
      break;
    }
    case "released":
      throw new AgentPassError("ResolveClaimWindowClosed", "the release window closed with no claim and the escrow already paid the store; nothing was sent", { details });
    case "disputed":
    case "responded":
    case "resolved":
    case "expired":
      throw new AgentPassError("ResolveDisputeExists", `this purchase already has a dispute in the store's escrow (${purchase.status}): one purchase, one dispute; nothing was sent`, {
        details: { ...details, status: purchase.status },
      });
  }
  return { contract, purchase, config, readers, openers };
}

/** Whether `open` certainly never took effect: refused before sending, or sent and failed (`EscrowClient`'s `stage`). */
function certainlyNotOpened(error: unknown): boolean {
  const stage = isVitrineeError(error) ? error.details["stage"] : undefined;
  return stage === "prepare" || stage === "simulate" || stage === "rejected" || stage === "failed";
}

/** The contract's refusal of `open`, said in words a chat can repeat. */
function refusal(error: unknown, contract: string): AgentPassError {
  const details = { escrow: contract };
  if (isSignatureRefused(error)) {
    return new AgentPassError("ResolveClaimantNotPayer", "the escrow refused the claim's signature: it is not from the owner of the account that paid. The dispute was not opened", { cause: error, details });
  }
  switch (escrowContractError(error)) {
    case 7:
      return new AgentPassError("ResolveReceiptInvalid", "the escrow has no purchase for this order. The dispute was not opened", { cause: error, details });
    case 8:
      return new AgentPassError("ResolveDisputeExists", "the purchase is no longer open to a claim in the escrow (it changed meanwhile). The dispute was not opened", { cause: error, details });
    case 10:
      return new AgentPassError("ResolveClaimWindowClosed", "the escrow's claim window closed. The dispute was not opened", { cause: error, details });
    case 11:
    case 12:
      return new AgentPassError("ResolveClaimantNotPayer", "the escrow could not take this payer's consent. The dispute was not opened", { cause: error, details });
    default:
      if (certainlyNotOpened(error)) return new AgentPassError("NetworkError", "Stellar did not take the dispute; nothing changed, try again in a minute", { cause: error, details });
      // A submission that timed out may still land: the chat must look before trying again.
      return new AgentPassError("NetworkError", "the dispute could not be confirmed on Stellar; read the order with get_order before trying again", { cause: error, details: { ...details, uncertain: true } });
  }
}

/**
 * Signs the escrow's message with the rail owner's key and sends `open`, paid by that same key. A classic payer
 * sends no signature: its transaction is the consent (`X-16`).
 */
export async function openEscrowDispute(input: {
  target: ClaimableEscrow;
  claimHash: string;
  agentKey: Keypair;
  timeoutMs?: number;
}): Promise<OpenedDispute> {
  const { contract, purchase, config, readers, openers } = input.target;
  // purchase.orderRef is the order id the claim is for: checkClaimableEscrow refuses any other.
  const sig = purchase.payer.startsWith("C") ? signEscrowOpen(contract, purchase.orderRef, input.claimHash, input.agentKey) : null;
  let sent: { txHash: string };
  try {
    sent = await openers(contract).open({ orderRef: purchase.orderRef, claimHash: input.claimHash, sig }, input.agentKey.secret());
  } catch (error) {
    throw refusal(error, contract);
  }
  // Read back for the dates: the dispute is open whatever this read says.
  let openedAt: number | null = null;
  try {
    const after = await withTimeout(readers(contract).get(purchase.orderRef), contract, input.timeoutMs ?? ESCROW_READ_TIMEOUT_MS);
    if (after?.status === "disputed" && after.claimHash === input.claimHash) openedAt = after.openedAt;
  } catch {
    openedAt = null;
  }
  return {
    escrow: contract,
    status: "disputed",
    transaction: sent.txHash,
    explorer_url: stellarExpertTxUrl(sent.txHash),
    respond_by: openedAt === null ? null : iso(openedAt + config.responseWindowSeconds),
    resolve_by: openedAt === null ? null : iso(openedAt + config.responseWindowSeconds + config.resolveWindowSeconds),
  };
}
