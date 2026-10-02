import { stellarAddressToDid } from "@agentpass/core";
import type { ReceiptClaims } from "@vitrinee/core";
import { RECEIPT_TYPE, STELLAR_TESTNET_CAIP2, signReceipt } from "@vitrinee/core";
import { Keypair } from "@stellar/stellar-sdk/base";

import type { AgentResolveClaim, VerifiedReceipt } from "../claim.js";

export const NOW = new Date("2026-10-02T12:00:00.000Z");
export const RAIL = "CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP";
export const PAID_ATOMIC = "15684211";

export const merchantKey = Keypair.random();
/** The merchant owner's wallet: the payout account in the receipt, which signs a response (T126). */
export const merchantOwnerKey = Keypair.random();
/** The rail's owner: the agent's key, the one allowed to speak for the rail. */
export const agentKey = Keypair.random();

export function receiptClaims(overrides: Partial<ReceiptClaims> = {}): ReceiptClaims {
  return {
    typ: RECEIPT_TYPE,
    orderId: "ord_mupk7srw006dfebad8",
    platformOrderId: "18946533884210",
    platform: "shopify",
    merchantDid: stellarAddressToDid(merchantKey.publicKey(), "testnet"),
    merchantAccount: merchantOwnerKey.publicKey(),
    payerAccount: RAIL,
    network: STELLAR_TESTNET_CAIP2,
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amountUSDC: "1.5684211",
    amountUSDCAtomic: PAID_ATOMIC,
    settlementTxHash: "06ff47cf38a4c1f8f22a9d4095c3cfb34b5d6ffd9c5914cb248fa299e2210ea6",
    items: [{ productId: "67624104591666", sku: "IMAN-01", name: "Imán de cobre Atacama", quantity: 1, unitPriceUSDC: "1.5684211", unitPriceUSDCAtomic: PAID_ATOMIC }],
    issuedAt: "2026-10-01T13:18:12.116Z",
    refundWindowEndsAt: "2026-10-11T13:18:12.116Z",
    ...overrides,
  };
}

/** A receipt signed with a real merchant key, standing in for one that passed its three checks. */
export function verifiedReceipt(overrides: Partial<ReceiptClaims> = {}): VerifiedReceipt & { jws: string } {
  const claims = receiptClaims(overrides);
  const { jws, hash } = signReceipt(claims, merchantKey.secret());
  return { valid: true, hash, receipt: claims, jws };
}

export function claimFor(receipt: { jws: string; hash: string }, overrides: Partial<AgentResolveClaim> = {}, signer: Keypair = agentKey): AgentResolveClaim {
  return {
    type: "AgentResolveClaim",
    claimId: "4b8a1f0e-2c3d-4e5f-9a6b-7c8d9e0f1a2b",
    claimant: stellarAddressToDid(signer.publicKey(), "testnet"),
    receipt: { hash: receipt.hash, jws: receipt.jws },
    reason: "not_delivered",
    description: "El pedido figura como pagado pero nunca llegó.",
    evidence: [{ kind: "text", content: "Sin número de seguimiento después de 8 días." }],
    amountAtomic: PAID_ATOMIC,
    createdAt: "2026-10-02T11:00:00.000Z",
    ...overrides,
  };
}

/** `policy_rail.owner()`, as the chain would answer it. */
export const railController = (payer: string): Promise<string> => Promise.resolve(payer === RAIL ? agentKey.publicKey() : "GNOBODY");
