/**
 * UCP's buyer consent extension (T149, VT-47). The buyer's consent decisions
 * travel in `checkout.buyer.consent`, shaped differently by each version:
 *
 * - 2026-04-08: four optional booleans (`marketing`, `analytics`,
 *   `preferences`, `sale_of_data`), sent by the platform and echoed back.
 * - 2026-08-25: one entry per purpose, keyed `dev.ucp.consent.*`. The business
 *   MUST advertise every purpose it supports, with its default (`source:
 *   "business"`) and a description; the platform confirms, setting `source:
 *   "platform"` only for what the buyer said. Purposes the business did not
 *   advertise are ignored.
 *
 * A session keeps one shape for both: the four purposes UCP defines, each
 * with its state and who set it. The store's default is no consent at all.
 * Only the buyer's own decisions (`source: "platform"`) go to the store's
 * platform order; a default is the store's own policy, not something to
 * record about the buyer.
 *
 * Sessions opened before T149 have no consent, and answer as they did: what
 * an AP2 mandate signed over them (`buyer` is in the terms) stays the same.
 */
import { CONSENT_PURPOSES, type BuyerConsent, type ConsentPurpose } from "@vitrinee/adapters";
import { VitrineeError, type UcpVersion } from "@vitrinee/core";
import { z, ZodError } from "zod";

const consentChoiceSchema = z.object({ granted: z.boolean(), source: z.enum(["business", "platform"]) });
export type ConsentChoice = z.infer<typeof consentChoiceSchema>;

/** A session's consent: every purpose the store offers, with its current state. */
export const sessionConsentSchema = z.object({
  marketing: consentChoiceSchema,
  analytics: consentChoiceSchema,
  preferences: consentChoiceSchema,
  sale_or_sharing: consentChoiceSchema,
});
export type SessionConsent = z.infer<typeof sessionConsentSchema>;

/** What a request decides, purpose by purpose. A purpose it does not name keeps its state (UCP: omitting a key signals nothing). */
export type ConsentUpdate = Partial<Record<ConsentPurpose, ConsentChoice>>;

/** The store's default for each purpose: nothing is assumed (VT-47). */
const BUSINESS_DEFAULT: Readonly<Record<ConsentPurpose, boolean>> = { marketing: false, analytics: false, preferences: false, sale_or_sharing: false };

/** UCP 2026-08-25's identifier for each purpose. */
const PURPOSE_ID: Readonly<Record<ConsentPurpose, string>> = {
  marketing: "dev.ucp.consent.marketing",
  analytics: "dev.ucp.consent.analytics",
  preferences: "dev.ucp.consent.preferences",
  sale_or_sharing: "dev.ucp.consent.sale_or_sharing",
};

/** UCP 2026-04-08's name for each purpose. */
const LEGACY_NAME: Readonly<Record<ConsentPurpose, string>> = {
  marketing: "marketing",
  analytics: "analytics",
  preferences: "preferences",
  sale_or_sharing: "sale_of_data",
};

/** At most this many purposes in a request: the four UCP defines leave plenty of room for a platform's own. */
export const MAX_CONSENT_PURPOSES = 32;

const legacyInput = z.looseObject({
  marketing: z.boolean().optional(),
  analytics: z.boolean().optional(),
  preferences: z.boolean().optional(),
  sale_of_data: z.boolean().optional(),
});

const currentInput = z
  .record(z.string().max(200), z.unknown())
  .refine((purposes) => Object.keys(purposes).length <= MAX_CONSENT_PURPOSES, `at most ${MAX_CONSENT_PURPOSES} consent purposes`);

/** A purpose as a 2026-08-25 request carries it. `description` and `links` are the business's, and ignored if sent. */
const choiceInput = z.looseObject({ granted: z.boolean(), source: z.enum(["business", "platform"]) });

/** A new session's consent: the store's default for every purpose. */
export function defaultConsent(): SessionConsent {
  const consent = {} as SessionConsent;
  for (const purpose of CONSENT_PURPOSES) consent[purpose] = { granted: BUSINESS_DEFAULT[purpose], source: "business" };
  return consent;
}

/**
 * Reads `buyer.consent` as the request's version shapes it. In 2026-04-08 every
 * boolean sent is the buyer's decision. In 2026-08-25 only the purposes this
 * store advertises are read; any other key is ignored, as UCP requires.
 *
 * @throws VitrineeError `ValidationError` for a malformed purpose this store reads.
 */
