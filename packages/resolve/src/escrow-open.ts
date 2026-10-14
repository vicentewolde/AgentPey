/**
 * The message a `policy_rail`'s owner signs to open a dispute in a
 * `purchase-escrow` contract (Fase 9, T157; spec §4.3).
 *
 * Byte for byte what `PurchaseEscrow::open_message` builds on chain: the
 * 32-byte domain, the escrow's 32-byte contract id, the claim hash (SHA-256 of
 * the compact claim JWS, as `claimHash` computes it), then the order
 * reference. Only the last part varies in length. The contract recomputes it
 * and checks the signature against the rail's `owner()`, so a claim signed
 * for one escrow or one order cannot open another.
 */
import { AgentPassError } from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk/base";

export const ESCROW_OPEN_DOMAIN = "agentpey/purchase-escrow/open/v1";
/** `receipt-registry`'s bound on an order reference; the escrow keeps the same one. */
export const ESCROW_MAX_ORDER_REF_BYTES = 64;

export function escrowOpenMessage(escrowContractId: string, orderRef: string, claimHashHex: string): Uint8Array {
  if (!StrKey.isValidContract(escrowContractId)) {
    throw new AgentPassError("InvalidArguments", "the escrow is a contract address (C…)", { details: { escrowContractId } });
  }
  if (!/^[0-9a-f]{64}$/.test(claimHashHex)) {
    throw new AgentPassError("InvalidArguments", "the claim hash is 64 lowercase hex characters", { details: { claimHashHex } });
  }
  const ref = new TextEncoder().encode(orderRef);
  if (ref.length === 0 || ref.length > ESCROW_MAX_ORDER_REF_BYTES) {
    throw new AgentPassError("InvalidArguments", `an order reference is 1 to ${ESCROW_MAX_ORDER_REF_BYTES} bytes`, { details: { orderRef } });
  }
  const domain = new TextEncoder().encode(ESCROW_OPEN_DOMAIN);
  const contract = StrKey.decodeContract(escrowContractId);
  const claim = Buffer.from(claimHashHex, "hex");
  const message = new Uint8Array(domain.length + contract.length + claim.length + ref.length);
  message.set(domain, 0);
  message.set(contract, domain.length);
  message.set(claim, domain.length + contract.length);
  message.set(ref, domain.length + contract.length + claim.length);
  return message;
}

/** The rail owner's Ed25519 signature over `escrowOpenMessage`: the `sig` argument of the escrow's `open`. */
export function signEscrowOpen(escrowContractId: string, orderRef: string, claimHashHex: string, railOwner: Keypair): Uint8Array {
  return railOwner.sign(Buffer.from(escrowOpenMessage(escrowContractId, orderRef, claimHashHex)));
}
