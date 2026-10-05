import { hasErrorCode, stellarAddressToDid } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk/base";
import { describe, expect, it } from "vitest";

import { makeVenueId } from "../catalog/ids.js";
import { EURC_MOCK, MOCK_VENUE_ID, USDC_TESTNET } from "../catalog/mock.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { reconcileTerms, termsError, type PaymentTerms } from "./terms.js";

const agent = Keypair.random();
const principal = Keypair.random();

const AGENT_DID = stellarAddressToDid(agent.publicKey(), "testnet");
const PRINCIPAL_DID = stellarAddressToDid(principal.publicKey(), "testnet");
const REGISTRY = "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";
const OTHER_VENUE = makeVenueId("otro-bazaar", "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F");

function intentFor(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:15:00.000Z",
    agent: AGENT_DID,
    principal: PRINCIPAL_DID,
    credential: { hash: "a".repeat(64), registry: REGISTRY },
    venue: MOCK_VENUE_ID,
    purchase: {
      productId: "mate-calabaza",
      quantity: 2,
      unitAmount: "18.50",
      totalAmount: "37.00",
      asset: USDC_TESTNET,
    },
    authorisation: { perTx: "50.00", currency: "USDC" },
    ...overrides,
  };
}

const MATCHING: PaymentTerms = {
  venue: MOCK_VENUE_ID,
  asset: USDC_TESTNET,
  amount: "37.00",
};

describe("terms that describe the purchase the intent describes", () => {
  it("are allowed", () => {
    expect(reconcileTerms(intentFor(), MATCHING).allowed).toBe(true);
  });

  it("are allowed when the venue formats the same amount differently", () => {
    // "37" and "37.0000000" are the same amount. A string comparison would
    // call a venue that pads its decimals a different purchase.
    for (const amount of ["37", "37.0", "37.0000000"]) {
      expect(reconcileTerms(intentFor(), { ...MATCHING, amount }).allowed).toBe(true);
    }
  });
});

