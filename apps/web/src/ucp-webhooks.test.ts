import { createHash, generateKeyPairSync } from "node:crypto";

import { signedWebhookHeaders, type EcPrivateJwk } from "@vitrinee/core";
import { describe, expect, it } from "vitest";

import { createOrderWebhookReceiver, isAgentPeyStoreHost } from "./ucp-webhooks.js";

const STORE = "https://agentcommerce.vitrinee.agentpey.com";
const URL_ = "https://agentpey.com/ucp/webhooks/orders";
const NOW = new Date("2026-10-05T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function p256(kid: string) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const privateJwk: EcPrivateJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
  return { kid, privateJwk, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" } };
}

const storeKey = p256("did:stellar:testnet:GSTORE#ucp-p256");
const ap2Key = p256("did:stellar:testnet:GSTORE#ap2-p256");
const order = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ucp: { version: "2026-08-25" }, id: "ord_1", checkout_id: "cs_1", permalink_url: `${STORE}/receipts/abc`, fulfillment: { expectations: [], events: [] }, ...overrides });

function deliver(body = order(), o: { id?: string; profile?: string; key?: ReturnType<typeof p256>; created?: number } = {}) {
  const key = o.key ?? storeKey;
  const headers = signedWebhookHeaders({
    url: URL_,
    body,
    profileUrl: o.profile ?? `${STORE}/.well-known/ucp`,
    webhookId: o.id ?? "11111111-2222-4333-8444-555555555555",
    webhookTimestamp: NOW_S - 60,
    created: o.created ?? NOW_S - 1,
    key: { privateJwk: key.privateJwk, kid: key.kid },
  });
  return { headers, body: Buffer.from(body) };
}

const PROFILE = { ucp: { version: "2026-08-25" }, keys: [{ kty: "OKP", crv: "Ed25519", x: "AA", kid: "x#key-1" }, ap2Key.publicJwk, storeKey.publicJwk] };

function receiver(profile: unknown = PROFILE, clock: { now: Date } = { now: NOW }) {
  const reads: string[] = [];
  return {
    reads,
    r: createOrderWebhookReceiver({
      fetchProfile: async (url) => {
        reads.push(url);
        if (profile instanceof Error) throw profile;
        return profile;
      },
      now: () => clock.now,
    }),
  };
}

