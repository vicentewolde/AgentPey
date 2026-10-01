/**
 * Verifying AP2 open mandates offline — T123, `E-8`.
 *
 * The verifier is given the issuer key it trusts; the token never chooses it.
 * Per token, in this order: signature (`verifySdJwt`) → disclosures → root
 * claims → exactly one disclosed mandate → its `vct` → constraint types →
 * mandate schema → validity window. The window is last on purpose, as everywhere else in
 * this codebase: a forged and expired mandate reports the forgery.
 *
 * For a pair, on top: `payment.reference` must be the `sd_hash` of the
 * checkout mandate it travels with, and both must name the same issuer,
 * agent key, window (`iat` and `exp`) and source Mandate.
 *
 * What this does not do: evaluate constraints against a closed mandate (there
 * is none; `E-8`), or ask the registry whether the source Mandate was revoked
 * (network, and which registry to trust is the caller's call — the reference
 * is returned so it can).
 */
import { AgentPassError, canonicalJson } from "@agentpass/core";
import type { z } from "zod";

import { sdHash, verifySdJwt } from "./sd-jwt.js";
import type { Ap2PublicJwk } from "./sd-jwt.js";
import {
  AGENTPEY_MANDATE_CLAIM,
  OPEN_CHECKOUT_MANDATE_VCT,
  OPEN_PAYMENT_MANDATE_VCT,
  ap2RootSchema,
  knownConstraintTypes,
  openCheckoutMandateSchema,
  openPaymentMandateSchema,
} from "./schemas.js";
import type { AgentPeyMandateRef, OpenCheckoutMandate, OpenPaymentMandate } from "./schemas.js";

export interface VerifyOpenMandateOptions {
  /** The Trusted Agent Provider's public key. Its algorithm is the only one accepted. */
  readonly issuerKey: Ap2PublicJwk;
  readonly now?: Date;
}

export interface VerifiedOpenMandate<T> {
  readonly issuer: string;
  readonly source: AgentPeyMandateRef;
  readonly mandate: T;
}

export interface VerifiedOpenMandatePair {
  readonly issuer: string;
  readonly source: AgentPeyMandateRef;
  readonly checkout: OpenCheckoutMandate;
  readonly payment: OpenPaymentMandate;
}

type Kind = "checkout" | "payment";

const SCHEMAS = { checkout: openCheckoutMandateSchema, payment: openPaymentMandateSchema } as const;
const VCTS = { checkout: OPEN_CHECKOUT_MANDATE_VCT, payment: OPEN_PAYMENT_MANDATE_VCT } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function verifyOpenMandate<K extends Kind>(
  kind: K,
  token: string,
  options: VerifyOpenMandateOptions,
): Promise<VerifiedOpenMandate<z.infer<(typeof SCHEMAS)[K]>>> {
  const { payload } = await verifySdJwt(token, options.issuerKey);

  const root = ap2RootSchema.safeParse(payload);
  if (!root.success) {
    throw new AgentPassError("Ap2MandateInvalid", "the AP2 mandate's signed root is not the expected shape", { details: { issues: root.error.issues } });
  }
  const [mandate] = root.data.delegate_payload;

  // Which kind of mandate this is comes first: a payment token handed in as
  // the checkout one is a wrong-type error, not an unknown constraint.
  if (mandate?.vct !== VCTS[kind]) {
    throw new AgentPassError("Ap2MandateInvalid", `expected an open ${kind} mandate (${VCTS[kind]})`, { details: { vct: mandate?.vct } });
  }

  // AP2: "Any unknown Constraints MUST be treated as failing evaluation." Said
  // with its own code, before the schema, so it is not mistaken for a typo.
  const constraints: unknown = mandate.constraints;
  if (Array.isArray(constraints)) {
    for (const constraint of constraints) {
      const type = isRecord(constraint) ? constraint.type : undefined;
      if (typeof type !== "string" || !knownConstraintTypes[kind].has(type)) {
        throw new AgentPassError("Ap2ConstraintUnsupported", `the ${kind} mandate carries a constraint this verifier does not know`, {
          details: { type, kind },
        });
      }
    }
  }

  const parsed = SCHEMAS[kind].safeParse(mandate);
  if (!parsed.success) {
    throw new AgentPassError("Ap2MandateInvalid", `the disclosed mandate is not an AP2 v0.2 open ${kind} mandate`, {
      details: { issues: parsed.error.issues },
    });
  }

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (now < parsed.data.iat) {
    throw new AgentPassError("Ap2MandateNotYetValid", `the ${kind} mandate is not valid yet`, { details: { iat: parsed.data.iat, now } });
  }
  // Inclusive, like `validUntil` and the registry's `expires_at`.
  if (now > parsed.data.exp) {
    throw new AgentPassError("Ap2MandateExpired", `the ${kind} mandate has expired`, { details: { exp: parsed.data.exp, now } });
  }

  return { issuer: root.data.iss, source: root.data[AGENTPEY_MANDATE_CLAIM], mandate: parsed.data as z.infer<(typeof SCHEMAS)[K]> };
}

