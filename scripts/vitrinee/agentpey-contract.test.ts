/**
 * The contract between AgentPey's buyer and a Vitrinee store (C-130, T99),
 * checked with each side's real code and no network: AgentPey's catalogue
 * adapter, route filling and 402 request against Vitrinee's own app.
 *
 * It lives here, outside both packages, so neither has to depend on the
 * other: `apps/agent` knows nothing about Vitrinee, and Vitrinee knows
 * nothing about AgentPey. What would break this test is exactly what would
 * break the promise of `F7` for this store: that adding it is a row in
 * `venues.json` and no code.
 */
import { request as httpRequest } from "node:http";

import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeVenueId } from "../../apps/agent/src/catalog/ids.js";
import { DEFAULT_VENUE_REGISTRY } from "../../apps/agent/src/catalog/default-registry.js";
import { expandPlatformVenues } from "../../apps/agent/src/catalog/platforms.js";
import { loadVenueRegistry } from "../../apps/agent/src/catalog/registry.js";
import { createX402Catalog, getX402ServiceRoute } from "../../apps/agent/src/catalog/x402-catalog.js";
import { fillRouteTemplate, requestPaymentChallenge, toPaymentTerms } from "../../apps/agent/src/payment/x402.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { OrderStore } from "../../packages/vitrinee-gateway/src/orders.js";
import { FAKE_TX_HASH, fakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { MemoryComercioStore, sealComercio } from "../../packages/vitrinee-gateway/src/platform/comercios.js";
import { createPlatformApp } from "../../packages/vitrinee-gateway/src/platform/platform-app.js";
import { createSecretBox, generateMasterKey } from "../../packages/vitrinee-gateway/src/platform/secret-box.js";
import { StorefrontPool } from "../../packages/vitrinee-gateway/src/platform/storefronts.js";
import { MERCHANT, REGISTRY_ID, fakeRegistry, testConfig } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../packages/vitrinee-gateway/src/test/listen.js";
import { MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { USDC_TESTNET, checkReceiptSignature } from "../../packages/vitrinee-core/src/index.js";

interface PaymentRequired {
  x402Version: number;
  resource: unknown;
  accepts: Record<string, unknown>[];
}

/** x402 v2 headers are base64 JSON; read and written by hand so this file needs no x402 package of its own. */
function readChallenge(challenge: Response): PaymentRequired {
  const header = challenge.headers.get("payment-required");
  if (header === null) throw new Error(`no PAYMENT-REQUIRED header (status ${challenge.status})`);
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentRequired;
}

const RAIL = "CANSQJH7KPQTBUXPA42BBWZGZRKLWQZUFVF3SLQOUWKHEX4L3JP7YEDA";
const SHIPPING = { name: "Ana Pérez", address: "Av. Irarrázaval 1234", city: "Ñuñoa", region: "Metropolitana" };

let server: { url: string; close: () => Promise<void> };
let app: VitrineeApp;
const adapter = new MockStoreAdapter();

beforeAll(async () => {
  const registry = fakeRegistry();
  app = createApp({
    config: testConfig(),
    adapter,
    facilitator: fakeFacilitator({ verify: { payer: RAIL }, settle: { payer: RAIL } }),
    orders: new OrderStore(),
    anchorer: registry.anchorer,
    registry: registry.registry,
  });
  server = await listen(app);
});
afterAll(async () => {
  app.anchors.stop();
  await server.close();
});

/** The row T100 adds to `venues.json`, pointed at this in-process store. */
function vitrineeVenue() {
  const registry = loadVenueRegistry([
    { slug: "vitrinee", address: MERCHANT, baseUrl: server.url, assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] },
  ]);
  return { venueId: makeVenueId("vitrinee", MERCHANT), registry };
}

describe("the vitrinee platform row of venues.json (T104, C-141)", () => {
  /**
   * Since T104 AgentPey trusts the Vitrinee platform, not each store: one
   * platform row, pinned here. Its host is where every store's subdomain
   * lives, its directory is the portal's public list, and its only asset is
   * the USDC every Vitrinee 402 quotes. A merchant's venue exists only once
   * the directory names it (`platforms.ts`).
   */
  it("names the platform's host, its directory and the USDC every Vitrinee checkout quotes", () => {
    const platform = DEFAULT_VENUE_REGISTRY.platforms?.get("vitrinee");
    expect(platform).toBeDefined();
    expect(platform!.host).toBe("vitrinee.agentpey.com");
    expect(platform!.directoryUrl).toBe("https://vitrinee.agentpey.com/api/comercios");
    expect([...platform!.byCode.entries()]).toEqual([["USDC", `USDC:${USDC_TESTNET.contractId}`]]);
    // No fixed row left for the old single store: its id would collide with the platform's merchants.
    expect([...DEFAULT_VENUE_REGISTRY.venues.keys()].some((id) => id.startsWith("vitrinee"))).toBe(false);
  });
});

describe("AgentPey reads the Vitrinee platform's directory (T104)", () => {
  /** `fetch` cannot set `Host`; this sends every `*.localhost` URL to the in-process platform, with its host. */
  function hostRoutedFetch(serverUrl: string): typeof fetch {
    const target = new URL(serverUrl);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const headers: Record<string, string> = { host: url.host };
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          { hostname: target.hostname, port: target.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const out = new Headers();
              for (const [key, value] of Object.entries(res.headers)) if (typeof value === "string") out.set(key, value);
              resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: out }));
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
    }) as typeof fetch;
  }

  it("turns a directory entry into a venue, catalogues its store, and pins the 402's payee to the merchant", async () => {
    const box = createSecretBox(generateMasterKey());
    const comercios = new MemoryComercioStore();
    const now = new Date("2026-09-24T12:00:00.000Z");
    await comercios.create(
      sealComercio({ slug: "bazar", name: "Bazar", payTo: MERCHANT, signingSecret: Keypair.random().secret(), credentials: { kind: "mock" } }, box, now),
    );
    const pool = new StorefrontPool({
      comercios,
      box,
      env: { RECEIPT_REGISTRY_ID: REGISTRY_ID, FX_RATE_CLP_USD: "950" },
      ordersFor: () => ({ load: async () => [], save: async () => {} }),
      appDeps: () => {
        const fake = fakeRegistry();
        return { facilitator: fakeFacilitator(), anchorer: fake.anchorer, registry: fake.registry };
      },
    });
    const platform = await listen(createPlatformApp({ platformHost: "localhost", pool, comercios, rootComercio: undefined }));
    try {
      const fetchImpl = hostRoutedFetch(platform.url);
      const registry = loadVenueRegistry([
        { kind: "platform", slug: "vitrinee", host: "localhost", directoryUrl: "http://localhost/api/comercios", assets: [{ code: "USDC", issuer: USDC_TESTNET.contractId }] },
      ]);
      const expanded = await expandPlatformVenues(registry, { fetchImpl });
      const venueId = makeVenueId("vitrinee-bazar", MERCHANT);
      expect(expanded.venues.get(venueId)?.baseUrl).toBe("http://bazar.localhost");

      const products = await createX402Catalog({ venueId, registry: expanded, fetchImpl }).listProducts();
      expect(products.map((p) => p.id)).toContain("stickers-cordillera");

      const route = await getX402ServiceRoute({ venueId, registry: expanded, fetchImpl }, "stickers-cordillera");
      const url = fillRouteTemplate("http://bazar.localhost", route, { quantity: 1, name: "Test", address: "Calle 1", city: "Santiago", region: "RM" });
      const challenge = await requestPaymentChallenge(url, fetchImpl);
      expect(challenge.status).toBe(402);
      const offered = readChallenge(challenge).accepts[0] as unknown as Parameters<typeof toPaymentTerms>[0];
      expect(toPaymentTerms(offered, venueId, expanded).payTo).toBe(MERCHANT);
    } finally {
      await platform.close();
    }
  });
});