describe("AgentPey's order webhook receiver (T147)", () => {
  it("accepts a delivery signed by the store whose profile it names, and lists it without the body or the order id", async () => {
    const { r, reads } = receiver();
    const { headers, body } = deliver();
    expect(await r.receive(URL_, headers, body)).toEqual({ status: 200, body: { ucp: { version: "2026-08-25", status: "success" } } });
    expect(reads).toEqual([`${STORE}/.well-known/ucp`]);
    expect(r.recent()).toEqual([
      {
        webhookId: "11111111-2222-4333-8444-555555555555",
        store: STORE,
        orderRef: createHash("sha256").update("ord_1").digest("hex").slice(0, 16),
        event: "created",
        occurredAt: new Date((NOW_S - 60) * 1000).toISOString(),
        receivedAt: NOW.toISOString(),
      },
    ]);
    expect(JSON.stringify(r.recent())).not.toContain("ord_1");
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
    ["the store's AP2 key, which signs checkouts and never webhooks", { key: ap2Key }, 401, "SignatureInvalid"],
    ["a signature made more than five minutes ago", { created: NOW_S - 301 }, 401, "SignatureStale"],
  ] as const)("refuses a delivery from %s", async (_label, o, status, code) => {
    const { r } = receiver();
    const { headers, body } = deliver(order(), o);
    expect(await r.receive(URL_, headers, body)).toMatchObject({ status, body: { code } });
    expect(r.recent()).toEqual([]);
  });

  it("refuses a body changed after signing, a delivery to another URL, one without the event headers, and one whose signature leaves its id uncovered", async () => {
    const { r } = receiver();
    const { headers, body } = deliver();
    expect(await r.receive(URL_, headers, Buffer.from(order({ id: "ord_2" })))).toMatchObject({ status: 401 });
    expect(await r.receive("https://agentpey.com/ucp/webhooks/other", headers, body)).toMatchObject({ status: 401 });
    const withoutId = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "webhook-id"));
    expect(await r.receive(URL_, withoutId, body)).toMatchObject({ status: 400, body: { code: "BadHeaders" } });
    const uncovered = { ...headers, "signature-input": headers["signature-input"]!.replace(' "webhook-id"', "") };
    expect(await r.receive(URL_, uncovered, body)).toMatchObject({ status: 401, body: { code: "SignatureInvalid" } });
  });

  it("refuses an order that belongs to another store, even signed by this one, and a body that is not an order", async () => {
    const { r } = receiver();
    const other = deliver(order({ permalink_url: "https://otra.vitrinee.agentpey.com/receipts/abc" }));
    expect(await r.receive(URL_, other.headers, other.body)).toMatchObject({ status: 403, body: { code: "NotYourOrder" } });
    const notAnOrder = deliver(JSON.stringify({ hello: "world" }), { id: "22222222-2222-4333-8444-555555555555" });
    expect(await r.receive(URL_, notAnOrder.headers, notAnOrder.body)).toMatchObject({ status: 400, body: { code: "BadBody" } });
  });

  it("answers 503, which the store retries, when the store's profile cannot be read, and does not ask again for a minute", async () => {
    const clock = { now: NOW };
    const { r, reads } = receiver(new Error("down"), clock);
    const { headers, body } = deliver();
    expect(await r.receive(URL_, headers, body)).toMatchObject({ status: 503, body: { code: "ProfileUnavailable" } });
    expect(await r.receive(URL_, headers, body)).toMatchObject({ status: 503 });
    expect(reads).toHaveLength(1);
    clock.now = new Date(NOW.getTime() + 61_000);
    await r.receive(URL_, headers, body);
    expect(reads).toHaveLength(2);
  });

  it("reads profiles within a budget: a flood of unsigned posts naming made-up stores costs a few reads, not one each", async () => {
    const { r, reads } = receiver(new Error("no such store"));
    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const { headers, body } = deliver(order(), { profile: `https://made-up-${i}.vitrinee.agentpey.com/.well-known/ucp`, id: `33333333-2222-4333-8444-${String(i).padStart(12, "0")}` });
        return r.receive(URL_, headers, body);
      }),
    );
    expect(answers.every((a) => a.status === 503)).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(10);
  });

  it("reads one profile once for deliveries arriving together, and accepts one copy of the same delivery", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: string[] = [];
    const r = createOrderWebhookReceiver({
      fetchProfile: async (url) => {
        reads.push(url);
        await gate;
        return PROFILE;
      },
      now: () => NOW,
    });
    const a = deliver(order(), { id: "44444444-2222-4333-8444-555555555555" });
    const b = deliver(order(), { id: "55555555-2222-4333-8444-555555555555" });
    const pending = [r.receive(URL_, a.headers, a.body), r.receive(URL_, b.headers, b.body), r.receive(URL_, a.headers, a.body)];
    release();
    const [first, second, copy] = await Promise.all(pending);
    expect(reads).toHaveLength(1);
    expect([first?.status, second?.status]).toEqual([200, 200]);
    expect(copy).toMatchObject({ status: 503, body: { code: "InProgress" } });
    expect(r.recent()).toHaveLength(2);
  });

  it("knows which hosts are AgentPey's stores", () => {
    expect(isAgentPeyStoreHost("agentcommerce.vitrinee.agentpey.com")).toBe(true);
    expect(isAgentPeyStoreHost("vitrinee.agentpey.com")).toBe(true);
    for (const host of ["agentpey.com", "evil.vitrinee.agentpey.com.example", "a.b.vitrinee.agentpey.com", "vitrinee.agentpey.com.evil.example", "-x.vitrinee.agentpey.com"]) {
      expect(isAgentPeyStoreHost(host), host).toBe(false);
    }
  });
});
