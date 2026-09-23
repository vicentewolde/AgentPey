/**
 * Compact JWS with EdDSA over Ed25519, signed with a Stellar keypair. The
 * verifying key is the one inside the signer's `did:stellar`, so a receipt
 * verifies with nothing but itself — no key registry, no network.
 */
import { Keypair } from "@stellar/stellar-base";

import { parseStellarDid, stellarDid, type StellarNetworkName } from "./did.js";
import { VitrineeError } from "./errors.js";

export interface JwsHeader {
  alg: "EdDSA";
  typ: string;
  /** `did:stellar:<network>:G...#key-1` */
  kid: string;
}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function signJws(payload: unknown, secret: string, options: { typ: string; network?: StellarNetworkName }): string {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch (error) {
    // Never echo the secret, not even partially.
    throw new VitrineeError("ConfigError", "signing secret is not a valid Stellar secret seed", { cause: error });
  }
  const header: JwsHeader = {
    alg: "EdDSA",
    typ: options.typ,
    kid: `${stellarDid(keypair.publicKey(), options.network ?? "testnet")}#key-1`,
  };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = keypair.sign(Buffer.from(signingInput, "ascii"));
  return `${signingInput}.${b64url(signature)}`;
}

export interface DecodedJws {
  header: JwsHeader;
  payload: unknown;
  signingInput: string;
  signature: Buffer;
}

/** Parses without verifying. Throws `ReceiptInvalid` on anything that is not a well-formed compact JWS. */
export function decodeJws(compact: string): DecodedJws {
  const parts = compact.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !B64URL_RE.test(p))) {
    throw new VitrineeError("ReceiptInvalid", "not a compact JWS (three base64url segments)");
  }
  const [h, p, s] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch (error) {
    throw new VitrineeError("ReceiptInvalid", "JWS header or payload is not JSON", { cause: error });
  }
  const hd = header as Partial<JwsHeader> | null;
  if (hd === null || typeof hd !== "object" || hd.alg !== "EdDSA" || typeof hd.kid !== "string" || typeof hd.typ !== "string") {
    throw new VitrineeError("ReceiptInvalid", "JWS header must be {alg: EdDSA, typ, kid}", { details: { header } });
  }
  return { header: hd as JwsHeader, payload, signingInput: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

export interface JwsVerification {
  ok: boolean;
  /** The account whose key checked the signature, taken from `kid`. */
  signer: string | undefined;
  reason?: string;
}

/**
 * Verifies the signature against the key in `kid`. When `expectedDid` is
 * given, `kid` must also name that DID — otherwise anyone could sign a
 * receipt with their own key and point `kid` at it.
 */
export function verifyJws(decoded: DecodedJws, expectedDid?: string): JwsVerification {
  const did = decoded.header.kid.replace(/#.*$/, "");
  let account: string;
  try {
    account = parseStellarDid(did).account;
  } catch {
    return { ok: false, signer: undefined, reason: `kid is not a did:stellar key: ${decoded.header.kid}` };
  }
  if (expectedDid !== undefined && did !== expectedDid) {
    return { ok: false, signer: account, reason: `signed by ${did}, but the receipt names ${expectedDid}` };
  }
  if (decoded.signature.length !== 64) {
    return { ok: false, signer: account, reason: "Ed25519 signatures are 64 bytes" };
  }
  const valid = Keypair.fromPublicKey(account).verify(Buffer.from(decoded.signingInput, "ascii"), decoded.signature);
  return valid ? { ok: true, signer: account } : { ok: false, signer: account, reason: "signature does not match the content" };
}
