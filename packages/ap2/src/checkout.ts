/**
 * AP2 inside a UCP checkout (T134, R-15): the business's authorization of a
 * checkout, and the agent's closed checkout mandate over it.
 *
 * - **`merchant_authorization`** (UCP `dev.ucp.common.payment.ap2_mandate`): a
 *   JWS with detached payload, ES256, over JCS(checkout without `ap2`).
 * - **`checkout_jwt`** (AP2 `mandate.checkout.1`): that same signature with the
 *   payload put back, `header.payload.signature`, so AP2's own tools read it
 *   and the business checks it with its own key (R-15, point 1).
 * - **The closed mandate** is AP2 v0.2's delegation chain `open~~close`: the
 *   open checkout mandate the platform signed (T123's shape, `cnf` = the
 *   agent's key) and a terminal `kb+sd-jwt` hop the agent signs, carrying
 *   `aud`, `nonce`, `sd_hash` of the open mandate and, disclosed in
 *   `delegate_payload`, `{vct: "mandate.checkout.1", checkout_jwt, checkout_hash}`.
 *
 * Every check runs on what a signature covers, and keys are the caller's:
 * the business passes the keys it trusts for the platform, and its own.
 */
import { AgentPassError } from "@agentpass/core";
import { CompactSign, compactVerify, decodeProtectedHeader, importJWK } from "jose";
import type { JWK } from "jose";
import { z } from "zod";

import { jcsCanonicalize } from "./jcs.js";
import { OPEN_CHECKOUT_MANDATE_VCT, ap2PublicJwkSchema, knownConstraintTypes, openCheckoutMandateSchema } from "./schemas.js";
import type { OpenCheckoutMandate } from "./schemas.js";
import { AP2_SD_ALG, disclosableArray, sdHash, sha256Base64Url, verifySdJwt } from "./sd-jwt.js";
import type { Ap2PublicJwk, Ap2Signer } from "./sd-jwt.js";

export const CLOSED_CHECKOUT_MANDATE_VCT = "mandate.checkout.1";
/** AP2's terminal delegation hop (`kb_sd_jwt.py`, `TYP_TERMINAL`). */
export const AP2_KB_TYP = "kb+sd-jwt";
/** How far apart two clocks may be, as AP2's own verifier allows (`clock_skew_seconds=300`). */
export const AP2_CLOCK_SKEW_SECONDS = 300;

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array | string): string => Buffer.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes).toString("base64url");

type Ap2FailureCode =
  | "Ap2MandateInvalid"
  | "Ap2SignatureInvalid"
  | "Ap2KeyNotFound"
  | "Ap2KeyBindingInvalid"
  | "Ap2ScopeMismatch"
  | "Ap2MerchantAuthorizationInvalid"
  | "Ap2MandateExpired"
  | "Ap2MandateNotYetValid"
  | "Ap2IssuerMismatch"
  | "Ap2ConstraintUnsupported";

function fail(code: Ap2FailureCode, message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): AgentPassError {
  return new AgentPassError(code, message, { details, cause });
}

/** The checkout as UCP's AP2 extension signs it: everything but `ap2`, canonicalized (JCS). */
export function checkoutSigningBytes(checkout: Readonly<Record<string, unknown>>): string {
  const { ap2: _ap2, ...rest } = checkout;
  return jcsCanonicalize(rest);
}

/** `ap2.merchant_authorization`: ES256 over JCS(checkout without `ap2`), payload detached (`header..signature`). */
export async function signMerchantAuthorization(checkout: Readonly<Record<string, unknown>>, signer: Ap2Signer): Promise<string> {
  if (signer.alg !== "ES256") throw fail("Ap2MandateInvalid", "UCP's AP2 extension signs with ECDSA (R-5): the business key must be P-256");
  const key = await importJWK(signer.privateJwk, "ES256");
  const compact = await new CompactSign(encoder.encode(checkoutSigningBytes(checkout))).setProtectedHeader({ alg: "ES256", kid: signer.kid }).sign(key);
  const [header, , signature] = compact.split(".");
  return `${header}..${signature}`;
}

