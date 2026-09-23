import { describe, expect, it } from "vitest";

import { stellarDid } from "./did.js";
import {
  MANIFEST_PATH,
  OPENZEPPELIN_FACILITATOR_TESTNET,
  USDC_TESTNET,
  storefrontManifestSchema,
  type StorefrontManifest,
} from "./manifest.js";

const ACCOUNT = USDC_TESTNET.issuer;

export function sampleManifest(): StorefrontManifest {
  return {
    version: "0.1",
    generatedAt: "2026-09-22T12:00:00.000Z",
    merchant: {
      name: "Bazar Cordillera",
      did: stellarDid(ACCOUNT),
      stellarAccount: ACCOUNT,
      country: "CL",
      currency: "CLP",
    },
    network: "stellar:testnet",
    settlement: {
      scheme: "exact",
      asset: "USDC",
      assetContract: USDC_TESTNET.contractId,
      decimals: 7,
      facilitator: OPENZEPPELIN_FACILITATOR_TESTNET,
    },
    fx: { base: "USD", quote: "CLP", rate: "950", source: "demo-fixed", asOf: "2026-09-22T12:00:00.000Z" },
    policies: { refundWindowSeconds: 864000, shippingCountries: ["CL"] },
    receipts: { format: "jws", alg: "EdDSA", anchoredValue: "sha256(compact-jws)", registry: "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5" },
    products: [
      {
        id: "hoodie-cordillera-m",
        sku: "HOOD-CORD-M",
        name: "Hoodie Cordillera talla M",
        description: "Polerón con capucha, algodón orgánico.",
        priceLocal: "34990",
        currency: "CLP",
        priceUSDC: "36.8315789",
        priceUSDCAtomic: "368315789",
        stock: 12,
        images: ["https://static.example.com/vitrinee/hoodie-cordillera-m.jpg"],
        checkoutRoute: "/checkout/hoodie-cordillera-m",
      },
    ],
    endpoints: {
      catalog: "https://vitrinee.example.com/catalog",
      product: "https://vitrinee.example.com/products/{id}",
      checkout: "https://vitrinee.example.com/checkout/{productId}",
      orders: "https://vitrinee.example.com/orders/{orderId}",
      verifyReceipt: "https://vitrinee.example.com/receipts/{hash}/verify",
      discovery: "https://vitrinee.example.com/discovery/resources",
    },
  };
}

describe("storefrontManifestSchema", () => {
  it("accepts a complete manifest", () => {
    expect(storefrontManifestSchema.parse(sampleManifest())).toEqual(sampleManifest());
    expect(MANIFEST_PATH).toBe("/.well-known/agent-storefront.json");
  });

  it("rejects a payTo that is not a Stellar account", () => {
    const bad = sampleManifest();
    bad.merchant.stellarAccount = USDC_TESTNET.contractId;
    expect(storefrontManifestSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown fields, float-looking prices and non-testnet networks", () => {
    const extra = { ...sampleManifest(), surprise: true };
    expect(storefrontManifestSchema.safeParse(extra).success).toBe(false);

    const floaty = sampleManifest();
    floaty.products[0]!.priceUSDCAtomic = "36.83";
    expect(storefrontManifestSchema.safeParse(floaty).success).toBe(false);

    const pubnet = { ...sampleManifest(), network: "stellar:pubnet" };
    expect(storefrontManifestSchema.safeParse(pubnet).success).toBe(false);
  });
});
