/**
 * Where an order's payment stands in the store's escrow, as `get_order` tells the chat (T161).
 *
 * The store's order shows `receipt.escrow`, but the store is the party a claim is against: what the chat repeats
 * comes from the escrow the signed receipt names, read on chain, never from the store's block (T161 review). The
 * store's block is only compared, and a difference is said out loud. A read that fails or a purchase the escrow does
 * not hold gives no state and a notice, never an error: the order and its receipt are still worth showing.
 */
import { AgentPassError } from "@agentpass/core";
import type { EscrowConfig, EscrowPurchase, EscrowReaderFactory } from "@vitrinee/anchor";
import { usdcAtomicToDecimal } from "@vitrinee/core";
import { z } from "zod";

export const ESCROW_READ_TIMEOUT_MS = 5_000;

const ESCROW_STATUSES = ["held", "shipped", "released", "disputed", "responded", "resolved", "expired"] as const;

/** The store's own block, read loosely: a malformed one is ignored, never a failed `get_order` (T161 review). */
const storeEscrowSchema = z.looseObject({ contract: z.string(), status: z.enum(ESCROW_STATUSES) });

export interface EscrowState {
  contract: string;
  status: EscrowPurchase["status"];
  meaning: string;
  amount_usdc: string;
  release_after: string | null;
  respond_by: string | null;
  resolve_by: string | null;
  refund_usdc: string;
  refund_owed_usdc: string;
}

export interface EscrowView {
  escrow: EscrowState | null;
  /** Something the person should hear about the escrow that `escrow` alone does not say; null when nothing. */
  escrow_notice: string | null;
}

type Windows = Pick<EscrowConfig, "releaseWindowSeconds" | "responseWindowSeconds" | "resolveWindowSeconds">;

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const usdc = (atomic: bigint): string => `${usdcAtomicToDecimal(atomic)} USDC`;

/** Each state in a sentence with its own amounts and dates, ready for the person (T161 review). */
export function escrowMeaning(p: EscrowPurchase, w: Windows, now: Date): string {
  const nowS = Math.floor(now.getTime() / 1000);
  const owed = p.refundOwedAtomic > 0n ? ` ${usdc(p.refundOwedAtomic)} of the refund could not be delivered yet and waits in the escrow until claim_refund delivers it.` : "";
  switch (p.status) {
    case "held":
      return `The payment of ${usdc(p.amountAtomic)} is held in the store's escrow. It goes to the store only after the order ships and the release window closes; a claim can be opened until then.`;
    case "shipped": {
      const releaseAfter = (p.shippedAt ?? 0) + w.releaseWindowSeconds;
      return nowS < releaseAfter
        ? `The store marked the order shipped. The payment of ${usdc(p.amountAtomic)} stays held until ${iso(releaseAfter)}; a claim can be opened before then.`
        : `The store marked the order shipped and the release window closed on ${iso(releaseAfter)} with no claim: the store can now collect the ${usdc(p.amountAtomic)}.`;
    }
    case "released":
      return `The release window closed with no claim: the escrow paid the store ${usdc(p.amountAtomic)}.`;
    case "disputed": {
      const respondBy = (p.openedAt ?? 0) + w.responseWindowSeconds;
      const resolveBy = respondBy + w.resolveWindowSeconds;
      return nowS <= respondBy
        ? `A claim is open: the payment of ${usdc(p.amountAtomic)} stays held, and the store has until ${iso(respondBy)} to answer.`
        : `A claim is open and the store did not answer by ${iso(respondBy)}: the payment stays held, and the arbiter decides before ${iso(resolveBy)}.`;
    }
    case "responded":
      return `The store answered the claim: the payment of ${usdc(p.amountAtomic)} stays held, and the arbiter decides before ${iso((p.openedAt ?? 0) + w.responseWindowSeconds + w.resolveWindowSeconds)}.`;
    case "resolved":
      if (p.refundAtomic === 0n) return `The arbiter decided for the store: nothing was refunded, and the escrow paid the store ${usdc(p.amountAtomic)}.`;
      if (p.refundAtomic >= p.amountAtomic) return `The arbiter decided for the payer: the full ${usdc(p.amountAtomic)} went back to the payer from the held payment.${owed}`;
      return `The arbiter decided: ${usdc(p.refundAtomic)} went back to the payer from the held payment, and ${usdc(p.amountAtomic - p.refundAtomic)} to the store.${owed}`;
    case "expired":
      return `The arbiter did not decide in time: the escrow refunded the payer the full ${usdc(p.amountAtomic)}.${owed}`;
  }
}

