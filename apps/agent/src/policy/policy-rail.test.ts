import { hasErrorCode, stellarAddressToDid, type Scope } from "@agentpass/core";
import { createMandate, type AgentPayMandate, type MandateGrant } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk/base";
import { describe, expect, it } from "vitest";

import { makeVenueId } from "../catalog/ids.js";
import { EURC_MOCK, MOCK_VENUE_ID, USDC_TESTNET } from "../catalog/mock.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { createInMemorySpendLedger, type SpendLedger } from "../ledger/spend-ledger.js";
import { createLocalPolicyRail, policyRailError, type PolicyRail } from "./policy-rail.js";
import type { PaymentTerms } from "./terms.js";

const principal = Keypair.random();
const agent = Keypair.random();
const stranger = Keypair.random();

const PRINCIPAL_DID = stellarAddressToDid(principal.publicKey(), "testnet");
const AGENT_DID = stellarAddressToDid(agent.publicKey(), "testnet");
const STRANGER_DID = stellarAddressToDid(stranger.publicKey(), "testnet");

const REGISTRY = "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";
const OTHER_VENUE = makeVenueId("otro-bazaar", "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F");

/** Midday, so a test never lands on a UTC day boundary by accident. */
const NOON = new Date("2026-10-01T12:00:00.000Z");

function scopeFor(overrides: Partial<Scope> = {}): Scope {
  return {
    actions: ["catalog:read", "intent:create"],
    venues: [MOCK_VENUE_ID],
    assets: [USDC_TESTNET],
    limits: { perTx: "50.00", perDay: "200.00", currency: "USDC" },
    ...overrides,
  };
}

function mandateFor(grant: Partial<MandateGrant> = {}): AgentPayMandate {
  return createMandate({
    principal: PRINCIPAL_DID,
    agent: AGENT_DID,
    grant: scopeFor(grant),
    registry: REGISTRY,
    validFrom: "2026-09-01T00:00:00.000Z",
    validUntil: "2026-12-01T00:00:00.000Z",
  });
}

let nextIntent = 0;

function intentFor(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  nextIntent += 1;
  return {
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: `8b0851b3-94e9-45b0-ba36-${String(nextIntent).padStart(12, "0")}`,
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

interface Harness {
  readonly rail: PolicyRail;
  readonly ledger: SpendLedger;
}

function harness(now: () => Date = () => NOON): Harness {
  const ledger = createInMemorySpendLedger();
  return { rail: createLocalPolicyRail({ ledger, now }), ledger };
}

describe("a purchase both authorities allow", () => {
  it("is authorised, and says what it recorded", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate: mandateFor(),
    });

    expect(decision.authorised).toBe(true);
    if (!decision.authorised) expect.unreachable("expected an authorisation");
    expect(decision.total).toBe("37.0000000");
    expect(decision.currency).toBe("USDC");
    expect(decision.spentToday).toBe("37.0000000");
  });

  it("records the spend against the agent, so the next purchase sees it", async () => {
    const { rail, ledger } = harness();

    await rail.authorise({ intent: intentFor(), scope: scopeFor(), mandate: mandateFor() });

    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("37.0000000");
  });

  it("accumulates across purchases", async () => {
    const { rail } = harness();
    const scope = scopeFor();
    const mandate = mandateFor();

    const first = await rail.authorise({ intent: intentFor(), scope, mandate });
    const second = await rail.authorise({ intent: intentFor(), scope, mandate });

    if (!first.authorised || !second.authorised) expect.unreachable("expected authorisations");
    expect(first.spentToday).toBe("37.0000000");
    expect(second.spentToday).toBe("74.0000000");
  });
});

