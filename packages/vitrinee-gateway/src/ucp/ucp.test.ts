import { readFileSync } from "node:fs";

import { MOCK_CATALOG, MockStoreAdapter } from "@vitrinee/adapters";
import {
  MANIFEST_PATH,
  STELLAR_X402_HANDLER,
  UCP_PROFILE_PATH,
  UCP_REST_PREFIX,
  USDC_TESTNET,
  originMatchesNamespace,
  storefrontManifestSchema,
  ucpBusinessProfileSchema,
  ucpSearchResponseSchema,
} from "@vitrinee/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { fakeFacilitator } from "../test/fake-facilitator.js";
import { MERCHANT, SIGNER, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { UCP_SCHEMA, addSchema, ucpErrors } from "../test/ucp-schemas.js";

const HANDLER_SCHEMA = JSON.parse(
  readFileSync(new URL("../../../../apps/web/public/ucp/handlers/stellar-x402/schema.json", import.meta.url), "utf8"),
) as { $id: string };
const RECEIPT_SCHEMA = JSON.parse(
  readFileSync(new URL("../../../../apps/web/public/ucp/extensions/receipt/schema.json", import.meta.url), "utf8"),
) as { $id: string };
addSchema(HANDLER_SCHEMA);
addSchema(RECEIPT_SCHEMA);

describe("UCP surface of a storefront", () => {
  const config = testConfig();
  const out: typeof MOCK_CATALOG = MOCK_CATALOG.map((p) => (p.id === "gorro-andes" ? { ...p, stock: 0 } : p));
  const adapter = new MockStoreAdapter({ catalog: out });
  const { anchorer, registry } = fakeRegistry();
  const app = createApp({ config, adapter, facilitator: fakeFacilitator(), anchorer, registry, now: () => new Date("2026-09-30T12:00:00.000Z") });
  let url = "";
  let close: () => Promise<void> = async () => {};

  const post = async (path: string, body: unknown) =>
    fetch(`${url}${UCP_REST_PREFIX}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    ({ url, close } = await listen(app));
  });
  afterAll(() => close());

  describe("GET /.well-known/ucp", () => {
    it("serves a business profile that validates against the official UCP schema", async () => {
      const res = await fetch(`${url}${UCP_PROFILE_PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      const profile = await res.json();
      expect(ucpErrors(UCP_SCHEMA.businessProfile, profile)).toEqual([]);
      expect(ucpBusinessProfileSchema.safeParse(profile).success).toBe(true);
    });

    it("is checked for real: the same validator rejects a broken profile (negative control)", async () => {
      const profile = (await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json()) as { ucp: Record<string, unknown> };
      const noVersion: Record<string, unknown> = { ...profile.ucp };
      delete noVersion["version"];
      expect(ucpErrors(UCP_SCHEMA.businessProfile, { ...profile, ucp: noVersion })).not.toEqual([]);
      expect(ucpErrors(UCP_SCHEMA.businessProfile, { ...profile, ucp: { ...profile.ucp, services: { "dev.ucp.shopping": [{ version: "2026-04-08", transport: "carrier-pigeon" }] } } })).not.toEqual([]);
    });

    it("points the REST service at the /ucp/v1 prefix of this host", async () => {
      const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
      expect(profile.ucp.version).toBe("2026-04-08");
      expect(profile.ucp.services["dev.ucp.shopping"]).toEqual([expect.objectContaining({ transport: "rest", endpoint: `${url}/ucp/v1` })]);
    });

    it("declares only the capabilities it answers: no checkout until it exists", async () => {
      const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
      expect(Object.keys(profile.ucp.capabilities ?? {}).sort()).toEqual(["dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.catalog.search"]);
    });

    it("declares the Stellar x402 handler with a config that validates against the handler's own schema", async () => {
      const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
      const [handler] = profile.ucp.payment_handlers[STELLAR_X402_HANDLER] ?? [];
      expect(handler).toMatchObject({ id: "stellar_x402", available_instruments: [{ type: "stellar_x402" }] });
      expect(ucpErrors(`${HANDLER_SCHEMA.$id}#/$defs/business_config`, handler?.config)).toEqual([]);
      expect(handler?.config).toEqual({
        x402_version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        asset: { code: "USDC", contract: USDC_TESTNET.contractId, decimals: 7 },
        pay_to: MERCHANT,
        facilitator: "https://channels.openzeppelin.com/x402/testnet",
      });
    });

    it("hosts every spec and schema it names under that name's own domain", async () => {
      const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
      const entries = [
        ...Object.entries(profile.ucp.services),
        ...Object.entries(profile.ucp.capabilities ?? {}),
        ...Object.entries(profile.ucp.payment_handlers),
      ];
      for (const [name, declarations] of entries) {
        for (const declaration of declarations) {
          for (const link of [declaration.spec, declaration.schema]) {
            if (link !== undefined) expect(originMatchesNamespace(name, link), `${name} → ${link}`).toBe(true);
          }
        }
      }
    });

    it("publishes the receipt-signing key, never the payout account", async () => {
      const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
      const [key] = profile.signing_keys ?? [];
      expect(key).toMatchObject({ kid: `did:stellar:testnet:${SIGNER.publicKey()}#key-1`, kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
      expect(String(key?.["x"])).toBe(Buffer.from(SIGNER.rawPublicKey()).toString("base64url"));
      expect(JSON.stringify(profile.signing_keys)).not.toContain(MERCHANT);
    });
  });

  describe("POST /ucp/v1/catalog/search", () => {
    it("lists every product as a UCP product that validates against the official schema", async () => {
      const res = await post("/catalog/search", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(ucpErrors(UCP_SCHEMA.searchResponse, body)).toEqual([]);
      const parsed = ucpSearchResponseSchema.parse(body);
      expect(parsed.products).toHaveLength(6);
      expect(parsed.pagination).toEqual({ has_next_page: false, total_count: 6 });
    });

    it("prices in the store's currency and carries the USDC settlement amount under the handler's name", async () => {
      const body = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { query: "hoodie" })).json());
      expect(body.products).toHaveLength(1);
      const [hoodie] = body.products;
      expect(hoodie?.price_range).toEqual({ min: { amount: 34990, currency: "CLP" }, max: { amount: 34990, currency: "CLP" } });
      expect(hoodie?.variants[0]).toMatchObject({
        id: "hoodie-cordillera-m",
        sku: "HOOD-CORD-M",
        price: { amount: 34990, currency: "CLP" },
        availability: { available: true, status: "in_stock" },
        // Same number the agent-storefront manifest shows as priceUSDCAtomic.
        metadata: { [STELLAR_X402_HANDLER]: { asset: USDC_TESTNET.contractId, amount_atomic: "368315789", fx: { base: "USD", quote: "CLP", rate: "950" } } },
      });
    });

    it("lists an out-of-stock product as unavailable instead of hiding it", async () => {
      const body = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { query: "gorro" })).json());
      expect(body.products[0]?.variants[0]?.availability).toEqual({ available: false, status: "out_of_stock" });
    });

    it("matches name and description without regard to case, and returns nothing for no match", async () => {
      const upper = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { query: "CAFÉ" })).json());
      expect(upper.products.map((p) => p.id)).toEqual(["cafe-nunoa-250"]);
      const none = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { query: "bicicleta" })).json());
      expect(none.products).toEqual([]);
      expect(none.pagination).toEqual({ has_next_page: false, total_count: 0 });
    });

    it("rejects a price that is not an integer, per the official schema (negative control)", async () => {
      const body = (await (await post("/catalog/search", { query: "hoodie" })).json()) as { products: Array<{ variants: Array<{ price: { amount: unknown } }> }> };
      const variant = body.products[0]?.variants[0];
      if (variant === undefined) throw new TypeError("no variant");
      variant.price.amount = 349.9;
      expect(ucpErrors(UCP_SCHEMA.searchResponse, body)).not.toEqual([]);
      variant.price.amount = "34990";
      expect(ucpErrors(UCP_SCHEMA.searchResponse, body)).not.toEqual([]);
    });

    it("matches no product for a category filter, since Vitrinee products carry no categories", async () => {
      const body = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { filters: { categories: ["ropa"] } })).json());
      expect(body.products).toEqual([]);
    });

    it("answers a body that is not JSON with a typed 400, not a 500", async () => {
      const res = await fetch(`${url}${UCP_REST_PREFIX}/catalog/search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "ValidationError" });
    });

    it("filters by price in minor units of the store's currency", async () => {
      const body = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { filters: { price: { max: 9000 } } })).json());
      expect(body.products.map((p) => p.id).sort()).toEqual(["cafe-nunoa-250", "stickers-cordillera"]);
    });

    it("pages with an opaque cursor until the last page", async () => {
      const first = ucpSearchResponseSchema.parse(await (await post("/catalog/search", { pagination: { limit: 4 } })).json());
      expect(first.products).toHaveLength(4);
      expect(first.pagination).toEqual({ has_next_page: true, cursor: "4", total_count: 6 });
      const second = await (await post("/catalog/search", { pagination: { limit: 4, cursor: first.pagination?.cursor } })).json();
      expect(ucpErrors(UCP_SCHEMA.searchResponse, second)).toEqual([]);
      const parsed = ucpSearchResponseSchema.parse(second);
      expect(parsed.products).toHaveLength(2);
      expect(parsed.pagination).toEqual({ has_next_page: false, total_count: 6 });
    });

    it("rejects a malformed request with a typed 400", async () => {
      for (const body of [{ query: 42 }, { pagination: { cursor: "abc" } }, { pagination: { limit: 0 } }, { query: "x".repeat(201) }]) {
        const res = await post("/catalog/search", body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: "ValidationError" });
      }
    });
  });

  describe("POST /ucp/v1/catalog/lookup", () => {
    it("resolves product ids and SKUs, drops unknown ids, and validates against the official schema", async () => {
      const res = await post("/catalog/lookup", { ids: ["gorro-andes", "HOOD-CORD-M", "nope"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { products: Array<{ id: string; variants: Array<{ inputs: unknown }> }> };
      expect(ucpErrors(UCP_SCHEMA.lookupResponse, body)).toEqual([]);
      expect(body.products.map((p) => p.id)).toEqual(["gorro-andes", "hoodie-cordillera-m"]);
      expect(body.products[1]?.variants[0]?.inputs).toEqual([{ id: "HOOD-CORD-M", match: "exact" }]);
    });

    it("folds two ids for the same product into one product with both inputs", async () => {
      const body = (await (await post("/catalog/lookup", { ids: ["gorro-andes", "GOR-ANDES"] })).json()) as {
        products: Array<{ variants: Array<{ inputs: unknown }> }>;
      };
      expect(body.products).toHaveLength(1);
      expect(body.products[0]?.variants[0]?.inputs).toEqual([
        { id: "gorro-andes", match: "exact" },
        { id: "GOR-ANDES", match: "exact" },
      ]);
    });

    it("requires at least one id", async () => {
      const res = await post("/catalog/lookup", { ids: [] });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "ValidationError" });
    });
  });

  describe("POST /ucp/v1/catalog/product", () => {
    it("returns one product, valid against the official schema", async () => {
      const body = await (await post("/catalog/product", { id: "stickers-cordillera" })).json();
      expect(ucpErrors(UCP_SCHEMA.getProductResponse, body)).toEqual([]);
      expect(body).toMatchObject({ ucp: { status: "success" }, product: { id: "stickers-cordillera" } });
    });

    it("reports a missing product as a UCP application error, not a transport error", async () => {
      const res = await post("/catalog/product", { id: "nope" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(ucpErrors(UCP_SCHEMA.errorResponse, body)).toEqual([]);
      expect(body).toMatchObject({
        ucp: { status: "error" },
        messages: [{ type: "error", code: "not_found", severity: "unrecoverable" }],
      });
    });
  });

  describe("what predates UCP", () => {
    it("still serves the agent-storefront manifest unchanged", async () => {
      const manifest = storefrontManifestSchema.parse(await (await fetch(`${url}${MANIFEST_PATH}`)).json());
      expect(manifest.products).toHaveLength(6);
      expect(manifest.products.find((p) => p.id === "hoodie-cordillera-m")).toMatchObject({ priceUSDCAtomic: "368315789" });
      expect(manifest.endpoints.catalog).toBe(`${url}/catalog`);
    });

    it("keeps GET /catalog and GET /orders/:orderId answering as before", async () => {
      const catalog = (await (await fetch(`${url}/catalog`)).json()) as { products: unknown[] };
      expect(catalog.products).toHaveLength(6);
      const order = await fetch(`${url}/orders/ord_nope`);
      expect(order.status).toBe(404);
      expect(await order.json()).toMatchObject({ error: "OrderNotFound" });
    });

    it("does not answer UCP routes outside the prefix", async () => {
      const res = await fetch(`${url}/catalog/search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(404);
    });
  });
});

