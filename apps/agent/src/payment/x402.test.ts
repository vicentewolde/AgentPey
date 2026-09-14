import { hasErrorCode, stellarAddressToDid, type Scope } from "@agentpass/core";
import { createMandate, type AgentPayMandate } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk/base";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { BAZAAR_USDC, BAZAAR_USDC_ISSUER, BAZAAR_VENUE_ID, type BazaarServiceRoute } from "../catalog/bazaar.js";
import type { PurchaseIntent } from "../intent/intent.js";
import type { AuthorisationDecision, AuthorisationRequest, PolicyRail } from "../policy/policy-rail.js";
import { executeBazaarPayment, fillRouteTemplate, toPaymentTerms } from "./x402.js";

const principal = Keypair.random();
const agent = Keypair.random();
const PRINCIPAL_DID = stellarAddressToDid(principal.publicKey(), "testnet");
const AGENT_DID = stellarAddressToDid(agent.publicKey(), "testnet");
const REGISTRY = "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";

function scopeFor(overrides: Partial<Scope> = {}): Scope {
  return {
    actions: ["catalog:read", "intent:create"],
    venues: [BAZAAR_VENUE_ID],
    assets: [BAZAAR_USDC],
    limits: { perTx: "1.00", perDay: "5.00", currency: "USDC" },
    ...overrides,
  };
}

function mandateFor(): AgentPayMandate {
  return createMandate({
    principal: PRINCIPAL_DID,
    agent: AGENT_DID,
    grant: scopeFor(),
    registry: REGISTRY,
    validFrom: "2026-09-01T00:00:00.000Z",
    validUntil: "2026-12-01T00:00:00.000Z",
  });
}

function intentFor(): PurchaseIntent {
  return {
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: "8b0851b3-94e9-45b0-ba36-000000000001",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:15:00.000Z",
    agent: AGENT_DID,
    principal: PRINCIPAL_DID,
    credential: { hash: "a".repeat(64), registry: REGISTRY },
    venue: BAZAAR_VENUE_ID,
    purchase: {
      productId: "swap-risk-quote",
      quantity: 1,
      unitAmount: "0.0010000",
      totalAmount: "0.0010000",
      asset: BAZAAR_USDC,
    },
    authorisation: { perTx: "1.00", currency: "USDC" },
  };
}

/** Shaped exactly like the real live challenge captured against the bazaar (T24 evidence). */
const REAL_REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  payTo: "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
  asset: BAZAAR_USDC_ISSUER,
  amount: "10000",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

const REAL_CHALLENGE_BODY = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://stellar-bazaar-x402.vercel.app/api/x402/swap-risk?pair=XLM/USDC&amount=100&side=buy",
    description: "Deterministic read-only Swap Risk Quote; informational only.",
    mimeType: "application/json",
  },
  accepts: [REAL_REQUIREMENTS],
};

const RESOURCE_URL =
  "https://stellar-bazaar-x402.vercel.app/api/x402/swap-risk?pair=XLM/USDC&amount=100&side=buy";

/** A syntactically valid throwaway secret — never funded, never used to sign in these tests. */
const THROWAWAY_SECRET = Keypair.random().secret();

function fetchChallengeThen(...responses: readonly Response[]): typeof fetch {
  let call = 0;
  return (async () => {
    const response = responses[call];
    call += 1;
    if (response === undefined) throw new Error("fetchImpl called more times than the test expected");
    return response;
  }) as typeof fetch;
}

/**
 * The bazaar's real 402 response carries the challenge in a base64
 * `PAYMENT-REQUIRED` header (x402 v2) — the body alone is not enough,
 * verified against real traffic (T24 evidence) and confirmed in
 * `@x402/core`'s own `getPaymentRequiredResponse`, which only falls back to
 * the body for v1 (`x402Version === 1`).
 */
