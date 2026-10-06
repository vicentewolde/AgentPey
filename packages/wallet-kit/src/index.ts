/**
 * The server side of the wallet layer: where the bundled browser file is, so each app serves it from its own
 * origin (no CDN), and the list of wallets offered.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export { OFFERED_WALLETS, LEFT_OUT_WALLETS, isOffered, parseNeeds, walletsFor, type Need, type OfferedWalletId } from "./wallets.js";
export { normalizeSignature } from "./signature.js";
export { WalletError, type WalletErrorCode } from "./errors.js";

/** The bundled browser file, built by `pnpm --filter @agentpey/wallet-kit run bundle` (part of `pnpm build`). */
export const WALLET_KIT_BUNDLE = fileURLToPath(new URL("../dist/wallet-kit.js", import.meta.url));
/** The path each app serves it at. */
export const WALLET_KIT_PATH = "/wallet-kit.js";

/** The external hosts the wallet picker loads images from (its wallet icons), for a page with a strict CSP. */
export const WALLET_KIT_IMAGE_HOSTS = ["https://stellar.creit.tech"] as const;

let integrity: string | undefined;

/**
 * The Subresource Integrity value of the bundle (`sha384-…`), computed once from the file, or `undefined` when it is
 * not built. A page that pins it loads exactly the file this server built.
 */
export function walletKitIntegrity(): string | undefined {
  if (integrity !== undefined) return integrity;
  try {
    integrity = `sha384-${createHash("sha384").update(readFileSync(WALLET_KIT_BUNDLE)).digest("base64")}`;
    return integrity;
  } catch {
    return undefined;
  }
}