describe("terms that describe a different purchase", () => {
  it("refuse a different venue, before looking at anything else", () => {
    const decision = reconcileTerms(intentFor(), {
      venue: OTHER_VENUE,
      // Also wrong, and deliberately: the venue is the more fundamental
      // mismatch and is what should be reported.
      asset: EURC_MOCK,
      amount: "1.00",
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsVenueMismatch");
    expect(decision.details).toMatchObject({ termsVenue: OTHER_VENUE, intentVenue: MOCK_VENUE_ID });
  });

  it("refuse a different asset", () => {
    const decision = reconcileTerms(intentFor(), { ...MATCHING, asset: EURC_MOCK });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsAssetMismatch");
  });

  it("refuse an amount larger than the intent's total", () => {
    const decision = reconcileTerms(intentFor(), { ...MATCHING, amount: "37.0000001" });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsAmountMismatch");
    expect(decision.details).toMatchObject({ termsAmount: "37.0000001", intentTotal: "37.0000000" });
  });

  it("refuse an amount smaller than the intent's total, too", () => {
    // Not a generosity check. A venue asking for less is still not the
    // purchase that was signed, and accepting it would mean the signed total
    // stopped being what is being paid.
    const decision = reconcileTerms(intentFor(), { ...MATCHING, amount: "0.01" });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsAmountMismatch");
  });

  it("compares against the total, not the unit price", () => {
    // The intent is two units at 18.50. A venue asking for one unit's price
    // is asking for a different purchase.
    const decision = reconcileTerms(intentFor(), { ...MATCHING, amount: "18.50" });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsAmountMismatch");
  });
});

const PAYEE = "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ";
const OTHER_PAYEE = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

describe("payTo (M-14)", () => {
  it("is unchecked when the mandate carries no payTo list", () => {
    expect(reconcileTerms(intentFor(), { ...MATCHING, payTo: PAYEE }, undefined).allowed).toBe(true);
  });

  it("is unchecked when the terms carry no payTo, even if the mandate has a list", () => {
    expect(reconcileTerms(intentFor(), MATCHING, [PAYEE]).allowed).toBe(true);
  });

  it("allows a payee the mandate's list names", () => {
    expect(reconcileTerms(intentFor(), { ...MATCHING, payTo: PAYEE }, [PAYEE, OTHER_PAYEE]).allowed).toBe(
      true,
    );
  });

  it("refuses a payee the mandate's list does not name", () => {
    const decision = reconcileTerms(intentFor(), { ...MATCHING, payTo: OTHER_PAYEE }, [PAYEE]);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsPayeeNotAllowed");
    expect(decision.details).toMatchObject({ payTo: OTHER_PAYEE, permitted: [PAYEE] });
  });

  it("an empty list permits no payee (B-1), it does not mean unchecked", () => {
    const decision = reconcileTerms(intentFor(), { ...MATCHING, payTo: PAYEE }, []);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsPayeeNotAllowed");
    expect(decision.details).toMatchObject({ permitsNothing: true });
  });
});

describe("the total is derived, never read from what the intent claims", () => {
  // An intent whose `totalAmount` disagrees with its own price and quantity.
  // Nothing in the rail reads that field, so the lie is inert: the terms are
  // reconciled against 18.50 x 2, and the liar's number matches nothing.
  const lying = () =>
    intentFor({
      purchase: {
        productId: "mate-calabaza",
        quantity: 2,
        unitAmount: "18.50",
        totalAmount: "1.00",
        asset: USDC_TESTNET,
      },
    });

  it("allows terms that match the derived total", () => {
    expect(reconcileTerms(lying(), { ...MATCHING, amount: "37.00" }).allowed).toBe(true);
  });

  it("refuses terms that match the claimed total", () => {
    const decision = reconcileTerms(lying(), { ...MATCHING, amount: "1.00" });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) expect.unreachable("expected a refusal");
    expect(decision.details).toMatchObject({ intentTotal: "37.0000000" });
  });
});

describe("a malformed amount is not a match", () => {
  it.each([["not-a-number"], ["-37.00"], ["37.000000001"]])(
    "raises InvalidAmount rather than quietly comparing %s",
    (amount) => {
      // Fail-closed: an amount the project's own schema would refuse never
      // reaches the comparison at all.
      expect(() => reconcileTerms(intentFor(), { ...MATCHING, amount })).toThrowError(
        expect.objectContaining({ code: "InvalidAmount" }),
      );
    },
  );
});

describe("the refusal becomes a typed error at the tool boundary", () => {
  it("carries the code and the details", () => {
    const decision = reconcileTerms(intentFor(), { ...MATCHING, amount: "99.00" });
    if (decision.allowed) expect.unreachable("expected a refusal");

    const error = termsError(decision);

    expect(hasErrorCode(error, "TermsAmountMismatch")).toBe(true);
    expect(error.details).toMatchObject({ termsAmount: "99.00" });
  });
});

describe("terms for a cart (T148)", () => {
  const cart = intentFor({
    purchase: {
      lines: [
        { productId: "mate-calabaza", quantity: 1, unitAmount: "18.50" },
        { productId: "poncho-andino", quantity: 2, unitAmount: "1.25" },
      ],
      // Never read: the total is derived from the lines.
      totalAmount: "99.00",
      asset: USDC_TESTNET,
    },
  });

  it("are allowed for the sum of the lines, and only for it", () => {
    expect(reconcileTerms(cart, { ...MATCHING, amount: "21.00" }).allowed).toBe(true);
    expect(reconcileTerms(cart, { ...MATCHING, amount: "99.00" })).toMatchObject({ allowed: false, code: "TermsAmountMismatch", details: { intentTotal: "21.0000000" } });
    expect(reconcileTerms(cart, { ...MATCHING, amount: "18.50" })).toMatchObject({ allowed: false, code: "TermsAmountMismatch" });
  });
});
