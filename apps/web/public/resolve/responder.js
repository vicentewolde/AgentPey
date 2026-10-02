/**
 * The merchant's side of an AgentResolve dispute, in the browser — T126 (`E-20`, `E-21`).
 *
 * Pure functions only: read a claim, build the response document, and the
 * exact message the wallet signs. The verifier (`packages/resolve/src/response.ts`)
 * rebuilds the same message from the same document, so the two must agree
 * byte for byte; `packages/resolve/src/responder-page.test.ts` imports this
 * file and holds them together. No dependencies: it runs as is in the page
 * and in Node.
 */

export const RESPONSE_TYPE = "AgentResolveResponse";
export const POSITIONS = ["accept_full", "accept_partial", "contest"];

/** Recursively sorts object keys, leaving arrays in order: `canonicalJson` in `@agentpass/core`. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlToText(part) {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The payload of a compact JWS, unverified: the page shows it; the arbiter verifies it. */
export function decodeJwsPayload(jws) {
  const parts = String(jws).trim().split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  return JSON.parse(base64UrlToText(parts[1]));
}

/**
 * A claim as the arbiter sent it: its document, the receipt inside it, and
 * its hash (`sha256` of the JWS, the `claim_hash` on chain). A forged claim
 * would carry a hash the chain does not hold, so a response to it is refused
 * when the arbiter decides.
 */
export async function readClaim(claimJws) {
  const jws = String(claimJws).trim();
  const claim = decodeJwsPayload(jws);
  if (!claim || claim.type !== "AgentResolveClaim" || !claim.receipt || typeof claim.receipt.jws !== "string") {
    throw new Error("not an AgentResolve claim");
  }
  const receipt = decodeJwsPayload(claim.receipt.jws);
  // Only what the page relies on; the arbiter verifies the rest.
  if (typeof claim.claimId !== "string" || !/^[1-9]\d*$/.test(String(claim.amountAtomic)) || publicKeyBytes(receipt && receipt.merchantAccount) === null) {
    throw new Error("not an AgentResolve claim");
  }
  return { claim, receipt, claimHash: await sha256Hex(jws) };
}

/** `5000000` → `0.5000000`: atomic units of a 7-decimal asset. Same as `formatAtomic` in the verifier. */
export function formatAtomic(atomic) {
  const padded = String(atomic).padStart(8, "0");
  return padded.slice(0, -7) + "." + padded.slice(-7);
}

/** `0.5` → `5000000`, or `null` for anything that is not a positive amount with at most 7 decimals. */
export function parseUsdc(text) {
  const match = /^\s*(\d+)(?:[.,](\d{1,7}))?\s*$/.exec(String(text));
  if (!match) return null;
  const atomic = (match[1] + (match[2] || "").padEnd(7, "0")).replace(/^0+(?=\d)/, "");
  return /^[1-9]\d*$/.test(atomic) ? atomic : null;
}

export function stellarDid(address) {
  return "did:stellar:testnet:" + address;
}

/**
 * The response document. Field order does not matter: the hash is over
 * canonical JSON. `acceptedAtomic` is set only for `accept_partial`.
 */
export function buildResponse(input) {
  return {
    type: RESPONSE_TYPE,
    responseId: input.responseId,
    respondent: stellarDid(input.address),
    receiptHash: input.claim.receipt.hash,
    claimHash: input.claimHash,
    claimId: input.claim.claimId,
    position: input.position,
    acceptedAtomic: input.position === "accept_partial" ? input.acceptedAtomic : null,
    // Trimmed here because the verifier's schema trims: the hash must be over what it parses.
    statement: input.statement.trim(),
    evidence: input.evidence.map((item) => ({ kind: item.kind, content: item.content.trim() })),
    createdAt: input.createdAt,
  };
}

export async function responseHash(response) {
  return sha256Hex(canonicalJson(response));
}

/** What Freighter shows and signs. Must equal `responseChallengeMessage` in the verifier. */
export async function responseChallengeMessage(response) {
  const position = response.acceptedAtomic === null ? response.position : response.position + " " + formatAtomic(response.acceptedAtomic) + " USDC";
  return [
    "AgentResolve merchant response",
    "Receipt: " + response.receiptHash,
    "Claim: " + response.claimHash,
    "Position: " + position,
    "Hash: " + (await responseHash(response)),
  ].join("\n");
}

/**
 * Freighter returns a signature as base64 already, or as bytes in one of
 * several shapes (Uint8Array, ArrayBuffer, a serialised Buffer, a plain object
 * of indices). Anything else is an empty string, which never verifies.
 */
export function toBase64Signature(signed) {
  if (typeof signed === "string") return signed;
  if (signed === null || typeof signed !== "object") return "";
  let values;
  if (signed instanceof ArrayBuffer) values = new Uint8Array(signed);
  else if (ArrayBuffer.isView(signed)) values = new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength);
  else if (Array.isArray(signed.data)) values = signed.data;
  else values = Object.values(signed);
  if (!values.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return "";
  let binary = "";
  for (const byte of values) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION = 6 << 3;

/** CRC16-XModem, the checksum of a Stellar strkey. */
function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The 32 raw bytes of a `G...` address, or `null` if it is not a valid one (checksum included). */
export function publicKeyBytes(address) {
  const text = String(address);
  if (!/^G[A-Z2-7]{55}$/.test(text)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const bytes = Uint8Array.from(out);
  if (bytes.length !== 35 || bytes[0] !== ED25519_PUBLIC_KEY_VERSION) return null;
  const expected = crc16(bytes.subarray(0, 33));
  if (bytes[33] !== (expected & 0xff) || bytes[34] !== expected >> 8) return null;
  return bytes.slice(1, 33);
}

/**
 * Checks a SEP-53 signature in the browser, as `verifyStellarMessage` does on
 * the arbiter's side: Ed25519 over `sha256("Stellar Signed Message:\n" + message)`.
 * `true` or `false`; `null` only when this browser has no Ed25519 in WebCrypto,
 * so the page can say it could not check instead of claiming it did.
 */
export async function verifySep53(address, message, signatureBase64) {
  const publicKey = publicKeyBytes(address);
  if (publicKey === null || !signatureBase64) return false;
  let signature;
  try {
    signature = Uint8Array.from(atob(signatureBase64), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("Stellar Signed Message:\n" + message));
  let key;
  try {
    key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, digest);
}

/** The file the merchant downloads and sends back to the arbiter. */
export function responseFile(response, signature) {
  return JSON.stringify({ response, signature }, null, 2) + "\n";
}
