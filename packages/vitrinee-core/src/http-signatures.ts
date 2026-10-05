/**
 * HTTP Message Signatures (RFC 9421) as UCP signs order webhooks (T147): the
 * business signs each delivery with a key its profile publishes, the platform
 * verifies it with that key. ES256 only (`ecdsa-p256-sha256`, raw r‖s): it is
 * the one algorithm every UCP platform must verify, in both versions this
 * codebase speaks. The body is bound by `Content-Digest` (RFC 9530, sha-256).
 *
 * Pure computation, no I/O: the store signs with it, AgentPey's receiver on
 * agentpey.com verifies with it, and each test checks one against the other.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { VitrineeError } from "./errors.js";

/** The one signature a delivery carries. */
export const SIGNATURE_LABEL = "sig1";

/**
 * What a webhook signature covers: the target, the body, and every header that
 * says who sends it and which event it is. UCP requires the first six for a
 * POST with a body and a `UCP-Agent`; `webhook-id` and `webhook-timestamp` bind
 * the event's identity too, so a retry cannot be passed off as another event.
 */
export const WEBHOOK_COMPONENTS = ["@method", "@authority", "@path", "content-digest", "content-type", "ucp-agent", "idempotency-key", "webhook-id", "webhook-timestamp"] as const;

export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid?: string;
}

export interface EcPrivateJwk extends EcPublicJwk {
  d: string;
}

