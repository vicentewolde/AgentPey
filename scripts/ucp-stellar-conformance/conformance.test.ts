/**
 * The conformance kit (T137) with no network: a real Vitrinee store in process passes every check, charge and
 * receipt included; the broken store fails exactly the check each break is about, with its reason.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { UcpStellarPayer } from "../../packages/ucp-stellar/src/index.js";
import { MOCK_CATALOG, MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { verifyReceipt } from "../../packages/vitrinee-anchor/src/index.js";
import { USDC_TESTNET } from "../../packages/vitrinee-core/src/index.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { FAKE_PAYER, fakeFacilitator, type FakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MERCHANT, fakePlatformProfiles, fakeRegistry, testConfig } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../packages/vitrinee-gateway/src/test/listen.js";
import { BREAKS, startBrokenStore, type Break } from "./broken-store.js";
import { DEFAULT_PLATFORM_PROFILE, formatReport, runConformance, type CheckResult, type KitDeps, type KitOptions } from "./checks.js";

type PaymentRequirements = Parameters<UcpStellarPayer["createPaymentPayload"]>[1];

const HANDLER_DIR = new URL("../../apps/web/public/ucp/handlers/stellar-x402/", import.meta.url);
const DESTINATION = { first_name: "Ana", last_name: "Pérez", street_address: "Av. Irarrázaval 1234", address_locality: "Ñuñoa", address_region: "Metropolitana", address_country: "CL" };

/** agentpey.com's handler spec and schema, served from the repo's copy; everything else goes to the real `fetch`. */
function withAgentpey(requests: Array<{ method: string; url: string }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
    if (url === "https://agentpey.com/ucp/handlers/stellar-x402/spec") return new Response(readFileSync(new URL("spec.md", HANDLER_DIR), "utf8"), { status: 200 });
    if (url === "https://agentpey.com/ucp/handlers/stellar-x402/schema.json") return new Response(readFileSync(new URL("schema.json", HANDLER_DIR), "utf8"), { status: 200 });
    return fetch(input, init);
  }) as typeof fetch;
}

/** A payer that records what it signed. */
function fakePayer(): UcpStellarPayer & { calls: PaymentRequirements[] } {
  const calls: PaymentRequirements[] = [];
  return {
    scheme: "exact",
    calls,
    async createPaymentPayload(_version: number, requirements: PaymentRequirements) {
      calls.push(requirements);
      return { x402Version: 2, payload: { transaction: Buffer.from(`kit-tx-${calls.length}-${Math.random()}`).toString("base64") } };
    },
  };
}

const byId = (results: readonly CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r]));

// ---------------------------------------------------------------- a Vitrinee store

let store: VitrineeApp;
let server: { url: string; close: () => Promise<void> };
let facilitator: FakeFacilitator;
const anchors = fakeRegistry();

/** One transaction hash per settlement, as on the network. */
function uniqueFacilitator(): FakeFacilitator {
  const base = fakeFacilitator();
  let n = 0;
  return {
    ...base,
    async settle(payload, requirements) {
      const result = await base.settle(payload, requirements);
      n += 1;
      return { ...result, transaction: n.toString(16).padStart(64, "0") };
    },
  };
}

