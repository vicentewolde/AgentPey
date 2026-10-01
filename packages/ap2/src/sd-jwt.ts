/**
 * The slice of SD-JWT (RFC 9901) that AP2 open mandates need — T123, `E-8`.
 *
 * An AP2 mandate is an issuer-signed SD-JWT whose claim `delegate_payload` is
 * an array holding one selectively disclosable element: the mandate itself
 * (AP2 `agent_authorization.md`, "Trusted Agent Provider"). This module issues
 * and verifies exactly that shape: an issuer JWT followed by disclosures and a
 * trailing `~`, no Key Binding JWT. Presentations with KB-JWTs belong to closed
 * mandates, which T123 does not produce (`E-8`).
 *
 * Written on `jose` rather than an SD-JWT library because the format is small,
 * and because the two rules that matter here are this codebase's own:
 *
 * 1. **The key is the caller's, never the token's.** Which issuer to trust is
 *    a decision the verifier makes (same rule as `RegistryMismatch`); the
 *    header's `alg` must match that key's algorithm, so a token cannot pick a
 *    weaker one for itself.
 * 2. **The signature is verified before anything about the content.**
 *    Disclosures are resolved only against a payload the issuer signed.
 *
 * Algorithms (`E-9`): `EdDSA` for the real export, signed with a Stellar key
 * this codebase already holds; `ES256` because it is the one AP2 requires of
 * a merchant's Checkout JWT today, and the only `cnf` key type the AP2
 * reference SDK follows when an agent closes a mandate.
 */
import { createHash, randomBytes } from "node:crypto";

import { AgentPassError } from "@agentpass/core";
import { CompactSign, compactVerify, decodeProtectedHeader, importJWK } from "jose";
import type { JWK, ProtectedHeaderParameters } from "jose";

/** SD-JWT VC media type (`draft-ietf-oauth-sd-jwt-vc`). Distinct from every other `typ` this codebase signs. */
export const AP2_SD_JWT_TYP = "dc+sd-jwt";

/** The only digest algorithm issued or accepted. AP2 defaults to it when `_sd_alg` is absent. */
export const AP2_SD_ALG = "sha-256";

export type Ap2SigningAlg = "EdDSA" | "ES256";

/** A public key a mandate can be signed with, or bound to through `cnf`. */
export type Ap2PublicJwk =
  | { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string }
  | { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string };

export interface Ap2Signer {
  readonly alg: Ap2SigningAlg;
  /** Private JWK: `d` plus the public members. Never leaves the signer. */
  readonly privateJwk: JWK;
  /** Goes into the header as `kid`; a hint for the verifier, never the key itself. */
  readonly kid: string;
}

/** A selectively disclosable array element, `{"...": digest}` (RFC 9901 §4.2.4.2). */
export interface DigestPlaceholder {
  readonly "...": string;
}

const DIGEST_KEY = "...";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** `base64url(sha256(ascii))`: disclosure digests and `sd_hash` alike. */
export function sha256Base64Url(ascii: string): string {
  return base64Url(createHash("sha256").update(ascii, "ascii").digest());
}

/** The JOSE algorithm a public key signs with. One key, one algorithm. */
export function algForKey(jwk: Ap2PublicJwk): Ap2SigningAlg {
  return jwk.kty === "OKP" ? "EdDSA" : "ES256";
}

/**
 * Makes each element of `values` selectively disclosable: returns the
 * placeholders that go in the signed payload and appends one disclosure per
 * element to `sink`. A fresh 128-bit salt per disclosure, so a digest never
 * reveals its value to someone guessing (AP2 "Rainbow Table Attacks").
 */
export function disclosableArray(values: readonly unknown[], sink: string[]): DigestPlaceholder[] {
  return values.map((value) => {
    const disclosure = base64Url(Buffer.from(JSON.stringify([base64Url(randomBytes(16)), value]), "utf8"));
    sink.push(disclosure);
    return { [DIGEST_KEY]: sha256Base64Url(disclosure) };
  });
}

