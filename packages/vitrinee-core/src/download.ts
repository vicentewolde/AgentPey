/**
 * The download link of a digital product (T188, `Y-5`, `Y-11`).
 *
 * A digital order has no parcel: the store hands the file over a link, and the first download is the delivery, which
 * opens the escrow's release window. Order pages are public (anyone holding a receipt reads them), so the link is not
 * a secret the store prints there: it is signed, for a few minutes, by whoever paid, with their own Stellar key (the
 * agent key that owns the rail that paid, the rail's principal, or the classic account that paid). The store checks
 * the signature and that the signer is that payer; nothing is stored to issue it, and a chat can mint a fresh one
 * whenever the person asks for the file again.
 *
 * Shared by the store, which verifies, and AgentPey's MCP, which signs.
 */
import { Keypair } from "@stellar/stellar-base";

/** How far ahead a download link may expire: long enough to click it, short enough that a leaked link soon dies. */
export const DOWNLOAD_LINK_MAX_SECONDS = 15 * 60;

export interface DownloadLink {
  /** The store's own host (`agentcommerce.vitrinee.agentpey.com`): a link for one store never opens another's file. */
  readonly store: string;
  readonly orderId: string;
  /** The `G...` account that signs the link. */
  readonly reader: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

/** The exact bytes a reader signs. Line-separated, with a version, so no field can run into another. */
export function downloadLinkMessage(link: DownloadLink): Uint8Array {
  return new TextEncoder().encode(["vitrinee-download:v1", link.store.toLowerCase(), link.orderId, link.reader, String(link.expiresAt)].join("\n"));
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Who signs a link: any Stellar keypair, whichever SDK version made it. */
export interface DownloadSigner {
  publicKey(): string;
  sign(data: Buffer): Uint8Array;
}

/** The query of a download link: `reader`, `exp` and `sig` (hex Ed25519). */
export function signDownloadLink(signer: DownloadSigner, link: Omit<DownloadLink, "reader">): URLSearchParams {
  const full: DownloadLink = { ...link, reader: signer.publicKey() };
  return new URLSearchParams({ reader: full.reader, exp: String(full.expiresAt), sig: toHex(signer.sign(Buffer.from(downloadLinkMessage(full)))) });
}

/** Whether `sigHex` is the reader's signature over this link. Never throws: a malformed key or signature is `false`. */
export function verifyDownloadLink(link: DownloadLink, sigHex: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    return Keypair.fromPublicKey(link.reader).verify(Buffer.from(downloadLinkMessage(link)), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
