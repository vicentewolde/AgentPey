/**
 * The three keypairs a Vitrinee demo needs, and which env vars hold them.
 * Two merchant keys on purpose (docs/DECISIONES.md, V-8): the payout account
 * receives x402 settlements and its secret is never read by the gateway; the
 * signing key signs receipts and pays anchors and cannot move the payout.
 */
import { Keypair } from "@stellar/stellar-sdk";

export interface Role {
  id: "merchant-payout" | "merchant-signing" | "agent";
  label: string;
  publicVar: string;
  secretVar: string;
  /** Needs a USDC trustline: it will receive (merchant) or spend (agent) USDC. */
  usdcTrustline: boolean;
  publicComment: string;
  secretComment: string;
}

export const ROLES: readonly Role[] = [
  {
    id: "merchant-payout",
    label: "merchant payTo",
    publicVar: "MERCHANT_STELLAR_ACCOUNT",
    secretVar: "MERCHANT_PAYOUT_SECRET",
    usdcTrustline: true,
    publicComment: "Receives every x402 settlement (payTo in the manifest).",
    secretComment:
      "Bootstrap-only: opened the USDC trustline with it. The gateway never reads this variable (V-8).",
  },
  {
    id: "merchant-signing",
    label: "merchant signing",
    publicVar: "MERCHANT_SIGNING_ACCOUNT",
    secretVar: "MERCHANT_SIGNING_SECRET",
    usdcTrustline: false,
    publicComment: "did:stellar of the receipts; pays the receipt-registry anchor fees in XLM.",
    secretComment: "Signs receipt JWS and anchor transactions. Holds no USDC.",
  },
  {
    id: "agent",
    label: "agent (buyer)",
    publicVar: "AGENT_ACCOUNT",
    secretVar: "AGENT_SECRET_KEY",
    usdcTrustline: true,
    publicComment: "The demo buyer. Fund it with testnet USDC at https://faucet.circle.com",
    secretComment: "Signs the x402 auth entries in apps/agent.",
  },
];

export interface ResolvedRole {
  role: Role;
  keypair: Keypair;
  origin: "existing" | "generated";
}

/** Reuses the keypair already in `.env.local`; generates one only when the secret is absent. */
export function resolveKeypair(role: Role, env: Map<string, string>): ResolvedRole {
  const secret = env.get(role.secretVar);
  if (secret !== undefined && secret !== "") {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      throw new Error(`${role.secretVar} in .env.local is not a valid Stellar secret seed`);
    }
    const declared = env.get(role.publicVar);
    if (declared !== undefined && declared !== "" && declared !== keypair.publicKey()) {
      throw new Error(
        `${role.publicVar} (${declared}) does not match the key derived from ${role.secretVar} (${keypair.publicKey()}); fix .env.local by hand`,
      );
    }
    return { role, keypair, origin: "existing" };
  }
  return { role, keypair: Keypair.random(), origin: "generated" };
}
