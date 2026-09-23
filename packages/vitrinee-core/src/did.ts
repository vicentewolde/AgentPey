/**
 * `did:stellar` identifiers, the same convention AgentPey uses: the DID is the
 * Stellar public key, so the key that verifies a signature is derivable from
 * the identifier alone, with no registry lookup.
 */
import { StrKey } from "@stellar/stellar-base";

import { VitrineeError } from "./errors.js";

export const STELLAR_NETWORK_NAMES = ["testnet", "pubnet"] as const;
export type StellarNetworkName = (typeof STELLAR_NETWORK_NAMES)[number];

export const STELLAR_DID_RE = /^did:stellar:(testnet|pubnet):(G[A-Z2-7]{55})$/;

export function isStellarAccount(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

export function isStellarContractId(value: string): boolean {
  return StrKey.isValidContract(value);
}

export function stellarDid(account: string, network: StellarNetworkName = "testnet"): string {
  if (!isStellarAccount(account)) {
    throw new VitrineeError("ValidationError", "not a Stellar account public key (G...)", {
      details: { account },
    });
  }
  return `did:stellar:${network}:${account}`;
}

export function parseStellarDid(did: string): { network: StellarNetworkName; account: string } {
  const match = STELLAR_DID_RE.exec(did);
  const network = match?.[1] as StellarNetworkName | undefined;
  const account = match?.[2];
  if (!network || !account || !isStellarAccount(account)) {
    throw new VitrineeError("ValidationError", "not a did:stellar identifier", {
      details: { did },
    });
  }
  return { network, account };
}