describe("the handler's published schemas", () => {
  it("describe a credential shaped like the x402 payload the buyer already builds", () => {
    const credential = {
      type: "x402_payment_payload",
      x402_version: 2,
      accepted: { scheme: "exact", network: "stellar:testnet", asset: USDC_TESTNET.contractId, amount: "368315789", payTo: MERCHANT, maxTimeoutSeconds: 300 },
      payload: { transaction: "AAAAAgAAAAA=" },
    };
    expect(ucpErrors(`${HANDLER_SCHEMA.$id}#/$defs/credential`, credential)).toEqual([]);
    expect(ucpErrors(`${HANDLER_SCHEMA.$id}#/$defs/credential`, { ...credential, accepted: { ...credential.accepted, amount: "1.5" } })).not.toEqual([]);
  });

  it("describe a receipt with the fields the gateway's order already returns", () => {
    const receipt = {
      format: "jws",
      jws: "eyJ.eyJ.sig",
      hash: "a".repeat(64),
      network: "stellar:testnet",
      settlement_tx_hash: "b".repeat(64),
      anchor: { status: "pending", registry: "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5" },
      verify_url: "https://shop.example/receipts/aaaa/verify",
    };
    expect(ucpErrors(`${RECEIPT_SCHEMA.$id}#/$defs/receipt`, receipt)).toEqual([]);
    expect(ucpErrors(`${RECEIPT_SCHEMA.$id}#/$defs/receipt`, { ...receipt, anchor: { status: "lost", registry: receipt.anchor.registry } })).not.toEqual([]);
  });
});
