import { Keypair } from "@stellar/stellar-sdk";
import { isVitrineeError } from "@vitrinee/core";
import { describe, expect, it } from "vitest";

import { REGISTRY_ID } from "../test/fixtures.js";
import { MemoryComercioStore, openComercioSecrets, sealComercio, seedComercioFromEnv } from "./comercios.js";
import { comercioConfig, loadPlatformSettings, parseComercioAllowedPlatforms, parseComercioBlockedPayers, parseComercioEscrows, parseComercioPayerLimits, parseComercioRequireAp2 } from "./config.js";
import { createSecretBox, generateMasterKey } from "./secret-box.js";

const now = new Date("2026-09-24T12:00:00.000Z");
const MERCHANT_LIKE = "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN";
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
      {
        RECEIPT_REGISTRY_ID: REGISTRY_ID,
        MERCHANT_STELLAR_ACCOUNT: Keypair.random().publicKey(),
        MERCHANT_SIGNING_SECRET: Keypair.random().secret(),
        PUBLIC_BASE_URL: "https://vitrinee.agentpey.com",
        ADAPTER: "jumpseller",
        // One store's escrow (T159): set on the platform, it must reach no store.
        ESCROW_CONTRACT_ID: "CCTVYTWFGOBD23UF7A2AX6CMCKF7ACHENU6YNFJPG6S3O5P3FBKCYLDO",
      },
      comercio,
      openComercioSecrets(comercio, box),
    );
    expect(config.merchant.stellarAccount).toBe(comercio.payTo);
    expect(config.signing.account).toBe(signer.publicKey());
    expect(config.adapter).toBe("mock");
    expect(config.publicBaseUrl).toBeUndefined();
    expect(config.escrowId).toBeUndefined();
  });
});

describe("COMERCIO_ESCROWS: the platform gives one store its escrow (T160)", () => {
  const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
  const OTHER = "CCTVYTWFGOBD23UF7A2AX6CMCKF7ACHENU6YNFJPG6S3O5P3FBKCYLDO";
  const comercio = (slug: string) => sealComercio({ slug, name: slug, payTo: Keypair.random().publicKey(), signingSecret: Keypair.random().secret(), credentials: { kind: "mock" } }, box, now);

  it("reads slug=contract pairs, and nothing when unset", () => {
    expect(parseComercioEscrows(` agentcommerce=${ESCROW} , bazar=${OTHER}`)).toEqual(new Map([["agentcommerce", ESCROW], ["bazar", OTHER]]));
    expect(parseComercioEscrows(undefined).size).toBe(0);
    expect(parseComercioEscrows(" ").size).toBe(0);
  });

  it("refuses a malformed pair, a repeated store, and one escrow for two stores (X-11)", async () => {
    for (const value of [`agentcommerce:${ESCROW}`, `agentcommerce=${MERCHANT_LIKE}`, `Agent Commerce=${ESCROW}`, `a=${ESCROW}=x`, `a=${ESCROW},a=${OTHER}`, `a=${ESCROW},b=${ESCROW}`]) {
      expect(await code(() => parseComercioEscrows(value)), value).toBe("ConfigError");
    }
  });

  it("is checked when the platform starts", async () => {
    const env = { DATABASE_URL: "postgres://x", MASTER_KEY: generateMasterKey() };
    expect(loadPlatformSettings({ ...env, COMERCIO_ESCROWS: `agentcommerce=${ESCROW}` })?.escrows.get("agentcommerce")).toBe(ESCROW);
    expect(await code(() => loadPlatformSettings({ ...env, COMERCIO_ESCROWS: "agentcommerce" }))).toBe("ConfigError");
  });

  it("reaches the listed store alone, and never through ESCROW_CONTRACT_ID", () => {
    const env = { RECEIPT_REGISTRY_ID: REGISTRY_ID, COMERCIO_ESCROWS: `agentcommerce=${ESCROW}`, ESCROW_CONTRACT_ID: OTHER };
    const listed = comercio("agentcommerce");
    expect(comercioConfig(env, listed, openComercioSecrets(listed, box)).escrowId).toBe(ESCROW);
    const other = comercio("bazar");
    expect(comercioConfig(env, other, openComercioSecrets(other, box)).escrowId).toBeUndefined();
  });
});

