/**
 * A merchant (comercio) of the Vitrinee platform, and where they are kept
 * (C-140, VT-27).
 *
 * A comercio is the business that registers; its **tienda** is its store on a
 * platform (Jumpseller today). One comercio has exactly one tienda for now.
 * Its receipt-signing key and its store credentials are only ever held
 * sealed: {@link sealComercio} takes them in clear once and hands back a
 * record with neither in it, and {@link openComercioSecrets} is the one way
 * back.
 */
import { randomBytes } from "node:crypto";

import { Keypair } from "@stellar/stellar-sdk";
import { VitrineeError, countryCodeSchema, currencyCodeSchema, stellarAccountSchema } from "@vitrinee/core";
import { z } from "zod";

import { isComercioSlug } from "./hosts.js";
import type { SecretBox } from "./secret-box.js";

/**
 * The credentials of a merchant's store. A tagged union from day one, so the
 * OAuth app that replaces pasted API credentials after the 29th (VT-28) is one
 * more member, not a change to every reader.
 */
export const storeCredentialsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("jumpseller-api"), login: z.string().min(1), authtoken: z.string().min(1) }),
  z.strictObject({ kind: z.literal("mock") }),
]);
export type StoreCredentials = z.infer<typeof storeCredentialsSchema>;

export const comercioSchema = z.strictObject({
  id: z.string().regex(/^com_[a-z0-9]+$/),
  slug: z.string().refine(isComercioSlug, "lowercase letters, digits and single hyphens, at most 31 (C-145)"),
  name: z.string().min(1).max(120),
  /** Where the merchant is paid. Their own account, from their own wallet (VT-4, VT-19). */
  payTo: stellarAccountSchema,
  /** The public half of the key Vitrinee holds for them (VT-8, VT-27). */
  signingAccount: stellarAccountSchema,
  platform: z.enum(["jumpseller", "mock"]),
  status: z.enum(["active", "disabled"]),
  country: countryCodeSchema,
  currency: currencyCodeSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  sealedSigningSecret: z.string().min(1),
  sealedCredentials: z.string().min(1),
});
export type Comercio = z.infer<typeof comercioSchema>;

export interface ComercioSecrets {
  signingSecret: string;
  credentials: StoreCredentials;
}

export interface ComercioStore {
  /** @throws VitrineeError `ComercioConflict` when the slug or id is taken. */
  create(comercio: Comercio): Promise<void>;
  getBySlug(slug: string): Promise<Comercio | undefined>;
  list(): Promise<Comercio[]>;
}

export interface NewComercio {
  slug: string;
  name: string;
  payTo: string;
  signingSecret: string;
  credentials: StoreCredentials;
  country?: string;
  currency?: string;
}

const signingContext = (id: string) => `${id}:signing`;
const credentialsContext = (id: string) => `${id}:credentials`;

export function newComercioId(now: Date): string {
  return `com_${now.getTime().toString(36)}${randomBytes(5).toString("hex")}`;
}

/**
 * Builds a comercio record from what an owner (or the seed) supplied in clear,
 * sealing both secrets. Refuses a signing key equal to the payout account
 * (VT-8): the key Vitrinee holds must never be one that moves the merchant's
 * funds.
 */
