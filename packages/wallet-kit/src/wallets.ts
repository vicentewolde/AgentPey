/**
 * The wallets AgentPey's signing screens offer (T143, C-160), with what each can sign, as the user's wallet-by-wallet
 * check found it (docs/fase-8-agentes-reales/evidencia/T143.md). Every screen starts with a SEP-53 sign-in, so a
 * wallet that cannot sign messages is offered nowhere: Albedo and Rabet answer `signMessage` with "not supported" in
 * Stellar Wallets Kit 2.7.0. LOBSTR signs messages, but cannot be told the network and signed the lab's testnet
 * transaction for mainnet: it is offered only where no transaction is signed.
 */
export type Need = "message" | "transaction";

export const OFFERED_WALLETS = [
  { id: "freighter", name: "Freighter", signs: ["message", "transaction"] },
  { id: "xbull", name: "xBull", signs: ["message", "transaction"] },
  { id: "lobstr", name: "LOBSTR", signs: ["message"] },
  { id: "hana", name: "Hana", signs: ["message", "transaction"] },
] as const satisfies ReadonlyArray<{ id: string; name: string; signs: readonly Need[] }>;

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

/**
 * What a screen needs signed, from its script tag (`data-needs="message transaction"`). Unknown words are ignored;
 * nothing declared means both, the strictest.
 */
export function parseNeeds(declared: string | null | undefined): readonly Need[] {
  const words = (declared ?? "").split(/\s+/).filter((word): word is Need => word === "message" || word === "transaction");
  return words.length === 0 ? ["message", "transaction"] : [...new Set(words)];
}

/** The wallets that can sign everything a screen needs, in the order they are offered. */
export function walletsFor(needs: readonly Need[]): readonly OfferedWalletId[] {
  return OFFERED_WALLETS.filter((wallet) => needs.every((need) => (wallet.signs as readonly Need[]).includes(need))).map((wallet) => wallet.id);
}
