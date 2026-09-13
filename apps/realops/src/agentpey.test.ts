import { isAgentPassError } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { createAgentPeyClient, PURCHASE_TIMEOUT_MS } from "./agentpey.js";

/**
 * A timeout is not "AgentPey is unreachable". In the deployed pilot a purchase
 * took 20–40 s, RealOps gave up at 15 s and said "no se pudo hablar con
 * AgentPey", and AgentPey settled the payment anyway (T84). The client has to
 * tell the two apart, and give a purchase long enough to finish.
 */
describe("timeouts", () => {
  const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  it("marks a timed-out call as timedOut, distinct from an unreachable AgentPey", async () => {
    const client = createAgentPeyClient({
      baseUrl: "https://agentpey.example",
      apiKey: "ap_test_x",
      fetchImpl: async () => {
        throw timeoutError();
      },
    });

    const error = await client.readActivity("ptn_x:tenant1").catch((caught: unknown) => caught);

    expect(isAgentPassError(error) && error.details.timedOut).toBe(true);
  });

  it("does not mark a refused connection as timedOut", async () => {
    const client = createAgentPeyClient({
      baseUrl: "https://agentpey.example",
      apiKey: "ap_test_x",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const error = await client.readActivity("ptn_x:tenant1").catch((caught: unknown) => caught);

    expect(isAgentPassError(error)).toBe(true);
    expect(isAgentPassError(error) && error.details.timedOut).toBeFalsy();
  });

  it("gives a purchase its own, longer timeout", async () => {
    let signal: AbortSignal | undefined;
    const client = createAgentPeyClient({
      baseUrl: "https://agentpey.example",
      apiKey: "ap_test_x",
      timeoutMs: 15_000,
      fetchImpl: async (_url, init) => {
        signal = init!.signal ?? undefined;
        return new Response(JSON.stringify({ ok: false, code: "Stop", message: "stop" }), { status: 400 });
      },
    });

    await client
      .purchase({ tenantId: "ptn_x:tenant1", venue: "v", productId: "p", quantity: 1, idempotencyKey: "k" })
      .catch(() => undefined);

    expect(PURCHASE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    // The signal is a timeout signal and not already aborted; its duration is
    // not observable, so the constant above is what pins the value.
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
  });
});
import type { ProposedGrant } from "./permissions.js";

const GRANT: ProposedGrant = {
  actions: ["intent:create"],
  venues: ["signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
  assets: ["USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
  products: ["signaldesk:market-brief-xlm-usdc"],
  payTo: ["GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
  limits: { perTx: "0.30", perDay: "0.30", currency: "USDC" },
  validFrom: "2026-09-13T00:00:00.000Z",
  validUntil: "2026-10-13T00:00:00.000Z",
};

/**
 * `mandateGrantSchema` (`@agentpey/mandate`) is a `strictObject` with no
 * `validFrom`/`validUntil` — the validity window is a sibling of `grant` in
 * `createConsentSessionRequestSchema`, not a field of it. `ProposedGrant`
 * (`permissions.ts`) carries both inside the grant object anyway, because the
 * review screen needs them there. A regression that forwards `input.grant`
 * verbatim smuggles those two keys past a strict schema and AgentPey refuses
 * the whole request with `InvalidArguments` — found only by sending a real
 * request, since `signing.test.ts` exercises a fake `AgentPeyClient` and never
 * builds this body. This test builds the actual wire body `createAgentPeyClient`
 * sends, so a regression here fails without needing testnet.
 */
describe("createConsentSession's wire body", () => {
  it("does not leak validFrom/validUntil into the grant object", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = createAgentPeyClient({
      baseUrl: "https://agentpey.example",
      apiKey: "ap_test_x",
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init!.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: "cns_1",
              status: "pending",
              consent_url: "https://agentpey.example/consent/cns_1",
              return_url: null,
              mandate_id: null,
              expires_at: "2026-09-14T00:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      },
    });

    await client.createConsentSession({
      tenantId: "ptn_x:tenant1",
      grant: GRANT,
      returnUrl: "https://realops.example/agentes/agt_1/volver",
      idempotencyKey: "consent-agt_1",
    });

    expect(capturedBody).toBeDefined();
    const grant = capturedBody!["grant"] as Record<string, unknown>;
    expect(grant).not.toHaveProperty("validFrom");
    expect(grant).not.toHaveProperty("validUntil");
    // Everything else the grant actually needs still travels.
    expect(grant["products"]).toEqual(["signaldesk:market-brief-xlm-usdc"]);
    expect(grant["limits"]).toEqual({ perTx: "0.30", perDay: "0.30", currency: "USDC" });
    // The validity window still reaches AgentPey — as a sibling, not nested.
    expect(capturedBody!["valid_until"]).toBe("2026-10-13T00:00:00.000Z");
  });
});