export function parseConsent(raw: unknown, version: UcpVersion): ConsentUpdate {
  try {
    const update: ConsentUpdate = {};
    if (version === "2026-04-08") {
      const legacy = legacyInput.parse(raw) as Record<string, boolean | undefined>;
      for (const purpose of CONSENT_PURPOSES) {
        const granted = legacy[LEGACY_NAME[purpose]];
        if (granted !== undefined) update[purpose] = { granted, source: "platform" };
      }
      return update;
    }
    const purposes = currentInput.parse(raw);
    for (const purpose of CONSENT_PURPOSES) {
      const entry = purposes[PURPOSE_ID[purpose]];
      if (entry === undefined) continue;
      const parsed = choiceInput.safeParse(entry);
      // Named by its purpose, so the platform knows which one it got wrong.
      if (!parsed.success) throw new ZodError(parsed.error.issues.map((issue) => ({ ...issue, path: [PURPOSE_ID[purpose], ...issue.path] })));
      update[purpose] = { granted: parsed.data.granted, source: parsed.data.source };
    }
    return update;
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const why = error.issues.map((issue) => `buyer.consent${issue.path.map((key) => `.${String(key)}`).join("")}: ${issue.message}`).join("; ");
    throw new VitrineeError("ValidationError", why, { details: {} });
  }
}

/**
 * A session's consent after a request's decisions. A purpose the platform
 * confirms with `source: "platform"` takes the buyer's value; one it echoes
 * with `source: "business"` goes back to the store's default, whatever value
 * came with it: only the buyer's decision moves a purpose away from it.
 */
export function applyConsent(current: SessionConsent, update: ConsentUpdate): SessionConsent {
  const next = structuredClone(current);
  for (const purpose of CONSENT_PURPOSES) {
    const choice = update[purpose];
    if (choice === undefined) continue;
    next[purpose] = choice.source === "platform" ? { granted: choice.granted, source: "platform" } : { granted: BUSINESS_DEFAULT[purpose], source: "business" };
  }
  return next;
}

export function sameConsent(a: SessionConsent, b: SessionConsent): boolean {
  return CONSENT_PURPOSES.every((purpose) => a[purpose].granted === b[purpose].granted && a[purpose].source === b[purpose].source);
}

/** What the store tells the buyer each purpose means. Part of what an AP2 mandate signs (`buyer` is in its terms): change with care. */
function descriptionOf(purpose: ConsentPurpose, merchant: string): string {
  switch (purpose) {
    case "marketing":
      return `Email updates and offers from ${merchant}. Needs the buyer's email.`;
    case "analytics":
      return `Analytics and performance tracking by ${merchant}. The buyer's choice is passed to the store with the order.`;
    case "preferences":
      return `Storing the buyer's preferences at ${merchant}. The buyer's choice is passed to the store with the order.`;
    case "sale_or_sharing":
      return `Selling or sharing the buyer's data with third parties. The buyer's choice is passed to the store with the order.`;
  }
}

/**
 * `buyer.consent` as a response in `version` shows it, or undefined for none.
 * 2026-08-25 advertises every purpose; 2026-04-08 has no defaults to show, so
 * it echoes only what the buyer decided.
 */
export function renderConsent(consent: SessionConsent | undefined, version: UcpVersion, merchant: string): Record<string, unknown> | undefined {
  if (consent === undefined) return undefined;
  if (version === "2026-04-08") {
    const legacy: Record<string, boolean> = {};
    for (const purpose of CONSENT_PURPOSES) {
      if (consent[purpose].source === "platform") legacy[LEGACY_NAME[purpose]] = consent[purpose].granted;
    }
    return Object.keys(legacy).length === 0 ? undefined : legacy;
  }
  return Object.fromEntries(
    CONSENT_PURPOSES.map((purpose) => [PURPOSE_ID[purpose], { granted: consent[purpose].granted, source: consent[purpose].source, description: descriptionOf(purpose, merchant) }]),
  );
}

/** The buyer's own decisions, for the store's platform order. Never a default. */
export function buyerConsentOf(consent: SessionConsent | undefined): BuyerConsent {
  const decided: BuyerConsent = {};
  if (consent === undefined) return decided;
  for (const purpose of CONSENT_PURPOSES) {
    if (consent[purpose].source === "platform") decided[purpose] = consent[purpose].granted;
  }
  return decided;
}

/**
 * A decision the store cannot act on without more of the buyer's data (UCP's
 * "data dependencies"): email marketing the buyer said yes to, with no email.
 * Each gap names where the missing data goes.
 */
export function consentGaps(consent: SessionConsent | undefined, buyer: { email?: string | undefined }): { path: string; content: string }[] {
  if (consent === undefined) return [];
  const { marketing } = consent;
  if (marketing.source === "platform" && marketing.granted && buyer.email === undefined) {
    return [{ path: "$.buyer.email", content: "the buyer's email is required for the marketing consent they gave" }];
  }
  return [];
}