describe("COMERCIO_BLOCKED_PAYERS and COMERCIO_PAYER_LIMITS: the platform brakes who may pay one store (T172, VT-49)", () => {
  const A = "GD7O7GEOP4Y3YG4JHSGOH5FOBZGLZUZWRMADELTRNPC3IYYQ4H7CINQ7";
  const B = "GAEGOVJ264EJ3I2S7EHP64N4BMYVUYGQWFOLBU7XHQEDR75J63OYGKQS";
  const comercio = (slug: string) => sealComercio({ slug, name: slug, payTo: Keypair.random().publicKey(), signingSecret: Keypair.random().secret(), credentials: { kind: "mock" } }, box, now);
  const configOf = (env: Record<string, string>, slug: string) => {
    const c = comercio(slug);
    return comercioConfig({ RECEIPT_REGISTRY_ID: REGISTRY_ID, ...env }, c, openComercioSecrets(c, box));
  };

  it("read each store's blocked accounts, and nothing when unset", () => {
    expect(parseComercioBlockedPayers(` agentcommerce=${A}, ${B} ; mycokit=${B} `)).toEqual(new Map([["agentcommerce", [A, B]], ["mycokit", [B]]]));
    expect(parseComercioBlockedPayers(undefined).size).toBe(0);
    expect(parseComercioBlockedPayers(" ").size).toBe(0);
  });

  it("refuse a malformed entry, a repeated store and a bad account", async () => {
    for (const value of [`agentcommerce:${A}`, `agentcommerce=not-an-account`, `Agent Commerce=${A}`, `a=${A}=x`, `a=${A};a=${B}`, `=${A}`]) {
      expect(await code(() => parseComercioBlockedPayers(value)), value).toBe("ConfigError");
    }
  });

  it("read limits per store, with * for the rest", () => {
    expect(parseComercioPayerLimits("*=10/3600, agentcommerce=3/3600")).toEqual(new Map([["*", "10/3600"], ["agentcommerce", "3/3600"]]));
    expect(parseComercioPayerLimits(undefined).size).toBe(0);
  });

  it("refuse a malformed limit, a repeated store and a zero", async () => {
    for (const value of ["agentcommerce", "agentcommerce=3", "agentcommerce=0/60", "agentcommerce=3/0", "Agent Commerce=3/60", "a=3/60,a=4/60", "a=3/60=x"]) {
      expect(await code(() => parseComercioPayerLimits(value)), value).toBe("ConfigError");
    }
  });

  it("are checked when the platform starts, so a typo stops it there", async () => {
    const env = { DATABASE_URL: "postgres://x", MASTER_KEY: generateMasterKey() };
    expect(loadPlatformSettings({ ...env, COMERCIO_BLOCKED_PAYERS: `agentcommerce=${A}`, COMERCIO_PAYER_LIMITS: "*=3/3600" })).toBeDefined();
    expect(await code(() => loadPlatformSettings({ ...env, COMERCIO_BLOCKED_PAYERS: "agentcommerce" }))).toBe("ConfigError");
    expect(await code(() => loadPlatformSettings({ ...env, COMERCIO_PAYER_LIMITS: "agentcommerce=lots" }))).toBe("ConfigError");
  });

  it("reach the listed store alone, and never through BLOCKED_PAYERS or PAYER_LIMIT", () => {
    const env = { COMERCIO_BLOCKED_PAYERS: `agentcommerce=${A}`, COMERCIO_PAYER_LIMITS: "*=10/3600,agentcommerce=3/3600", BLOCKED_PAYERS: B, PAYER_LIMIT: "1/60" };
    expect(configOf(env, "agentcommerce").payerGuard).toEqual({ blocked: [A], limit: { max: 3, windowSeconds: 3_600 } });
    // Another store: not blocked, and the `*` limit; the single-store variables are not inherited.
    expect(configOf(env, "bazar").payerGuard).toEqual({ blocked: [], limit: { max: 10, windowSeconds: 3_600 } });
  });

  it("leave a store alone when nothing names it", () => {
    expect(configOf({}, "agentcommerce").payerGuard).toEqual({ blocked: [], limit: undefined });
  });
});