/** `checkout_jwt` for AP2: the business's detached signature with the signed bytes put back (R-15). */
export function checkoutJwtFrom(checkout: Readonly<Record<string, unknown>>): string {
  const authorization = (checkout.ap2 as { merchant_authorization?: unknown } | undefined)?.merchant_authorization;
  if (typeof authorization !== "string" || !/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/.test(authorization)) {
    throw fail("Ap2MerchantAuthorizationInvalid", "the checkout carries no ap2.merchant_authorization to close a mandate over");
  }
  const [header, signature] = authorization.split("..");
  return `${header}.${b64(checkoutSigningBytes(checkout))}.${signature}`;
}

/**
 * Checks a `checkout_jwt` against a business key and returns the checkout it
 * signed. The key is the caller's: the business's own when it verifies a
 * mandate, the one its profile publishes when an agent checks a response.
 */
export async function verifyCheckoutJwt(checkoutJwt: string, businessKey: Ap2PublicJwk & { kid?: string }): Promise<Record<string, unknown>> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(checkoutJwt);
  } catch (error) {
    throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT is unreadable", {}, error);
  }
  if (header.alg !== "ES256" || businessKey.kty !== "EC") throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT is not ES256 over a P-256 business key", { alg: header.alg });
  if (businessKey.kid !== undefined && header.kid !== businessKey.kid) throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT names another business key", { kid: header.kid });
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(checkoutJwt, await importJWK({ kty: "EC", crv: "P-256", x: businessKey.x, y: businessKey.y }, "ES256"), { algorithms: ["ES256"] }));
  } catch (error) {
    throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT is not signed by this business", { kid: header.kid }, error);
  }
  let checkout: unknown;
  try {
    checkout = JSON.parse(new TextDecoder().decode(payload));
  } catch (error) {
    throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT payload is not JSON", {}, error);
  }
  if (checkout === null || typeof checkout !== "object" || Array.isArray(checkout)) throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT payload is not an object");
  // What was signed must be canonical: a payload that only parses to the checkout is not the bytes UCP signs.
  if (jcsCanonicalize(checkout) !== new TextDecoder().decode(payload)) throw fail("Ap2MerchantAuthorizationInvalid", "the checkout JWT payload is not the JCS form of its checkout");
  return checkout as Record<string, unknown>;
}

/** Checks a checkout response's `ap2.merchant_authorization` against the business key its profile publishes (the agent's side). */
export async function verifyMerchantAuthorization(checkout: Readonly<Record<string, unknown>>, businessKey: Ap2PublicJwk & { kid?: string }): Promise<void> {
  await verifyCheckoutJwt(checkoutJwtFrom(checkout), businessKey);
}

export interface CloseCheckoutMandateInput {
  /** The open checkout mandate the platform signed, as issued (`jwt~d~…~`). Its `cnf` must be `holder`'s key. */
  readonly open: string;
  /** The agent: the key the open mandate's `cnf` names. */
  readonly holder: Ap2Signer;
  readonly checkoutJwt: string;
  /** The business: its origin (R-15). */
  readonly aud: string;
  /** The checkout's id (R-15). */
  readonly nonce: string;
  readonly issuedAt: Date;
}

/** Closes an open checkout mandate over one signed checkout: `open~~close` (AP2 v0.2 delegation chain). */
export async function closeCheckoutMandate(input: CloseCheckoutMandateInput): Promise<string> {
  if (!input.open.endsWith("~")) throw fail("Ap2MandateInvalid", "the open mandate must be an issued SD-JWT ending in '~'");
  if (input.holder.alg !== "ES256") throw fail("Ap2MandateInvalid", "the agent closes with P-256 (R-5): AP2's SDK follows only an EC P-256 cnf");
  const closed = { vct: CLOSED_CHECKOUT_MANDATE_VCT, checkout_jwt: input.checkoutJwt, checkout_hash: sha256Base64Url(input.checkoutJwt) };
  const disclosures: string[] = [];
  const claims = {
    delegate_payload: disclosableArray([closed], disclosures),
    iat: Math.floor(input.issuedAt.getTime() / 1000),
    aud: input.aud,
    nonce: input.nonce,
    sd_hash: sdHash(input.open),
    _sd_alg: AP2_SD_ALG,
  };
  const key = await importJWK(input.holder.privateJwk, "ES256");
  const hop = await new CompactSign(encoder.encode(JSON.stringify(claims))).setProtectedHeader({ alg: "ES256", typ: AP2_KB_TYP, kid: input.holder.kid }).sign(key);
  // The open mandate keeps its trailing "~"; one more "~" joins the hop: `jwt~d~` + `~` + `hop~d~`.
  return `${input.open}~${hop}~${disclosures.map((d) => `${d}~`).join("")}`;
}