export function sealComercio(input: NewComercio, box: SecretBox, now: Date, id = newComercioId(now)): Comercio {
  let signingAccount: string;
  try {
    signingAccount = Keypair.fromSecret(input.signingSecret).publicKey();
  } catch {
    throw new VitrineeError("ValidationError", "the signing key is not a Stellar secret seed");
  }
  if (signingAccount === input.payTo) {
    throw new VitrineeError("ValidationError", "the signing key must not be the payout account's key (VT-8)");
  }
  const credentials = storeCredentialsSchema.parse(input.credentials);
  const at = now.toISOString();
  const parsed = comercioSchema.safeParse({
    id,
    slug: input.slug,
    name: input.name,
    payTo: input.payTo,
    signingAccount,
    platform: credentials.kind === "mock" ? "mock" : "jumpseller",
    status: "active",
    country: input.country ?? "CL",
    currency: input.currency ?? "CLP",
    createdAt: at,
    updatedAt: at,
    sealedSigningSecret: box.seal(input.signingSecret, signingContext(id)),
    sealedCredentials: box.seal(JSON.stringify(credentials), credentialsContext(id)),
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new VitrineeError("ValidationError", `invalid comercio: ${problems.join("; ")}`, { details: { problems } });
  }
  return parsed.data;
}

/** The only way a comercio's secrets leave their sealed form. Never put the result in a response or a log. */
export function openComercioSecrets(comercio: Comercio, box: SecretBox): ComercioSecrets {
  const signingSecret = box.open(comercio.sealedSigningSecret, signingContext(comercio.id));
  const raw = box.open(comercio.sealedCredentials, credentialsContext(comercio.id));
  const credentials = storeCredentialsSchema.safeParse(JSON.parse(raw));
  if (!credentials.success) {
    throw new VitrineeError("SecretUnreadable", "a comercio's store credentials opened to an unknown shape", { details: { comercio: comercio.id } });
  }
  return { signingSecret, credentials: credentials.data };
}

/** For tests and local runs without Postgres. */
export class MemoryComercioStore implements ComercioStore {
  private readonly bySlug = new Map<string, Comercio>();

  async create(comercio: Comercio): Promise<void> {
    const parsed = comercioSchema.parse(comercio);
    if (this.bySlug.has(parsed.slug) || [...this.bySlug.values()].some((c) => c.id === parsed.id)) {
      throw new VitrineeError("ComercioConflict", `a comercio with slug "${parsed.slug}" already exists`, { details: { slug: parsed.slug } });
    }
    this.bySlug.set(parsed.slug, structuredClone(parsed));
  }

  async getBySlug(slug: string): Promise<Comercio | undefined> {
    const found = this.bySlug.get(slug);
    return found === undefined ? undefined : structuredClone(found);
  }

  async list(): Promise<Comercio[]> {
    return [...this.bySlug.values()].map((c) => structuredClone(c)).sort((a, b) => a.slug.localeCompare(b.slug));
  }
}

export const DEFAULT_SEED_SLUG = "bazar-cordillera";

/**
 * Registers the single store the gateway ran before T103 as the platform's
 * first comercio, from the same variables it already had (`MERCHANT_*`,
 * `ADAPTER`, `JUMPSELLER_*`). Same payout account, same signing key, so every
 * receipt it already issued keeps verifying. Idempotent by slug: an existing
 * comercio is returned untouched, never overwritten from the environment.
 *
 * Returns `undefined` when the environment names no store to seed.
 */
export async function seedComercioFromEnv(
  env: NodeJS.ProcessEnv,
  store: ComercioStore,
  box: SecretBox,
  now: Date,
): Promise<{ comercio: Comercio; created: boolean } | undefined> {
  const payTo = env["MERCHANT_STELLAR_ACCOUNT"];
  const signingSecret = env["MERCHANT_SIGNING_SECRET"];
  if (payTo === undefined || payTo === "" || signingSecret === undefined || signingSecret === "") return undefined;
  const slug = env["SEED_COMERCIO_SLUG"] || DEFAULT_SEED_SLUG;
  const existing = await store.getBySlug(slug);
  if (existing !== undefined) return { comercio: existing, created: false };

  const adapter = env["ADAPTER"] || "mock";
  let credentials: StoreCredentials;
  if (adapter === "jumpseller") {
    const login = env["JUMPSELLER_LOGIN"];
    const authtoken = env["JUMPSELLER_AUTHTOKEN"];
    if (!login || !authtoken) throw new VitrineeError("ConfigError", "seeding a jumpseller comercio needs JUMPSELLER_LOGIN and JUMPSELLER_AUTHTOKEN");
    credentials = { kind: "jumpseller-api", login, authtoken };
  } else if (adapter === "mock") {
    credentials = { kind: "mock" };
  } else {
    throw new VitrineeError("ConfigError", `unknown ADAPTER "${adapter}" for the seed comercio`);
  }
  const comercio = sealComercio(
    {
      slug,
      name: env["MERCHANT_NAME"] || "Bazar Cordillera",
      payTo,
      signingSecret,
      credentials,
      ...(env["MERCHANT_COUNTRY"] ? { country: env["MERCHANT_COUNTRY"] } : {}),
      ...(env["MERCHANT_CURRENCY"] ? { currency: env["MERCHANT_CURRENCY"] } : {}),
    },
    box,
    now,
  );
  await store.create(comercio);
  return { comercio, created: true };
}
