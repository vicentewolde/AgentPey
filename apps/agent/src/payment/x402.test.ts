import { AgentPassError, hasErrorCode, stellarAddressToDid, type Scope } from "@agentpass/core";
import { createMandate, type AgentPayMandate } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk/base";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { findDefaultAsset } from "@x402/stellar";
import { describe, expect, it, vi } from "vitest";

import { BAZAAR_USDC, BAZAAR_USDC_ISSUER, BAZAAR_VENUE_ID, type BazaarServiceRoute } from "../catalog/bazaar.js";
import type { PurchaseIntent } from "../intent/intent.js";
import type { AuthorisationDecision, AuthorisationRequest, PolicyRail } from "../policy/policy-rail.js";
import {
  PAYMENT_SENT_DETAIL,
  executeBazaarPayment,
  fillRouteTemplate,
  mayHaveBeenPaid,
  spendControlsFor,
  toPaymentTerms,
} from "./x402.js";

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
  return {
    authorise,
    release: () => {
      throw new Error("release must not be called from inside executeBazaarPayment");
    },
    preview: () => {
      throw new Error("preview must not be called from inside executeBazaarPayment");
    },
  };
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

/**
 * T92 (`C-113`): whether a spend may be given back hangs entirely on this
 * marker, so it is tested as a contract in its own right — not only through
 * the callers that read it.
 */
describe("mayHaveBeenPaid", () => {
  it("answers false only for an AgentPassError explicitly stamped paymentSent: false", () => {
    const stamped = new AgentPassError("NetworkError", "before the door", {
      details: { [PAYMENT_SENT_DETAIL]: false },
    });
    expect(mayHaveBeenPaid(stamped)).toBe(false);
  });

  it("answers true for an AgentPassError stamped paymentSent: true", () => {
    const stamped = new AgentPassError("NetworkError", "past the door", {
      details: { [PAYMENT_SENT_DETAIL]: true },
    });
    expect(mayHaveBeenPaid(stamped)).toBe(true);
  });

  it("fails closed for anything unmarked — an unstamped error must never release a spend", () => {
    // Every one of these is a route by which an error could reach a caller
    // without ever passing through `executeBazaarPayment`'s own marking. None
    // of them may be treated as proof that nothing was paid.
    expect(mayHaveBeenPaid(new AgentPassError("NetworkError", "no details at all"))).toBe(true);
    expect(mayHaveBeenPaid(new AgentPassError("NetworkError", "other details", { details: { foo: 1 } }))).toBe(true);
    expect(mayHaveBeenPaid(new Error("a plain error from a dependency"))).toBe(true);
    expect(mayHaveBeenPaid("a thrown string")).toBe(true);
    expect(mayHaveBeenPaid(undefined)).toBe(true);
  });

  it("fails closed for a non-boolean stamp, rather than reading it as falsy", () => {
    const odd = new AgentPassError("NetworkError", "odd", { details: { [PAYMENT_SENT_DETAIL]: "no" } });
    expect(mayHaveBeenPaid(odd)).toBe(true);
  });
});

describe("executeBazaarPayment — the payment door (C-113, T92)", () => {
  async function failureFrom(fetchImpl: typeof fetch, authorise: Parameters<typeof fakeRail>[0]): Promise<unknown> {
    try {
      await executeBazaarPayment(
        { policyRail: fakeRail(authorise), signerSecret: THROWAWAY_SECRET, fetchImpl },
        { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
      );
      return expect.unreachable("expected executeBazaarPayment to throw");
    } catch (error) {
      return error;
    }
  }

  const refuses = async () => ({
    authorised: false as const,
    code: "ScopeAmountExceeded" as const,
    reason: "over the per-transaction limit",
    details: {},
  });

  it("marks a PolicyRail refusal as pre-payment — nothing was signed, so the spend is releasable", async () => {
    const error = await failureFrom(fetchChallengeThen(challengeResponse()), refuses);
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(hasErrorCode(error, "ScopeAmountExceeded")).toBe(true);
  });

  it("keeps the original code and message when it stamps the marker on", async () => {
    // The marker must not cost a caller its typed refusal: every
    // `hasErrorCode` check upstream still has to match.
    const error = await failureFrom(fetchChallengeThen(challengeResponse()), refuses);
    expect(error).toBeInstanceOf(AgentPassError);
    expect((error as AgentPassError).message).toBe("over the per-transaction limit");
    expect((error as AgentPassError).code).toBe("ScopeAmountExceeded");
  });

  it("marks a venue that never answered with a 402 as pre-payment", async () => {
    const error = await failureFrom(fetchChallengeThen(new Response("ok", { status: 200 })), vi.fn());
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(hasErrorCode(error, "NetworkError")).toBe(true);
  });

  it("marks a venue that refused the request outright as pre-payment", async () => {
    const error = await failureFrom(
      fetchChallengeThen(new Response(JSON.stringify({ ok: false, code: "InvalidRequest" }), { status: 400 })),
      vi.fn(),
    );
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect(hasErrorCode(error, "MerchantRejectedRequest")).toBe(true);
  });

  it("marks an unreachable venue as pre-payment", async () => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const error = await failureFrom(unreachable, vi.fn());
    expect(mayHaveBeenPaid(error)).toBe(false);
  });
});

