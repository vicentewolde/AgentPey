import type { AddressInfo } from "node:net";

import { MockStoreAdapter } from "@vitrinee/adapters";
import { MANIFEST_PATH, USDC_TESTNET, storefrontManifestSchema } from "@vitrinee/core";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const MERCHANT = USDC_TESTNET.issuer;

function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("gateway (day 0 routes)", () => {
  const config = loadConfig({
    MERCHANT_STELLAR_ACCOUNT: MERCHANT,
    FX_RATE_CLP_USD: "950",
    SHIPPING_COUNTRIES: "CL, AR",
  });
  const adapter = new MockStoreAdapter();
  const app = createApp({ config, adapter, now: () => new Date("2026-09-22T15:00:00.000Z") });
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
    expect(manifest.merchant).toMatchObject({
      did: `did:stellar:testnet:${MERCHANT}`,
      stellarAccount: MERCHANT,
      country: "CL",
      currency: "CLP",
    });
    expect(manifest.settlement.assetContract).toBe(USDC_TESTNET.contractId);
    expect(manifest.policies.shippingCountries).toEqual(["CL", "AR"]);
    expect(manifest.products).toHaveLength(5);
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
  });

  it("honours PUBLIC_BASE_URL for absolute endpoints", async () => {
    const publicConfig = loadConfig({
      MERCHANT_STELLAR_ACCOUNT: MERCHANT,
      PUBLIC_BASE_URL: "https://vitrinee.example.com/",
    });
    const { url: localUrl, close: closeLocal } = await listen(createApp({ config: publicConfig, adapter }));
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
    expect(() => loadConfig({ MERCHANT_STELLAR_ACCOUNT: "SECRETLOOKINGVALUE" })).toThrow(
      /MERCHANT_STELLAR_ACCOUNT: not a Stellar account/,
    );
    expect(() => loadConfig({ MERCHANT_STELLAR_ACCOUNT: "SECRETLOOKINGVALUE" })).not.toThrow(
      /SECRETLOOKINGVALUE/,
    );
    expect(() => loadConfig({})).toThrow(/MERCHANT_STELLAR_ACCOUNT/);
  });

  it("applies defaults", () => {
    const config = loadConfig({ MERCHANT_STELLAR_ACCOUNT: MERCHANT });
    expect(config).toMatchObject({
      port: 4021,
      adapter: "mock",
      fx: { rate: "950", base: "USD", quote: "CLP" },
      policies: { refundWindowSeconds: 864000, shippingCountries: ["CL"] },
      facilitator: { url: "https://channels.openzeppelin.com/x402/testnet", apiKey: undefined },
    });
  });
});
