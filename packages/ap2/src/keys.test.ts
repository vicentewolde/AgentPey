import { CompactSign, compactVerify, importJWK } from "jose";
import { describe, expect, it } from "vitest";

import { deriveP256, p256FromScalar } from "./keys.js";

describe("P-256 keys for AP2 (T134)", () => {
  const seed = new Uint8Array(32).fill(7);

  it("derives the same key from the same seed and label, and an unrelated one under another label", () => {
    const a = deriveP256(seed, "label/one", "k");
    expect(deriveP256(seed, "label/one", "k").publicJwk).toEqual(a.publicJwk);
    expect(deriveP256(seed, "label/two", "k").publicJwk.x).not.toBe(a.publicJwk.x);
  });

  it("derives a key that signs and verifies ES256", async () => {
    const key = deriveP256(seed, "label/one", "k");
    const jws = await new CompactSign(new TextEncoder().encode("hi")).setProtectedHeader({ alg: "ES256" }).sign(await importJWK(key.signer.privateJwk, "ES256"));
    await expect(compactVerify(jws, await importJWK(key.publicJwk, "ES256"))).resolves.toBeTruthy();
  });

  it.each([new Uint8Array(0), new Uint8Array(31), new Uint8Array(32), new Uint8Array(32).fill(0xff)])("refuses a scalar out of range, with a typed error", (d) => {
    expect(() => p256FromScalar(d, "k")).toThrow(expect.objectContaining({ code: "Ap2MandateInvalid" }));
  });
});