/**
 * The order's escrow state, from the chain.
 *
 * @param signed what the signed receipt says: its hash and the escrow it names (no contract: paid directly); null when
 *   the receipt does not check out as this order's
 * @param storeBlock the store's `receipt.escrow`, unparsed: only compared
 */
export async function readEscrowState(input: {
  orderId: string;
  signed: { receiptHash: string; contract: string | undefined } | null;
  storeBlock: unknown;
  readers: EscrowReaderFactory | undefined;
  now: Date;
  timeoutMs?: number;
}): Promise<EscrowView> {
  const store = input.storeBlock === undefined ? null : storeEscrowSchema.safeParse(input.storeBlock);
  if (input.signed === null) {
    return { escrow: null, escrow_notice: store === null ? null : "The order's receipt does not check out as this order's, so no escrow state is shown for it." };
  }
  const contract = input.signed.contract;
  if (contract === undefined) {
    // A receipt that names no escrow was paid straight to the store: an escrow block next to it is the store's word only.
    return { escrow: null, escrow_notice: store === null ? null : "The store's order shows an escrow, but its signed receipt names none: the payment went straight to the store, and that escrow state is not shown." };
  }
  if (input.readers === undefined) return { escrow: null, escrow_notice: "The receipt names an escrow, but it could not be read on Stellar from here." };
  const timeoutMs = input.timeoutMs ?? ESCROW_READ_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  let purchase: EscrowPurchase | null;
  let config: EscrowConfig;
  try {
    const reader = input.readers(contract);
    [purchase, config] = await Promise.race([
      Promise.all([reader.get(input.orderId), reader.config()]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentPassError("NetworkError", `the escrow gave no answer in ${timeoutMs} ms`, { details: { contract, timeoutMs } })), timeoutMs);
      }),
    ]);
  } catch {
    return { escrow: null, escrow_notice: "Could not read the store's escrow on Stellar right now; try again in a minute." };
  } finally {
    clearTimeout(timer);
  }
  if (purchase === null) {
    return { escrow: null, escrow_notice: "The payment went to the store's escrow, but the store has not recorded the purchase there yet: until it does, a claim cannot be opened." };
  }
  // The escrow holds a purchase for this order: it must be this receipt's, or it is another payment's.
  if (purchase.receiptHash !== input.signed.receiptHash) {
    return { escrow: null, escrow_notice: "The store's escrow holds a purchase for this order under a different receipt: the escrow state is not shown." };
  }
  const p = purchase;
  const w = config;
  try {
    const state: EscrowState = {
      contract,
      status: p.status,
      meaning: escrowMeaning(p, w, input.now),
      amount_usdc: usdcAtomicToDecimal(p.amountAtomic),
      release_after: p.shippedAt === null ? null : iso(p.shippedAt + w.releaseWindowSeconds),
      respond_by: p.openedAt === null ? null : iso(p.openedAt + w.responseWindowSeconds),
      resolve_by: p.openedAt === null ? null : iso(p.openedAt + w.responseWindowSeconds + w.resolveWindowSeconds),
      refund_usdc: usdcAtomicToDecimal(p.refundAtomic),
      refund_owed_usdc: usdcAtomicToDecimal(p.refundOwedAtomic),
    };
    const differs = store !== null && (!store.success || store.data.contract !== contract || store.data.status !== p.status);
    return { escrow: state, escrow_notice: differs ? "The store's order shows a different escrow state than the escrow on Stellar; this is the escrow's." : null };
  } catch {
    // A date out of range (RangeError): nothing trustworthy to show.
    return { escrow: null, escrow_notice: "The store's escrow answered with dates that cannot be read: the escrow state is not shown." };
  }
}
