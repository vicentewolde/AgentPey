import { checkReceiptSignature, parseStellarDid, type ReceiptClaims } from "@vitrinee/core";

import type { RegistryReader } from "./registry.js";
import type { AnchoredRecord } from "./scval.js";
import { checkSettlement, type SettlementCheck } from "./settlement.js";

export interface ReceiptVerification {
  /** True only when all three checks pass. */
  valid: boolean;
  hash: string;
  receipt: ReceiptClaims | null;
  checks: {
    signature: { ok: boolean; signer?: string; reason?: string };
    anchored: { ok: boolean; reason?: string; record?: Omit<AnchoredRecord, "amount"> & { amount: string }; registry: string | null };
    settlement: SettlementCheck;
  };
}

export interface VerifyOptions {
  registry: (RegistryReader & { contractId?: string }) | null;
  horizonUrl: string;
  fetchImpl?: typeof fetch;
  settlementAttempts?: number;
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

  return {
    valid: signature.ok && anchored.ok && settlement.ok,
    hash,
    receipt: claims,
    checks: {
      signature: { ok: signature.ok, ...(signature.signer === undefined ? {} : { signer: signature.signer }), ...(signature.reason === undefined ? {} : { reason: signature.reason }) },
      anchored,
      settlement,
    },
  };
}

function safeAccount(did: string): string | undefined {
  try {
    return parseStellarDid(did).account;
  } catch {
    return undefined;
  }
}
