import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET, VitrineeError } from "@vitrinee/core";
import { beforeEach, describe, expect, it } from "vitest";

import { MemoryComercioStore, openComercioSecrets, sealComercio } from "./comercios.js";
import { onboardComercio, shopHostFrom, storeCatalogueReader, type OnboardingDeps } from "./onboarding.js";
import { createSecretBox, generateMasterKey } from "./secret-box.js";
import { testnet, type PayoutReadiness, type StellarNetwork } from "./stellar-network.js";

const CREDENTIALS = { kind: "jumpseller-api", login: "a1b2c3d4", authtoken: "tok-secret-123" } as const;

/** Records what each check was asked, so a test can prove the later ones never ran. */
class FakeStellar implements StellarNetwork {
  readiness: PayoutReadiness = "ready";
  fundError: VitrineeError | undefined;
  readonly funded: string[] = [];
  readonly asked: string[] = [];
  async payoutReadiness(account: string) {
    this.asked.push(account);
    return this.readiness;
  }
  async fund(account: string) {
    if (this.fundError !== undefined) throw this.fundError;
    this.funded.push(account);
  }
}

describe("a merchant's owner registers their store (T105, four checks before anything is saved)", () => {
  const box = createSecretBox(generateMasterKey());
  const owner = Keypair.random().publicKey();
  let comercios: MemoryComercioStore;
  let stellar: FakeStellar;
  let catalogueReads: number;
  let catalogueError: VitrineeError | undefined;
  let deps: OnboardingDeps;

  beforeEach(() => {
    comercios = new MemoryComercioStore();
    stellar = new FakeStellar();
    catalogueReads = 0;
    catalogueError = undefined;
    deps = {
      comercios,
      box,
      stellar,
      readCatalogue: async () => {
        catalogueReads += 1;
        if (catalogueError !== undefined) throw catalogueError;
        return 4;
      },
      now: () => new Date("2026-09-25T10:00:00Z"),
    };
  });

  const register = (body: Record<string, unknown> = {}) =>
    onboardComercio(owner, { name: "Tienda de Prueba", slug: "tienda-prueba", credentials: CREDENTIALS, ...body }, deps);

  async function expectNothingSaved() {
    expect(await comercios.list()).toEqual([]);
  }

  it("registers a comercio paid at the signed-in wallet, with a fresh funded signing key, secrets sealed", async () => {
    const { comercio, products } = await register();
    expect(products).toBe(4);
    expect(comercio).toMatchObject({ slug: "tienda-prueba", name: "Tienda de Prueba", payTo: owner, status: "active", platform: "jumpseller" });
    expect(stellar.funded).toEqual([comercio.signingAccount]);
    expect(comercio.signingAccount).not.toBe(owner);

    const stored = await comercios.getBySlug("tienda-prueba");
    expect(stored?.id).toBe(comercio.id);
    const row = JSON.stringify(stored);
    expect(row).not.toContain(CREDENTIALS.authtoken);
    expect(row).not.toContain(CREDENTIALS.login);
    const secrets = openComercioSecrets(stored!, box);
    expect(secrets.credentials).toEqual(CREDENTIALS);
    expect(Keypair.fromSecret(secrets.signingSecret).publicKey()).toBe(comercio.signingAccount);
  });

  it("normalises the slug to lowercase before checking it", async () => {
    const { comercio } = await register({ slug: "  Tienda-Prueba " });
    expect(comercio.slug).toBe("tienda-prueba");
  });

  describe("check 1: the slug", () => {
    it.each([
      ["with a double hyphen", "tienda--prueba"],
      ["with a dot", "tienda.prueba"],
      ["too long for AgentPey's venue id (C-145)", "a".repeat(32)],
      ["empty", ""],
    ])("refuses a slug %s, and runs no other check", async (_label, slug) => {
      await expect(register({ slug })).rejects.toMatchObject({ code: "SlugUnavailable", details: { reason: "invalid" } });
      expect(stellar.asked).toEqual([]);
      expect(catalogueReads).toBe(0);
      await expectNothingSaved();
    });

    it("refuses a slug the platform reserves", async () => {
      await expect(register({ slug: "www" })).rejects.toMatchObject({ code: "SlugUnavailable", details: { reason: "reserved" } });
      await expectNothingSaved();
    });

    it("refuses a slug that is taken, and leaves the existing comercio alone", async () => {
      const first = sealComercio({ slug: "tienda-prueba", name: "Primera", payTo: Keypair.random().publicKey(), signingSecret: Keypair.random().secret(), credentials: { kind: "mock" } }, box, new Date());
      await comercios.create(first);
      await expect(register()).rejects.toMatchObject({ code: "SlugUnavailable", details: { reason: "taken" } });
      expect(stellar.funded).toEqual([]);
      expect((await comercios.list()).map((c) => c.name)).toEqual(["Primera"]);
    });
  });

  describe("check 2: the payout account can receive testnet USDC", () => {
    it.each(["account_missing", "usdc_trustline_missing"] as const)("refuses when %s, before reading the store", async (reason) => {
      stellar.readiness = reason;
      await expect(register()).rejects.toMatchObject({ code: "PayoutAccountNotReady", details: { reason } });
      expect(stellar.asked).toEqual([owner]);
      expect(catalogueReads).toBe(0);
      expect(stellar.funded).toEqual([]);
      await expectNothingSaved();
    });
  });

  describe("check 3: the credentials read the catalogue", () => {
    it("refuses credentials the store rejects, and funds no key", async () => {
      catalogueError = new VitrineeError("StoreCredentialsRejected", "no", { details: { status: 401 } });
      await expect(register()).rejects.toMatchObject({ code: "StoreCredentialsRejected" });
      expect(stellar.funded).toEqual([]);
      await expectNothingSaved();
    });
  });

  describe("check 4: the new signing key is funded", () => {
    it("refuses when the faucet fails, and saves nothing", async () => {
      stellar.fundError = new VitrineeError("SigningKeyNotFunded", "friendbot down");
      await expect(register()).rejects.toMatchObject({ code: "SigningKeyNotFunded" });
      expect(catalogueReads).toBe(1);
      await expectNothingSaved();
    });
  });

  it("only registers Jumpseller stores unless mock stores are allowed", async () => {
    await expect(register({ credentials: { kind: "mock" } })).rejects.toMatchObject({ code: "ValidationError" });
    await expectNothingSaved();
    deps.allowMockStores = true;
    await expect(register({ credentials: { kind: "mock" } })).resolves.toMatchObject({ comercio: { platform: "mock" } });
  });

  it("refuses a body with extra or missing fields; the payout account is never taken from it", async () => {
    await expect(register({ payTo: Keypair.random().publicKey() })).rejects.toMatchObject({ code: "ValidationError" });
    await expect(onboardComercio(owner, { slug: "x", credentials: CREDENTIALS }, deps)).rejects.toMatchObject({ code: "ValidationError" });
    await expectNothingSaved();
  });
});