describe("COMERCIO_ALLOWED_PLATFORMS and COMERCIO_REQUIRE_AP2: the platform names who may open a checkout (T172, VT-49)", () => {
  const comercio = (slug: string) => sealComercio({ slug, name: slug, payTo: Keypair.random().publicKey(), signingSecret: Keypair.random().secret(), credentials: { kind: "mock" } }, box, now);
  const configOf = (env: Record<string, string>, slug: string) => {
    const c = comercio(slug);
    return comercioConfig({ RECEIPT_REGISTRY_ID: REGISTRY_ID, ...env }, c, openComercioSecrets(c, box));
  };

  it("read each store's platforms by origin, and nothing when unset", () => {
    expect(parseComercioAllowedPlatforms("agentcommerce=https://agentpey.com/x/p.json, https://a.example ; mycokit=https://b.example")).toEqual(
      new Map([["agentcommerce", ["https://agentpey.com", "https://a.example"]], ["mycokit", ["https://b.example"]]]),
    );
    expect(parseComercioAllowedPlatforms(undefined).size).toBe(0);
  });

  it("refuse a malformed entry, a repeated store and a URL that is not https", async () => {
    for (const value of ["agentcommerce:https://a.example", "agentcommerce=http://a.example", "Agent Commerce=https://a.example", "a=https://a.example;a=https://b.example", "a=https://a.example=x"]) {
      expect(await code(() => parseComercioAllowedPlatforms(value)), value).toBe("ConfigError");
    }
  });

  it("read the stores that require AP2, or * for all", () => {
    expect(parseComercioRequireAp2("agentcommerce, mycokit")).toEqual({ all: false, slugs: new Set(["agentcommerce", "mycokit"]) });
    expect(parseComercioRequireAp2("*").all).toBe(true);
    expect(parseComercioRequireAp2(undefined)).toEqual({ all: false, slugs: new Set() });
  });

  it("refuse anything that is neither a slug nor *", async () => {
    expect(await code(() => parseComercioRequireAp2("Agent Commerce"))).toBe("ConfigError");
  });

  it("are checked when the platform starts", async () => {
    const env = { DATABASE_URL: "postgres://x", MASTER_KEY: generateMasterKey() };
    expect(loadPlatformSettings({ ...env, COMERCIO_ALLOWED_PLATFORMS: "agentcommerce=https://agentpey.com", COMERCIO_REQUIRE_AP2: "agentcommerce" })).toBeDefined();
    expect(await code(() => loadPlatformSettings({ ...env, COMERCIO_ALLOWED_PLATFORMS: "agentcommerce=agentpey.com" }))).toBe("ConfigError");
    expect(await code(() => loadPlatformSettings({ ...env, COMERCIO_REQUIRE_AP2: "Agent Commerce" }))).toBe("ConfigError");
  });

  it("reach the listed store alone, and never through ALLOWED_PLATFORMS or REQUIRE_AP2", () => {
    const env = { COMERCIO_ALLOWED_PLATFORMS: "agentcommerce=https://agentpey.com", COMERCIO_REQUIRE_AP2: "agentcommerce", ALLOWED_PLATFORMS: "https://x.example", REQUIRE_AP2: "true" };
    expect(configOf(env, "agentcommerce").platformPolicy).toEqual({ requireAp2: true, allowedPlatforms: ["https://agentpey.com"] });
    expect(configOf(env, "bazar").platformPolicy).toEqual({ requireAp2: false, allowedPlatforms: [] });
  });

  it("require AP2 at every store with *", () => {
    expect(configOf({ COMERCIO_REQUIRE_AP2: "*" }, "bazar").platformPolicy.requireAp2).toBe(true);
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
