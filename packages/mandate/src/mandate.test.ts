import { scopeSchema } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { grantToScope, mandateGrantSchema } from "./mandate.js";

const FULL_GRANT = mandateGrantSchema.parse({
  actions: ["purchase"],
  venues: ["signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
  assets: ["USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
  limits: { perTx: "0.30", perDay: "0.30", currency: "USDC" },
  payTo: ["GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
  products: ["signaldesk:market-brief-xlm-usdc"],
});

/**
 * `mandateGrantSchema` extends `scopeSchema` with `payTo` (`M-14`) and
 * `products` (`C-75`). A credential's `scope` field is validated against the
 * narrower, strict `scopeSchema` and does not know either extension — an
 * agent's issued credential is a statement about what it may generally do,
 * not the buyer's own consent narrowing that down further.
 *
 * This exists because the one caller that did this by hand
 * (`apps/web/src/server.ts`'s `startConsentSession`) stripped only `payTo`,
 * a leftover from before `products` existed. Every real consent-session
 * wallet-anchor with a `products`-bearing grant then failed
 * `InvalidCredential: payload does not match the AgentPass schema` — found
 * running the flow with a real wallet, not by reading.
 */
describe("grantToScope", () => {
  it("strips payTo and products, and the result validates as a plain Scope", () => {
    const scope = grantToScope(FULL_GRANT);

    expect(scope).not.toHaveProperty("payTo");
    expect(scope).not.toHaveProperty("products");
    const result = scopeSchema.safeParse(scope);
    expect(result.success).toBe(true);
  });

  it("keeps everything a Scope actually needs", () => {
    const scope = grantToScope(FULL_GRANT);

    expect(scope.actions).toEqual(FULL_GRANT.actions);
    expect(scope.venues).toEqual(FULL_GRANT.venues);
    expect(scope.assets).toEqual(FULL_GRANT.assets);
    expect(scope.limits).toEqual(FULL_GRANT.limits);
  });

  it("works the same on a grant with no payTo or products (both optional)", () => {
    const bare = mandateGrantSchema.parse({
      actions: ["purchase"],
      venues: ["signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
      assets: ["USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
      limits: { perTx: "0.30", perDay: "0.30", currency: "USDC" },
    });

    expect(scopeSchema.safeParse(grantToScope(bare)).success).toBe(true);
  });
});
