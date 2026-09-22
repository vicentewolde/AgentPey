import { describe, expect, it } from "vitest";

import { newAgent, type AgentConfig } from "./accounts.js";
import type { CheckedResource } from "./bazaar-catalog.js";
import { buildCatalog, coverageOf, findCard, kindFor } from "./catalog.js";
import { BAZAAR_VENUE_ID, SIGNALDESK_VENUE_ID, TEST_TARGETS } from "./testing.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const PERMISSIONS = { perTx: "0.30", perDay: "0.60", validForDays: 30 };

function signed(kind: AgentConfig["kind"]): AgentConfig {
  const agent = newAgent("acc_1", kind, "An agent", PERMISSIONS, NOW);
  return { ...agent, tenantId: "ten_1", mandateId: "mdt_1" };
}

function unsigned(kind: AgentConfig["kind"]): AgentConfig {
  return newAgent("acc_1", kind, "An agent", PERMISSIONS, NOW);
}

const BAZAAR_ROWS: readonly CheckedResource[] = [
  {
    id: "swap-risk-quote",
    name: "Swap Risk Quote (Sandbox)",
    description: "Deterministic read-only swap risk quote.",
    declaredAmount: "0.001",
    declaredAsset: "USDC",
    declaredPayTo: "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
    routeTemplate: "/api/x402/swap-risk?pair={pair}",
    inputs: [{ name: "pair", type: "string", required: true }],
    availability: "sellable",
  },
  {
    id: "ai-video-scriptwriter",
    name: "AI Video Scriptwriter",
    description: "Writes a script.",
    declaredAmount: "0.02",
    declaredAsset: "USDC",
    declaredPayTo: "GBYXQUSY7WA3DUXZSANGQ3HMER2EBMOK5IYPUJV4YY2UH7QS736J62LB",
    routeTemplate: "/api/script?topic={topic}",
    inputs: [{ name: "topic", type: "string", required: true }],
    availability: "unavailable",
  },
];

describe("kindFor", () => {
  it("resolves a product to the kind whose grant names it, at that venue", () => {
    expect(kindFor(TEST_TARGETS, SIGNALDESK_VENUE_ID, "signaldesk:market-brief-xlm-usdc")).toBe("market_brief");
    expect(kindFor(TEST_TARGETS, BAZAAR_VENUE_ID, "swap-risk-quote")).toBe("bazaar_shopper");
  });

  /**
   * The venue is part of the question, not decoration. A grant names one venue,
   * so the same product id at another venue is another permission — which is
   * exactly what `checkMandate` decides on, byte for byte.
   */
  it("does not resolve a product at the wrong venue", () => {
    expect(kindFor(TEST_TARGETS, SIGNALDESK_VENUE_ID, "swap-risk-quote")).toBeUndefined();
    expect(kindFor(TEST_TARGETS, BAZAAR_VENUE_ID, "signaldesk:market-brief-xlm-usdc")).toBeUndefined();
  });

  it("does not resolve a product no target names", () => {
    expect(kindFor(TEST_TARGETS, BAZAAR_VENUE_ID, "something-the-merchant-added-today")).toBeUndefined();
  });
});

describe("coverageOf", () => {
  it("reports an account with no agent of that kind as outside the grant", () => {
    expect(coverageOf([], "bazaar_shopper")).toEqual({ state: "outside" });
    expect(coverageOf([signed("market_brief")], "bazaar_shopper")).toEqual({ state: "outside" });
  });

  it("reports an agent whose permission is not signed yet as its own state", () => {
    const agent = unsigned("bazaar_shopper");
    expect(coverageOf([agent], "bazaar_shopper")).toEqual({
      state: "unsigned",
      agentId: agent.id,
      agentLabel: agent.label,
    });
  });

  it("prefers a signed agent over an unsigned one of the same kind", () => {
    const ok = signed("bazaar_shopper");
    expect(coverageOf([unsigned("bazaar_shopper"), ok], "bazaar_shopper")).toMatchObject({
      state: "covered",
      agentId: ok.id,
    });
  });

  /**
   * A mandate id with no tenant is not a permission anything can be bought
   * with: the purchase path needs both, and a card that offered a buy form for
   * it would offer a button that cannot work.
   */
  it("does not count a mandate with no tenant as covered", () => {
    const half = { ...unsigned("bazaar_shopper"), mandateId: "mdt_1" };
    expect(coverageOf([half], "bazaar_shopper").state).toBe("unsigned");
  });
});