describe("the real catalogue check against Jumpseller's API (fake fetch)", () => {
  const jumpseller = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const product = (id: number, sku: string) => ({ product: { id, name: `P${id}`, price: 1000, sku, stock: 3, stock_unlimited: false, status: "available", variants: [], images: [] } });

  it("counts the products on sale", async () => {
    const read = storeCatalogueReader({ fetch: jumpseller(200, [product(1, "A"), product(2, "B")]) });
    await expect(read(CREDENTIALS)).resolves.toBe(2);
  });

  it.each([401, 403, 404])("turns a %s from Jumpseller into StoreCredentialsRejected", async (status) => {
    const read = storeCatalogueReader({ fetch: jumpseller(status, { message: "nope" }) });
    await expect(read(CREDENTIALS)).rejects.toMatchObject({ code: "StoreCredentialsRejected", details: { status } });
  });

  it("leaves a Jumpseller outage as an outage, not the owner's mistake", async () => {
    const read = storeCatalogueReader({ fetch: jumpseller(500, { message: "down" }) });
    await expect(read(CREDENTIALS)).rejects.toMatchObject({ code: "AdapterError" });
  });

  it("never puts the credentials in what it throws", async () => {
    const read = storeCatalogueReader({ fetch: jumpseller(401, { message: "nope" }) });
    const error = await read(CREDENTIALS).catch((e: unknown) => e);
    expect(JSON.stringify((error as VitrineeError).toJSON())).not.toContain(CREDENTIALS.authtoken);
  });
});

