import { Keypair } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { stellarDid } from "./did.js";
import { USDC_TESTNET } from "./manifest.js";
import { checkReceiptSignature, receiptHash, signReceipt, type ReceiptClaims } from "./receipt.js";
import { decodeJws, signJws, verifyJws } from "./jws.js";

const signer = Keypair.random();
const PAYER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

function claims(overrides: Partial<ReceiptClaims> = {}): ReceiptClaims {
  return {
    typ: "vitrinee-receipt/0.1",
    orderId: "ord_mucrhcq85d377d2f30",
    platformOrderId: "mock-0001",
    platform: "mock",
    merchantDid: stellarDid(signer.publicKey()),
    merchantAccount: USDC_TESTNET.issuer,
    payerAccount: PAYER,
    network: "stellar:testnet",
    asset: USDC_TESTNET.contractId,
    amountUSDC: "9.4631579",
    amountUSDCAtomic: "94631579",
    settlementTxHash: "ef86ca2fb6b3fbbe32e89b23c7159a4b13dc02e251bb83a7e75e0ac68f86080f",
    items: [{ productId: "cafe-nunoa-250", sku: "CAF-NUN-250", name: "Café de grano Ñuñoa 250 g", quantity: 1, unitPriceUSDC: "9.4631579", unitPriceUSDCAtomic: "94631579" }],
    issuedAt: "2026-09-22T14:20:30.000Z",
    refundWindowEndsAt: "2026-10-02T14:20:30.000Z",
    ...overrides,
  };
}

/** Flips one character of one segment, keeping it valid base64url. */
function tamper(jws: string, segment: 0 | 1 | 2, at = 10): string {
  const parts = jws.split(".");
  const s = parts[segment]!;
  const c = s[at]!;
  parts[segment] = s.slice(0, at) + (c === "A" ? "B" : "A") + s.slice(at + 1);
  return parts.join(".");
}

describe("signJws / verifyJws", () => {
  it("round-trips and names the signer in kid", () => {
    const jws = signJws({ hello: "Ñuñoa" }, signer.secret(), { typ: "JWT" });
    const decoded = decodeJws(jws);
    expect(decoded.header).toEqual({ alg: "EdDSA", typ: "JWT", kid: `did:stellar:testnet:${signer.publicKey()}#key-1` });
    expect(decoded.payload).toEqual({ hello: "Ñuñoa" });
    expect(verifyJws(decoded)).toEqual({ ok: true, signer: signer.publicKey() });
  });

  it("refuses a bad secret without echoing it", () => {
    expect(() => signJws({}, "SNOTASECRETATALL", { typ: "JWT" })).toThrow(/not a valid Stellar secret/);
    expect(() => signJws({}, "SNOTASECRETATALL", { typ: "JWT" })).not.toThrow(/SNOTASECRETATALL/);
  });

  it("rejects malformed input", () => {
    expect(() => decodeJws("a.b")).toThrow(/compact JWS/);
    expect(() => decodeJws("a.b.c!")).toThrow(/compact JWS/);
    const noneAlg = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.AA`;
    expect(() => decodeJws(noneAlg)).toThrow(/EdDSA/);
  });
});

describe("receipts", () => {
  it("signs, hashes and verifies a receipt", () => {
    const { jws, hash } = signReceipt(claims(), signer.secret());
    expect(hash).toBe(receiptHash(jws));
    const check = checkReceiptSignature(jws);
    expect(check).toMatchObject({ ok: true, signer: signer.publicKey(), hash });
    expect(check.claims?.orderId).toBe("ord_mucrhcq85d377d2f30");
  });

  it("goes red when any byte of the payload or signature changes", () => {
    const { jws, hash } = signReceipt(claims(), signer.secret());
    for (const segment of [1, 2] as const) {
      const bad = tamper(jws, segment);
      const check = checkReceiptSignature(bad);
      expect(check.ok, `segment ${segment}`).toBe(false);
      expect(check.hash).not.toBe(hash);
    }
  });

  it("goes red when the amount is edited and re-encoded without re-signing", () => {
    const { jws } = signReceipt(claims(), signer.secret());
    const [h, , s] = jws.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims(), amountUSDC: "0.0000001", amountUSDCAtomic: "1" })).toString("base64url");
    const check = checkReceiptSignature(`${h}.${forged}.${s}`);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/does not match/);
  });

  it("refuses a receipt signed by someone other than the merchant it names", () => {
    const impostor = Keypair.random();
    const { jws } = signReceipt(claims(), impostor.secret()); // merchantDid still names `signer`
    const check = checkReceiptSignature(jws);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/but the receipt names/);
  });

  it("refuses signing claims that do not validate", () => {
    expect(() => signReceipt(claims({ settlementTxHash: "nope" }), signer.secret())).toThrow();
  });
});
