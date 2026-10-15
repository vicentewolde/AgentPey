/**
 * The agent's side of a store's `purchase-escrow` (Fase 9, T160, X-9, X-20).
 *
 * A store with an escrow asks to be paid into a contract, not into its payout
 * account. Before anything is signed, {@link escrowVerifier} reads that
 * contract on chain and lets the payment through only when it runs the
 * `purchase-escrow` code the agent knows, settles disputes with an arbiter the
 * agent knows, holds the asset being paid, says what the store declares, and
 * releases to the very account the venue pins for that store. Then the escrow
 * is that store's account under the escrow's rules: a release pays the store,
 * a refund pays the buyer, and nothing else can move the money.
 *
 * The check hands back a {@link VerifiedEscrow}, the only thing
 * `toPaymentTerms` accepts as a contract payee: a caller cannot skip it.
 *
 * After the payment, {@link awaitHeld} looks for the purchase the store must
 * record with `hold`, for this order, amount, receipt and payer. A payment that reached the escrow but was never held is
 * unallocated: the buyer cannot claim it (X-20). It never throws: the money
 * already moved, and the answer is a warning the person can act on.
 *
 * The on-chain reads are injected ({@link EscrowLedger}): `@vitrinee/anchor`'s
 * `EscrowClient` has the shape, and nothing here holds a key.
 */
import { AgentPassError } from "@agentpass/core";
import type { StellarX402Escrow } from "@agentpey/ucp-stellar";

import { parseVenueId, type VenueId } from "../catalog/ids.js";
import type { VenueRegistry } from "../catalog/registry.js";

/** A `purchase-escrow`'s `config()`, as read on chain. */
export interface EscrowOnChain {
  readonly operator: string;
  readonly payee: string;
  readonly arbiter: string;
  readonly token: string;
  readonly releaseWindowSeconds: number;
  readonly responseWindowSeconds: number;
  readonly resolveWindowSeconds: number;
  /** SHA-256 of the code the contract runs, hex; `null` when it is not a wasm contract. */
  readonly wasmHash: string | null;
}

/** A purchase an escrow holds, as `by_tx` returns it. */
export interface EscrowHeldPurchase {
  readonly orderRef: string;
  readonly payer: string;
  readonly amountAtomic: bigint;
  readonly receiptHash: string;
}

/** Read-only access to any `purchase-escrow` by its contract id. */
export interface EscrowLedger {
  config(contract: string): Promise<EscrowOnChain>;
  byTx(contract: string, txHash: string): Promise<EscrowHeldPurchase | null>;
}

/** What the agent trusts in an escrow, and how long it looks for the hold after paying. */
export interface EscrowPolicy {
  readonly ledger: EscrowLedger;
  /** The `purchase-escrow` wasm hashes the agent knows (`PURCHASE_ESCROW_WASM_HASHES`). */
  readonly wasmHashes: readonly string[];
  /** The arbiters the agent accepts to settle a dispute: AgentResolve's. */
  readonly arbiters: readonly string[];
  /** How long to look for the hold after paying (default 30 s). */
  readonly heldWaitMs?: number;
  /** How often to look (default 3 s). */
  readonly heldPollMs?: number;
}

declare const verifiedEscrowBrand: unique symbol;
/**
 * An escrow {@link escrowVerifier} checked on chain: the only contract `toPaymentTerms` accepts as payee. Made only
 * by the verifier, so no caller can hand `toPaymentTerms` an escrow it did not check (the lesson of `B-25`).
 */
export type VerifiedEscrow = { readonly contract: string; readonly payee: string } & { readonly [verifiedEscrowBrand]: true };

/** Where a payment into an escrow stands, right after paying (X-20). */
export interface EscrowHold {
  readonly contract: string;
  /** The escrow holds this purchase: this order, this amount, this receipt. */
  readonly held: boolean;
  /** Set when `held` is false: what the person should know. */
  readonly warning?: string;
}

function unverified(message: string, details: Record<string, unknown>): AgentPassError {
  return new AgentPassError("EscrowUnverified", message, { details });
}

/**
 * The account a venue pins for a store: its registry `payTo`, or the address in its id (`slug:G…`). An escrow is
 * accepted only when it releases to exactly that account.
 */
export function pinnedAccountOf(venueId: VenueId, registry: VenueRegistry): string {
  return registry.venues.get(venueId)?.payTo ?? parseVenueId(venueId).address;
}

/**
 * The Stellar accounts a store signs with, from its profile's keys (`did:stellar:testnet:G…#…`): the receipt key,
 * which must also be its escrow's `operator` (X-4).
 */
export function storeSignersOf(keys: readonly unknown[] | undefined): string[] {
  const accounts = (keys ?? []).flatMap((key) => {
    const kid = typeof key === "object" && key !== null ? (key as { kid?: unknown }).kid : undefined;
    const account = typeof kid === "string" ? /^did:stellar:testnet:(G[A-Z2-7]{55})#/.exec(kid)?.[1] : undefined;
    return account === undefined ? [] : [account];
  });
  return [...new Set(accounts)];
}

