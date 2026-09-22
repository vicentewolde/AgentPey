import { describe, expect, it } from "vitest";

import type { AgentPermissions } from "./accounts.js";
import {
  CURRENCY,
  PURCHASE_ACTION,
  enforcementSummary,
  proposedGrantSchema,
  translatePermissions,
  type PilotTargets,
} from "./permissions.js";
import { TEST_TARGETS } from "./testing.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

const TARGETS = TEST_TARGETS;

const PERMISSIONS: AgentPermissions = { perTx: "0.30", perDay: "0.60", validForDays: 30 };

describe("translatePermissions", () => {
  /**
   * `PURCHASE_ACTION` is copied from `checkScope`'s own `INTENT_CREATE_ACTION`
   * (`apps/agent/src/scope`), not imported — RealOps is a partner and builds
   * from the published contract (`examples/cloudops-partner-integration.md`:
   * `actions: [..., "intent:create"]`), not an internal import. A copy that
   * drifts from the real value is invisible until a real Mandate gets
   * rejected with `ScopeActionNotAllowed` on its first purchase — which is
   * exactly what happened before this test existed.
   */
  it("proposes the one action checkScope actually requires", () => {
    expect(PURCHASE_ACTION).toBe("intent:create");
  });

  it("builds a grant that matches the published schema", () => {
    const { grant } = translatePermissions("market_brief", PERMISSIONS, TARGETS, NOW);

    expect(proposedGrantSchema.safeParse(grant).success).toBe(true);
  });

  it("puts each control where the layer that enforces it will look", () => {
    const { grant } = translatePermissions("market_brief", PERMISSIONS, TARGETS, NOW);

    expect(grant).toMatchObject({
      actions: [PURCHASE_ACTION],
      venues: [TARGETS.market_brief.venueId],
      assets: [TARGETS.market_brief.assetId],
      products: ["signaldesk:market-brief-xlm-usdc"],
      payTo: [...TARGETS.market_brief.payTo],
      limits: { perTx: "0.30", perDay: "0.60", currency: CURRENCY },
    });
  });

  /**
   * T73 made the product permission real. Each agent gets only its own
   * product: an agent for briefs cannot buy credits, even though both live at
   * the same merchant.
   */
  it("grants each agent kind only its own product", () => {
    const brief = translatePermissions("market_brief", PERMISSIONS, TARGETS, NOW);
    const credits = translatePermissions("ai_credits", PERMISSIONS, TARGETS, NOW);

    expect(brief.grant.products).toEqual(["signaldesk:market-brief-xlm-usdc"]);
    expect(credits.grant.products).toEqual(["signaldesk:ai-credits-1000"]);
    expect(brief.grant.products).not.toContain("signaldesk:ai-credits-1000");
  });

  /** A validity window the browser could choose is one an attacker could choose. */
  it("computes the window from the clock, never from input", () => {
    const { grant } = translatePermissions("market_brief", { ...PERMISSIONS, validForDays: 7 }, TARGETS, NOW);

    expect(grant.validFrom).toBe(NOW.toISOString());
    expect(new Date(grant.validUntil).getTime() - NOW.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("carries amounts as strings, so no float ever touches a limit", () => {
    const { grant } = translatePermissions("market_brief", { ...PERMISSIONS, perTx: "0.1" }, TARGETS, NOW);

    expect(typeof grant.limits.perTx).toBe("string");
    expect(grant.limits.perTx).toBe("0.1");
  });
});

describe("the enforcement labels", () => {
  const { controls } = translatePermissions("market_brief", PERMISSIONS, TARGETS, NOW);

  /**
   * `PILOTO-F9.md` § 7.1 asks the review screen to mark what enforces what.
   * The difference between "signed", "on-chain" and "RealOps decides" is the
   * difference between a guarantee and a promise, and a UI that showed them
   * identically would be claiming guarantees the system does not make.
   */
  it("marks every control with who enforces it", () => {
    expect(controls.every((control) => ["signed", "onchain", "realops"].includes(control.enforcedBy))).toBe(true);
  });

  it("labels the two limits as on-chain, because the contract revalidates them", () => {
    const limits = controls.filter((control) => control.field.startsWith("limits."));

    expect(limits).toHaveLength(2);
    expect(limits.every((control) => control.enforcedBy === "onchain")).toBe(true);
  });

  it("is honest that the agent's name is only RealOps' business", () => {
    const label = controls.find((control) => control.enforcedBy === "realops");

    expect(label?.label.es).toContain("Nombre");
    expect(label?.explanation.es).toContain("no cambia lo que el agente puede hacer");
    expect(label?.explanation.en).toContain("does not change what the agent can do");
  });

  it("counts what is actually guaranteed", () => {
    const summary = enforcementSummary(controls);

    expect(summary.signed + summary.onchain).toBeGreaterThan(summary.realops);
    expect(summary.realops).toBe(1);
  });

  it("shows a value for every control, so nothing on screen is blank", () => {
    expect(controls.every((control) => control.value.trim() !== "")).toBe(true);
    expect(controls.every((control) => control.explanation.en.trim() !== "" && control.explanation.es.trim() !== "")).toBe(true);
  });
});
