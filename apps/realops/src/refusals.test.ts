import { describe, expect, it } from "vitest";

import { EXPLAINED_CODES, explainRefusal } from "./refusals.js";

describe("explainRefusal", () => {
  it("explains a refusal without using the word that caused it", () => {
    const explained = explainRefusal("MandateDailyLimitExceeded", "perDay exceeded");

    expect(explained.what.es).toContain("tope");
    expect(explained.what.en).toContain("limit");
    for (const text of [explained.what.en, explained.what.es]) {
      expect(text).not.toContain("MandateDailyLimitExceeded");
      expect(text).not.toContain("perDay");
    }
  });

  /**
   * Every explained refusal has to answer "what now?", because a person who
   * cannot tell whether to wait, re-sign, or do nothing will read the same
   * message as "it is broken". In both languages the pages speak.
   */
  it("tells the person what to do, for every code it claims to know, in both languages", () => {
    for (const code of EXPLAINED_CODES) {
      const explained = explainRefusal(code, "whatever");
      for (const text of [explained.what.en, explained.what.es, explained.next.en, explained.next.es]) {
        expect(text.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it("says plainly when there is nothing for the person to do", () => {
    for (const code of ["TermsPayeeNotAllowed", "TermsAmountMismatch", "VenueNotRegistered"]) {
      expect(explainRefusal(code, null).next.es).toContain("nada");
      expect(explainRefusal(code, null).next.en).toContain("nothing");
    }
  });

  /**
   * The rule that matters most here: a code this table does not know must
   * degrade to the truth, awkwardly phrased, and never to a friendly sentence
   * describing a different failure.
   */
  it("falls back to the platform's own reason rather than inventing one", () => {
    const explained = explainRefusal("SomeCodeFromTheFuture", "the registry said no");

    expect(explained.what).toEqual({ en: "the registry said no", es: "the registry said no" });
    expect(explained.next.en).toContain("SomeCodeFromTheFuture");
    expect(explained.next.es).toContain("SomeCodeFromTheFuture");
  });

  it("still says something when the platform sent no reason either", () => {
    const explained = explainRefusal("SomeCodeFromTheFuture", null);

    expect(explained.what.en.length).toBeGreaterThan(0);
    expect(explained.what.es.length).toBeGreaterThan(0);
    expect(explained.next.en).toContain("SomeCodeFromTheFuture");
  });

  /**
   * The acceptance cases of the brief § 7 name specific refusals. Each one has
   * to arrive at a person as a sentence, not as a code — this pins which codes
   * that promise covers.
   */
  it("covers every refusal the acceptance cases require", () => {
    const required = [
      // case 3 — venue, asset or payTo not allowed
      "MandateVenueNotAllowed",
      "MandateAssetNotAllowed",
      "TermsPayeeNotAllowed",
      // case 4 — over per-transaction and per-day
      "MandateAmountExceeded",
      "MandateDailyLimitExceeded",
      // case 5 — invoice disagrees with the intent
      "TermsAmountMismatch",
      // case 6 — expired, revoked, credential revoked
      "MandateExpired",
      "MandateRevoked",
      "CredentialRevoked",
      // case 7 — a different wallet than expected
      "MandatePrincipalMismatch",
      // case 8 — no funds
      "SponsoredCreditExhausted",
      // case 9 — catalogue down or product missing
      "CatalogUnavailable",
      "ProductNotFound",
      // reached a person untranslated when the suite ran against production (T85)
      "MandateNotFound",
      "MerchantRejectedRequest",
    ];

    for (const code of required) expect(EXPLAINED_CODES).toContain(code);
  });

  it("never leaves a message that reads like a crash", () => {
    for (const code of EXPLAINED_CODES) {
      const { what, next } = explainRefusal(code, "x");
      for (const text of [what.en, what.es, next.en, next.es]) {
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("[object");
        expect(text).not.toContain("Error:");
      }
    }
  });

  /** The pilot's copy rules (decided by the user for the Stellar meeting): no em dash, no voseo. */
  it("writes without em dashes, and in neutral Spanish", () => {
    for (const code of EXPLAINED_CODES) {
      const { what, next } = explainRefusal(code, "x");
      for (const text of [what.en, what.es, next.en, next.es]) expect(text).not.toContain("—");
      for (const text of [what.es, next.es]) expect(text).not.toMatch(/\b(podés|querés|tenés|firmá|probá|usá|esperá|conectá)\b/);
    }
  });
});
