/**
 * The conformance kit (T137) with no network: a real Vitrinee store in process passes every check, charge and
 * receipt included; the broken store fails exactly the check each break is about, with its reason; and the charge
 * signs one authorization at most, which settles once at most.
 */
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { USDC_TESTNET as SAC_USDC, type UcpStellarPayer } from "../../packages/ucp-stellar/src/index.js";
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
const PAYER = "GBQS3GKS2JS6JAVJOC2ZZ3MTTC7LYDHLRQAMQYMZM34TUJGO6CXNXJVP";
const HAT_ATOMIC = 136_736_842n;
const MAGNET_ATOMIC = 15_684_211n;
const START = 1_000_000_000n;

type Rewrite = (url: string, init: RequestInit | undefined, res: Response) => Promise<Response>;

/**
 * agentpey.com's handler spec and schema from the repo's copy; the stores on this machine through the real `fetch`,
 * optionally rewritten; anything else is refused, so a test never reaches the network by mistake.
 */
function localFetch(options: { requests?: Array<{ method: string; url: string; body?: string }>; rewrite?: Rewrite; fail?: (url: string, body: string | undefined) => boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    options.requests?.push({ method: init?.method ?? "GET", url, ...(body === undefined ? {} : { body }) });
    if (url === "https://agentpey.com/ucp/handlers/stellar-x402/spec") return new Response(readFileSync(new URL("spec.md", HANDLER_DIR), "utf8"), { status: 200 });
    if (url === "https://agentpey.com/ucp/handlers/stellar-x402/schema.json") return new Response(readFileSync(new URL("schema.json", HANDLER_DIR), "utf8"), { status: 200 });
    const host = new URL(url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") throw new TypeError(`a test asked for ${url}`);
    if (options.fail?.(url, body) === true) throw new TypeError("socket hang up");
    const res = await fetch(input, init);
    return options.rewrite === undefined ? res : options.rewrite(url, init, res);
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

const chargeWith = (payer: UcpStellarPayer, overrides: Partial<NonNullable<KitOptions["charge"]>> = {}): NonNullable<KitOptions["charge"]> => ({ payer, payerAddress: PAYER, maxAmount: "20.00", asset: SAC_USDC, ...overrides });
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

/** The payer's balance falls by one hat per settlement the store's facilitator made. */
function deps(overrides: Partial<KitDeps> = {}, fetchOptions: Parameters<typeof localFetch>[0] = {}): KitDeps {
  return {
    fetch: localFetch(fetchOptions),
    readBalance: async () => START - BigInt(facilitator.settleCalls.length) * HAT_ATOMIC,
    registry: () => anchors.registry,
    verifyReceipt: (jws, registry) => verifyReceipt(jws, { registry, horizonUrl: "https://horizon.test", fetchImpl: horizonFor("13.6736842"), settlementAttempts: 1 }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
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

/** Rewrites one JSON answer of the store. */
const rewriteJson =
  (match: (url: string, init: RequestInit | undefined) => boolean, change: (body: Record<string, unknown>) => void): Rewrite =>
  async (url, init, res) => {
    if (!match(url, init)) return res;
    const body = (await res.json()) as Record<string, unknown>;
    change(body);
    return Response.json(body, { status: res.status });
  };

describe("the kit against a Vitrinee store (T137)", () => {
  it("passes every check, signing one authorization that settles once", async () => {
    const payer = fakePayer();
    const settled = facilitator.settleCalls.length;
    const results = await runConformance(options({ charge: chargeWith(payer) }), deps());
    expect(results.filter((r) => r.outcome !== "pass")).toEqual([]);
    expect(results.map((r) => r.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "R1", "R2", "R3", "R4", "R5", "R6", "C1", "C2", "C3", "E1", "E2", "E3", "E4"]);
    expect(payer.calls).toHaveLength(1);
    // Signed for a capped validity, not the store's 300 s.
    expect(payer.calls[0]!.maxTimeoutSeconds).toBeLessThanOrEqual(120);
    expect(facilitator.settleCalls).toHaveLength(settled + 1);
    expect(byId(results)["C3"]?.detail).toContain("one payment");
  });

  it("without --pay, signs nothing and settles nothing, and says why the charge did not run", async () => {
    const settled = facilitator.settleCalls.length;
    const results = byId(await runConformance(options(), deps()));
    expect(results["R6"]).toMatchObject({ outcome: "pass", detail: expect.stringContaining("C1 (--pay) shows it compares accepted") });
    expect(results["C2"]).toMatchObject({ outcome: "skip", detail: "runs only with --pay and a testnet key" });
    expect(facilitator.settleCalls).toHaveLength(settled);
  });

  it("with --profile-only, the store only sees GETs", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const results = await runConformance(options({ profileOnly: true }), deps({}, { requests }));
    expect(results.map((r) => r.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("finds a product in the catalog when none is given", async () => {
    expect(byId(await runConformance(options({ productId: undefined }), deps()))["R1"]?.outcome).toBe("pass");
  });

  it("signs nothing above --max-amount", async () => {
    const payer = fakePayer();
    const results = byId(await runConformance(options({ charge: chargeWith(payer, { maxAmount: "1.00" }) }), deps()));
    expect(results["C1"]).toMatchObject({ outcome: "skip", detail: expect.stringContaining("above --max-amount 1.00") });
    expect(payer.calls).toEqual([]);
  });

  it("signs nothing for a checkout in another asset than --asset", async () => {
    const payer = fakePayer();
    const results = byId(await runConformance(options({ charge: chargeWith(payer, { asset: "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5" }) }), deps()));
    expect(results["C1"]).toMatchObject({ outcome: "skip", detail: expect.stringContaining("the kit pays only in CADILO6Q") });
    expect(payer.calls).toEqual([]);
  });

  it("stops after a signed probe that did not reach the store: nothing more is signed or sent", async () => {
    const payer = fakePayer();
    const settled = facilitator.settleCalls.length;
    const signedComplete = (url: string, body: string | undefined) => url.endsWith("/complete") && body !== undefined && !body.includes(Buffer.from("ucp-stellar-conformance").toString("base64").slice(0, 16));
    const results = byId(await runConformance(options({ charge: chargeWith(payer) }), deps({}, { fail: signedComplete })));
    expect(results["C1"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("nothing more is sent") });
    expect(results["C2"]?.outcome).toBe("skip");
    expect(payer.calls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(settled);
  });

  it("refuses an R4 with another scheme than exact", async () => {
    const rewrite = rewriteJson(
      (url, init) => url.endsWith("/checkout-sessions") && init?.method === "POST",
      (body) => {
        const config = ((body["ucp"] as Record<string, unknown>)["payment_handlers"] as Record<string, Array<{ config: { payment_requirements: Record<string, unknown> } }>>)["com.agentpey.stellar_x402"]![0]!.config;
        config.payment_requirements["scheme"] = "upto";
      },
    );
    const results = byId(await runConformance(options(), deps({}, { rewrite })));
    expect(results["R4"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("scheme upto") });
  });

  it("signs nothing for a checkout that does not say its line_items", async () => {
    const payer = fakePayer();
    const rewrite = rewriteJson((url, init) => url.endsWith("/checkout-sessions") && init?.method === "POST", (body) => delete body["line_items"]);
    const results = byId(await runConformance(options({ charge: chargeWith(payer) }), deps({}, { rewrite })));
    expect(results["C1"]).toMatchObject({ outcome: "skip", detail: expect.stringContaining("line_items") });
    expect(payer.calls).toEqual([]);
  });

  it("fails E2 when the profile publishes the receipt's kid with another key", async () => {
    const rewrite = rewriteJson(
      (url) => url.endsWith("/.well-known/ucp"),
      (body) => {
        for (const key of (body["keys"] as Array<Record<string, unknown>> | undefined) ?? []) if (key["kty"] === "OKP") key["x"] = Buffer.alloc(32, 7).toString("base64url");
      },
    );
    const results = byId(await runConformance(options({ charge: chargeWith(fakePayer()) }), deps({}, { rewrite })));
    expect(results["E2"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("with another key") });
  });

  it("warns, not fails, on an anchor still pending when the signature and settlement are good", async () => {
    const rewrite = rewriteJson(
      (url) => /\/orders\/[^/]+$/.test(url),
      (body) => ((body["receipt"] as { anchor: { status: string } }).anchor.status = "pending"),
    );
    const results = byId(
      await runConformance(
        options({ anchorWaitMs: 50, charge: chargeWith(fakePayer()) }),
        deps(
          {
            verifyReceipt: async (jws, registry) => {
              const real = await verifyReceipt(jws, { registry, horizonUrl: "https://horizon.test", fetchImpl: horizonFor("13.6736842"), settlementAttempts: 1 });
              return { ...real, valid: false, checks: { ...real.checks, anchored: { ok: false, reason: "not yet", registry: null } } };
            },
          },
          { rewrite },
        ),
      ),
    );
    expect(results["E4"]).toMatchObject({ outcome: "warn", detail: expect.stringContaining("still pending") });
  });

  it("fails a receipt anchored in a registry it does not trust", async () => {
    const results = byId(await runConformance(options({ registry: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", charge: chargeWith(fakePayer()) }), deps()));
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
  // The checks each break fails, read-only, with the reason a person reads. `settles-signed` refuses the junk
  // transaction, so only the charge (below) catches it.
  const expected: Record<Break, Array<{ id: string; detail: string }>> = {
    "spec-off-domain": [{ id: "P3", detail: "UCP binds com.agentpey.* to https://agentpey.com" }],
    decimals: [{ id: "P5", detail: "the asset declares 6 decimals; Stellar assets have 7" }],
    "pay-to-mismatch": [{ id: "R4", detail: "a platform must refuse to sign" }],
    "no-binding": [
      { id: "R2", detail: "must have required property 'binding'" },
      { id: "R3", detail: "the handler's config has no binding.checkout_id" },
    ],
    "accepts-tampered": [{ id: "R6", detail: "the spec says it MUST reject it" }],
    "settles-signed": [],
  };

  /** The payer's balance falls by one magnet per transaction the broken store "settled". */
  const brokenDeps = (broken: { settled: () => number }, fetchOptions: Parameters<typeof localFetch>[0] = {}) =>
    deps({ readBalance: async () => START - BigInt(broken.settled()) * MAGNET_ATOMIC }, fetchOptions);

  it("with no break, it is a store that follows the spec, and passes (it has no receipt extension)", async () => {
    const broken = await startBrokenStore({ breaks: new Set() });
    try {
      const results = await runConformance(options({ storeUrl: broken.url, productId: undefined, charge: chargeWith(fakePayer(), { maxAmount: "2.00" }) }), brokenDeps(broken));
      expect(results.filter((r) => r.outcome === "fail")).toEqual([]);
      expect(byId(results)["E1"]).toMatchObject({ outcome: "skip", detail: "the store does not declare com.agentpey.shopping.receipt (optional)" });
      expect(broken.settled()).toBe(1);
    } finally {
      await broken.close();
    }
  });

  for (const which of BREAKS) {
    const ids = expected[which].map((e) => e.id).join(" and ") || "nothing";
    it(`fails ${ids}, read-only, when the store breaks ${which}`, async () => {
      const broken = await startBrokenStore({ breaks: new Set([which]) });
      try {
        const results = await runConformance(options({ storeUrl: broken.url, productId: undefined }), brokenDeps(broken));
        expect(results.filter((r) => r.outcome === "fail")).toEqual(expected[which].map((e) => expect.objectContaining({ id: e.id, detail: expect.stringContaining(e.detail) })));
      } finally {
        await broken.close();
      }
    });
  }

  it("catches, with --pay, a store that settles the signed probe and answers a refusal, and pays nothing more", async () => {
    const broken = await startBrokenStore({ breaks: new Set(["settles-signed"]) });
    try {
      const payer = fakePayer();
      const results = byId(await runConformance(options({ storeUrl: broken.url, productId: undefined, charge: chargeWith(payer, { maxAmount: "2.00" }) }), brokenDeps(broken)));
      expect(results["C1"]).toMatchObject({ outcome: "fail", detail: expect.stringContaining("it settled the altered credential") });
      expect(results["C2"]?.outcome).toBe("skip");
      expect(payer.calls).toHaveLength(1);
      expect(broken.settled()).toBe(1);
    } finally {
      await broken.close();
    }
  });

  for (const which of ["accepts-tampered", "no-binding", "decimals", "pay-to-mismatch"] as const) {
    it(`signs nothing, with --pay, for a store that failed a check before (${which})`, async () => {
      const broken = await startBrokenStore({ breaks: new Set([which]) });
      try {
        const payer = fakePayer();
        const results = byId(await runConformance(options({ storeUrl: broken.url, productId: undefined, charge: chargeWith(payer, { maxAmount: "2.00" }) }), brokenDeps(broken)));
        expect(results["C1"]).toMatchObject({ outcome: "skip", detail: expect.stringContaining("nothing is signed") });
        expect(payer.calls).toEqual([]);
      } finally {
        await broken.close();
      }
    });
  }
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
