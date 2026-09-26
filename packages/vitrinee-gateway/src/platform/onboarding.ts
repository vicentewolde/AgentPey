/**
 * A merchant's owner registers their store on the portal, with no code
 * (T105, C-144, VT-27, VT-28, VT-29).
 *
 * Four checks run before anything is saved, cheapest first, and each one
 * refuses with its own code so the portal can say exactly what to fix:
 *
 * 1. The slug is well formed, not reserved and free (`SlugUnavailable`).
 * 2. The payout account, which is the wallet the owner signed in with, exists
 *    and trusts testnet USDC (`PayoutAccountNotReady`); without the trustline
 *    the first payment would fail.
 * 3. The store credentials read the store's catalogue
 *    (`StoreCredentialsRejected`).
 * 4. A fresh receipt-signing key is generated and funded with friendbot's XLM,
 *    so it can pay for its own anchors (`SigningKeyNotFunded`).
 *
 * Only then is the comercio sealed and written. If any check fails, nothing is
 * written. The credentials are taken in as "store credentials" whatever their
 * shape (VT-28): the OAuth app after the 29th is one more member of
 * {@link StoreCredentials} and one more branch in {@link storeCatalogueReader}.
 */
import { JumpsellerStoreAdapter, ShopifyStoreAdapter } from "@vitrinee/adapters";
import { Keypair } from "@stellar/stellar-sdk";
import { VitrineeError, isVitrineeError } from "@vitrinee/core";
import { z } from "zod";

import { sealComercio, storeCredentialsSchema, type Comercio, type ComercioStore, type StoreCredentials } from "./comercios.js";
import { COMERCIO_SLUG_MAX, isComercioSlug } from "./hosts.js";
import type { SecretBox } from "./secret-box.js";
import type { StellarNetwork } from "./stellar-network.js";

/**
 * Labels that would read as part of the platform rather than a merchant, at
 * `<label>.vitrinee.agentpey.com`. Refused as slugs.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "app",
  "admin",
  "portal",
  "dashboard",
  "static",
  "assets",
  "mail",
  "status",
  "vitrinee",
  "agentpey",
  "realops",
  "signaldesk",
  "help",
  "support",
]);

/** What the owner types in. The payout account is not here: it is the signed-in wallet (VT-29). */
export const onboardingRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().max(64),
  credentials: storeCredentialsSchema,
});
export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;

/** Reads the store's catalogue with the credentials; resolves to how many products are on sale. */
export type CatalogueReader = (credentials: StoreCredentials) => Promise<number>;

export interface OnboardingDeps {
  comercios: ComercioStore;
  box: SecretBox;
  stellar: StellarNetwork;
  readCatalogue: CatalogueReader;
  /** Whether a `mock` store may be registered. Local runs and tests only; never in production. */
  allowMockStores?: boolean;
  now?: () => Date;
  newSigningKey?: () => Keypair;
}

export interface OnboardingResult {
  comercio: Comercio;
  products: number;
}

/** Pasted from a web page: stray spaces are the likeliest typo, and the Shopify host is case-insensitive. */
function trimmed(credentials: StoreCredentials): StoreCredentials {
  switch (credentials.kind) {
    case "jumpseller-api":
      return { ...credentials, login: credentials.login.trim(), authtoken: credentials.authtoken.trim() };
    case "shopify-app":
      return {
        ...credentials,
        shop: credentials.shop.trim().toLowerCase(),
        clientId: credentials.clientId.trim(),
        clientSecret: credentials.clientSecret.trim(),
      };
    case "mock":
      return credentials;
  }
}

/** The Shopify host is checked by the schema, so its stray spaces and capitals have to go before that check. */
function normaliseShop(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const credentials = (input as { credentials?: unknown }).credentials;
  if (credentials === null || typeof credentials !== "object") return input;
  const shop = (credentials as { kind?: unknown; shop?: unknown }).shop;
  if ((credentials as { kind?: unknown }).kind !== "shopify-app" || typeof shop !== "string") return input;
  return { ...input, credentials: { ...credentials, shop: shop.trim().toLowerCase() } };
}

export function slugProblem(slug: string): "invalid" | "reserved" | undefined {
  if (!isComercioSlug(slug)) return "invalid";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return undefined;
}