describe("the terms of the payment are reconciled before anything else (M-14)", () => {
  const TERMS: PaymentTerms = { venue: MOCK_VENUE_ID, asset: USDC_TESTNET, amount: "37.00" };

  it("reports it reconciled when terms were supplied", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate: mandateFor(),
      terms: TERMS,
    });

    if (!decision.authorised) expect.unreachable("expected an authorisation");
    expect(decision.reconciled).toBe(true);
  });

  it("says so plainly when there were no terms to reconcile, rather than implying a check", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate: mandateFor(),
    });

    if (!decision.authorised) expect.unreachable("expected an authorisation");
    expect(decision.reconciled).toBe(false);
  });

  it("refuses a venue asking for more than the intent, even when everything else permits it", async () => {
    const { rail, ledger } = harness();

    // 40.00 is under perTx (50.00) and under perDay (200.00). Every limit
    // would allow it. It is still not the purchase that was signed.
    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate: mandateFor(),
      terms: { ...TERMS, amount: "40.00" },
    });

    expect(decision.authorised).toBe(false);
    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsAmountMismatch");
    // And nothing was recorded: a refused purchase does not consume budget.
    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("0.0000000");
  });

  it("refuses a payee the mandate's payTo list does not name (M-14)", async () => {
    const { rail, ledger } = harness();
    const mandate = mandateFor({ payTo: ["GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ"] });

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate,
      terms: { ...TERMS, payTo: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ" },
    });

    expect(decision.authorised).toBe(false);
    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsPayeeNotAllowed");
    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("0.0000000");
  });

  it("authorises a payee the mandate's payTo list does name", async () => {
    const { rail } = harness();
    const payTo = "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ";
    const mandate = mandateFor({ payTo: [payTo] });

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate,
      terms: { ...TERMS, payTo },
    });

    expect(decision.authorised).toBe(true);
  });

  it("does not check payTo when the mandate carries no list, exactly as before M-14", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate: mandateFor(),
      terms: { ...TERMS, payTo: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ" },
    });

    expect(decision.authorised).toBe(true);
  });

  it("reports the terms mismatch ahead of a scope violation on the same request", async () => {
    const { rail } = harness();

    // Both are wrong. The terms mismatch is the more fundamental one: it says
    // the other checks would be answering about a different purchase.
    const decision = await rail.authorise({
      intent: intentFor({ venue: OTHER_VENUE }),
      scope: scopeFor(),
      mandate: mandateFor(),
      terms: { ...TERMS, venue: MOCK_VENUE_ID },
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("TermsVenueMismatch");
  });
});

describe("both authorities must allow, and neither can widen the other (M-4)", () => {
  it("refuses with the credential's code when the scope is what forbids it", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor({ limits: { perTx: "10.00", perDay: "200.00", currency: "USDC" } }),
      mandate: mandateFor(),
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("ScopeAmountExceeded");
  });

  it("refuses with the mandate's code when the principal's consent is what forbids it", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(),
      mandate: mandateFor({ limits: { perTx: "10.00", perDay: "200.00", currency: "USDC" } }),
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("MandateAmountExceeded");
  });

  it("a generous mandate does not widen a narrow credential", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor({ venues: [] }),
      mandate: mandateFor({ venues: [MOCK_VENUE_ID, OTHER_VENUE] }),
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("ScopeVenueNotAllowed");
  });

  it("a generous credential does not widen a narrow mandate", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor({ assets: [USDC_TESTNET, EURC_MOCK] }),
      mandate: mandateFor({ assets: [EURC_MOCK] }),
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("MandateAssetNotAllowed");
  });

  it("refuses a mandate that does not empower this agent", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor({ agent: STRANGER_DID }),
      scope: scopeFor(),
      mandate: mandateFor(),
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    expect(decision.code).toBe("MandateAgentMismatch");
  });
});

