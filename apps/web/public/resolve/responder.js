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

/** Freighter returns a signature either as base64 already, or as bytes. */
export function toBase64Signature(signed) {
  if (typeof signed === "string") return signed;
  const bytes = new Uint8Array(signed);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** The file the merchant downloads and sends back to the arbiter. */
export function responseFile(response, signature) {
  return JSON.stringify({ response, signature }, null, 2) + "\n";
}
