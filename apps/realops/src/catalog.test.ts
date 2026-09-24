import { describe, expect, it } from "vitest";

import { newAgent, type AgentConfig } from "./accounts.js";
import type { CheckedResource } from "./bazaar-catalog.js";
import { buildCatalog, coverageOf, findCard, kindFor, storeTarget, type StoreRows } from "./catalog.js";
import { BAZAAR_VENUE_ID, OTHER_STORE_PAY_TO, OTHER_STORE_VENUE_ID, SIGNALDESK_VENUE_ID, STORE_VENUE_ID, TEST_TARGETS, VITRINEE_PAY_TO, VITRINEE_VENUE_ID } from "./testing.js";

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

/** Two of the real store's products, shaped exactly as its ServiceCard feed answered on 2026-09-23. */
const VITRINEE_ROWS: readonly CheckedResource[] = [
  {
    id: "37283001",
    name: "Pack de stickers Cordillera",
    description: "Seis stickers de vinilo.",
    declaredAmount: "1.0421053",
    declaredAsset: "USDC",
    declaredPayTo: VITRINEE_PAY_TO,
    routeTemplate: "/checkout/37283001?quantity={quantity}&name={name}&address={address}&city={city}&region={region}",
    inputs: [
      { name: "quantity", type: "number", required: true },
      { name: "name", type: "string", required: true },
      { name: "address", type: "string", required: true },
      { name: "city", type: "string", required: true },
      { name: "region", type: "string", required: true },
    ],
    availability: "sellable",
  },
  {
    id: "37282902",
    name: "Hoodie Cordillera talla M",
    description: "Polerón con capucha.",
    declaredAmount: "36.8315789",
    declaredAsset: "USDC",
    declaredPayTo: VITRINEE_PAY_TO,
    routeTemplate: "/checkout/37282902?quantity={quantity}&name={name}&address={address}&city={city}&region={region}",
    inputs: [
      { name: "quantity", type: "number", required: true },
      { name: "name", type: "string", required: true },
      { name: "address", type: "string", required: true },
      { name: "city", type: "string", required: true },
      { name: "region", type: "string", required: true },
    ],
    availability: "sellable",
  },
];