function challengeResponse(): Response {
  return new Response(JSON.stringify(REAL_CHALLENGE_BODY), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": Buffer.from(JSON.stringify(REAL_CHALLENGE_BODY)).toString("base64"),
    },
  });
}

function fakeRail(authorise: (request: AuthorisationRequest) => Promise<AuthorisationDecision>): PolicyRail {
  return { authorise };
}

describe("toPaymentTerms", () => {
  it("maps a real payment challenge to PaymentTerms", () => {
    const requirements = REAL_REQUIREMENTS;

    expect(toPaymentTerms(requirements, BAZAAR_VENUE_ID)).toEqual({
      venue: BAZAAR_VENUE_ID,
      asset: BAZAAR_USDC,
      amount: "0.0010000",
      payTo: "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
    });
  });

  it("refuses a scheme other than exact", () => {
    const requirements = { ...REAL_REQUIREMENTS, scheme: "upto" } as PaymentRequirements;
    try {
      toPaymentTerms(requirements, BAZAAR_VENUE_ID);
      expect.unreachable("expected toPaymentTerms to throw");
    } catch (error) {
      expect(hasErrorCode(error, "InvalidProduct")).toBe(true);
    }
  });

  it("refuses a network other than stellar:testnet", () => {
    const requirements = { ...REAL_REQUIREMENTS, network: "stellar:pubnet" } as PaymentRequirements;
    try {
      toPaymentTerms(requirements, BAZAAR_VENUE_ID);
      expect.unreachable("expected toPaymentTerms to throw");
    } catch (error) {
      expect(hasErrorCode(error, "InvalidProduct")).toBe(true);
    }
  });

  it("refuses an asset contract it does not recognise, rather than guessing", () => {
    const requirements = { ...REAL_REQUIREMENTS, asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    try {
      toPaymentTerms(requirements, BAZAAR_VENUE_ID);
      expect.unreachable("expected toPaymentTerms to throw");
    } catch (error) {
      expect(hasErrorCode(error, "InvalidProduct")).toBe(true);
    }
  });

  it("refuses a non-integer amount", () => {
    const requirements = { ...REAL_REQUIREMENTS, amount: "0.001" };
    try {
      toPaymentTerms(requirements, BAZAAR_VENUE_ID);
      expect.unreachable("expected toPaymentTerms to throw");
    } catch (error) {
      expect(hasErrorCode(error, "InvalidProduct")).toBe(true);
    }
  });
});

describe("executeBazaarPayment", () => {
  it("never signs or sends a payment for a challenge PolicyRail refuses", async () => {
    const authorise = vi.fn(async () => ({
      authorised: false as const,
      code: "ScopeAmountExceeded" as const,
      reason: "over the per-transaction limit",
      details: {},
    }));
    const fetchImpl = fetchChallengeThen(challengeResponse());

    try {
      await executeBazaarPayment(
        { policyRail: fakeRail(authorise), signerSecret: THROWAWAY_SECRET, fetchImpl },
        { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
      );
      expect.unreachable("expected executeBazaarPayment to throw");
    } catch (error) {
      expect(hasErrorCode(error, "ScopeAmountExceeded")).toBe(true);
    }

    // Exactly one fetch — the initial challenge. No X-PAYMENT retry was ever sent.
    expect(authorise).toHaveBeenCalledTimes(1);
  });

  it("reconciles the real challenge into PaymentTerms before asking PolicyRail", async () => {
    const authorise = vi.fn(async (request: AuthorisationRequest) => ({
      authorised: false as const,
      code: "TermsAmountMismatch" as const,
      reason: "stop here — this test only checks what authorise() was called with",
      details: {},
    }));
    const fetchImpl = fetchChallengeThen(challengeResponse());

    await executeBazaarPayment(
      { policyRail: fakeRail(authorise), signerSecret: THROWAWAY_SECRET, fetchImpl },
      { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
    ).catch(() => undefined);

    expect(authorise).toHaveBeenCalledWith(
      expect.objectContaining({
        terms: {
          venue: BAZAAR_VENUE_ID,
          asset: BAZAAR_USDC,
          amount: "0.0010000",
          payTo: "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
        },
      }),
    );
  });

  it("treats a first response that is not 402 as NetworkError, before touching PolicyRail", async () => {
    const authorise = vi.fn();
    const fetchImpl = fetchChallengeThen(new Response("ok", { status: 200 }));

    try {
      await executeBazaarPayment(
        { policyRail: fakeRail(authorise), signerSecret: THROWAWAY_SECRET, fetchImpl },
        { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
      );
      expect.unreachable("expected executeBazaarPayment to throw");
    } catch (error) {
      expect(hasErrorCode(error, "NetworkError")).toBe(true);
    }
    expect(authorise).not.toHaveBeenCalled();
  });

  /**
   * T85, found against production: SignalDesk refused a credits request with a
   * 400 for its input, and it reached a person as "no se pudo hablar con el
   * comercio, puede estar caído" — about a request that would fail identically
   * forever. A venue that read the request and declined it is not unreachable.
   */
  it("treats a 4xx from the venue as MerchantRejectedRequest, before touching PolicyRail", async () => {
    const authorise = vi.fn();
    const fetchImpl = fetchChallengeThen(
      new Response(JSON.stringify({ ok: false, code: "InvalidRequest", message: "account must be a Stellar classic account" }), {
        status: 400,
      }),
    );

    try {
      await executeBazaarPayment(
        { policyRail: fakeRail(authorise), signerSecret: THROWAWAY_SECRET, fetchImpl },
        { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
      );
      expect.unreachable("expected executeBazaarPayment to throw");
    } catch (error) {
      expect(hasErrorCode(error, "MerchantRejectedRequest")).toBe(true);
      expect(error).toMatchObject({ details: { status: 400 } });
    }
    expect(authorise).not.toHaveBeenCalled();
  });

  it("wraps a network failure on the first request as NetworkError", async () => {
    const authorise = vi.fn();
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    try {
      await executeBazaarPayment(
        { policyRail: fakeRail(authorise), signerSecret: THROWAWAY_SECRET, fetchImpl },
        { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
      );
      expect.unreachable("expected executeBazaarPayment to throw");
    } catch (error) {
      expect(hasErrorCode(error, "NetworkError")).toBe(true);
    }
    expect(authorise).not.toHaveBeenCalled();
  });
});

describe("fillRouteTemplate", () => {
  const route: BazaarServiceRoute = {
    id: "swap-risk-quote",
    routeTemplate: "/api/x402/swap-risk?pair={pair}&amount={amount}&side={side}",
    input: [
      { name: "pair", type: "string", required: true },
      { name: "amount", type: "number", required: true },
      { name: "side", type: "string", required: true },
    ],
  };

  it("fills every placeholder and joins onto the base url", () => {
    const url = fillRouteTemplate("https://stellar-bazaar-x402.vercel.app", route, {
      pair: "XLM/USDC",
      amount: 100,
      side: "buy",
    });

    expect(url).toBe(
      "https://stellar-bazaar-x402.vercel.app/api/x402/swap-risk?pair=XLM%2FUSDC&amount=100&side=buy",
    );
  });

  it("drops a trailing slash on the base url", () => {
    const url = fillRouteTemplate("https://stellar-bazaar-x402.vercel.app/", route, {
      pair: "XLM/USDC",
      amount: 100,
      side: "buy",
    });

    expect(url.startsWith("https://stellar-bazaar-x402.vercel.app/api/")).toBe(true);
  });

  it("refuses a placeholder the caller did not supply", () => {
    try {
      fillRouteTemplate("https://stellar-bazaar-x402.vercel.app", route, { pair: "XLM/USDC", amount: 100 });
      expect.unreachable("expected fillRouteTemplate to throw");
    } catch (error) {
      expect(hasErrorCode(error, "InvalidArguments")).toBe(true);
    }
  });
});
