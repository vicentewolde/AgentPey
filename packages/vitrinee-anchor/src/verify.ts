import { checkReceiptSignature, parseStellarDid, type ReceiptClaims } from "@vitrinee/core";

import { PURCHASE_ESCROW_WASM_HASHES, type EscrowReaderFactory } from "./escrow.js";
import type { RegistryReader } from "./registry.js";
import type { AnchoredRecord } from "./scval.js";
import { checkSettlement, type SettlementCheck } from "./settlement.js";

/**
 * Check 4, only for a receipt that declares an escrow (T159): the escrow
 * holds this exact receipt next to the payment it cites, for the payer and the
 * amount it names, the escrow runs the `purchase-escrow` code this verifier
 * knows, and it belongs to the store that signed it.
 */
export interface HeldCheck {
  ok: boolean;
  reason?: string;
  escrow: string;
  status?: string;
}

export interface ReceiptVerification {
  /** True only when every check passes: three, or four when the receipt declares an escrow. */
  valid: boolean;
  hash: string;
  receipt: ReceiptClaims | null;
  checks: {
    signature: { ok: boolean; signer?: string; reason?: string };
    anchored: { ok: boolean; reason?: string; record?: Omit<AnchoredRecord, "amount"> & { amount: string }; registry: string | null };
    settlement: SettlementCheck;
    /** `null` for a receipt paid straight to the merchant. */
    held: HeldCheck | null;
  };
}

export interface VerifyOptions {
  registry: (RegistryReader & { contractId?: string }) | null;
  horizonUrl: string;
  fetchImpl?: typeof fetch;
  settlementAttempts?: number;
  /** Reads the escrow a receipt declares. Without it, a receipt with an escrow fails check 4: fail closed. */
  escrows?: EscrowReaderFactory;
}

/**
 * The three checks a receipt must pass, each independent of the gateway that
 * issued it: (1) signature against the key in the merchant's DID, (2) its
 * hash anchored in receipt-registry by that merchant for that amount and
 * order, (3) the settlement transaction on Stellar moved that USDC.
 */
export async function verifyReceipt(jws: string, options: VerifyOptions): Promise<ReceiptVerification> {
  const signature = checkReceiptSignature(jws);
  const { hash, claims } = signature;
  const registryId = options.registry?.contractId ?? null;

  let anchored: ReceiptVerification["checks"]["anchored"];
  if (options.registry === null) {
    anchored = { ok: false, reason: "no receipt registry configured", registry: null };
  } else {
    const record = await options.registry.get(hash);
    if (record === null) {
      anchored = { ok: false, reason: "this exact receipt is not anchored in the registry", registry: registryId };
    } else {
      const view = { ...record, amount: record.amount.toString() };
      const signer = claims === null ? undefined : safeAccount(claims.merchantDid);
      if (claims !== null && record.merchant !== signer) {
        anchored = { ok: false, reason: "anchored by a different merchant than the receipt names", record: view, registry: registryId };
      } else if (claims !== null && record.amount.toString() !== claims.amountUSDCAtomic) {
        anchored = { ok: false, reason: "anchored amount differs from the receipt", record: view, registry: registryId };
      } else if (claims !== null && record.orderRef !== claims.orderId) {
        anchored = { ok: false, reason: "anchored order reference differs from the receipt", record: view, registry: registryId };
      } else {
        anchored = { ok: true, record: view, registry: registryId };
      }
    }
  }

  const settlement: SettlementCheck =
    claims === null
      ? { ok: false, reason: "no readable receipt claims to check against the chain" }
      : await checkSettlement(claims, {
          horizonUrl: options.horizonUrl,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.settlementAttempts === undefined ? {} : { attempts: options.settlementAttempts }),
        });

  const held = claims?.escrow === undefined ? null : await checkHeld(claims, hash, options.escrows);

  return {
    valid: signature.ok && anchored.ok && settlement.ok && (held === null || held.ok),
    hash,
    receipt: claims,
    checks: {
      signature: { ok: signature.ok, ...(signature.signer === undefined ? {} : { signer: signature.signer }), ...(signature.reason === undefined ? {} : { reason: signature.reason }) },
      anchored,
      settlement,
      held,
    },
  };
}

/**
 * One payment, one receipt (brecha 10): the escrow's `by_tx` for the payment
 * this receipt cites must return this receipt, this order, this payer and this
 * amount. The escrow must run the known `purchase-escrow` code, or "held" would
 * promise rules nobody enforces. And it must be the signing store's: its
 * operator the receipt's signer and its payee the receipt's `merchantAccount`,
 * or a receipt could point at someone else's escrow.
 */
export async function checkHeld(
  claims: Pick<ReceiptClaims, "escrow" | "settlementTxHash" | "orderId" | "payerAccount" | "amountUSDCAtomic" | "merchantDid" | "merchantAccount">,
  receiptHash: string,
  escrows: EscrowReaderFactory | undefined,
): Promise<HeldCheck> {
  const escrow = claims.escrow?.contract ?? "";
  if (escrows === undefined) return { ok: false, escrow, reason: "no escrow reader configured" };
  try {
    const reader = escrows(escrow);
    const [config, purchase] = await Promise.all([reader.config(), reader.byTx(claims.settlementTxHash)]);
    const fail = (reason: string): HeldCheck => ({ ok: false, escrow, reason, ...(purchase === null ? {} : { status: purchase.status }) });
    // Same layout is not same rules: a look-alike contract could skip `hold`'s checks or pay itself.
    if (config.wasmHash === null || !PURCHASE_ESCROW_WASM_HASHES.includes(config.wasmHash)) return fail("the escrow does not run the purchase-escrow code this verifier knows");
    if (config.operator !== safeAccount(claims.merchantDid)) return fail("the escrow's operator is not the account that signed the receipt");
    if (config.payee !== claims.merchantAccount) return fail("the escrow pays another account than the receipt's merchantAccount");
    if (purchase === null) return fail("the escrow holds no purchase for this payment");
    if (purchase.receiptHash !== receiptHash) return fail("the escrow holds another receipt for this payment");
    if (purchase.orderRef !== claims.orderId) return fail("the escrow holds this payment for another order");
    if (purchase.payer !== claims.payerAccount) return fail("the escrow names another payer");
    if (purchase.amountAtomic.toString() !== claims.amountUSDCAtomic) return fail("the escrow holds another amount");
    return { ok: true, escrow, status: purchase.status };
  } catch (error) {
    return { ok: false, escrow, reason: `could not read the escrow: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
  }
}

function safeAccount(did: string): string | undefined {
  try {
    return parseStellarDid(did).account;
  } catch {
    return undefined;
  }
}