describe("the daily limit, against both authorities (M-16)", () => {
  it("refuses with the credential's code when scope.limits.perDay runs out first", async () => {
    const { rail } = harness();
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });
    const mandate = mandateFor();

    const first = await rail.authorise({ intent: intentFor(), scope, mandate });
    const second = await rail.authorise({ intent: intentFor(), scope, mandate });

    expect(first.authorised).toBe(true);
    if (second.authorised) expect.unreachable("expected a refusal");
    expect(second.code).toBe("ScopeDailyLimitExceeded");
    expect(second.details).toMatchObject({ spentToday: "37.0000000", limit: "50.00" });
  });

  it("refuses with the mandate's code when grant.limits.perDay runs out first", async () => {
    const { rail } = harness();
    const scope = scopeFor();
    const mandate = mandateFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });

    await rail.authorise({ intent: intentFor(), scope, mandate });
    const second = await rail.authorise({ intent: intentFor(), scope, mandate });

    if (second.authorised) expect.unreachable("expected a refusal");
    expect(second.code).toBe("MandateDailyLimitExceeded");
  });

  it("counts both authorities against the same running total", async () => {
    const { rail } = harness();
    // Neither limit alone is exceeded by one purchase; the second purchase
    // exceeds both. The stricter one is the one reported.
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "60.00", currency: "USDC" } });
    const mandate = mandateFor({ limits: { perTx: "50.00", perDay: "70.00", currency: "USDC" } });

    await rail.authorise({ intent: intentFor(), scope, mandate });
    const second = await rail.authorise({ intent: intentFor(), scope, mandate });

    if (second.authorised) expect.unreachable("expected a refusal");
    expect(second.code).toBe("ScopeDailyLimitExceeded");
  });

  /**
   * T90 lets a partner choose which of an agent's Mandates a purchase goes
   * through. Choosing does not split the day's budget: the running total is
   * the agent's, so each Mandate's `perDay` is checked against everything the
   * agent spent today, through any of them. Pinned here so a change to that is
   * a decision someone takes, not a side effect.
   */
  it("counts every Mandate of the same agent against one running total", async () => {
    const { rail } = harness();
    const scope = scopeFor();
    const first = mandateFor({ limits: { perTx: "50.00", perDay: "100.00", currency: "USDC" } });
    const second = mandateFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });

    const throughFirst = await rail.authorise({ intent: intentFor(), scope, mandate: first });
    const throughSecond = await rail.authorise({ intent: intentFor(), scope, mandate: second });

    expect(throughFirst.authorised).toBe(true);
    if (throughSecond.authorised) expect.unreachable("expected a refusal");
    expect(throughSecond.code).toBe("MandateDailyLimitExceeded");
    expect(throughSecond.details).toMatchObject({ spentToday: "37.0000000", limit: "50.00" });
  });

  it("lets the budget start again on the next UTC day", async () => {
    let today = new Date("2026-10-01T23:00:00.000Z");
    const { rail } = harness(() => today);
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });
    const mandate = mandateFor();

    await rail.authorise({ intent: intentFor(), scope, mandate });
    today = new Date("2026-10-02T01:00:00.000Z");
    const next = await rail.authorise({ intent: intentFor(), scope, mandate });

    expect(next.authorised).toBe(true);
  });

  it("reads the day from the rail's clock, never from the intent the agent signed (M-16)", async () => {
    const { rail } = harness();
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });
    const mandate = mandateFor();

    await rail.authorise({ intent: intentFor(), scope, mandate });

    // A compromised agent backdates its next intent to yesterday, hoping to
    // land in an empty bucket. The rail's clock is what decides the bucket.
    const backdated = await rail.authorise({
      intent: intentFor({ issuedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T00:15:00.000Z" }),
      scope,
      mandate,
    });

    if (backdated.authorised) expect.unreachable("expected a refusal");
    expect(backdated.code).toBe("ScopeDailyLimitExceeded");
  });
});

describe("a refused purchase consumes nothing (M-15)", () => {
  it.each([
    ["the scope's perTx", { scope: { limits: { perTx: "1.00", perDay: "200.00", currency: "USDC" } } }],
    ["the mandate's venues", { mandate: { venues: [] } }],
  ])("records no spend when %s refuses", async (_label, overrides) => {
    const { rail, ledger } = harness();
    const o = overrides as { scope?: Partial<Scope>; mandate?: Partial<Scope> };

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor(o.scope),
      mandate: mandateFor(o.mandate),
    });

    expect(decision.authorised).toBe(false);
    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("0.0000000");
  });
  it("records nothing when the day's limit is what refuses it", async () => {
    // The other refusals happen before the ledger is ever touched. This one
    // happens inside the critical section, one line above the `record` call —
    // the only place where recording a refused purchase is even possible.
    const { rail, ledger } = harness();
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });
    const mandate = mandateFor();

    await rail.authorise({ intent: intentFor(), scope, mandate });
    const refused = await rail.authorise({ intent: intentFor(), scope, mandate });

    expect(refused.authorised).toBe(false);
    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("37.0000000");
  });
});