/** Signs `claims` and appends `disclosures`, in RFC 9901 compact form with no KB-JWT: `jwt~d1~…~dn~`. */
export async function issueSdJwt(
  claims: Readonly<Record<string, unknown>>,
  disclosures: readonly string[],
  signer: Ap2Signer,
): Promise<string> {
  const key = await importJWK(signer.privateJwk, signer.alg);
  const jwt = await new CompactSign(new TextEncoder().encode(JSON.stringify({ ...claims, _sd_alg: AP2_SD_ALG })))
    .setProtectedHeader({ alg: signer.alg, typ: AP2_SD_JWT_TYP, kid: signer.kid })
    .sign(key);
  return `${jwt}~${disclosures.map((disclosure) => `${disclosure}~`).join("")}`;
}

/**
 * `sd_hash` of an issued SD-JWT: the digest of the whole token, disclosures
 * included. AP2 uses it for `payment.reference` (`conditional_transaction_id`)
 * and for receipt references; the AP2 SDK computes it the same way
 * (`compute_sd_hash`).
 */
export function sdHash(token: string): string {
  parseSdJwt(token);
  return sha256Base64Url(token);
}

interface ParsedSdJwt {
  readonly issuerJwt: string;
  readonly disclosures: readonly string[];
}

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): AgentPassError {
  return new AgentPassError("Ap2MandateInvalid", message, { details, cause });
}

function parseSdJwt(token: string): ParsedSdJwt {
  if (!token.endsWith("~")) {
    throw invalid("an AP2 open mandate is an SD-JWT with no Key Binding JWT, so it must end with '~'");
  }
  const parts = token.split("~");
  const issuerJwt = parts[0] ?? "";
  const disclosures = parts.slice(1, -1);
  if (issuerJwt.split(".").length !== 3 || disclosures.some((disclosure) => disclosure === "")) {
    throw invalid("the SD-JWT is not `jwt~disclosure~…~`");
  }
  return { issuerJwt, disclosures };
}

