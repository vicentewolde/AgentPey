import { describe, expect, it } from "vitest";

import { stellarDid } from "./did.js";
import { USDC_TESTNET } from "./manifest.js";
import { receiptClaimsSchema, receiptHash, type ReceiptClaims } from "./receipt.js";

const MERCHANT = USDC_TESTNET.issuer;
const PAYER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

function sampleClaims(): ReceiptClaims {
  return {
    typ: "vitrinee-receipt/0.1",
    orderId: "01J8Q2W6K9V5D9Y4T2N3M1P0R7",
    platformOrderId: "mock-0001",
    platform: "mock",
    merchantDid: stellarDid(MERCHANT),
    merchantAccount: MERCHANT,
    payerAccount: PAYER,
    network: "stellar:testnet",
    asset: USDC_TESTNET.contractId,
    amountUSDC: "36.8315789",
    amountUSDCAtomic: "368315789",
    settlementTxHash: "a".repeat(64),
    items: [
      {
        productId: "hoodie-cordillera-m",
        sku: "HOOD-CORD-M",
        name: "Hoodie Cordillera talla M",
        quantity: 1,
        unitPriceUSDC: "36.8315789",
        unitPriceUSDCAtomic: "368315789",
      },
    ],
    issuedAt: "2026-09-22T12:00:00.000Z",
    refundWindowEndsAt: "2026-10-02T12:00:00.000Z",
  };
}

describe("receipt claims", () => {
  it("accepts well-formed claims", () => {
    expect(receiptClaimsSchema.parse(sampleClaims())).toEqual(sampleClaims());
  });

  it("rejects an uppercase or short tx hash and an empty item list", () => {
    const upper = { ...sampleClaims(), settlementTxHash: "A".repeat(64) };
    expect(receiptClaimsSchema.safeParse(upper).success).toBe(false);
    const short = { ...sampleClaims(), settlementTxHash: "ab" };
    expect(receiptClaimsSchema.safeParse(short).success).toBe(false);
    const empty = { ...sampleClaims(), items: [] };
    expect(receiptClaimsSchema.safeParse(empty).success).toBe(false);
  });
});

describe("receiptHash", () => {
  it("is the sha256 of the compact JWS and changes with any byte", () => {
    const jws = "eyJhbGciOiJFZERTQSJ9.eyJ0eXAiOiJ2aXRyaW5lZS1yZWNlaXB0LzAuMSJ9.c2ln";
    const hash = receiptHash(jws);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptHash(jws)).toBe(hash);
    expect(receiptHash(jws.slice(0, -1) + "h")).not.toBe(hash);
  });
});