describe("AgentPey's buyer against a Vitrinee store", () => {
  it("reads the store's catalogue through the generic x402 adapter, with no Vitrinee-specific code", async () => {
    const products = await createX402Catalog(vitrineeVenue()).listProducts();
    expect(products.map((product) => product.id)).toContain("hoodie-cordillera-m");
    expect(products.find((product) => product.id === "hoodie-cordillera-m")).toMatchObject({
      name: "Hoodie Cordillera talla M",
      price: { amount: "36.8315789" },
      available: true,
    });
  });

  it("learns the paid route and the shipping inputs a physical order needs", async () => {
    const route = await getX402ServiceRoute(vitrineeVenue(), "hoodie-cordillera-m");
    expect(route.input.map((field) => field.name)).toEqual(["quantity", "name", "address", "city", "region"]);
    expect(route.input.every((field) => field.required)).toBe(true);
  });

  it("gets a 402 from a bodyless GET, priced as unit price × the quantity AgentPey signs for", async () => {
    const venue = vitrineeVenue();
    const route = await getX402ServiceRoute(venue, "hoodie-cordillera-m");
    const resourceUrl = fillRouteTemplate(server.url, route, { quantity: 2, ...SHIPPING });

    const challenge = await requestPaymentChallenge(resourceUrl);
    const required = readChallenge(challenge);
    const [accepted] = required.accepts;
    // The shipping details fill the route, but never the resource a client forwards to the facilitator (VT-25).
    expect(required.resource).toMatchObject({ url: `${server.url}/checkout/hoodie-cordillera-m` });
    // `toPaymentTerms` would see exactly this: the card's unit price × 2, to the card's destination.
    expect(accepted).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      asset: USDC_TESTNET.contractId,
      amount: "736631578",
      payTo: MERCHANT,
    });
  });

  it("completes a paid GET from a policy_rail and signs a receipt naming the rail as the payer", async () => {
    const venue = vitrineeVenue();
    const route = await getX402ServiceRoute(venue, "gorro-andes");
    const resourceUrl = fillRouteTemplate(server.url, route, { quantity: 1, ...SHIPPING });
    const required = readChallenge(await requestPaymentChallenge(resourceUrl));

    // What `executeBazaarPayment` sends on the retry: the same URL, the same method, one header.
    const paid = await fetch(resourceUrl, {
      headers: {
        "payment-signature": Buffer.from(
          JSON.stringify({
            x402Version: required.x402Version,
            resource: required.resource,
            accepted: required.accepts[0],
            payload: { transaction: Buffer.from("fake-rail-tx").toString("base64") },
          }),
        ).toString("base64"),
      },
    });
    expect(paid.status).toBe(200);
    const order = (await paid.json()) as { platformOrderId: string; settlement: { payer: string; txHash: string }; receipt: { jws: string } };
    expect(order.settlement).toMatchObject({ payer: RAIL, txHash: FAKE_TX_HASH });
    expect(checkReceiptSignature(order.receipt.jws).claims?.payerAccount).toBe(RAIL);
    expect((await adapter.getOrder(order.platformOrderId))?.buyer.shipping).toMatchObject({ ...SHIPPING, country: "CL" });
  });
});