describe("Stellar testnet checks against Horizon and friendbot (fake fetch)", () => {
  const account = Keypair.random().publicKey();
  const usdc = { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer, balance: "0" };
  const native = { asset_type: "native", balance: "10000" };

  function horizon(routes: Record<string, () => Response>): typeof fetch {
    return async (input) => {
      const url = String(input);
      for (const [prefix, reply] of Object.entries(routes)) if (url.startsWith(prefix)) return reply();
      return new Response("not found", { status: 404 });
    };
  }
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

  it("says ready for an account with the USDC trustline", async () => {
    const net = testnet({ horizonUrl: "https://h", fetch: horizon({ [`https://h/accounts/${account}`]: json({ balances: [native, usdc] }) }) });
    await expect(net.payoutReadiness(account)).resolves.toBe("ready");
  });

  it("tells a missing account from a missing trustline", async () => {
    await expect(testnet({ horizonUrl: "https://h", fetch: horizon({}) }).payoutReadiness(account)).resolves.toBe("account_missing");
    const noTrust = testnet({ horizonUrl: "https://h", fetch: horizon({ [`https://h/accounts/${account}`]: json({ balances: [native] }) }) });
    await expect(noTrust.payoutReadiness(account)).resolves.toBe("usdc_trustline_missing");
  });

  it("does not take a USDC from another issuer for testnet USDC", async () => {
    const fake = { ...usdc, asset_issuer: Keypair.random().publicKey() };
    const net = testnet({ horizonUrl: "https://h", fetch: horizon({ [`https://h/accounts/${account}`]: json({ balances: [native, fake] }) }) });
    await expect(net.payoutReadiness(account)).resolves.toBe("usdc_trustline_missing");
  });

  it("funds a key and waits until Horizon shows it", async () => {
    let created = false;
    const net = testnet({
      horizonUrl: "https://h",
      friendbotUrl: "https://fb",
      pollDelaysMs: [1, 1],
      fetch: async (input) => {
        const url = String(input);
        if (url.startsWith("https://fb")) {
          created = true;
          return new Response("{}", { status: 200 });
        }
        return created ? new Response(JSON.stringify({ balances: [native] }), { status: 200 }) : new Response("", { status: 404 });
      },
    });
    await expect(net.fund(account)).resolves.toBeUndefined();
  });

  it("fails typed when friendbot refuses or the account never appears", async () => {
    const refused = testnet({ friendbotUrl: "https://fb", fetch: horizon({ "https://fb": json({ detail: "rate limited" }, 429) }), pollDelaysMs: [] });
    await expect(refused.fund(account)).rejects.toMatchObject({ code: "SigningKeyNotFunded", details: { status: 429 } });
    const ghost = testnet({ horizonUrl: "https://h", friendbotUrl: "https://fb", fetch: horizon({ "https://fb": json({}) }), pollDelaysMs: [1] });
    await expect(ghost.fund(account)).rejects.toMatchObject({ code: "SigningKeyNotFunded" });
  });
});

