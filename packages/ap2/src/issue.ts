/**
 * Issuing the pair of AP2 open mandates for one purchase — T123, `E-8`, `E-11`.
 *
 * An AP2 open mandate is a task, not a standing permission: the checkout one
 * names the items (`checkout.line_items` is required by its schema) and the
 * payment one is tied to it by `payment.reference`. So the pair is issued per
 * purchase, from facts the caller has already checked against the principal's
 * Mandate. This module does no authorisation of its own — it is pure mapping
 * and signing. The caller that decides whether the Mandate allows the purchase
 * is the agent's exporter, which runs `checkMandate` first.
 *
 * Every claim is validated against the zod mirror of the AP2 schema before it
 * is signed, so a malformed mandate fails here and not at a verifier.
 */
import { AgentPassError } from "@agentpass/core";

import { disclosableArray, issueSdJwt, sdHash } from "./sd-jwt.js";
import type { Ap2PublicJwk, Ap2Signer } from "./sd-jwt.js";
import {
  AGENTPEY_MANDATE_CLAIM,
  OPEN_CHECKOUT_MANDATE_VCT,
  OPEN_PAYMENT_MANDATE_VCT,
  agentPeyMandateRefSchema,
  openCheckoutMandateSchema,
  openPaymentMandateSchema,
} from "./schemas.js";
import type { AgentPeyMandateRef, Ap2Item, Ap2Merchant, Ap2PaymentInstrument } from "./schemas.js";

export interface OpenMandateTask {
  /** `iss`: the Trusted Agent Provider signing on the principal's behalf. */
  readonly issuer: string;
  /** The Mandate this pair is derived from (`com.agentpey.mandate`). */
  readonly source: AgentPeyMandateRef;
  /** `cnf.jwk`: the only agent that may close these mandates. */
  readonly agentKey: Ap2PublicJwk;
  readonly merchant: Ap2Merchant;
  readonly item: Ap2Item;
  readonly quantity: number;
  /** `payment.amount_range.max`, in the asset's smallest unit. */
  readonly maxAmount: bigint;
  /** `payment.amount_range.currency`. AP2 asks for ISO 4217; a Stellar asset has none (gap for the SEP). */
  readonly currency: string;
  readonly paymentInstrument: Ap2PaymentInstrument;
  readonly issuedAt: Date;
  /** `exp` of both mandates. Short on purpose: an open mandate cannot be revoked (`E-10`). */
  readonly expiresAt: Date;
}

export interface OpenMandatePair {
  /** `mandate.checkout.open.1`, compact SD-JWT. */
  readonly checkout: string;
  /** `mandate.payment.open.1`, compact SD-JWT, bound to `checkout` by `payment.reference`. */
  readonly payment: string;
}

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

function invalid(message: string, details: Readonly<Record<string, unknown>>, cause?: unknown): AgentPassError {
  return new AgentPassError("Ap2MandateInvalid", message, { details, cause });
}

/** Turns an array into what the mandate carries: placeholders when signing, the plain values when checking the shape. */
type Disclose = (values: readonly unknown[]) => unknown[];

async function issueOpenMandate(
  task: OpenMandateTask,
  build: (disclose: Disclose) => Record<string, unknown>,
  schema: typeof openCheckoutMandateSchema | typeof openPaymentMandateSchema,
  signer: Ap2Signer,
): Promise<string> {
  // The schema runs on the mandate as a verifier will resolve it, every
  // selectively disclosable array in the clear; only then is it signed.
  const plain = build((values) => [...values]);
  const checked = schema.safeParse(plain);
  if (!checked.success) {
    throw invalid("the AP2 mandate would not match its AP2 v0.2 schema", { vct: plain.vct, issues: checked.error.issues });
  }
  const disclosures: string[] = [];
  const mandate = build((values) => disclosableArray(values, disclosures));
  const placeholder = disclosableArray([mandate], disclosures);
  return issueSdJwt(
    { iss: task.issuer, iat: seconds(task.issuedAt), [AGENTPEY_MANDATE_CLAIM]: task.source, delegate_payload: placeholder },
    disclosures,
    signer,
  );
}

/**
 * Signs the open checkout mandate, then the open payment mandate that points
 * at it. Both carry the same `cnf`, `iat` and `exp`, and the same source
 * Mandate, so the verifier can insist the pair agrees.
 *
 * @throws AgentPassError `Ap2MandateInvalid` if the task cannot produce mandates that match the AP2 schema
 */
export async function issueOpenMandatePair(task: OpenMandateTask, signer: Ap2Signer): Promise<OpenMandatePair> {
  const source = agentPeyMandateRefSchema.safeParse(task.source);
  if (!source.success) throw invalid("the source Mandate reference is malformed", { issues: source.error.issues });
  if (task.expiresAt.getTime() <= task.issuedAt.getTime()) {
    throw invalid("an AP2 open mandate must expire after it is issued", { iat: task.issuedAt.toISOString(), exp: task.expiresAt.toISOString() });
  }
  if (task.maxAmount <= 0n || task.maxAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid("payment.amount_range.max must be a positive JSON-safe integer", { maxAmount: task.maxAmount.toString() });
  }

  const window = { cnf: { jwk: task.agentKey }, iat: seconds(task.issuedAt), exp: seconds(task.expiresAt) };

  const checkout = await issueOpenMandate(
    task,
    (disclose) => ({
      vct: OPEN_CHECKOUT_MANDATE_VCT,
      constraints: [
        {
          type: "checkout.line_items",
          items: [{ id: "line_1", acceptable_items: disclose([task.item]), quantity: task.quantity }],
        },
        { type: "checkout.allowed_merchants", allowed: disclose([task.merchant]) },
      ],
      ...window,
    }),
    openCheckoutMandateSchema,
    signer,
  );

  const payment = await issueOpenMandate(
    task,
    (disclose) => ({
      vct: OPEN_PAYMENT_MANDATE_VCT,
      constraints: [
        { type: "payment.reference", conditional_transaction_id: sdHash(checkout) },
        { type: "payment.amount_range", currency: task.currency, max: Number(task.maxAmount) },
        { type: "payment.allowed_payees", allowed: disclose([task.merchant]) },
        { type: "payment.allowed_payment_instruments", allowed: disclose([task.paymentInstrument]) },
        { type: "payment.execution_date", not_after: task.expiresAt.toISOString() },
      ],
      ...window,
    }),
    openPaymentMandateSchema,
    signer,
  );

  return { checkout, payment };
}