/** `Content-Digest` of a body: `sha-256=:<base64>:` (RFC 9530). */
export function contentDigest(body: string | Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

/** A component's value per RFC 9421 §2: derived components from the target, fields from the (lowercased) headers. */
function componentValue(name: string, method: string, url: URL, headers: Readonly<Record<string, string | undefined>>): string | undefined {
  switch (name) {
    case "@method":
      return method.toUpperCase();
    case "@authority":
      // URL.host is lowercase and already omits the scheme's default port (§2.2.3).
      return url.host;
    case "@path":
      return url.pathname === "" ? "/" : url.pathname;
    case "@query":
      return url.search === "" ? "?" : url.search;
    default:
      if (name.startsWith("@")) return undefined;
      return headers[name]?.trim();
  }
}

/** The signature base (§2.5): one line per covered component, then `@signature-params`, joined by LF. */
function signatureBase(components: readonly string[], params: string, value: (name: string) => string | undefined): string | null {
  const lines: string[] = [];
  for (const name of components) {
    const v = value(name);
    if (v === undefined || /[\r\n]/.test(v)) return null;
    lines.push(`"${name}": ${v}`);
  }
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

/**
 * The signature base of a request for the given components and serialized
 * `@signature-params` (RFC 9421 §2.5), or `null` if a component has no value.
 * Exported for the RFC's own test vectors.
 */
export function httpSignatureBase(method: string, url: string, headers: Readonly<Record<string, string | undefined>>, components: readonly string[], params: string): string | null {
  const target = new URL(url);
  return signatureBase(components, params, (name) => componentValue(name, method, target, headers));
}

const sfString = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

export interface WebhookSigningInput {
  /** Where the delivery goes. */
  url: string;
  body: string;
  /** The business's own profile, `<origin>/.well-known/ucp`: what `UCP-Agent` names. */
  profileUrl: string;
  webhookId: string;
  /** Unix seconds: when the event happened. Kept across retries. */
  webhookTimestamp: number;
  /** Unix seconds: when this attempt was signed. */
  created: number;
  key: { privateJwk: EcPrivateJwk; kid: string };
}

/**
 * Every header a signed UCP order webhook carries: `Content-Type`,
 * `Content-Digest`, `UCP-Agent`, `Idempotency-Key` (the event id, which UCP
 * 2026-04-08 requires on a signed POST), `Webhook-Id`, `Webhook-Timestamp`,
 * `Signature-Input` and `Signature`.
 *
 * The query, when the URL has one, is covered too (`@query`): a platform may
 * put a token there, and a UCP verifier requires it covered.
 *
 * @throws VitrineeError `ConfigError` for a key, a URL or a value that cannot be signed
 */
export function signedWebhookHeaders(input: WebhookSigningInput): Record<string, string> {
  for (const [what, value] of [["kid", input.key.kid], ["profile URL", input.profileUrl], ["webhook id", input.webhookId]] as const) {
    if (value === "" || !sfString.test(value)) throw new VitrineeError("ConfigError", `the ${what} cannot go in a signed header`, { details: { what } });
  }
  if (input.key.privateJwk.kty !== "EC" || input.key.privateJwk.crv !== "P-256") throw new VitrineeError("ConfigError", "webhooks are signed with a P-256 key (ES256)");
  if (!URL.canParse(input.url)) throw new VitrineeError("ConfigError", "the webhook URL is not a URL", { details: {} });
  const url = new URL(input.url);
  const components: readonly string[] = url.search === "" ? WEBHOOK_COMPONENTS : [...WEBHOOK_COMPONENTS.slice(0, 3), "@query", ...WEBHOOK_COMPONENTS.slice(3)];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-digest": contentDigest(input.body),
    "ucp-agent": `profile="${input.profileUrl}"`,
    "idempotency-key": input.webhookId,
    "webhook-id": input.webhookId,
    "webhook-timestamp": String(input.webhookTimestamp),
  };
  const params = `(${components.map((c) => `"${c}"`).join(" ")});created=${input.created};keyid="${input.key.kid}"`;
  const base = signatureBase(components, params, (name) => componentValue(name, "POST", url, headers));
  if (base === null) throw new VitrineeError("ConfigError", "a covered component has no value");
  const { kty, crv, x, y, d } = input.key.privateJwk;
  const signature = cryptoSign("sha256", Buffer.from(base, "utf8"), { key: createPrivateKey({ key: { kty, crv, x, y, d }, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return { ...headers, "signature-input": `${SIGNATURE_LABEL}=${params}`, signature: `${SIGNATURE_LABEL}=:${signature.toString("base64")}:` };
}

export type SignatureFailure = "missing_signature" | "digest_mismatch" | "bad_signature_input" | "missing_component" | "key_not_found" | "bad_signature" | "expired";

/** The only RFC 9421 algorithm this module verifies; a signature naming another is refused. */
export const ES256_ALGORITHM = "ecdsa-p256-sha256";

export type SignatureCheck = { ok: true; keyid: string; created: number | null; components: readonly string[] } | { ok: false; reason: SignatureFailure };

export interface VerifySignatureInput {
  method: string;
  url: string;
  /** The request's headers, names lowercased. */
  headers: Readonly<Record<string, string | undefined>>;
  /** The raw body, exactly as received. */
  body: string | Uint8Array;
  /** The signer's key for a `keyid`, from its profile; `undefined` if it publishes none by that id. */
  keyFor: (keyid: string) => EcPublicJwk | undefined;
  /** Components the verifier needs covered beyond UCP's minimum (a receiver that dedupes by `webhook-id` needs it signed). */
  requiredComponents?: readonly string[];
  /** Unix seconds, to refuse a signature whose `expires` has passed. */
  now?: number;
}

/** `label=(…);param=value;…`: one member of a `Signature-Input` dictionary. */
const signatureInputMember = /^([a-z*][a-z0-9_.*-]*)=(\(((?:"[^"\\]+")(?: "[^"\\]+")*)?\)((?:;[a-z][a-z0-9_-]*=(?:"[^"\\]*"|-?\d+))*))$/;

/**
 * Verifies one RFC 9421 signature the way UCP's verification algorithm does:
 * the digest matches the body, the signature covers the target, the body and
 * every integrity header the request carries, its `keyid` names a key the
 * signer publishes, and the ES256 signature holds over the signature base. A
 * request with more than one signature is not accepted.
 */
export function verifyHttpMessageSignature(input: VerifySignatureInput): SignatureCheck {
  const fail = (reason: SignatureFailure): SignatureCheck => ({ ok: false, reason });
  const signatureInput = input.headers["signature-input"]?.trim();
  const signatureHeader = input.headers["signature"]?.trim();
  if (signatureInput === undefined || signatureHeader === undefined) return fail("missing_signature");

  const bodyLength = typeof input.body === "string" ? Buffer.byteLength(input.body) : input.body.byteLength;
  const digest = input.headers["content-digest"]?.trim();
  if (bodyLength > 0 && (digest === undefined || digest !== contentDigest(input.body))) return fail("digest_mismatch");

  const member = signatureInputMember.exec(signatureInput);
  if (member === null) return fail("bad_signature_input");
  const label = member[1]!;
  // Everything after `label=`: the inner list and its parameters, exactly as received, which is what `@signature-params` signs.
  const params = member[2]!;
  const list = member[3];
  const components = list === undefined ? [] : list.split(" ").map((c) => c.slice(1, -1));
  const parameters = new Map([...params.matchAll(/;([a-z][a-z0-9_-]*)=("[^"\\]*"|-?\d+)/g)].map((m) => [m[1]!, m[2]!.startsWith('"') ? m[2]!.slice(1, -1) : m[2]!]));
  const keyid = parameters.get("keyid");
  if (keyid === undefined || new Set(components).size !== components.length) return fail("bad_signature_input");
  // RFC 9421 §3.2: an `alg` that does not match the key is refused; `expires` in the past is refused.
  const alg = parameters.get("alg");
  if (alg !== undefined && alg !== ES256_ALGORITHM) return fail("bad_signature_input");
  const expires = parameters.get("expires");
  if (expires !== undefined && input.now !== undefined && input.now > Number(expires)) return fail("expired");

  const url = new URL(input.url);
  const required = ["@method", "@authority", "@path"];
  if (url.search !== "") required.push("@query");
  if (bodyLength > 0) required.push("content-digest", "content-type");
  if (input.headers["idempotency-key"] !== undefined) required.push("idempotency-key");
  if (input.headers["ucp-agent"] !== undefined) required.push("ucp-agent");
  required.push(...(input.requiredComponents ?? []));
  if (required.some((name) => !components.includes(name))) return fail("missing_component");

  const signed = new RegExp(`^${label.replace(/[.*]/g, "\\$&")}=:([A-Za-z0-9+/]+={0,2}):$`).exec(signatureHeader);
  if (signed === null) return fail("bad_signature_input");
  const key = input.keyFor(keyid);
  if (key === undefined || key.kty !== "EC" || key.crv !== "P-256") return fail("key_not_found");

  const base = signatureBase(components, params, (name) => componentValue(name, input.method, url, input.headers));
  if (base === null) return fail("missing_component");
  const signature = Buffer.from(signed[1]!, "base64");
  if (signature.length !== 64) return fail("bad_signature");
  let valid: boolean;
  try {
    valid = cryptoVerify("sha256", Buffer.from(base, "utf8"), { key: createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return fail("key_not_found");
  }
  if (!valid) return fail("bad_signature");
  const created = parameters.get("created");
  return { ok: true, keyid, created: created === undefined ? null : Number(created), components };
}
