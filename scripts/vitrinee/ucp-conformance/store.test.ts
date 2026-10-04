/**
 * The UCP conformance store (T131, R-3): its test payment works there and
 * nowhere else.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MockStoreAdapter } from "../../../packages/vitrinee-adapters/src/index.js";
import { UCP_REST_PREFIX } from "../../../packages/vitrinee-core/src/index.js";
import { createApp } from "../../../packages/vitrinee-gateway/src/app.js";
import { loadConfig } from "../../../packages/vitrinee-gateway/src/config.js";
import { fakeFacilitator } from "../../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { fakeRegistry, testConfig, fakePlatformProfiles } from "../../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../../packages/vitrinee-gateway/src/test/listen.js";
import { MemoryCheckoutSessions } from "../../../packages/vitrinee-gateway/src/ucp/sessions.js";
import { MOCK_HANDLER_ID, OUT_OF_STOCK_ID, SUCCESS_TOKEN, assertLocalOnly, startConformanceStore, type ConformanceStore } from "./store.js";

const SECRET = "a-simulation-secret-for-tests";
const AGENT = { "content-type": "application/json", "UCP-Agent": 'profile="http://localhost:8285/profiles/shopping-agent.json"' };

const readySession = (productId = "stickers-cordillera") => ({
  line_items: [{ item: { id: productId }, quantity: 1 }],
  buyer: { email: "ana@example.com" },
  fulfillment: {
    methods: [{ type: "shipping", destinations: [{ street_address: "123 Market St", address_locality: "San Francisco", address_region: "CA", address_country: "US", postal_code: "94105" }] }],
  },
});

const mockPayment = (token: string) => ({
  payment: {
    instruments: [
      { id: "instr_1", handler_id: MOCK_HANDLER_ID, type: "card", display: { brand: "Visa", last_digits: "1234" }, credential: { type: "token", token } },
    ],
  },
});

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...AGENT, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { id?: string; status?: string; messages?: Array<{ code: string }>; order?: { id: string } } };
}

describe("the UCP conformance store (T131)", () => {
  let store: ConformanceStore;
  beforeAll(async () => {
    store = await startConformanceStore({ simulationSecret: SECRET, env: {} });
  });
  afterAll(() => store.close());

  it("listens on loopback only", () => {
    expect(new URL(store.url).hostname).toBe("127.0.0.1");
  });

  it("completes a checkout paid with the suite's success token, with an order and a receipt", async () => {
    const created = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions`, readySession());
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("ready_for_complete");
    const done = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions/${created.body.id}/complete`, mockPayment(SUCCESS_TOKEN));
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
    expect(done.body.order?.id).toMatch(/^ord_/);
    // The receipt is signed by this run's throwaway key, for this run's throwaway merchant.
    expect(done.body["receipt"]).toMatchObject({ format: "jws" });
  });

  it("reads the suite's agent profile on localhost, and answers in the version it declares (2026-04-08); the well-known profile is the 2026-04-08 leaf", async () => {
    const profileServer = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ucp: { version: "2026-04-08", capabilities: {} } }));
    });
    await new Promise<void>((done) => profileServer.listen(0, "127.0.0.1", () => done()));
    const { port } = profileServer.address() as AddressInfo;
    try {
      const created = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions`, readySession(), { "UCP-Agent": `profile="http://127.0.0.1:${port}/profiles/shopping-agent.json"` });
      expect((created.body["ucp"] as { version: string }).version).toBe("2026-04-08");
      const wellKnown = (await (await fetch(`${store.url}/.well-known/ucp`)).json()) as { ucp: { version: string } };
      expect(wellKnown.ucp.version).toBe("2026-04-08");
    } finally {
      await new Promise<void>((done) => profileServer.close(() => done()));
    }
  });

  it("refuses any other token, as the suite's fail_token must be", async () => {
    const created = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions`, readySession());
    const done = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions/${created.body.id}/complete`, mockPayment("fail_token"));
    expect(done.body.status).not.toBe("completed");
    expect(done.body.messages?.map((m) => m.code)).toContain("payment_failed");
  });

  it("serves the out-of-stock product the conformance data names", async () => {
    const created = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions`, readySession(OUT_OF_STOCK_ID));
    expect(JSON.stringify(created.body)).toMatch(/out_of_stock|item_unavailable/);
  });

  it("guards the shipping simulation with the shared secret", async () => {
    const created = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions`, readySession());
    const done = await call(store.url, "POST", `${UCP_REST_PREFIX}/checkout-sessions/${created.body.id}/complete`, mockPayment(SUCCESS_TOKEN));
    const path = `/testing/simulate-shipping/${done.body.order?.id}`;
    expect((await call(store.url, "POST", path)).status).toBe(403);
    expect((await call(store.url, "POST", path, undefined, { "Simulation-Secret": "wrong-secret-wrong-secret" })).status).toBe(403);
    expect((await call(store.url, "POST", path, undefined, { "Simulation-Secret": SECRET })).status).toBe(200);
    expect((await call(store.url, "POST", "/testing/simulate-shipping/ord_nope", undefined, { "Simulation-Secret": SECRET })).status).toBe(404);
  });
});

describe("the conformance test payment never reaches a real store", () => {
  it("a store started the production way refuses mock_payment_handler, even with a facilitator that says yes to everything", async () => {
    const registry = fakeRegistry();
    const app = createApp({
    platformProfiles: fakePlatformProfiles(),
      config: testConfig({ SHIPPING_COUNTRIES: "US" }),
      adapter: new MockStoreAdapter(),
      facilitator: fakeFacilitator(),
      anchorer: registry.anchorer,
      registry: registry.registry,
      sessions: new MemoryCheckoutSessions(),
      disputes: null,
      syncFacilitatorOnStart: false,
    });
    const { url, close } = await listen(app);
    try {
      const created = await call(url, "POST", `${UCP_REST_PREFIX}/checkout-sessions`, readySession());
      expect(created.body.status).toBe("ready_for_complete");
      const done = await call(url, "POST", `${UCP_REST_PREFIX}/checkout-sessions/${created.body.id}/complete`, mockPayment(SUCCESS_TOKEN));
      expect(done.body.status).not.toBe("completed");
      expect(done.body.messages?.map((m) => m.code)).toContain("payment_failed");
    } finally {
      await close();
    }
  });

  it("the gateway's config refuses UCP_CONFORMANCE", () => {
    expect(() => loadConfig({ ...process.env, UCP_CONFORMANCE: "1" })).toThrow(/UCP_CONFORMANCE/);
  });

  it.each([
    [{ RENDER: "true" }, /RENDER/],
    [{ DATABASE_URL: "postgres://x" }, /DATABASE_URL/],
    [{ MASTER_KEY: "k" }, /MASTER_KEY/],
    [{ VITRINEE_DATABASE_URL: "postgres://x" }, /VITRINEE_DATABASE_URL/],
    [{ PUBLIC_BASE_URL: "https://vitrinee.agentpey.com" }, /not loopback/],
  ] as const)("the conformance store refuses to start with %o", (env, message) => {
    expect(() => assertLocalOnly(env)).toThrow(message);
  });

  it("refuses a PUBLIC_BASE_URL that is not a URL, with a typed error", () => {
    expect(() => assertLocalOnly({ PUBLIC_BASE_URL: "not a url" })).toThrow(/not a URL/);
  });

  it("starts on loopback with nothing set", () => {
    expect(() => assertLocalOnly({ PUBLIC_BASE_URL: "http://127.0.0.1:4999" })).not.toThrow();
  });

  it("no deployed code imports the conformance store", () => {
    const repo = join(import.meta.dirname, "../../..");
    const roots = ["apps", "packages"].flatMap((group) =>
      readdirSync(join(repo, group))
        .map((name) => join(group, name, "src"))
        .filter((src) => existsSync(join(repo, src))),
    );
    expect(roots).toEqual(expect.arrayContaining(["apps/gateway/src", "apps/mcp/src", "packages/vitrinee-gateway/src", "packages/vitrinee-anchor/src"]));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && readFileSync(path, "utf8").includes("ucp-conformance")) offenders.push(path);
      }
    };
    for (const root of roots) walk(join(repo, root));
    expect(offenders).toEqual([]);
  });
});
