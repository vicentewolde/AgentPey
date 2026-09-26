import { Keypair } from "@stellar/stellar-sdk";
import { isVitrineeError } from "@vitrinee/core";
import { describe, expect, it } from "vitest";

import { REGISTRY_ID } from "../test/fixtures.js";
import { MemoryComercioStore, openComercioSecrets, sealComercio, seedComercioFromEnv } from "./comercios.js";
import { comercioConfig, loadPlatformSettings } from "./config.js";
import { createSecretBox, generateMasterKey } from "./secret-box.js";

const now = new Date("2026-09-24T12:00:00.000Z");
const box = createSecretBox(generateMasterKey());

async function code(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (error) {
    return isVitrineeError(error) ? error.code : "untyped";
  }
  return undefined;
}

describe("a comercio's secrets (VT-27)", () => {
  const payTo = Keypair.random().publicKey();
  const signer = Keypair.random();

  it("are kept only sealed, and open back to what was given", () => {
    const comercio = sealComercio(
      { slug: "bazar", name: "Bazar", payTo, signingSecret: signer.secret(), credentials: { kind: "jumpseller-api", login: "lg", authtoken: "tk-123" } },
      box,
      now,
    );
    expect(JSON.stringify(comercio)).not.toContain(signer.secret());
    expect(JSON.stringify(comercio)).not.toContain("tk-123");
    expect(comercio.signingAccount).toBe(signer.publicKey());
    expect(openComercioSecrets(comercio, box)).toEqual({ signingSecret: signer.secret(), credentials: { kind: "jumpseller-api", login: "lg", authtoken: "tk-123" } });
  });

  it("refuses a signing key that is the payout account's key (VT-8)", async () => {
    expect(await code(() => sealComercio({ slug: "x", name: "X", payTo: signer.publicKey(), signingSecret: signer.secret(), credentials: { kind: "mock" } }, box, now))).toBe("ValidationError");
  });

  it("refuses a malformed slug or payout account", async () => {
    expect(await code(() => sealComercio({ slug: "Bad Slug", name: "X", payTo, signingSecret: signer.secret(), credentials: { kind: "mock" } }, box, now))).toBe("ValidationError");
    expect(await code(() => sealComercio({ slug: "ok", name: "X", payTo: "GNOPE", signingSecret: signer.secret(), credentials: { kind: "mock" } }, box, now))).toBe("ValidationError");
  });

  it("cannot be registered twice under the same slug", async () => {
    const store = new MemoryComercioStore();
    const mk = () => sealComercio({ slug: "bazar", name: "Bazar", payTo, signingSecret: signer.secret(), credentials: { kind: "mock" } }, box, now);
    await store.create(mk());
    expect(await code(store.create(mk()))).toBe("ComercioConflict");
  });
});

describe("seeding the pre-T103 store as the first comercio", () => {
  const signer = Keypair.random();
  const env = {
    ADAPTER: "jumpseller",
    MERCHANT_NAME: "Bazar Cordillera",
    MERCHANT_STELLAR_ACCOUNT: Keypair.random().publicKey(),
    MERCHANT_SIGNING_SECRET: signer.secret(),
    JUMPSELLER_LOGIN: "login",
    JUMPSELLER_AUTHTOKEN: "token",
  };

  it("registers it once, with the same payout account and signing key, and never overwrites it", async () => {
    const store = new MemoryComercioStore();
    const first = await seedComercioFromEnv(env, store, box, now);
    expect(first).toMatchObject({ created: true, comercio: { slug: "bazar-cordillera", payTo: env.MERCHANT_STELLAR_ACCOUNT, signingAccount: signer.publicKey(), platform: "jumpseller" } });
    const again = await seedComercioFromEnv({ ...env, MERCHANT_NAME: "Otro nombre" }, store, box, now);
    expect(again).toMatchObject({ created: false, comercio: { name: "Bazar Cordillera" } });
    expect(await store.list()).toHaveLength(1);
  });

  it("does nothing when the environment names no store", async () => {
    expect(await seedComercioFromEnv({}, new MemoryComercioStore(), box, now)).toBeUndefined();
  });
});

describe("platform settings", () => {
  it("runs the single-store gateway when neither platform variable is set", () => {
    expect(loadPlatformSettings({})).toBeUndefined();
  });

  it("refuses half a platform configuration", async () => {
    expect(await code(() => loadPlatformSettings({ DATABASE_URL: "postgres://x" }))).toBe("ConfigError");
    expect(await code(() => loadPlatformSettings({ MASTER_KEY: generateMasterKey() }))).toBe("ConfigError");
  });

  it("derives the platform host from the public URL when not given", () => {
    expect(loadPlatformSettings({ DATABASE_URL: "postgres://x", MASTER_KEY: "k", PUBLIC_BASE_URL: "https://vitrinee.agentpey.com" })?.platformHost).toBe("vitrinee.agentpey.com");
  });

  it("gives each comercio its own merchant values over the platform's, never the platform's merchant values", () => {
    const signer = Keypair.random();
    const comercio = sealComercio({ slug: "b", name: "B", payTo: Keypair.random().publicKey(), signingSecret: signer.secret(), credentials: { kind: "mock" } }, box, now);
    const config = comercioConfig(
      { RECEIPT_REGISTRY_ID: REGISTRY_ID, MERCHANT_STELLAR_ACCOUNT: Keypair.random().publicKey(), MERCHANT_SIGNING_SECRET: Keypair.random().secret(), PUBLIC_BASE_URL: "https://vitrinee.agentpey.com", ADAPTER: "jumpseller" },
      comercio,
      openComercioSecrets(comercio, box),
    );
    expect(config.merchant.stellarAccount).toBe(comercio.payTo);
    expect(config.signing.account).toBe(signer.publicKey());
    expect(config.adapter).toBe("mock");
    expect(config.publicBaseUrl).toBeUndefined();
  });
});

describe("a Shopify comercio (T112)", () => {
  const shopify = { kind: "shopify-app", shop: "s.myshopify.com", clientId: "c", clientSecret: "x" } as const;

  it("reaches the gateway's config with its own variables", () => {
    const comercio = sealComercio({ slug: "shop", name: "Shop", payTo: Keypair.random().publicKey(), signingSecret: Keypair.random().secret(), credentials: shopify }, box, now);
    expect(comercio.platform).toBe("shopify");
    const config = comercioConfig({ RECEIPT_REGISTRY_ID: REGISTRY_ID }, comercio, openComercioSecrets(comercio, box));
    expect(config.adapter).toBe("shopify");
    expect(config.shopify).toEqual({ shop: "s.myshopify.com", clientId: "c", clientSecret: "x" });
  });

  it("does not accept a shop host outside myshopify.com", async () => {
    expect(await code(() => sealComercio({ slug: "shop", name: "Shop", payTo: Keypair.random().publicKey(), signingSecret: Keypair.random().secret(), credentials: { ...shopify, shop: "evil.example.com" } }, box, now))).toBeDefined();
  });
});