/** @throws VitrineeError with the code of the first check that fails; nothing is written in that case. */
export async function onboardComercio(payTo: string, input: unknown, deps: OnboardingDeps): Promise<OnboardingResult> {
  const parsed = onboardingRequestSchema.safeParse(normaliseShop(input));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new VitrineeError("ValidationError", `invalid registration: ${problems.join("; ")}`, { details: { problems } });
  }
  const request = parsed.data;
  // Pasted from a web page: stray spaces are the likeliest typo. What is tested is what is saved.
  const credentials: StoreCredentials = trimmed(request.credentials);
  if (credentials.kind === "jumpseller-api" && (credentials.login === "" || credentials.authtoken === "")) {
    throw new VitrineeError("ValidationError", "the Jumpseller login and API token are both required");
  }
  if (credentials.kind === "shopify-app" && (credentials.shop === "" || credentials.clientId === "" || credentials.clientSecret === "")) {
    throw new VitrineeError("ValidationError", "the Shopify store address, client id and client secret are all required");
  }
  if (credentials.kind === "mock" && deps.allowMockStores !== true) {
    throw new VitrineeError("ValidationError", "this platform only registers Jumpseller and Shopify stores");
  }

  // 1. The slug.
  const problem = slugProblem(request.slug);
  if (problem === "invalid") {
    throw new VitrineeError("SlugUnavailable", `use lowercase letters, digits and single hyphens, at most ${COMERCIO_SLUG_MAX} characters`, {
      details: { slug: request.slug, reason: "invalid" },
    });
  }
  if (problem === "reserved") {
    throw new VitrineeError("SlugUnavailable", `"${request.slug}" is reserved by the platform`, { details: { slug: request.slug, reason: "reserved" } });
  }
  if ((await deps.comercios.getBySlug(request.slug)) !== undefined) {
    throw new VitrineeError("SlugUnavailable", `"${request.slug}" is already taken`, { details: { slug: request.slug, reason: "taken" } });
  }

  // 2. The payout account can receive testnet USDC.
  const readiness = await deps.stellar.payoutReadiness(payTo);
  if (readiness !== "ready") {
    throw new VitrineeError(
      "PayoutAccountNotReady",
      readiness === "account_missing"
        ? "your wallet's account does not exist on Stellar testnet yet; fund it first"
        : "your wallet's account has no trustline to testnet USDC; add USDC in your wallet first",
      { details: { account: payTo, reason: readiness } },
    );
  }

  // 3. The credentials read the catalogue.
  const products = await deps.readCatalogue(credentials);

  // 4. A fresh signing key, funded.
  const signer = deps.newSigningKey?.() ?? Keypair.random();
  await deps.stellar.fund(signer.publicKey());

  const comercio = sealComercio(
    { slug: request.slug, name: request.name, payTo, signingSecret: signer.secret(), credentials },
    deps.box,
    (deps.now ?? (() => new Date()))(),
  );
  try {
    await deps.comercios.create(comercio);
  } catch (error) {
    // Someone took the slug between check 1 and here.
    if (isVitrineeError(error) && error.code === "ComercioConflict") {
      throw new VitrineeError("SlugUnavailable", `"${request.slug}" is already taken`, { details: { slug: request.slug, reason: "taken" } });
    }
    throw error;
  }
  return { comercio, products };
}

/**
 * The real catalogue check. A refusal from the store (401, 403, 404) means the
 * credentials are wrong; anything else (Jumpseller down, a timeout) is not the
 * owner's fault and surfaces as `AdapterError`, so they can simply retry.
 */
export function storeCatalogueReader(options: { fetch?: typeof globalThis.fetch } = {}): CatalogueReader {
  return async (credentials) => {
    switch (credentials.kind) {
      case "mock":
        return 0;
      case "shopify-app": {
        const adapter = new ShopifyStoreAdapter({
          credentials: { shop: credentials.shop, clientId: credentials.clientId, clientSecret: credentials.clientSecret },
          currency: "CLP",
          timeoutMs: 15_000,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        try {
          return (await adapter.listProducts()).length;
        } catch (error) {
          // The adapter says whether Shopify refused the app (wrong id or secret, app and store in
          // different organizations, a missing permission); a currency mismatch or an outage is not that.
          if (isVitrineeError(error) && error.details["credentialsRejected"] === true) {
            throw new VitrineeError("StoreCredentialsRejected", error.message, { details: { status: error.details["status"] ?? 403 } });
          }
          throw error;
        }
      }
      case "jumpseller-api": {
        const adapter = new JumpsellerStoreAdapter({
          credentials: { login: credentials.login, authtoken: credentials.authtoken },
          currency: "CLP",
          timeoutMs: 15_000,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        try {
          return (await adapter.listProducts()).length;
        } catch (error) {
          const status = isVitrineeError(error) ? error.details["status"] : undefined;
          if (typeof status === "number" && [401, 403, 404].includes(status)) {
            throw new VitrineeError("StoreCredentialsRejected", "Jumpseller did not accept this login and API token", { details: { status } });
          }
          throw error;
        }
      }
    }
  };
}
