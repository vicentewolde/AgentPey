/**
 * Wallets answer `signMessage` in different shapes: Freighter and Lobstr with base64 (or, in older versions,
 * bytes), Bitget with hex, some with a Node `Buffer` serialized as `{ type: "Buffer", data: [...] }`. The signing
 * screens send AgentPey's server one shape, the base64 of the 64-byte Ed25519 signature, and the server's SEP-53
 * check (`packages/core/src/sep53.ts`) is the same for every wallet.
 */
import { WalletError } from "./errors.js";

const ED25519_SIGNATURE_BYTES = 64;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function checked(bytes: Uint8Array | undefined, shape: string): string {
  if (bytes === undefined || bytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new WalletError("SignatureMalformed", `the wallet returned a signature (${shape}) that is not ${ED25519_SIGNATURE_BYTES} bytes`);
  }
  return toBase64(bytes);
}

/**
 * The wallet's signature as base64 of its 64 bytes.
 * @throws WalletError `SignatureMalformed` for anything that is not a 64-byte signature in a known shape
 */
export function normalizeSignature(value: unknown): string {
  if (value instanceof Uint8Array) return checked(value, "bytes");
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return checked(Uint8Array.from(value as number[]), "byte array");
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    return normalizeSignature((value as { data: unknown[] }).data);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^(0x)?[0-9a-fA-F]{128}$/.test(text)) {
      const hex = text.replace(/^0x/, "");
      return checked(Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16)), "hex");
    }
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return checked(fromBase64(text), "base64");
  }
  throw new WalletError("SignatureMalformed", "the wallet returned no signature in a known shape");
}