const closedCheckoutSchema = z.looseObject({
  vct: z.literal(CLOSED_CHECKOUT_MANDATE_VCT),
  checkout_jwt: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  checkout_hash: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
const hopClaimsSchema = z.looseObject({
  iat: z.int().nonnegative(),
  aud: z.string().min(1),
  nonce: z.string().min(1),
  sd_hash: z.string().min(1),
  delegate_payload: z.array(z.unknown()).length(1),
});

export interface VerifyCheckoutMandateOptions {
  /** The platform keys the business trusts, by `kid` (from the platform's profile `keys`). */
  readonly platformKey: (kid: string | undefined) => (Ap2PublicJwk & { kid?: string }) | undefined;
  /**
   * The origin of the platform profile those keys came from (R-15). The open
   * mandate's `iss` must be it, and a `kid` that is a URL must live there: a
   * platform signs only in its own name, never in another's.
   */
  readonly issuer: string;
  /** The business's origin. */
  readonly aud: string;
  /** The checkout's id. */
  readonly nonce: string;
  readonly now?: Date;
}

export interface VerifiedCheckoutMandate {
  readonly open: OpenCheckoutMandate;
  readonly checkoutJwt: string;
}

/**
 * Verifies `open~~close` as a business must before charging: the platform's
 * signature on the open mandate, its window, the agent's hop bound to it
 * (`cnf` key, `typ`, `sd_hash`, `aud`, `nonce`, `iat`), and the closed
 * mandate's `checkout_hash`. What the checkout says, and the business's own
 * signature on it, are the caller's next steps (`verifyCheckoutJwt`,
 * {@link checkOpenCheckoutConstraints}).
 *
 * @throws AgentPassError `Ap2KeyNotFound` · `Ap2IssuerMismatch` · `Ap2ConstraintUnsupported` · `Ap2SignatureInvalid` · `Ap2MandateExpired` · `Ap2MandateNotYetValid` · `Ap2KeyBindingInvalid` · `Ap2MandateInvalid`
 */
export async function verifyCheckoutMandateChain(chain: string, options: VerifyCheckoutMandateOptions): Promise<VerifiedCheckoutMandate> {
  const parts = chain.split("~~");
  if (parts.length !== 2) throw fail("Ap2MandateInvalid", "a closed checkout mandate is a two-hop chain, open~~close");
  const open = `${parts[0]}~`;
  const hop = parts[1]!;

  let rootHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    rootHeader = decodeProtectedHeader(open.split("~")[0]!);
  } catch (error) {
    throw fail("Ap2MandateInvalid", "the open mandate header is unreadable", {}, error);
  }
  const rootKid = typeof rootHeader.kid === "string" ? rootHeader.kid : undefined;
  // A kid is only a label inside the profile the key was read from; one that is a URL must not name another origin.
  if (rootKid !== undefined && URL.canParse(rootKid) && new URL(rootKid).origin !== options.issuer) {
    throw fail("Ap2IssuerMismatch", "the open mandate's kid names another platform than the one whose profile is presented", { kid: rootKid, issuer: options.issuer });
  }
  const platformKey = options.platformKey(rootKid);
  if (platformKey === undefined) throw fail("Ap2KeyNotFound", "the platform publishes no key for the open mandate's kid", { kid: rootKid });
  const { payload } = await verifySdJwt(open, platformKey);
  if (payload.iss !== options.issuer) {
    throw fail("Ap2IssuerMismatch", "the open mandate's iss is not the platform whose profile published its key", { iss: payload.iss, issuer: options.issuer });
  }
  const delegated = Array.isArray(payload.delegate_payload) ? (payload.delegate_payload[0] as unknown) : undefined;
  // AP2: a constraint this verifier does not know fails, and says so rather than reading as a malformed mandate.
  const types = (delegated as { constraints?: unknown } | undefined)?.constraints;
  const unknownType = Array.isArray(types) ? types.map((c) => (c as { type?: unknown } | null)?.type).find((t) => typeof t === "string" && !knownConstraintTypes.checkout.has(t)) : undefined;
  if (unknownType !== undefined) throw fail("Ap2ConstraintUnsupported", "the open mandate carries a constraint type this business does not know", { type: unknownType });
  const opened = openCheckoutMandateSchema.safeParse(delegated);
  if (!opened.success || opened.data.vct !== OPEN_CHECKOUT_MANDATE_VCT) {
    throw fail("Ap2MandateInvalid", "the root of the chain is not an AP2 open checkout mandate", { issues: opened.success ? [] : opened.error.issues });
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (now + AP2_CLOCK_SKEW_SECONDS < opened.data.iat) throw fail("Ap2MandateNotYetValid", "the open mandate is not valid yet", { iat: opened.data.iat, now });
  if (now > opened.data.exp) throw fail("Ap2MandateExpired", "the open mandate has expired", { exp: opened.data.exp, now });

  // The hop: signed by the key the open mandate's cnf names, and nothing else.
  const holder = ap2PublicJwkSchema.safeParse(opened.data.cnf.jwk);
  if (!holder.success) throw fail("Ap2KeyBindingInvalid", "the open mandate's cnf is not a public key", { issues: holder.error.issues });
  const holderKey = holder.data as Ap2PublicJwk;
  if (holderKey.kty !== "EC") throw fail("Ap2KeyBindingInvalid", "the open mandate binds a key AP2 cannot close with (P-256 only)");
  const hopJwt = hop.split("~")[0] ?? "";
  const hopDisclosures = hop.split("~").slice(1).filter((d) => d !== "");
  let hopHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    hopHeader = decodeProtectedHeader(hopJwt);
  } catch (error) {
    throw fail("Ap2KeyBindingInvalid", "the closing hop header is unreadable", {}, error);
  }
  if (hopHeader.typ !== AP2_KB_TYP || hopHeader.alg !== "ES256") throw fail("Ap2KeyBindingInvalid", `the closing hop must be a ${AP2_KB_TYP} signed ES256`, { typ: hopHeader.typ, alg: hopHeader.alg });
  let hopBytes: Uint8Array;
  try {
    ({ payload: hopBytes } = await compactVerify(hopJwt, await importJWK({ ...holderKey } as JWK, "ES256"), { algorithms: ["ES256"] }));
  } catch (error) {
    throw fail("Ap2KeyBindingInvalid", "the closing hop is not signed by the agent the open mandate names", {}, error);
  }
  let hopJson: unknown;
  try {
    hopJson = JSON.parse(new TextDecoder().decode(hopBytes));
  } catch (error) {
    throw fail("Ap2KeyBindingInvalid", "the closing hop payload is not JSON", {}, error);
  }
  const hopClaims = hopClaimsSchema.safeParse(hopJson);
  if (!hopClaims.success) throw fail("Ap2KeyBindingInvalid", "the closing hop is not an AP2 terminal hop", { issues: hopClaims.error.issues });
  if (hopClaims.data.sd_hash !== sdHash(open)) throw fail("Ap2KeyBindingInvalid", "the closing hop is bound to another open mandate");
  if (hopClaims.data.aud !== options.aud) throw fail("Ap2KeyBindingInvalid", "the closing hop is for another business", { aud: hopClaims.data.aud });
  if (hopClaims.data.nonce !== options.nonce) throw fail("Ap2ScopeMismatch", "the closing hop is for another checkout", { nonce: hopClaims.data.nonce });
  if (Math.abs(now - hopClaims.data.iat) > AP2_CLOCK_SKEW_SECONDS) throw fail("Ap2MandateExpired", "the closing hop is stale or from the future", { iat: hopClaims.data.iat, now });

  // Its one disclosed element, resolved through the same strict RFC 9901 rules as any SD-JWT here.
  const resolvedHop = await resolveHopDisclosures(hopClaims.data, hopDisclosures);
  const closed = closedCheckoutSchema.safeParse(resolvedHop);
  if (!closed.success) throw fail("Ap2MandateInvalid", "the closing hop does not carry an AP2 closed checkout mandate", { issues: closed.error.issues });
  if (closed.data.checkout_hash !== sha256Base64Url(closed.data.checkout_jwt)) throw fail("Ap2ScopeMismatch", "checkout_hash is not the hash of checkout_jwt");
  return { open: opened.data, checkoutJwt: closed.data.checkout_jwt };
}

/** Resolves the hop's `delegate_payload[0]` digest against its disclosures: exactly one, used once. */
async function resolveHopDisclosures(claims: z.infer<typeof hopClaimsSchema>, disclosures: readonly string[]): Promise<unknown> {
  const placeholder = claims.delegate_payload[0] as { "..."?: unknown } | undefined;
  const digest = placeholder?.["..."];
  if (typeof digest !== "string" || disclosures.length !== 1) throw fail("Ap2MandateInvalid", "the closing hop must disclose exactly its one delegated mandate");
  const [disclosure] = disclosures;
  if (sha256Base64Url(disclosure!) !== digest) throw fail("Ap2MandateInvalid", "the closing hop's disclosure is not the one it signed");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(disclosure!, "base64url").toString("utf8"));
  } catch (error) {
    throw fail("Ap2MandateInvalid", "the closing hop's disclosure is not base64url JSON", {}, error);
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string") throw fail("Ap2MandateInvalid", "the closing hop's disclosure is not [salt, value]");
  return decoded[1];
}

