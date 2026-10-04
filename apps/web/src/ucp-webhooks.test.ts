import { generateKeyPairSync } from "node:crypto";

import { signedWebhookHeaders, type EcPrivateJwk } from "@vitrinee/core";
import { describe, expect, it } from "vitest";

import { createOrderWebhookReceiver, isAgentPeyStoreHost } from "./ucp-webhooks.js";

const STORE = "https://agentcommerce.vitrinee.agentpey.com";
const URL_ = "https://agentpey.com/ucp/webhooks/orders";

function p256(kid: string) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const privateJwk: EcPrivateJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
  return { kid, privateJwk, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" } };
}

const storeKey = p256("did:stellar:testnet:GSTORE#ucp-p256");
const order = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ucp: { version: "2026-08-25" }, id: "ord_1", checkout_id: "cs_1", permalink_url: `${STORE}/receipts/abc`, fulfillment: { expectations: [], events: [] }, ...overrides });

function deliver(body = order(), o: { id?: string; profile?: string; key?: ReturnType<typeof p256> } = {}) {
  const key = o.key ?? storeKey;
  const headers = signedWebhookHeaders({
    url: URL_,
    body,
    profileUrl: o.profile ?? `${STORE}/.well-known/ucp`,
    webhookId: o.id ?? "11111111-2222-4333-8444-555555555555",
    webhookTimestamp: 1_759_600_000,
    created: 1_759_600_001,
    key: { privateJwk: key.privateJwk, kid: key.kid },
  });
  return { headers, body: Buffer.from(body) };
}

function receiver(profile: unknown = { ucp: { version: "2026-08-25" }, keys: [{ kty: "OKP", crv: "Ed25519", x: "AA", kid: "x#key-1" }, storeKey.publicJwk] }) {
  const reads: string[] = [];
  return {
    reads,
    r: createOrderWebhookReceiver({
      fetchProfile: async (url) => {
        reads.push(url);
        if (profile instanceof Error) throw profile;
        return profile;
      },
      now: () => new Date("2026-10-05T12:00:00Z"),
    }),
  };
}

describe("AgentPey's order webhook receiver (T147)", () => {
  it("accepts a delivery signed by the store whose profile it names, and lists it without its body", async () => {
    const { r, reads } = receiver();
    const { headers, body } = deliver();
    expect(await r.receive(URL_, headers, body)).toEqual({ status: 200, body: { ucp: { version: "2026-08-25", status: "success" } } });
    expect(reads).toEqual([`${STORE}/.well-known/ucp`]);
    expect(r.recent()).toEqual([
      { webhookId: "11111111-2222-4333-8444-555555555555", store: STORE, orderId: "ord_1", event: "created", occurredAt: "2025-10-04T17:46:40.000Z", receivedAt: "2026-10-05T12:00:00.000Z" },
    ]);
  });

  it("names the event by the order's newest fulfillment event, and acknowledges a retry once", async () => {
    const { r } = receiver();
    const shipped = deliver(order({ fulfillment: { expectations: [], events: [{ id: "ful_1", type: "shipped" }] } }), { id: "99999999-2222-4333-8444-555555555555" });
    expect((await r.receive(URL_, shipped.headers, shipped.body)).status).toBe(200);
    expect((await r.receive(URL_, shipped.headers, shipped.body)).body).toMatchObject({ duplicate: true });
    expect(r.recent()).toEqual([expect.objectContaining({ event: "shipped" })]);
  });

  it("finds the key in a 2026-04-08 profile's signing_keys", async () => {
    const { r } = receiver({ ucp: { version: "2026-04-08" }, signing_keys: [storeKey.publicJwk] });
    const { headers, body } = deliver();
    expect((await r.receive(URL_, headers, body)).status).toBe(200);
  });

  it.each([
    ["a store AgentPey does not run", { profile: "https://evil.example/.well-known/ucp" }, 403, "UnknownStore"],
    ["a profile that is not the store's well-known one", { profile: `${STORE}/somewhere/else` }, 403, "UnknownStore"],
    ["a profile over plain http", { profile: "http://agentcommerce.vitrinee.agentpey.com/.well-known/ucp" }, 403, "UnknownStore"],
    ["a key the store does not publish", { key: p256("did:stellar:testnet:GSTORE#ucp-p256") }, 401, "SignatureInvalid"],
  ] as const)("refuses a delivery from %s", async (_label, o, status, code) => {
    const { r } = receiver();
    const { headers, body } = deliver(order(), o);
    expect(await r.receive(URL_, headers, body)).toMatchObject({ status, body: { code } });
    expect(r.recent()).toEqual([]);
  });

  it("refuses a body changed after signing, a delivery to another URL, and one without the event headers", async () => {
    const { r } = receiver();
    const { headers, body } = deliver();
    expect(await r.receive(URL_, headers, Buffer.from(order({ id: "ord_2" })))).toMatchObject({ status: 401 });
    expect(await r.receive("https://agentpey.com/ucp/webhooks/other", headers, body)).toMatchObject({ status: 401 });
    const { "webhook-id": _id, ...withoutId } = headers;
    expect(await r.receive(URL_, withoutId, body)).toMatchObject({ status: 400, body: { code: "BadHeaders" } });
  });

  it("refuses an order that belongs to another store, even signed by this one", async () => {
    const { r } = receiver();
    const { headers, body } = deliver(order({ permalink_url: "https://otra.vitrinee.agentpey.com/receipts/abc" }));
    expect(await r.receive(URL_, headers, body)).toMatchObject({ status: 403, body: { code: "NotYourOrder" } });
  });

  it("answers 503, which the store retries, when the store's profile cannot be read", async () => {
    const { r } = receiver(new Error("down"));
    const { headers, body } = deliver();
    expect(await r.receive(URL_, headers, body)).toMatchObject({ status: 503, body: { code: "ProfileUnavailable" } });
  });

  it("knows which hosts are AgentPey's stores", () => {
    expect(isAgentPeyStoreHost("agentcommerce.vitrinee.agentpey.com")).toBe(true);
    expect(isAgentPeyStoreHost("vitrinee.agentpey.com")).toBe(true);
    for (const host of ["agentpey.com", "evil.vitrinee.agentpey.com.example", "a.b.vitrinee.agentpey.com", "vitrinee.agentpey.com.evil.example", "-x.vitrinee.agentpey.com"]) {
      expect(isAgentPeyStoreHost(host), host).toBe(false);
    }
  });
});
