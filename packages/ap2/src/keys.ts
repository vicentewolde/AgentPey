/**
 * P-256 keys for AP2 in the UCP checkout (T134, R-5): from a 32-byte scalar,
 * or derived from a seed this codebase already holds (VT-43, R-16).
 */
import { createECDH, createHash, hkdfSync } from "node:crypto";

import { AgentPassError } from "@agentpass/core";

import type { Ap2Signer } from "./sd-jwt.js";

/** The order of the P-256 group. */
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

export interface P256Key {
  readonly signer: Ap2Signer;
  /** The public half, as published in a UCP profile's `keys`. */
  readonly publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string; alg: "ES256"; use: "sig" };
}

/** A P-256 key from its private scalar (32 bytes, 1 ≤ d < n). */
export function p256FromScalar(d: Uint8Array, kid: string): P256Key {
  const invalid = () => new AgentPassError("Ap2MandateInvalid", "a P-256 private key is a 32-byte scalar in [1, n)");
  if (d.length !== 32) throw invalid();
  const scalar = BigInt(`0x${Buffer.from(d).toString("hex")}`);
  if (scalar === 0n || scalar >= P256_N) throw invalid();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(d));
  const point = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
  const x = point.subarray(1, 33).toString("base64url");
  const y = point.subarray(33, 65).toString("base64url");
  return {
    signer: { alg: "ES256", kid, privateJwk: { kty: "EC", crv: "P-256", x, y, d: Buffer.from(d).toString("base64url") } },
    publicJwk: { kty: "EC", crv: "P-256", x, y, kid, alg: "ES256", use: "sig" },
  };
}

/**
 * A P-256 key derived from a seed under a label of its own: HKDF-SHA256, 48
 * bytes reduced mod n−1, plus one. The bias is below 2^-128 and the scalar is
 * never zero. One seed and one label always give the same key; another label,
 * an unrelated one.
 */
export function deriveP256(seed: Uint8Array, label: string, kid: string): P256Key {
  const okm = Buffer.from(hkdfSync("sha256", seed, createHash("sha256").update(label).digest(), label, 48));
  const d = (BigInt(`0x${okm.toString("hex")}`) % (P256_N - 1n)) + 1n;
  return p256FromScalar(Buffer.from(d.toString(16).padStart(64, "0"), "hex"), kid);
}
