/**
 * The wallets AgentPey's signing screens offer (T143, C-160). Every screen starts with a SEP-53 sign-in, so a
 * wallet that cannot sign messages is not offered at all: Albedo and Rabet answer `signMessage` with "not
 * supported" in Stellar Wallets Kit 2.7.0, and are left out. HOT works on mainnet only. The list is the one the
 * user's wallet-by-wallet check confirmed (docs/fase-8-agentes-reales/evidencia/T143.md).
 */
export const OFFERED_WALLETS = [
  { id: "freighter", name: "Freighter", signsMessages: true },
  { id: "xbull", name: "xBull", signsMessages: true },
  { id: "lobstr", name: "LOBSTR", signsMessages: true },
  { id: "hana", name: "Hana", signsMessages: true },
] as const;

export type OfferedWalletId = (typeof OFFERED_WALLETS)[number]["id"];

/** Wallets the kit knows but AgentPey does not offer, and why. Kept so the reason is not lost. */
export const LEFT_OUT_WALLETS = [
  { id: "albedo", why: "does not sign messages (SEP-53)" },
  { id: "rabet", why: "does not sign messages (SEP-53)" },
  { id: "hot-wallet", why: "mainnet only" },
] as const;

export function isOffered(id: string): id is OfferedWalletId {
  return OFFERED_WALLETS.some((wallet) => wallet.id === id);
}