describe("concurrent authorisations cannot both spend the same room (M-15)", () => {
  it("serialises them, so the second sees what the first recorded", async () => {
    // The TOCTOU M-10 named and deferred to this milestone: without the
    // critical section, both of these read spentToday = 0 and both pass,
    // together spending 74.00 against a 50.00 daily limit.
    const { rail } = harness();
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "50.00", currency: "USDC" } });
    const mandate = mandateFor();

    const [first, second] = await Promise.all([
      rail.authorise({ intent: intentFor(), scope, mandate }),
      rail.authorise({ intent: intentFor(), scope, mandate }),
    ]);

    expect([first.authorised, second.authorised].filter(Boolean)).toHaveLength(1);
    const refused = first.authorised ? second : first;
    if (refused.authorised) expect.unreachable("expected exactly one refusal");
    expect(refused.code).toBe("ScopeDailyLimitExceeded");
  });

  it("holds under more concurrency than the day has room for", async () => {
    const { rail, ledger } = harness();
    // Room for exactly five purchases of 37.00 (185.00 of a 200.00 budget).
    const scope = scopeFor();
    const mandate = mandateFor();

    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => rail.authorise({ intent: intentFor(), scope, mandate })),
    );

    expect(decisions.filter((d) => d.authorised)).toHaveLength(5);
    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("185.0000000");
  });

  it("a failing authorisation does not poison the queue for the next one", async () => {
    // A ledger whose first `record` blows up, so `authorise` rejects *inside*
    // the critical section rather than returning a decision. The queue must
    // survive it: one broken authorisation cannot stop the agent from ever
    // buying again.
    let calls = 0;
    const inner = createInMemorySpendLedger();
    const flaky: SpendLedger = {
      spentOn: (subject, currency, at) => inner.spentOn(subject, currency, at),
      hasRecorded: (intentId) => inner.hasRecorded(intentId),
      record: async (entry) => {
        calls += 1;
        if (calls === 1) throw new Error("ledger unavailable");
        await inner.record(entry);
      },
    };
    const rail = createLocalPolicyRail({ ledger: flaky, now: () => NOON });
    const scope = scopeFor();
    const mandate = mandateFor();

    await expect(rail.authorise({ intent: intentFor(), scope, mandate })).rejects.toThrow(
      "ledger unavailable",
    );

    const after = await rail.authorise({ intent: intentFor(), scope, mandate });

    expect(after.authorised).toBe(true);
    if (!after.authorised) expect.unreachable("expected an authorisation");
    // And the failed one recorded nothing: the day's budget is untouched by it.
    expect(after.spentToday).toBe("37.0000000");
  });
});

describe("authorising the same intent twice counts once", () => {
  it("does not double-charge the day's budget", async () => {
    const { rail, ledger } = harness();
    const scope = scopeFor();
    const mandate = mandateFor();
    const intent = intentFor();

    await rail.authorise({ intent, scope, mandate });
    const again = await rail.authorise({ intent, scope, mandate });

    expect(again.authorised).toBe(true);
    expect(await ledger.spentOn(AGENT_DID, "USDC", NOON)).toBe("37.0000000");
  });

  it("does not refuse a re-verification that only fits because it isn't counted twice (G-8)", async () => {
    // perDay = 40.00 is tight around a single 37.00 purchase: room for one,
    // not for the same purchase counted a second time on top of itself. This
    // is exactly what a real payment does — authorise() is called once
    // structurally (T19) and again with the venue's real terms (T24) — so a
    // fix that only de-duplicates the *ledger* and not the *check* would
    // still refuse the second call here.
    const { rail } = harness();
    const scope = scopeFor({ limits: { perTx: "50.00", perDay: "40.00", currency: "USDC" } });
    const mandate = mandateFor({ limits: { perTx: "50.00", perDay: "40.00", currency: "USDC" } });
    const intent = intentFor();

    const first = await rail.authorise({ intent, scope, mandate });
    expect(first.authorised).toBe(true);

    const second = await rail.authorise({ intent, scope, mandate });
    expect(second.authorised).toBe(true);
    if (!second.authorised) expect.unreachable("expected the re-verification to be authorised");
    expect(second.spentToday).toBe("37.0000000");
  });
});

describe("the refusal becomes a typed error at the tool boundary", () => {
  it("carries the code and the details of whichever check refused", async () => {
    const { rail } = harness();

    const decision = await rail.authorise({
      intent: intentFor(),
      scope: scopeFor({ limits: { perTx: "1.00", perDay: "200.00", currency: "USDC" } }),
      mandate: mandateFor(),
    });

    if (decision.authorised) expect.unreachable("expected a refusal");
    const error = policyRailError(decision);

    expect(hasErrorCode(error, "ScopeAmountExceeded")).toBe(true);
    expect(error.details).toMatchObject({ limit: "1.00" });
  });
});