export interface VerifiedSdJwt {
  readonly header: ProtectedHeaderParameters;
  /** The signed payload with every disclosure resolved into place and `_sd_alg` removed. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Verifies an SD-JWT against the caller's trusted issuer key, then resolves
 * its disclosures. Order: header → signature → `_sd_alg` → disclosures.
 *
 * @throws AgentPassError `Ap2MandateInvalid` — malformed, wrong `typ`, `alg` not the key's
 * @throws AgentPassError `Ap2SignatureInvalid` — not signed by that key
 * @throws AgentPassError `Ap2DisclosureMismatch` — a disclosure the issuer never signed, or one used twice
 */
export async function verifySdJwt(token: string, issuerKey: Ap2PublicJwk): Promise<VerifiedSdJwt> {
  const { issuerJwt, disclosures } = parseSdJwt(token);

  let header: ProtectedHeaderParameters;
  try {
    header = decodeProtectedHeader(issuerJwt);
  } catch (error) {
    throw invalid("the SD-JWT protected header is unreadable", {}, error);
  }
  const alg = algForKey(issuerKey);
  if (header.alg !== alg) {
    throw invalid(`expected alg ${alg}, the algorithm of the trusted issuer key`, { alg: header.alg, expected: alg });
  }
  if (header.typ !== AP2_SD_JWT_TYP) {
    throw invalid(`expected typ ${AP2_SD_JWT_TYP}`, { typ: header.typ, expected: AP2_SD_JWT_TYP });
  }

  let signedBytes: Uint8Array;
  try {
    const verified = await compactVerify(issuerJwt, await importJWK({ ...issuerKey }, alg), { algorithms: [alg] });
    signedBytes = verified.payload;
  } catch (error) {
    throw new AgentPassError("Ap2SignatureInvalid", "the SD-JWT is not signed by the trusted issuer key", {
      cause: error,
      details: { kid: header.kid, alg },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(signedBytes));
  } catch (error) {
    throw invalid("the SD-JWT payload is not JSON", {}, error);
  }
  if (!isRecord(payload)) throw invalid("the SD-JWT payload is not a JSON object");
  const { _sd_alg: sdAlg, ...claims } = payload;
  if (sdAlg !== undefined && sdAlg !== AP2_SD_ALG) {
    throw invalid(`only ${AP2_SD_ALG} disclosure digests are accepted`, { _sd_alg: sdAlg });
  }

  return { header, payload: resolveDisclosures(claims, disclosures) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mismatch(message: string, details: Readonly<Record<string, unknown>> = {}): AgentPassError {
  return new AgentPassError("Ap2DisclosureMismatch", message, { details });
}

type DecodedDisclosure = { readonly kind: "element"; readonly value: unknown } | { readonly kind: "property"; readonly name: string; readonly value: unknown };

function decodeDisclosure(disclosure: string): DecodedDisclosure {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(disclosure, "base64url").toString("utf8"));
  } catch {
    throw mismatch("a disclosure is not base64url JSON");
  }
  if (!Array.isArray(decoded) || typeof decoded[0] !== "string") throw mismatch("a disclosure is not [salt, …]");
  if (decoded.length === 2) return { kind: "element", value: decoded[1] };
  if (decoded.length === 3 && typeof decoded[1] === "string" && decoded[1] !== "_sd" && decoded[1] !== DIGEST_KEY) {
    return { kind: "property", name: decoded[1], value: decoded[2] };
  }
  throw mismatch("a disclosure is neither [salt, value] nor [salt, name, value]");
}

/**
 * RFC 9901 §7.1 processing: replace every digest the issuer signed with the
 * disclosure that hashes to it. A disclosure no digest points at, or a digest
 * that appears twice, rejects the whole token: the holder cannot add content
 * the issuer never committed to.
 */
function resolveDisclosures(claims: Record<string, unknown>, disclosures: readonly string[]): Record<string, unknown> {
  const byDigest = new Map<string, DecodedDisclosure>();
  for (const disclosure of disclosures) {
    const digest = sha256Base64Url(disclosure);
    if (byDigest.has(digest)) throw mismatch("the same disclosure appears twice", { digest });
    byDigest.set(digest, decodeDisclosure(disclosure));
  }
  const seen = new Set<string>();
  const take = (digest: unknown): DecodedDisclosure | undefined => {
    if (typeof digest !== "string") throw mismatch("a digest is not a string");
    if (seen.has(digest)) throw mismatch("a digest appears twice in the signed payload", { digest });
    seen.add(digest);
    return byDigest.get(digest);
  };

  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const element of value) {
        if (isRecord(element) && DIGEST_KEY in element) {
          if (Object.keys(element).length !== 1) throw mismatch("an array digest placeholder carries other members");
          const disclosed = take(element[DIGEST_KEY]);
          if (disclosed === undefined) continue; // undisclosed: the element is withheld, not invented
          if (disclosed.kind !== "element") throw mismatch("an array element points at a property disclosure");
          out.push(resolve(disclosed.value));
        } else {
          out.push(resolve(element));
        }
      }
      return out;
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        if (name !== "_sd") out[name] = resolve(member);
      }
      const digests = value._sd;
      if (digests !== undefined) {
        if (!Array.isArray(digests)) throw mismatch("_sd is not an array");
        for (const digest of digests) {
          const disclosed = take(digest);
          if (disclosed === undefined) continue;
          if (disclosed.kind !== "property") throw mismatch("an _sd digest points at an array element disclosure");
          if (disclosed.name in out) throw mismatch("a disclosure would overwrite a signed claim", { claim: disclosed.name });
          out[disclosed.name] = resolve(disclosed.value);
        }
      }
      return out;
    }
    return value;
  };

  const resolved = resolve(claims) as Record<string, unknown>;
  const unused = [...byDigest.keys()].filter((digest) => !seen.has(digest));
  if (unused.length > 0) throw mismatch("a disclosure matches no digest the issuer signed", { digests: unused });
  return resolved;
}