/** Verifies one open checkout mandate on its own. */
export function verifyOpenCheckoutMandate(token: string, options: VerifyOpenMandateOptions): Promise<VerifiedOpenMandate<OpenCheckoutMandate>> {
  return verifyOpenMandate("checkout", token, options);
}

/** Verifies one open payment mandate on its own — its `payment.reference` is checked only by {@link verifyOpenMandatePair}. */
export function verifyOpenPaymentMandate(token: string, options: VerifyOpenMandateOptions): Promise<VerifiedOpenMandate<OpenPaymentMandate>> {
  return verifyOpenMandate("payment", token, options);
}

function referenceMismatch(message: string, details: Readonly<Record<string, unknown>>): AgentPassError {
  return new AgentPassError("Ap2ReferenceMismatch", message, { details });
}

/**
 * Verifies the pair an AgentPey export produces.
 *
 * @throws AgentPassError `Ap2MandateInvalid`, `Ap2SignatureInvalid`, `Ap2DisclosureMismatch`,
 *   `Ap2ConstraintUnsupported`, `Ap2MandateNotYetValid`, `Ap2MandateExpired` — from either token
 * @throws AgentPassError `Ap2ReferenceMismatch` — the payment mandate is not bound to this checkout mandate, or the two disagree
 */
export async function verifyOpenMandatePair(
  pair: { readonly checkout: string; readonly payment: string },
  options: VerifyOpenMandateOptions,
): Promise<VerifiedOpenMandatePair> {
  const checkout = await verifyOpenCheckoutMandate(pair.checkout, options);
  const payment = await verifyOpenPaymentMandate(pair.payment, options);

  const expected = sdHash(pair.checkout);
  const references = payment.mandate.constraints.flatMap((constraint) => (constraint.type === "payment.reference" ? [constraint.conditional_transaction_id] : []));
  if (!references.every((reference) => reference === expected)) {
    throw referenceMismatch("payment.reference does not point at this checkout mandate", { expected, found: references });
  }
  if (checkout.issuer !== payment.issuer) {
    throw referenceMismatch("the two mandates have different issuers", { checkout: checkout.issuer, payment: payment.issuer });
  }
  if (canonicalJson(checkout.mandate.cnf.jwk) !== canonicalJson(payment.mandate.cnf.jwk)) {
    throw referenceMismatch("the two mandates are bound to different agent keys", {});
  }
  if (checkout.mandate.iat !== payment.mandate.iat || checkout.mandate.exp !== payment.mandate.exp) {
    throw referenceMismatch("the two mandates have different validity windows", {
      checkout: { iat: checkout.mandate.iat, exp: checkout.mandate.exp },
      payment: { iat: payment.mandate.iat, exp: payment.mandate.exp },
    });
  }
  if (canonicalJson(checkout.source) !== canonicalJson(payment.source)) {
    throw referenceMismatch("the two mandates name different source Mandates", { checkout: checkout.source, payment: payment.source });
  }

  return { issuer: checkout.issuer, source: checkout.source, checkout: checkout.mandate, payment: payment.mandate };
}