/**
 * The check `pay()` runs before signing for a store that charges into an escrow (`verifyEscrow`). `operators` are the
 * store's signing accounts (`storeSignersOf`); `onVerified` receives the escrow once it passed, branded.
 *
 * @throws AgentPassError `EscrowUnverified` unless the contract on chain is a known `purchase-escrow` with a known
 * arbiter, run by the store's signing account, in the asset being paid, saying exactly what the store declares, and
 * releasing to the venue's account
 */
export function escrowVerifier(policy: EscrowPolicy, venueId: VenueId, registry: VenueRegistry, operators: readonly string[], onVerified: (escrow: VerifiedEscrow) => void) {
  return async (declared: Readonly<StellarX402Escrow>, context: { readonly asset: string; readonly storeUrl: string }): Promise<void> => {
    const pinned = pinnedAccountOf(venueId, registry);
    const details = { venueId, escrow: declared.contract, storeUrl: context.storeUrl };
    if (declared.payee !== pinned) {
      throw unverified("the store's escrow releases to another account than the one this store is paid at", { ...details, payee: declared.payee, expected: pinned });
    }
    let onChain: EscrowOnChain;
    try {
      onChain = await policy.ledger.config(declared.contract);
    } catch (error) {
      throw new AgentPassError("EscrowUnverified", "the store's escrow could not be read on chain; nothing was signed", { cause: error, details });
    }
    const problems: string[] = [];
    if (onChain.wasmHash === null || !policy.wasmHashes.includes(onChain.wasmHash)) problems.push("it does not run the purchase-escrow code the agent knows");
    if (!policy.arbiters.includes(onChain.arbiter)) problems.push("its arbiter is not one the agent accepts");
    if (!operators.includes(onChain.operator)) problems.push("its operator is not the key the store signs its receipts with");
    if (onChain.payee !== declared.payee) problems.push("its payee is not the one the store declares");
    if (onChain.arbiter !== declared.arbiter) problems.push("its arbiter is not the one the store declares");
    if (onChain.token !== context.asset) problems.push("it holds another asset than the one being paid");
    if (
      onChain.releaseWindowSeconds !== declared.release_window_seconds ||
      onChain.responseWindowSeconds !== declared.response_window_seconds ||
      onChain.resolveWindowSeconds !== declared.resolve_window_seconds
    ) {
      problems.push("its windows are not the ones the store declares");
    }
    if (problems.length > 0) throw unverified(`the store's escrow is not what it declares: ${problems.join("; ")}`, { ...details, problems, wasmHash: onChain.wasmHash });
    onVerified({ contract: declared.contract, payee: onChain.payee } as VerifiedEscrow);
  };
}

export interface AwaitHeldInput {
  readonly contract: string;
  /** The settlement transaction, as the store reported it. */
  readonly transaction: string | undefined;
  readonly orderId: string;
  /** Atomic units paid. */
  readonly amount: string;
  /** The store's receipt hash, when it issued one. */
  readonly receiptHash: string | undefined;
  /** Who paid: the rail, or the agent's own account. A refund goes to the `payer` the store recorded. */
  readonly payer: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks for the purchase the store must record with `hold` after this payment (X-20), for up to `heldWaitMs`.
 * Never throws: the payment was made, and what comes back is whether it is protected.
 */
export async function awaitHeld(policy: EscrowPolicy, input: AwaitHeldInput): Promise<EscrowHold> {
  const { contract } = input;
  if (input.transaction === undefined) {
    return { contract, held: false, warning: "the store reported no settlement transaction, so the escrow cannot be checked for this purchase" };
  }
  const deadline = Date.now() + (policy.heldWaitMs ?? 30_000);
  const poll = policy.heldPollMs ?? 3_000;
  let lastError: unknown;
  for (;;) {
    try {
      const held = await policy.ledger.byTx(contract, input.transaction);
      if (held !== null) {
        const mismatch =
          held.orderRef !== input.orderId
            ? "another order"
            : held.amountAtomic.toString() !== input.amount
              ? "another amount"
              : input.receiptHash !== undefined && held.receiptHash !== input.receiptHash
                ? "another receipt"
                : held.payer !== input.payer
                  ? "another payer, so a claim or a refund would not reach whoever paid"
                  : undefined;
        if (mismatch === undefined) return { contract, held: true };
        return { contract, held: false, warning: `the escrow holds this payment for ${mismatch}; open a claim with the order id` };
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() + poll > deadline) break;
    await sleep(poll);
  }
  return {
    contract,
    held: false,
    warning:
      lastError === undefined
        ? "the payment reached the store's escrow, but the store has not recorded the purchase yet; until it does, a claim cannot be opened. Check the order again in a few minutes"
        : "the store's escrow could not be read after paying; check the order again in a few minutes",
  };
}