describe("buildCatalog", () => {
  it("draws both merchants, with the bazaar's own product ids verbatim", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS });

    expect(cards.map((card) => card.productId)).toEqual([
      "signaldesk:market-brief-xlm-usdc",
      "signaldesk:ai-credits-1000",
      "swap-risk-quote",
      "ai-video-scriptwriter",
    ]);
    expect(cards.filter((card) => card.venue === "bazaar")).toHaveLength(2);
  });

  /**
   * The wall the pilot used to hit, now visible instead of silent: an agent
   * that can buy at SignalDesk shows the bazaar's products as outside its
   * grant, which is exactly what AgentPey would decide.
   */
  it("marks the bazaar outside the grant for an account that only signed SignalDesk", () => {
    const cards = buildCatalog({
      targets: TEST_TARGETS,
      agents: [signed("market_brief")],
      bazaar: BAZAAR_ROWS,
    });

    expect(findCard(cards, "signaldesk:market-brief-xlm-usdc")!.coverage.state).toBe("covered");
    // Same merchant, other product, other kind: still outside.
    expect(findCard(cards, "signaldesk:ai-credits-1000")!.coverage.state).toBe("outside");
    expect(findCard(cards, "swap-risk-quote")!.coverage.state).toBe("outside");
  });

  it("marks the bazaar covered once its own agent is signed, and leaves SignalDesk alone", () => {
    const cards = buildCatalog({
      targets: TEST_TARGETS,
      agents: [signed("bazaar_shopper")],
      bazaar: BAZAAR_ROWS,
    });

    expect(findCard(cards, "swap-risk-quote")!.coverage.state).toBe("covered");
    expect(findCard(cards, "ai-video-scriptwriter")!.coverage.state).toBe("covered");
    expect(findCard(cards, "signaldesk:market-brief-xlm-usdc")!.coverage.state).toBe("outside");
  });

  /**
   * The merchant's listed price is carried for display and never becomes a
   * decision (`C-77`). Worth asserting because the moment it is read for
   * anything else, this line is where it would start.
   */
  it("carries the merchant's declared price as display only", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS });
    expect(findCard(cards, "swap-risk-quote")!.declaredAmount).toBe("0.001");
  });

  it("keeps the merchant's availability so the screen can say it is not for sale", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS });
    expect(findCard(cards, "ai-video-scriptwriter")!.availability).toBe("unavailable");
    expect(findCard(cards, "swap-risk-quote")!.availability).toBe("sellable");
  });

  /**
   * A product no `PilotTarget` names is dropped rather than drawn as forbidden:
   * offering to sign a permission RealOps cannot build would be a button that
   * cannot work, which is worse than an absence.
   */
  it("drops a bazaar row no grant could ever cover", () => {
    const rows: readonly CheckedResource[] = [{ ...BAZAAR_ROWS[0]!, id: "added-yesterday" }];
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: rows });
    expect(cards.every((card) => card.venue === "signaldesk")).toBe(true);
  });

  it("still draws SignalDesk when the bazaar could not be read", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: undefined });
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.venue === "signaldesk")).toBe(true);
  });

  /**
   * The credits route's `account` is the tenant's opaque reference. If it ever
   * became a form field, a browser could credit somebody else.
   */
  it("keeps SignalDesk's own parameters out of the person's hands, and the bazaar's in them", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS });
    expect(findCard(cards, "signaldesk:ai-credits-1000")!.serverFilled).toEqual(["account"]);
    expect(findCard(cards, "signaldesk:market-brief-xlm-usdc")!.serverFilled).toEqual(["pair"]);
    expect(findCard(cards, "swap-risk-quote")!.serverFilled).toEqual([]);
  });
});