/**
 * T101 (`C-139`). The first real product of the Vitrinee store costs 13.67
 * USDC, and `x402Client`'s default cap of 1 USD refused it with a plain
 * `Error` after AgentPey had authorised it: the spend stayed counted and
 * `/v1` answered 500. These run the real client with a fake scheme, because
 * the real Stellar one needs a network to build a transaction.
 */
describe("executeBazaarPayment — the x402 client's own spend controls (C-139, T101)", () => {
  const STORE_AMOUNT = "136736842"; // 13.6736842 USDC, the store's beanie

  function challengeWith(accepts: readonly PaymentRequirements[]): Response {
    const body = { ...REAL_CHALLENGE_BODY, accepts };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") },
    });
  }

  const authorised = async () => ({
    authorised: true as const,
    intentId: "8b0851b3-94e9-45b0-ba36-000000000001",
    total: "13.6736842",
    currency: "USDC",
    spentToday: "13.6736842",
    reconciled: true,
  });

  function fakeScheme(build: (requirements: PaymentRequirements) => Promise<PaymentPayloadResult>): SchemeNetworkClient & { calls: PaymentRequirements[] } {
    const calls: PaymentRequirements[] = [];
    return {
      scheme: "exact",
      findDefaultAsset,
      calls,
      async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
        calls.push(requirements);
        return build(requirements);
      },
    } as SchemeNetworkClient & { calls: PaymentRequirements[] };
  }

  const builds = async () => ({ x402Version: 2, payload: { transaction: "ZmFrZQ==" } }) as PaymentPayloadResult;

  async function run(scheme: SchemeNetworkClient, fetchImpl: typeof fetch): Promise<unknown> {
    try {
      await executeBazaarPayment(
        { policyRail: fakeRail(authorised), signerSecret: THROWAWAY_SECRET, fetchImpl, schemeForTests: scheme },
        { resourceUrl: RESOURCE_URL, intent: intentFor(), scope: scopeFor(), mandate: mandateFor(), venueId: BAZAAR_VENUE_ID },
      );
      return expect.unreachable("expected executeBazaarPayment to throw at the fake venue");
    } catch (error) {
      return error;
    }
  }

  it("lets an authorised payment above 1 USD reach the scheme, and the door", async () => {
    const scheme = fakeScheme(builds);
    const unreachableAfterPaying = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    let first = true;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      if (first) {
        first = false;
        return challengeWith([{ ...REAL_REQUIREMENTS, amount: STORE_AMOUNT }]);
      }
      return unreachableAfterPaying(...args);
    }) as typeof fetch;

    const error = await run(scheme, fetchImpl);

    expect(scheme.calls.map((requirements) => requirements.amount)).toEqual([STORE_AMOUNT]);
    // It got past building the payment: the failure is the resend, after the
    // door, so the spend is (correctly) not releasable.
    expect(mayHaveBeenPaid(error)).toBe(true);
    expect(hasErrorCode(error, "NetworkError")).toBe(true);
  });

  it("hands the client only the requirement that was authorised, never a dearer offer from the same venue", async () => {
    const scheme = fakeScheme(builds);
    let first = true;
    const fetchImpl = (async () => {
      if (first) {
        first = false;
        return challengeWith([
          { ...REAL_REQUIREMENTS, amount: STORE_AMOUNT },
          { ...REAL_REQUIREMENTS, amount: "500000000" },
        ]);
      }
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await run(scheme, fetchImpl);

    expect(scheme.calls).toHaveLength(1);
    expect(scheme.calls[0]!.amount).toBe(STORE_AMOUNT);
  });

  it("types a dependency's failure before the door as PaymentNotCreated, so the spend is released", async () => {
    const scheme = fakeScheme(async () => {
      throw new Error("simulation failed for a reason this code has never seen");
    });
    const error = await run(scheme, fetchChallengeThen(challengeWith([{ ...REAL_REQUIREMENTS, amount: STORE_AMOUNT }])));

    expect(hasErrorCode(error, "PaymentNotCreated")).toBe(true);
    expect(mayHaveBeenPaid(error)).toBe(false);
    expect((error as AgentPassError).details[PAYMENT_SENT_DETAIL]).toBe(false);
  });

  it("caps the client at exactly the authorised amount, on exactly the reconciled asset", () => {
    expect(spendControlsFor({ ...REAL_REQUIREMENTS, amount: STORE_AMOUNT })).toEqual({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: "stellar:testnet", asset: BAZAAR_USDC_ISSUER, maxAmountPerPayment: STORE_AMOUNT }],
    });
  });
});
