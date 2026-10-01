/**
 * AP2 v0.2 open mandates, as zod — T123.
 *
 * Mirrors `open_checkout_mandate.json` and `open_payment_mandate.json` of the
 * AP2 repository (commit `e1ea56d`, vendored under `test/ap2-v0.2/` and checked
 * against these in the tests). Objects are `looseObject`: AP2 lets mandate
 * types grow new members, and a verifier that dropped them silently would
 * report less than the issuer signed. Constraint **types** are the exception:
 * an unknown one fails evaluation (AP2 `agent_authorization.md`), which
 * `knownConstraintTypes` lets the verifier report on its own code.
 *
 * Every allowlist needs at least one revealed element. AP2: "If they are not
 * present, or if the `allowed` contains no revealed elements, the constraint
 * is invalid." A holder can withhold a disclosure without breaking the
 * signature, so an empty list here means someone stripped it, and is rejected
 * rather than read as "no restriction".
 */
import { stellarContractIdSchema } from "@agentpass/core";
import { z } from "zod";

export const OPEN_CHECKOUT_MANDATE_VCT = "mandate.checkout.open.1";
export const OPEN_PAYMENT_MANDATE_VCT = "mandate.payment.open.1";

/** Root claim naming the AgentPey Mandate an AP2 mandate was derived from (`E-10`). rDNS-prefixed, as AP2 recommends for extensions. */
export const AGENTPEY_MANDATE_CLAIM = "com.agentpey.mandate";

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "expected base64url");

export const ap2PublicJwkSchema = z.discriminatedUnion("kty", [
  z.looseObject({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: base64Url.length(43) }),
  z.looseObject({ kty: z.literal("EC"), crv: z.literal("P-256"), x: base64Url.length(43), y: base64Url.length(43) }),
]);

/** RFC 7800 confirmation claim. Required on an open mandate: it names the only agent allowed to close it. */
export const cnfSchema = z.looseObject({ jwk: ap2PublicJwkSchema });

export const ap2MerchantSchema = z.looseObject({ id: z.string().min(1), name: z.string().min(1), website: z.string().optional() });
export const ap2ItemSchema = z.looseObject({ id: z.string().min(1), title: z.string().min(1) });
export const ap2PaymentInstrumentSchema = z.looseObject({ id: z.string().min(1), type: z.string().min(1), description: z.string().optional() });
const ap2PispSchema = z.looseObject({ legal_name: z.string(), brand_name: z.string(), domain_name: z.string() });

const lineItemsConstraint = z.looseObject({
  type: z.literal("checkout.line_items"),
  items: z
    .array(z.looseObject({ id: z.string().min(1), acceptable_items: z.array(ap2ItemSchema).min(1), quantity: z.int().positive() }))
    .min(1),
});
const allowedMerchantsConstraint = z.looseObject({ type: z.literal("checkout.allowed_merchants"), allowed: z.array(ap2MerchantSchema).min(1) });

export const checkoutConstraintSchema = z.discriminatedUnion("type", [lineItemsConstraint, allowedMerchantsConstraint]);

const paymentReferenceConstraint = z.looseObject({ type: z.literal("payment.reference"), conditional_transaction_id: base64Url });
export const paymentConstraintSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("payment.agent_recurrence"),
    frequency: z.enum(["ON_DEMAND", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"]),
    max_occurrences: z.int().optional(),
  }),
  z.looseObject({ type: z.literal("payment.allowed_payees"), allowed: z.array(ap2MerchantSchema).min(1) }),
  z.looseObject({ type: z.literal("payment.allowed_payment_instruments"), allowed: z.array(ap2PaymentInstrumentSchema).min(1) }),
  z.looseObject({ type: z.literal("payment.allowed_pisps"), allowed: z.array(ap2PispSchema).min(1) }),
  z.looseObject({ type: z.literal("payment.amount_range"), currency: z.string().min(1), max: z.int(), min: z.int().optional() }),
  z.looseObject({ type: z.literal("payment.budget"), max: z.number(), currency: z.string().min(1) }),
  z.looseObject({ type: z.literal("payment.execution_date"), not_before: z.string().optional(), not_after: z.string().optional() }),
  paymentReferenceConstraint,
]);

export const knownConstraintTypes = {
  checkout: new Set(["checkout.line_items", "checkout.allowed_merchants"]),
  payment: new Set([
    "payment.agent_recurrence",
    "payment.allowed_payees",
    "payment.allowed_payment_instruments",
    "payment.allowed_pisps",
    "payment.amount_range",
    "payment.budget",
    "payment.execution_date",
    "payment.reference",
  ]),
} as const;

/**
 * `iat` and `exp` are optional in AP2 but required here: an open mandate
 * cannot be revoked, so its expiry is the only thing that ends it (`E-10`).
 */
const window = { iat: z.int().nonnegative(), exp: z.int().positive() };

export const openCheckoutMandateSchema = z.looseObject({
  vct: z.literal(OPEN_CHECKOUT_MANDATE_VCT),
  constraints: z
    .array(checkoutConstraintSchema)
    .refine((constraints) => constraints.some((constraint) => constraint.type === "checkout.line_items"), "AP2 requires a checkout.line_items constraint"),
  cnf: cnfSchema,
  ...window,
});

export const openPaymentMandateSchema = z.looseObject({
  vct: z.literal(OPEN_PAYMENT_MANDATE_VCT),
  constraints: z
    .array(paymentConstraintSchema)
    .refine((constraints) => constraints.some((constraint) => constraint.type === "payment.reference"), "AP2 requires a payment.reference constraint"),
  cnf: cnfSchema,
  ...window,
});

/** Where the AP2 mandate came from: the Mandate's hash and the registry that anchors it, so an online verifier can ask whether it was revoked. */
export const agentPeyMandateRefSchema = z.strictObject({
  mandate_id: z.uuid(),
  hash: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256"),
  registry: stellarContractIdSchema,
});

/** The signed root, after disclosures are resolved. `delegate_payload` holds exactly one disclosed mandate. */
export const ap2RootSchema = z.looseObject({
  iss: z.string().min(1),
  iat: z.int().nonnegative(),
  [AGENTPEY_MANDATE_CLAIM]: agentPeyMandateRefSchema,
  delegate_payload: z.array(z.record(z.string(), z.unknown())).length(1, "expected exactly one disclosed mandate in delegate_payload"),
});

export type Ap2Merchant = z.infer<typeof ap2MerchantSchema>;
export type Ap2Item = z.infer<typeof ap2ItemSchema>;
export type Ap2PaymentInstrument = z.infer<typeof ap2PaymentInstrumentSchema>;
export type OpenCheckoutMandate = z.infer<typeof openCheckoutMandateSchema>;
export type OpenPaymentMandate = z.infer<typeof openPaymentMandateSchema>;
export type AgentPeyMandateRef = z.infer<typeof agentPeyMandateRefSchema>;
