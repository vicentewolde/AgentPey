import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

import { signStellarMessage } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { MANIFEST_PATH, VitrineeError } from "@vitrinee/core";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrderPersistence, OrderRecord } from "../orders.js";
import { fakeFacilitator } from "../test/fake-facilitator.js";
import { REGISTRY_ID, fakeRegistry } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { MemoryComercioStore, sealComercio, type Comercio } from "./comercios.js";
import type { StellarNetwork } from "./stellar-network.js";
import { createPlatformApp } from "./platform-app.js";
import { createSecretBox, generateMasterKey } from "./secret-box.js";
import { StorefrontPool } from "./storefronts.js";
import { WalletSessions } from "./wallet-session.js";

const PLATFORM = "vitrinee.test";
const PORTAL_ORIGIN = `http://${PLATFORM}`;
const ENV = { RECEIPT_REGISTRY_ID: REGISTRY_ID, FX_RATE_CLP_USD: "950" };

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  body: unknown;
}

/** `fetch` will not set `Host`; the platform routes on nothing else. */
function call(base: string, host: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const url = new URL(path, base);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: { host, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let body: unknown = null;
          try {
            body = raw === "" ? null : JSON.parse(raw);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: raw, body });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

class Table {
  readonly rows = new Map<string, { comercioId: string; record: OrderRecord }>();
  for(comercio: Comercio): OrderPersistence {
    return {
      load: async () => [...this.rows.values()].filter((r) => r.comercioId === comercio.id).map((r) => structuredClone(r.record)),
      save: async (order) => {
        this.rows.set(order.orderId, { comercioId: comercio.id, record: structuredClone(order) });
      },
    };
  }
}

class FakeStellar implements StellarNetwork {
  readonly ready = new Set<string>();
  readonly funded: string[] = [];
  async payoutReadiness(account: string) {
    return this.ready.has(account) ? ("ready" as const) : ("usdc_trustline_missing" as const);
  }
  async fund(account: string) {
    this.funded.push(account);
  }
}

describe("the owners' portal: sign in with the wallet, register a store, see its orders (T105)", () => {
  const box = createSecretBox(generateMasterKey());
  const comercios = new MemoryComercioStore();
  const table = new Table();
  const stellar = new FakeStellar();
  const now = new Date("2026-09-25T12:00:00.000Z");
  const owner = Keypair.random();
  const stranger = Keypair.random();
  const JUMPSELLER = { kind: "jumpseller-api", login: "store-login", authtoken: "store-token-do-not-leak" } as const;
  let catalogueAccepts = true;

  let base = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    stellar.ready.add(owner.publicKey());
    stellar.ready.add(stranger.publicKey());
    // A comercio of someone else, with an order, that the owner must never see.
    const theirs = sealComercio({ slug: "ajena", name: "Tienda Ajena", payTo: stranger.publicKey(), signingSecret: Keypair.random().secret(), credentials: { kind: "mock" } }, box, now);
    await comercios.create(theirs);

    const pool = new StorefrontPool({
      comercios,
      box,
      env: ENV,
      ordersFor: (c) => table.for(c),
      appDeps: () => {
        const registry = fakeRegistry();
        return { facilitator: fakeFacilitator(), anchorer: registry.anchorer, registry: registry.registry, anchorRetryDelaysMs: [5], now: () => now };
      },
    });

    const app = createPlatformApp({
      platformHost: PLATFORM,
      pool,
      comercios,
      rootComercio: undefined,
      portal: {
        sessions: new WalletSessions({ sessionKey: randomBytes(32) }),
        ordersFor: (c) => table.for(c),
        onboarding: {
          box,
          stellar,
          allowMockStores: true,
          readCatalogue: async (credentials) => {
            if (credentials.kind === "jumpseller-api" && !catalogueAccepts) {
              throw new VitrineeError("StoreCredentialsRejected", "no", { details: { status: 401 } });
            }
            return 6;
          },
          now: () => now,
        },
      },
    });
    ({ url: base, close } = await listen(app));
  });
  afterAll(() => close());

  async function signIn(wallet: Keypair): Promise<string> {
    const challenge = await call(base, PLATFORM, "/api/portal/challenge", { method: "POST", body: { account: wallet.publicKey() } });
    expect(challenge.status).toBe(200);
    const { nonce, message } = challenge.body as { nonce: string; message: string };
    const session = await call(base, PLATFORM, "/api/portal/session", {
      method: "POST",
      body: { account: wallet.publicKey(), nonce, signature: signStellarMessage(wallet, message) },
    });
    expect(session.status).toBe(200);
    const setCookie = session.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "";
    expect(cookie).not.toMatch(/domain=/i);
    return cookie.split(";")[0]!;
  }

  it("serves the portal page on the platform host only", async () => {
    const page = await call(base, PLATFORM, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.text).toContain("Connect Freighter");
    // The pilot's copy never uses the em dash (U+2014).
    expect(page.text).not.toContain("\u2014");
    // A store's subdomain is not the portal.
    expect((await call(base, "ajena.vitrinee.test", "/api/portal/me")).status).toBe(404);
  });

  it("lets nobody in without a valid wallet signature", async () => {
    expect((await call(base, PLATFORM, "/api/portal/me")).body).toMatchObject({ error: "SessionRequired" });
    const challenge = await call(base, PLATFORM, "/api/portal/challenge", { method: "POST", body: { account: owner.publicKey() } });
    const { nonce, message } = challenge.body as { nonce: string; message: string };
    const forged = await call(base, PLATFORM, "/api/portal/session", {
      method: "POST",
      body: { account: owner.publicKey(), nonce, signature: signStellarMessage(stranger, message) },
    });
    expect(forged.status).toBe(401);
    expect(forged.body).toMatchObject({ error: "WalletProofInvalid" });
    expect(forged.headers["set-cookie"]).toBeUndefined();
    expect((await call(base, PLATFORM, "/api/portal/me", { headers: { cookie: "vitrinee_portal=made.up" } })).status).toBe(401);
  });

  it("refuses a sign-in or a registration posted from another origin", async () => {
    const r = await call(base, PLATFORM, "/api/portal/challenge", { method: "POST", body: { account: owner.publicKey() }, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(401);
    const cookie = await signIn(owner);
    const reg = await call(base, PLATFORM, "/api/portal/comercios", {
      method: "POST",
      body: { name: "X", slug: "desde-afuera", credentials: JUMPSELLER },
      headers: { cookie, origin: "http://ajena.vitrinee.test" },
    });
    expect(reg.status).toBe(401);
    expect(await comercios.getBySlug("desde-afuera")).toBeUndefined();
  });

  it("registers a store for the signed-in wallet and publishes it in the directory, with no secret in any answer", async () => {
    const cookie = await signIn(owner);
    const reg = await call(base, PLATFORM, "/api/portal/comercios", {
      method: "POST",
      body: { name: "Tienda de Prueba", slug: "tienda-prueba", credentials: JUMPSELLER },
      headers: { cookie, origin: PORTAL_ORIGIN },
    });
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ products: 6, comercio: { slug: "tienda-prueba", payTo: owner.publicKey(), storeUrl: "http://tienda-prueba.vitrinee.test", status: "active" } });
    expect(reg.text).not.toContain(JUMPSELLER.authtoken);
    expect(reg.text).not.toContain(JUMPSELLER.login);
    expect(reg.text).not.toContain("v1:");

    const directory = await call(base, PLATFORM, "/api/comercios");
    expect((directory.body as { comercios: { slug: string; payTo: string }[] }).comercios).toContainEqual(
      expect.objectContaining({ slug: "tienda-prueba", payTo: owner.publicKey() }),
    );
    expect(directory.text).not.toContain(JUMPSELLER.authtoken);

    const me = await call(base, PLATFORM, "/api/portal/me", { headers: { cookie } });
    expect(me.text).not.toContain(JUMPSELLER.authtoken);
    expect(me.text).not.toContain(JUMPSELLER.login);
  });

  it("refuses a slug that is taken and a wallet without the USDC trustline, saving nothing", async () => {
    const cookie = await signIn(owner);
    const taken = await call(base, PLATFORM, "/api/portal/comercios", {
      method: "POST",
      body: { name: "Otra", slug: "ajena", credentials: JUMPSELLER },
      headers: { cookie, origin: PORTAL_ORIGIN },
    });
    expect(taken.body).toMatchObject({ error: "SlugUnavailable", details: { reason: "taken" } });

    const noTrust = Keypair.random();
    const fresh = await signIn(noTrust);
    const refused = await call(base, PLATFORM, "/api/portal/comercios", {
      method: "POST",
      body: { name: "Sin USDC", slug: "sin-usdc", credentials: JUMPSELLER },
      headers: { cookie: fresh, origin: PORTAL_ORIGIN },
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: "PayoutAccountNotReady", details: { reason: "usdc_trustline_missing" } });
    expect(await comercios.getBySlug("sin-usdc")).toBeUndefined();
  });

  it("refuses credentials the store rejects, saving nothing and funding nothing", async () => {
    const cookie = await signIn(owner);
    const fundedBefore = stellar.funded.length;
    catalogueAccepts = false;
    try {
      const r = await call(base, PLATFORM, "/api/portal/comercios", {
        method: "POST",
        body: { name: "Mala", slug: "credenciales-malas", credentials: JUMPSELLER },
        headers: { cookie, origin: PORTAL_ORIGIN },
      });
      expect(r.body).toMatchObject({ error: "StoreCredentialsRejected" });
    } finally {
      catalogueAccepts = true;
    }
    expect(stellar.funded.length).toBe(fundedBefore);
    expect(await comercios.getBySlug("credenciales-malas")).toBeUndefined();
  });

  it("answers whether a slug is free, for the form", async () => {
    const cookie = await signIn(owner);
    expect((await call(base, PLATFORM, "/api/portal/slugs/ajena", { headers: { cookie } })).body).toEqual({ slug: "ajena", available: false, reason: "taken" });
    expect((await call(base, PLATFORM, "/api/portal/slugs/www", { headers: { cookie } })).body).toEqual({ slug: "www", available: false, reason: "reserved" });
    expect((await call(base, PLATFORM, "/api/portal/slugs/libre-aun", { headers: { cookie } })).body).toEqual({ slug: "libre-aun", available: true });
  });

  it("shows the owner their own store's orders with a receipt link, and never another merchant's", async () => {
    // A mock store sells the fixtures' products; register one and buy from it.
    const cookie = await signIn(owner);
    const reg = await call(base, PLATFORM, "/api/portal/comercios", {
      method: "POST",
      body: { name: "Tienda Mock", slug: "tienda-mock", credentials: { kind: "mock" } },
      headers: { cookie, origin: PORTAL_ORIGIN },
    });
    expect(reg.status).toBe(201);

    const buy = async (host: string) => {
      const path = "/checkout/stickers-cordillera";
      const body = { quantity: 1, buyer: { stellarAccount: Keypair.random().publicKey(), shipping: { name: "Test", address: "Calle 1", city: "Santiago", region: "RM", country: "CL" } } };
      const challenge = await call(base, host, path, { method: "POST", body });
      expect(challenge.status).toBe(402);
      const required = decodePaymentRequiredHeader(challenge.headers["payment-required"] as string);
      const payment = encodePaymentSignatureHeader({
        x402Version: required.x402Version,
        resource: required.resource,
        accepted: required.accepts[0]!,
        payload: { transaction: Buffer.from(`fake-tx-${Math.random()}`).toString("base64") },
      });
      const paid = await call(base, host, path, { method: "POST", body, headers: { "payment-signature": payment } });
      expect(paid.status).toBe(200);
      return (paid.body as { orderId: string }).orderId;
    };
    // The new store answers at its subdomain, charging to the owner's wallet.
    const manifest = await call(base, "tienda-mock.vitrinee.test", MANIFEST_PATH);
    expect(manifest.body).toMatchObject({ merchant: { stellarAccount: owner.publicKey() } });
    const mine = await buy("tienda-mock.vitrinee.test");
    const theirs = await buy("ajena.vitrinee.test");

    const me = await call(base, PLATFORM, "/api/portal/me", { headers: { cookie } });
    const body = me.body as { account: string; comercios: { slug: string; orders: { orderId: string; receiptUrl: string | null; status: string }[] }[] };
    expect(body.account).toBe(owner.publicKey());
    expect(body.comercios.map((c) => c.slug).sort()).toEqual(["tienda-mock", "tienda-prueba"]);
    const orders = body.comercios.flatMap((c) => c.orders);
    expect(orders.map((o) => o.orderId)).toEqual([mine]);
    expect(orders[0]).toMatchObject({ status: "paid" });
    expect(orders[0]?.receiptUrl).toMatch(/^http:\/\/tienda-mock\.vitrinee\.test\/receipts\/[0-9a-f]{64}$/);
    expect(me.text).not.toContain(theirs);
    expect(me.text).not.toContain("ajena");
  });

  it("signs out", async () => {
    const cookie = await signIn(owner);
    const out = await call(base, PLATFORM, "/api/portal/logout", { method: "POST", body: {}, headers: { cookie, origin: PORTAL_ORIGIN } });
    const cleared = out.headers["set-cookie"];
    expect(String(cleared)).toContain("Max-Age=0");
  });
});