const STORE: StoreRows = { slug: "bazar-cordillera", name: "Bazar Cordillera", venueId: STORE_VENUE_ID, rows: VITRINEE_ROWS };
const OTHER_STORE: StoreRows = {
  slug: "otra-tienda",
  name: "Otra Tienda",
  venueId: OTHER_STORE_VENUE_ID,
  rows: [{ ...VITRINEE_ROWS[0]!, id: "otra-9001", declaredPayTo: OTHER_STORE_PAY_TO }],
};

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
    // The store's product ids are Jumpseller's; at the bazaar's venue they name nothing (T100).
    expect(kindFor(TEST_TARGETS, BAZAAR_VENUE_ID, "37283001")).toBeUndefined();
  });

  it("resolves the real store's products to the Vitrinee kind, at the store's venue (T100)", () => {
    expect(kindFor(TEST_TARGETS, VITRINEE_VENUE_ID, "37283001")).toBe("vitrinee_shopper");
    expect(kindFor(TEST_TARGETS, VITRINEE_VENUE_ID, "37282902")).toBe("vitrinee_shopper");
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
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS, stores: [] });

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
      stores: [],
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
      stores: [],
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
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS, stores: [] });
    expect(findCard(cards, "swap-risk-quote")!.declaredAmount).toBe("0.001");
  });

  it("keeps the merchant's availability so the screen can say it is not for sale", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS, stores: [] });
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
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: rows, stores: [] });
    expect(cards.every((card) => card.venue === "signaldesk")).toBe(true);
  });

  it("still draws SignalDesk when the bazaar could not be read", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: undefined, stores: [] });
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.venue === "signaldesk")).toBe(true);
  });

  /**
   * The credits route's `account` is the tenant's opaque reference. If it ever
   * became a form field, a browser could credit somebody else.
   */
  it("keeps SignalDesk's own parameters out of the person's hands, and the bazaar's in them", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS, stores: [] });
    expect(findCard(cards, "signaldesk:ai-credits-1000")!.serverFilled).toEqual(["account"]);
    expect(findCard(cards, "signaldesk:market-brief-xlm-usdc")!.serverFilled).toEqual(["pair"]);
    expect(findCard(cards, "swap-risk-quote")!.serverFilled).toEqual([]);
  });

  /**
   * T104: each Vitrinee store the directory names is its own section, its
   * cards are its own products verbatim, and only that store's own shopper
   * covers them.
   */
  it("draws each Vitrinee store after the bazaar, covered only by its own store's shopper", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [signed("bazaar_shopper")], bazaar: BAZAAR_ROWS, stores: [STORE] });

    expect(cards.map((card) => card.productId)).toEqual([
      "signaldesk:market-brief-xlm-usdc",
      "signaldesk:ai-credits-1000",
      "swap-risk-quote",
      "ai-video-scriptwriter",
      "37283001",
      "37282902",
    ]);
    const stickers = findCard(cards, "37283001")!;
    expect(stickers).toMatchObject({
      venue: "vitrinee",
      store: { slug: "bazar-cordillera", name: "Bazar Cordillera" },
      kind: "vitrinee_shopper",
      venueId: STORE_VENUE_ID,
      declaredAmount: "1.0421053",
    });
    // A signed bazaar agent covers nothing at the store: another venue is another permission.
    expect(stickers.coverage.state).toBe("outside");
    expect(findCard(cards, "swap-risk-quote")!.coverage.state).toBe("covered");
  });

  it("marks a store covered once its own shopper is signed, and no other store", () => {
    const shopper = { ...signed("vitrinee_shopper"), comercio: "bazar-cordillera" };
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [shopper], bazaar: BAZAAR_ROWS, stores: [STORE, OTHER_STORE] });
    expect(findCard(cards, "37283001")!.coverage.state).toBe("covered");
    expect(findCard(cards, "37282902")!.coverage.state).toBe("covered");
    expect(findCard(cards, "otra-9001")!.coverage.state).toBe("outside");
    expect(findCard(cards, "swap-risk-quote")!.coverage.state).toBe("outside");
  });

  /** A store shopper hired before T104 names no store, so it covers none. */
  it("does not count a store shopper with no store as covering any store", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [signed("vitrinee_shopper")], bazaar: undefined, stores: [STORE] });
    expect(findCard(cards, "37283001")!.coverage.state).toBe("outside");
  });

  /** Two cards with one product id would make every form ambiguous, so the store's is not drawn. */
  it("drops a store's card whose product id another card already uses", () => {
    const clash: StoreRows = { ...OTHER_STORE, rows: [{ ...OTHER_STORE.rows![0]!, id: "37283001" }] };
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: undefined, stores: [STORE, clash] });
    expect(cards.filter((card) => card.productId === "37283001")).toHaveLength(0);
    expect(findCard(cards, "37282902")).toBeDefined();
  });

  it("builds a store shopper's grant target from that store only", () => {
    const targets = storeTarget(TEST_TARGETS, { venueId: OTHER_STORE_VENUE_ID, payTo: OTHER_STORE_PAY_TO }, ["otra-9001"]);
    expect(targets.vitrinee_shopper).toEqual({ venueId: OTHER_STORE_VENUE_ID, assetId: TEST_TARGETS.vitrinee_shopper.assetId, payTo: [OTHER_STORE_PAY_TO], products: ["otra-9001"] });
    expect(targets.bazaar_shopper).toBe(TEST_TARGETS.bazaar_shopper);
  });

  /** Every input of a physical order is the person's, including the quantity: RealOps fills none of them. */
  it("leaves the store's shipping inputs, and its quantity, in the person's hands", () => {
    const cards = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: undefined, stores: [STORE] });
    const stickers = findCard(cards, "37283001")!;
    expect(stickers.serverFilled).toEqual([]);
    expect(stickers.inputs.map((input) => input.name)).toEqual(["quantity", "name", "address", "city", "region"]);
  });

  it("still draws the store when the bazaar could not be read, and the other way round", () => {
    const withoutBazaar = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: undefined, stores: [STORE] });
    expect(withoutBazaar.filter((card) => card.venue === "vitrinee")).toHaveLength(2);
    expect(withoutBazaar.some((card) => card.venue === "bazaar")).toBe(false);
    const withoutStore = buildCatalog({ targets: TEST_TARGETS, agents: [], bazaar: BAZAAR_ROWS, stores: [] });
    expect(withoutStore.some((card) => card.venue === "vitrinee")).toBe(false);
    expect(withoutStore.filter((card) => card.venue === "bazaar")).toHaveLength(2);
  });
});
