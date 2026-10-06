/**
 * The server side of the wallet layer: where the bundled browser file is, so each app serves it from its own
 * origin (no CDN), and the list of wallets offered.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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

const integrities = new Map<string, { readonly stamp: string; readonly value: string }>();

/**
 * The Subresource Integrity value of a bundle (`sha384-…`), or `undefined` when it is not built. A page that pins it
 * loads exactly the file this server serves. Computed again whenever the file changes (its size or modification
 * time): a bundle rebuilt under a running server must not be announced with the old file's hash, or browsers block it.
 */
export function walletKitIntegrity(bundle: string = WALLET_KIT_BUNDLE): string | undefined {
  try {
    const { size, mtimeMs } = statSync(bundle);
    const stamp = `${size}:${mtimeMs}`;
    const known = integrities.get(bundle);
    if (known !== undefined && known.stamp === stamp) return known.value;
    const value = `sha384-${createHash("sha384").update(readFileSync(bundle)).digest("base64")}`;
    integrities.set(bundle, { stamp, value });
    return value;
  } catch {
    return undefined;
  }
}

/** A short fingerprint of an integrity value, for a cache-busting `?v=`: a new bundle is a new URL. */
export function walletKitVersion(integrity: string): string {
  return integrity.replace(/^sha384-/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
}