describe("a Shopify store registers the same way (T112, VT-33)", () => {
  const box = createSecretBox(generateMasterKey());
  const owner = Keypair.random().publicKey();
  const SHOPIFY = { kind: "shopify-app", shop: "mi-tienda.myshopify.com", clientId: "cid-123", clientSecret: "shpss_secret-456" } as const;

  const shopifyFetch = (tokenStatus: number, nodes: unknown[] = [], currency = "CLP"): typeof fetch =>
    (async (input: string | URL | Request) => {
      if (String(input).endsWith("/admin/oauth/access_token")) {
        return new Response(JSON.stringify(tokenStatus === 200 ? { access_token: "tok", expires_in: 86399 } : { error: "invalid_client" }), { status: tokenStatus });
      }
      return new Response(
        JSON.stringify({ data: { shop: { currencyCode: currency }, products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }),
        { status: 200 },
      );
    }) as typeof fetch;

  const sticker = {
    id: "gid://shopify/Product/1",
    title: "Stickers",
    status: "ACTIVE",
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "Default Title", sku: "STK", price: "2850.00", inventoryQuantity: 5, inventoryItem: { tracked: true } }] },
  };

  const deps = (fetch: typeof globalThis.fetch): { d: OnboardingDeps; comercios: MemoryComercioStore } => {
    const comercios = new MemoryComercioStore();
    const stellar = new FakeStellar();
    return { comercios, d: { comercios, box, stellar, readCatalogue: storeCatalogueReader({ fetch }), now: () => new Date("2026-09-27T10:00:00Z") } };
  };
  const register = (d: OnboardingDeps, credentials: Record<string, unknown> = SHOPIFY) =>
    onboardComercio(owner, { name: "Tienda Shopify", slug: "tienda-shopify", credentials }, d);

  it("registers it, counts its products and seals the client secret", async () => {
    const { d, comercios } = deps(shopifyFetch(200, [sticker]));
    const { comercio, products } = await register(d);
    expect(products).toBe(1);
    expect(comercio.platform).toBe("shopify");
    const stored = (await comercios.getBySlug("tienda-shopify"))!;
    expect(JSON.stringify(stored)).not.toContain(SHOPIFY.clientSecret);
    expect(openComercioSecrets(stored, box).credentials).toEqual(SHOPIFY);
  });

  it("normalises the pasted values", async () => {
    const { d, comercios } = deps(shopifyFetch(200, [sticker]));
    await register(d, { ...SHOPIFY, shop: "  Mi-Tienda.myshopify.com ", clientId: " cid-123 " });
    const stored = (await comercios.getBySlug("tienda-shopify"))!;
    expect(openComercioSecrets(stored, box).credentials).toEqual(SHOPIFY);
  });

  it.each([
    ["agenticom", "agenticom.myshopify.com"],
    ["  Agenticom.MyShopify.com ", "agenticom.myshopify.com"],
    ["https://agenticom.myshopify.com/", "agenticom.myshopify.com"],
    ["https://agenticom.myshopify.com/admin/products?x=1", "agenticom.myshopify.com"],
    ["https://admin.shopify.com/store/agenticom/orders/123", "agenticom.myshopify.com"],
  ])("reads the store address %j as %s", (typed, host) => {
    expect(shopHostFrom(typed)).toBe(host);
  });

  it.each(["evil.example.com", "agenticom.myshopify.com.evil.com", "https://evil.example.com/store/agenticom", ""])(
    "does not turn %j into a Shopify host",
    (typed) => {
      expect(shopHostFrom(typed)).not.toMatch(/^[a-z0-9-]+\.myshopify\.com$/);
    },
  );

  it("refuses a host that is not *.myshopify.com, and never contacts it", async () => {
    let contacted = false;
    const { d, comercios } = deps((async () => { contacted = true; return new Response("{}"); }) as typeof fetch);
    await expect(register(d, { ...SHOPIFY, shop: "evil.example.com" })).rejects.toMatchObject({ code: "ValidationError" });
    expect(contacted).toBe(false);
    expect(await comercios.list()).toEqual([]);
  });

  it.each([400, 401, 403])("turns a %s on the token exchange into StoreCredentialsRejected and saves nothing", async (status) => {
    const { d, comercios } = deps(shopifyFetch(status));
    await expect(register(d)).rejects.toMatchObject({ code: "StoreCredentialsRejected" });
    expect(await comercios.list()).toEqual([]);
  });

  it("does not blame the owner for a store that sells in another currency", async () => {
    const { d } = deps(shopifyFetch(200, [sticker], "USD"));
    await expect(register(d)).rejects.toMatchObject({ code: "AdapterError" });
  });

  it("never puts the secret in what it throws", async () => {
    const { d } = deps(shopifyFetch(400));
    const error = await register(d).catch((e: unknown) => e);
    expect(JSON.stringify((error as VitrineeError).toJSON())).not.toContain(SHOPIFY.clientSecret);
  });
});
