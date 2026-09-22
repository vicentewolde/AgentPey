import { MockStoreAdapter } from "@vitrinee/adapters";
import { MANIFEST_PATH, USDC_TESTNET, storefrontManifestSchema } from "@vitrinee/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fakeFacilitator } from "./test/fake-facilitator.js";
import { MERCHANT, REGISTRY_ID, SIGNER, fakeRegistry, testConfig } from "./test/fixtures.js";
import { listen } from "./test/listen.js";

const REQUIRED = { MERCHANT_STELLAR_ACCOUNT: MERCHANT, MERCHANT_SIGNING_SECRET: SIGNER.secret(), RECEIPT_REGISTRY_ID: REGISTRY_ID };

describe("gateway (free routes)", () => {
  const config = testConfig({ SHIPPING_COUNTRIES: "CL, AR" });
  const adapter = new MockStoreAdapter();
  const { anchorer, registry } = fakeRegistry();
  const app = createApp({ config, adapter, facilitator: fakeFacilitator(), anchorer, registry, now: () => new Date("2026-09-22T15:00:00.000Z") });
  let url = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    ({ url, close } = await listen(app));
  });
  afterAll(() => close());

  it("serves a manifest that validates against the core schema", async () => {
    const res = await fetch(`${url}${MANIFEST_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const manifest = storefrontManifestSchema.parse(await res.json());
    // did = the signing key (V-8); stellarAccount = payTo. They are different accounts.
    expect(manifest.merchant).toMatchObject({
      did: `did:stellar:testnet:${SIGNER.publicKey()}`,
      stellarAccount: MERCHANT,
      country: "CL",
      currency: "CLP",
    });
    expect(manifest.settlement.assetContract).toBe(USDC_TESTNET.contractId);
    expect(manifest.policies.shippingCountries).toEqual(["CL", "AR"]);
    expect(manifest.receipts).toEqual({ format: "jws", alg: "EdDSA", anchoredValue: "sha256(compact-jws)", registry: REGISTRY_ID });
    expect(manifest.products).toHaveLength(6);
    expect(manifest.endpoints.checkout).toBe(`${url}/checkout/{productId}`);
    expect(manifest.generatedAt).toBe("2026-09-22T15:00:00.000Z");
  });

  it("prices every product in USDC atomic units at the fixed rate", async () => {
    const res = await fetch(`${url}/catalog`);
    const body = (await res.json()) as { products: Array<Record<string, unknown>> };
    const hoodie = body.products.find((p) => p["id"] === "hoodie-cordillera-m");
    expect(hoodie).toMatchObject({
      priceLocal: "34990",
      priceUSDC: "36.8315789",
      priceUSDCAtomic: "368315789",
      checkoutRoute: "/checkout/hoodie-cordillera-m",
    });
  });

  it("returns one product, and a typed 404 for an unknown one", async () => {
    const ok = await fetch(`${url}/products/gorro-andes`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ product: { sku: "GOR-ANDES", priceUSDC: "13.6736842" } });

    const missing = await fetch(`${url}/products/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "ProductNotFound" });

    const noRoute = await fetch(`${url}/nothing`);
    expect(noRoute.status).toBe(404);
    expect(await noRoute.json()).toMatchObject({ error: "NotFound" });

    const noOrder = await fetch(`${url}/orders/ord_nope`);
    expect(noOrder.status).toBe(404);
    expect(await noOrder.json()).toMatchObject({ error: "OrderNotFound" });
  });

  it("honours PUBLIC_BASE_URL for absolute endpoints", async () => {
    const publicConfig = testConfig({ PUBLIC_BASE_URL: "https://vitrinee.example.com/" });
    const { url: localUrl, close: closeLocal } = await listen(
      createApp({ config: publicConfig, adapter, facilitator: fakeFacilitator(), anchorer, registry }),
    );
    try {
      const manifest = storefrontManifestSchema.parse(await (await fetch(`${localUrl}${MANIFEST_PATH}`)).json());
      expect(manifest.endpoints.catalog).toBe("https://vitrinee.example.com/catalog");
    } finally {
      await closeLocal();
    }
  });
});

describe("loadConfig", () => {
  it("names the variable that is wrong without echoing its value", () => {
    expect(() => loadConfig({ ...REQUIRED, MERCHANT_STELLAR_ACCOUNT: "SECRETLOOKINGVALUE" })).toThrow(
      /MERCHANT_STELLAR_ACCOUNT: not a Stellar account/,
    );
    expect(() => loadConfig({ ...REQUIRED, MERCHANT_STELLAR_ACCOUNT: "SECRETLOOKINGVALUE" })).not.toThrow(
      /SECRETLOOKINGVALUE/,
    );
    expect(() => loadConfig({ ...REQUIRED, MERCHANT_SIGNING_SECRET: "SBADBADBAD" })).toThrow(/MERCHANT_SIGNING_SECRET: not a Stellar secret/);
    expect(() => loadConfig({ ...REQUIRED, MERCHANT_SIGNING_SECRET: "SBADBADBAD" })).not.toThrow(/SBADBADBAD/);
    expect(() => loadConfig({})).toThrow(/MERCHANT_STELLAR_ACCOUNT/);
    expect(() => loadConfig({})).toThrow(/RECEIPT_REGISTRY_ID/);
  });

  it("applies defaults and never reads the payout secret", () => {
    const config = loadConfig({ ...REQUIRED, MERCHANT_PAYOUT_SECRET: "SHOULDNOTMATTER" });
    expect(config).toMatchObject({
      port: 4021,
      adapter: "mock",
      fx: { rate: "950", base: "USD", quote: "CLP" },
      policies: { refundWindowSeconds: 864000, shippingCountries: ["CL"] },
      facilitator: { url: "https://channels.openzeppelin.com/x402/testnet", apiKey: undefined, timeoutMs: 60000 },
      checkout: { maxTimeoutSeconds: 300 },
      signing: { account: SIGNER.publicKey() },
      receiptRegistryId: REGISTRY_ID,
    });
    expect(JSON.stringify(config)).not.toContain("SHOULDNOTMATTER");
  });
});

describe("loadConfig (V-8)", () => {
  it("refuses a signing key that is the payTo account", async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const same = Keypair.random();
    expect(() => loadConfig({ ...REQUIRED, MERCHANT_STELLAR_ACCOUNT: same.publicKey(), MERCHANT_SIGNING_SECRET: same.secret() })).toThrow(/must not be the payTo/);
  });
});
