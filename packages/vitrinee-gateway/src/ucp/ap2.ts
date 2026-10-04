/**
 * A storefront's side of AP2 in the UCP checkout (T134, R-15, VT-43).
 *
 * The business signs every checkout response with a P-256 key (UCP's AP2
 * extension is ECDSA, R-5). That key is derived from the storefront's receipt
 * key (VT-43): HKDF-SHA256 over the Ed25519 seed with a label of its own,
 * reduced to a valid P-256 scalar. No new secret, no migration; the receipt
 * key is already the storefront's identity.
 */
import { createECDH, createHash, hkdfSync } from "node:crypto";

import { StrKey } from "@stellar/stellar-sdk";
import type { Ap2Signer } from "@agentpey/ap2";

/** The order of the P-256 group. */
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const LABEL = "vitrinee/ucp-ap2/p256/v1";

export interface StoreAp2Key {
  readonly signer: Ap2Signer;
  /** Published in `keys` of the 2026-08-25 profile. */
  readonly publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string; alg: "ES256"; use: "sig" };
}

/**
 * The storefront's AP2 key, derived from its receipt-signing secret. 48 bytes
 * of HKDF reduced mod n−1, plus one: uniform enough (the bias is below 2^-128)
 * and never zero.
 */
export function deriveStoreAp2Key(signingSecret: string, kidPrefix: string): StoreAp2Key {
  const seed = StrKey.decodeEd25519SecretSeed(signingSecret);
  const okm = Buffer.from(hkdfSync("sha256", seed, createHash("sha256").update("vitrinee").digest(), LABEL, 48));
  const d = (BigInt(`0x${okm.toString("hex")}`) % (P256_N - 1n)) + 1n;
  const dBytes = Buffer.from(d.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(dBytes);
  const point = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
  const x = point.subarray(1, 33).toString("base64url");
  const y = point.subarray(33, 65).toString("base64url");
  const kid = `${kidPrefix}#ap2-p256`;
  return {
    signer: { alg: "ES256", kid, privateJwk: { kty: "EC", crv: "P-256", x, y, d: dBytes.toString("base64url") } },
    publicJwk: { kty: "EC", crv: "P-256", x, y, kid, alg: "ES256", use: "sig" },
  };
}