/** A Horizon where every transaction moved `amount` USDC from the facilitator's payer to the merchant. */
function horizonFor(amount: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/transactions\/[0-9a-f]{64}$/.test(url)) return Response.json({ successful: true, ledger: 4_899_999, created_at: "2026-10-06T12:00:00Z" });
    if (/\/transactions\/[0-9a-f]{64}\/effects/.test(url)) {
      return Response.json({
        _embedded: {
          records: [
            { type: "account_debited", account: FAKE_PAYER, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
            { type: "account_credited", account: MERCHANT, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
          ],
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  facilitator = uniqueFacilitator();
  const catalog = MOCK_CATALOG.map((product) => (product.id === "gorro-andes" ? { ...product, stock: 1000 } : product));
  store = createApp({ platformProfiles: fakePlatformProfiles(), config: testConfig(), adapter: new MockStoreAdapter({ catalog }), facilitator, anchorer: anchors.anchorer, registry: anchors.registry });
  server = await listen(store);
});
afterAll(async () => {
  store.anchors.stop();
  await server.close();
});

function deps(overrides: Partial<KitDeps> = {}, requests?: Array<{ method: string; url: string }>): KitDeps {
  return {
    fetch: withAgentpey(requests),
    readBalance: async () => 10_000_000n,
    registry: () => anchors.registry,
    verifyReceipt: (jws, registry) => verifyReceipt(jws, { registry, horizonUrl: "https://horizon.test", fetchImpl: horizonFor("13.6736842"), settlementAttempts: 1 }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    ...overrides,
  };
}

const options = (overrides: Partial<KitOptions> = {}): KitOptions => ({
  storeUrl: server.url,
  productId: "gorro-andes",
  destination: DESTINATION,
  email: "ana@example.com",
  platformProfile: DEFAULT_PLATFORM_PROFILE,
  registry: anchors.registry.contractId,
  anchorWaitMs: 5_000,
  ...overrides,
});

describe("the kit against a Vitrinee store (T137)", () => {
  it("passes every check, charge and receipt included", async () => {
    const payer = fakePayer();
    const settled = facilitator.settleCalls.length;
    const results = await runConformance(options({ charge: { payer, maxAmount: "20.00" } }), deps());
    expect(results.filter((r) => r.outcome !== "pass")).toEqual([]);
    expect(results.map((r) => r.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "R1", "R2", "R3", "R4", "R5", "R6", "C1", "C2", "C3", "E1", "E2", "E3", "E4"]);
    // C1's signed probe and C2's payment: two signatures, one settlement, and the replay settles nothing.
    expect(payer.calls).toHaveLength(2);
    expect(facilitator.settleCalls).toHaveLength(settled + 1);
  });

  it("without --pay, signs nothing and settles nothing, and says why the charge did not run", async () => {
    const settled = facilitator.settleCalls.length;
    const results = byId(await runConformance(options(), deps()));
    expect(results["R6"]?.outcome).toBe("pass");
    expect(results["C2"]).toMatchObject({ outcome: "skip", detail: "runs only with --pay and a testnet key" });
    expect(facilitator.settleCalls).toHaveLength(settled);
  });

  it("with --profile-only, only reads: every request is a GET", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const results = await runConformance(options({ profileOnly: true }), deps({}, requests));
    expect(results.map((r) => r.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("finds a product in the catalog when none is given", async () => {
    const results = byId(await runConformance(options({ productId: undefined }), deps()));
    expect(results["R1"]?.outcome).toBe("pass");
  });

  it("signs nothing above --max-amount", async () => {
    const payer = fakePayer();
    const results = byId(await runConformance(options({ charge: { payer, maxAmount: "1.00" } }), deps()));
    expect(results["C1"]).toMatchObject({ outcome: "skip", detail: expect.stringContaining("above --max-amount 1.00") });
    expect(payer.calls).toEqual([]);
  });

  it("fails a receipt anchored in a registry it does not trust", async () => {
    const results = byId(await runConformance(options({ registry: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", charge: { payer: fakePayer(), maxAmount: "20.00" } }), deps()));
    expect(results["E3"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("pass --registry to trust another") });
  });

  it("names a pay_to without a trustline", async () => {
    const results = byId(await runConformance(options({ profileOnly: true }), deps({ readBalance: () => Promise.reject(new Error('Transaction simulation failed: "HostError: Error(Contract, #13)\n data:["trustline entry is missing for account"]')) })));
    expect(results["P6"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("has no trustline to USDC") });
  });

  it("fails, not throws, on a store that does not answer", async () => {
    const results = await runConformance(options({ storeUrl: "http://localhost:9" }), deps());
    expect(results).toEqual([expect.objectContaining({ id: "P1", outcome: "fail" })]);
  });
});

// ---------------------------------------------------------------- the broken store

describe("the kit against a store broken on purpose (T137)", () => {
  // The checks each break must fail, with the reason a person reads: a missing binding is both a schema error and
  // an unbound credential.
  const expected: Record<Break, Array<{ id: string; detail: string }>> = {
    "spec-off-domain": [{ id: "P3", detail: "UCP binds com.agentpey.* to https://agentpey.com" }],
    decimals: [{ id: "P5", detail: "the asset declares 6 decimals; Stellar assets have 7" }],
    "pay-to-mismatch": [{ id: "R4", detail: "a platform must refuse to sign" }],
    "no-binding": [
      { id: "R2", detail: "must have required property 'binding'" },
      { id: "R3", detail: "the handler's config has no binding.checkout_id" },
    ],
    "accepts-tampered": [{ id: "R6", detail: "the spec says it MUST reject it" }],
  };

  it("with no break, it is a store that follows the spec, and passes (it has no receipt extension)", async () => {
    const broken = await startBrokenStore({ breaks: new Set() });
    try {
      const results = await runConformance(options({ storeUrl: broken.url, productId: undefined, charge: { payer: fakePayer(), maxAmount: "2.00" } }), deps());
      expect(results.filter((r) => r.outcome === "fail")).toEqual([]);
      expect(byId(results)["E1"]).toMatchObject({ outcome: "skip", detail: "the store does not declare com.agentpey.shopping.receipt (optional)" });
    } finally {
      await broken.close();
    }
  });

  for (const which of BREAKS) {
    it(`fails ${expected[which].map((e) => e.id).join(" and ")} when the store breaks ${which}, and only what that break touches`, async () => {
      const broken = await startBrokenStore({ breaks: new Set([which]) });
      try {
        const results = await runConformance(options({ storeUrl: broken.url, productId: undefined }), deps());
        const failed = results.filter((r) => r.outcome === "fail");
        expect(failed).toEqual(expected[which].map((e) => expect.objectContaining({ id: e.id, detail: expect.stringContaining(e.detail) })));
      } finally {
        await broken.close();
      }
    });
  }

  it("catches, with --pay, a store that completes on a really signed but altered credential, and pays nothing more", async () => {
    const broken = await startBrokenStore({ breaks: new Set(["accepts-tampered"]) });
    try {
      const payer = fakePayer();
      const results = byId(await runConformance(options({ storeUrl: broken.url, productId: undefined, charge: { payer, maxAmount: "2.00" } }), deps()));
      expect(results["C1"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("with a really signed transaction") });
      expect(results["C2"]?.outcome).toBe("skip");
      expect(payer.calls).toHaveLength(1);
    } finally {
      await broken.close();
    }
  });

  it("does not sign for a profile a platform may not pay against", async () => {
    const broken = await startBrokenStore({ breaks: new Set(["decimals"]) });
    try {
      const payer = fakePayer();
      const results = byId(await runConformance(options({ storeUrl: broken.url, productId: undefined, charge: { payer, maxAmount: "2.00" } }), deps()));
      expect(results["C1"]).toMatchObject({ outcome: "skip", detail: expect.stringContaining("nothing is signed") });
      expect(payer.calls).toEqual([]);
    } finally {
      await broken.close();
    }
  });
});

describe("formatReport", () => {
  it("writes one line per check and the counts", () => {
    const text = formatReport([
      { id: "P1", group: "profile", title: "business profile", outcome: "pass", detail: "ok" },
      { id: "R6", group: "requirements", title: "refuses", outcome: "fail", detail: "completed" },
    ]);
    expect(text.split("\n")).toEqual(["✔ P1  business profile: ok", "✘ R6  refuses: completed", "", "1 pass · 1 fail · 0 warn · 0 skipped"]);
  });
});