/**
 * The open mandate's constraints against the checkout the business signed
 * (AP2: an unknown constraint fails). `checkout.line_items`: lines and allowed
 * entries pair up one to one, each line an acceptable item of its entry in
 * that entry's quantity (so two lines never spend one allowed entry);
 * `checkout.allowed_merchants`: the signed checkout's `merchant.id` is this
 * business's origin, and an allowed merchant has that id.
 */
export function checkOpenCheckoutConstraints(open: OpenCheckoutMandate, checkout: Readonly<Record<string, unknown>>, businessOrigin: string): void {
  const lines = z.array(z.looseObject({ item: z.looseObject({ id: z.string() }), quantity: z.int() })).safeParse(checkout.line_items);
  if (!lines.success) throw fail("Ap2ScopeMismatch", "the signed checkout has no readable line items");
  for (const constraint of open.constraints) {
    if (constraint.type === "checkout.line_items") {
      const wanted = constraint.items;
      const fits = (line: number, entry: number): boolean => {
        const l = lines.data[line]!;
        const w = wanted[entry]!;
        return w.quantity === l.quantity && w.acceptable_items.some((item) => item.id === l.item.id);
      };
      if (lines.data.length !== wanted.length || !pairsOneToOne(lines.data.length, fits)) throw fail("Ap2ScopeMismatch", "the checkout is not the items the open mandate allows", { lines: lines.data.map((l) => [l.item.id, l.quantity]) });
    } else if (constraint.type === "checkout.allowed_merchants") {
      // By id, as AP2's own evaluator does (`merchant_matches`): a business's id is its origin (R-15), the same
      // name the hop's `aud` uses; and the checkout it signed says so in `merchant.id`.
      const signedMerchant = (checkout.merchant as { id?: unknown } | undefined)?.id;
      const ok = signedMerchant === businessOrigin && constraint.allowed.some((merchant) => merchant.id === businessOrigin);
      if (!ok) throw fail("Ap2ScopeMismatch", "this business is not among the open mandate's allowed merchants", { origin: businessOrigin });
    }
  }
}

/**
 * Whether `n` lines and `n` allowed entries pair up one to one (a perfect
 * bipartite matching, by augmenting paths). A checkout has a handful of lines.
 */
function pairsOneToOne(n: number, fits: (line: number, entry: number) => boolean): boolean {
  const lineOfEntry = new Array<number>(n).fill(-1);
  const assign = (line: number, seen: boolean[]): boolean => {
    for (let entry = 0; entry < n; entry++) {
      if (seen[entry] || !fits(line, entry)) continue;
      seen[entry] = true;
      if (lineOfEntry[entry] === -1 || assign(lineOfEntry[entry]!, seen)) {
        lineOfEntry[entry] = line;
        return true;
      }
    }
    return false;
  };
  for (let line = 0; line < n; line++) if (!assign(line, new Array<boolean>(n).fill(false))) return false;
  return true;
}
