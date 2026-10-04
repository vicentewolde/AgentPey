import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { contentDigest, httpSignatureBase, signedWebhookHeaders, verifyHttpMessageSignature, type EcPrivateJwk, type EcPublicJwk } from "./http-signatures.js";

/** RFC 9421 Appendix B.1.3, test-key-ecc-p256. */
const RFC_P256 = { kty: "EC", crv: "P-256", x: "qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA", y: "Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0" } as const;

function p256(kid: string): { privateJwk: EcPrivateJwk; publicJwk: EcPublicJwk & { kid: string } } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  return { privateJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, kid }, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid } };
}

describe("RFC 9421, against the RFC's own test vectors (T147)", () => {
  it("builds the B.2.6 request signature base byte for byte", () => {
    const base = httpSignatureBase(
      "POST",
      "https://example.com/foo?param=Value&Pet=dog",
      { date: "Tue, 20 Apr 2021 02:07:55 GMT", "content-type": "application/json", "content-length": "18" },
      ["date", "@method", "@path", "@authority", "content-type", "content-length"],
      '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
    );
    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join("\n"),
    );
  });

  it("verifies B.2.4's ecdsa-p256-sha256 signature the way this module does (raw r‖s over the base)", () => {
    const base = [
      '"@status": 200',
      '"content-type": application/json',
      '"content-digest": sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
      '"content-length": 23',
      '"@signature-params": ("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
    ].join("\n");
    const signature = Buffer.from("wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==", "base64");
    const key = createPublicKey({ key: RFC_P256, format: "jwk" });
    expect(verify("sha256", Buffer.from(base), { key, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("writes Content-Digest as RFC 9530 sha-256", () => {
    expect(contentDigest('{"hello": "world"}')).toBe("sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:");
  });
});

describe("signed UCP order webhooks (T147)", () => {
  const store = p256("did:stellar:testnet:GSTORE#ucp-p256");
  const stranger = p256("did:stellar:testnet:GSTORE#ucp-p256");
  const url = "https://agentpey.com/ucp/webhooks/orders";
  const body = JSON.stringify({ id: "ord_1", checkout_id: "cs_1" });
  const sign = (overrides: Partial<Parameters<typeof signedWebhookHeaders>[0]> = {}) =>
    signedWebhookHeaders({
      url,
      body,
      profileUrl: "https://agentcommerce.vitrinee.agentpey.com/.well-known/ucp",
      webhookId: "4a3c9f8e-1b2d-4c5e-8f7a-0b1c2d3e4f5a",
      webhookTimestamp: 1_759_600_000,
      created: 1_759_600_002,
      key: { privateJwk: store.privateJwk, kid: store.publicJwk.kid },
      ...overrides,
    });
  const check = (headers: Record<string, string>, o: { body?: string; url?: string; keys?: EcPublicJwk[] } = {}) =>
    verifyHttpMessageSignature({
      method: "POST",
      url: o.url ?? url,
      headers,
      body: o.body ?? body,
      keyFor: (keyid) => (o.keys ?? [store.publicJwk]).find((k) => k.kid === keyid),
    });

  it("carries the headers UCP and its suite expect, and verifies against the store's published key", () => {
    const headers = sign();
    expect(headers).toMatchObject({
      "content-type": "application/json",
      "content-digest": contentDigest(body),
      "ucp-agent": 'profile="https://agentcommerce.vitrinee.agentpey.com/.well-known/ucp"',
      "idempotency-key": "4a3c9f8e-1b2d-4c5e-8f7a-0b1c2d3e4f5a",
      "webhook-id": "4a3c9f8e-1b2d-4c5e-8f7a-0b1c2d3e4f5a",
      "webhook-timestamp": "1759600000",
    });
    expect(headers["signature-input"]).toBe(
      'sig1=("@method" "@authority" "@path" "content-digest" "content-type" "ucp-agent" "idempotency-key" "webhook-id" "webhook-timestamp");created=1759600002;keyid="did:stellar:testnet:GSTORE#ucp-p256"',
    );
    expect(headers["signature"]).toMatch(/^sig1=:[A-Za-z0-9+/]{86}==:$/);
    expect(check(headers)).toMatchObject({ ok: true, keyid: store.publicJwk.kid, created: 1_759_600_002 });
  });

  it.each([
    ["another body", { body: '{"id":"ord_2"}' }, "digest_mismatch"],
    ["another path", { url: "https://agentpey.com/ucp/webhooks/other" }, "bad_signature"],
    ["another host", { url: "https://evil.example/ucp/webhooks/orders" }, "bad_signature"],
    ["a key the store does not publish under that id", { keys: [stranger.publicJwk] }, "bad_signature"],
    ["no key under that id", { keys: [] }, "key_not_found"],
  ] as const)("refuses %s", (_label, o, reason) => {
    expect(check(sign(), o)).toEqual({ ok: false, reason });
  });

  it("refuses a delivery whose event identity was swapped after signing", () => {
    expect(check({ ...sign(), "webhook-id": "another-event" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ ...sign(), "webhook-timestamp": "1759600999" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an unsigned delivery, and a signature that leaves UCP-Agent or the body uncovered", () => {
    const unsigned = Object.fromEntries(Object.entries(sign()).filter(([name]) => name !== "signature" && name !== "signature-input"));
    expect(check(unsigned)).toEqual({ ok: false, reason: "missing_signature" });
    const headers = sign();
    expect(check({ ...headers, "signature-input": headers["signature-input"]!.replace(' "ucp-agent"', "") })).toEqual({ ok: false, reason: "missing_component" });
    expect(check({ ...headers, "signature-input": headers["signature-input"]!.replace(' "content-digest"', "") })).toEqual({ ok: false, reason: "missing_component" });
  });

  it("refuses to sign with a value that would break the header", () => {
    expect(() => sign({ webhookId: 'a"b' })).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });
});
