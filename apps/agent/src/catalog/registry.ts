/**
 * The venue/asset registry — the data F7 turns "add a merchant" into.
 *
 * Before this, `bazaar.ts` hardcoded one venue's identity and its single
 * recognised asset (`mapAsset`, `mapAssetContract`) directly in code: adding
 * a second x402 merchant meant writing a new file shaped just like it. This
 * module replaces that with a single validated table — one row per venue,
 * each row naming the asset codes and issuer/contract addresses that venue
 * is allowed to quote. `x402.ts`'s generic adapter reads this table instead
 * of asking a per-venue function; `bazaar.ts` becomes one row in it.
 *
 * **Fail-closed is the whole point, not a detail.** An asset code or
 * contract address a venue's row does not name refuses with `InvalidProduct`
 * — same error, same reasoning `mapAsset` already used: a fabricated issuer
 * could quietly authorise the wrong asset, which is worse than refusing the
 * product outright. That discipline now lives in one place instead of one
 * copy per venue file, so it cannot drift between them.
 */
import { AgentPassError } from "@agentpass/core";
import { z } from "zod";

import { assetIdSchema, makeAssetId, makeVenueId, venueIdSchema, type AssetId, type VenueId } from "./ids.js";

/** `<slug>:<contract id>`, split the same way {@link makeVenueId} validates them. */
const venueSlugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase slug: letters, digits and single hyphens");

/** 1–12 alphanumeric characters — same rule `ids.ts` enforces on an asset code. */
const assetCodeSchema = z.string().regex(/^[A-Za-z0-9]{1,12}$/, "expected a 1-12 character Stellar asset code");

/** One asset a venue is allowed to quote: the bare code plus its issuer or SAC contract. */
export const registryAssetSchema = z.strictObject({
  code: assetCodeSchema,
  /** A classic account (`G...`) or a Soroban token contract (`C...`) — `ids.ts` accepts either. */
  issuer: z.string(),
});

/** One venue's row: its identity, where to reach it, and every asset it may quote. */
export const registryVenueSchema = z.strictObject({
  slug: venueSlugSchema,
  /**
   * The venue's on-chain identity: a Soroban contract (`C...`) or the classic
   * account it is paid at (`G...`). Validated by `parseVenueId`, not here —
   * one definition of what a venue id is, in `ids.ts`.
   */
  address: z.string(),
  /**
   * Present for a venue `x402.ts`'s generic adapter can fetch over HTTP.
   * Absent for a venue registered only so its assets resolve (e.g. one whose
   * catalogue is read some other way) — {@link venueCatalogs} skips those.
   */
  baseUrl: z.url().optional(),
  assets: z.array(registryAssetSchema).min(1),
});

export type RegistryVenueRow = z.infer<typeof registryVenueSchema>;

/**
 * A platform of many merchants (T104, `C-141`): AgentPey trusts the platform,
 * not each merchant. The row fixes where the platform lives, where its public
 * directory of merchants is, and every asset its merchants may quote. The
 * directory can add merchants; it can never add an asset, move a merchant off
 * the platform's host, or pay anyone by itself (see `platforms.ts`).
 */
export const registryPlatformSchema = z.strictObject({
  kind: z.literal("platform"),
  slug: venueSlugSchema,
  /** `vitrinee.agentpey.com`: each merchant's store is exactly `https://<merchant>.<host>`. */
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/, "a lowercase hostname, no scheme, port or path"),
  directoryUrl: z.url(),
  assets: z.array(registryAssetSchema).min(1),
});

export type RegistryPlatformRow = z.infer<typeof registryPlatformSchema>;

/** The whole registry file: every venue's and platform's row, in no particular order. */
export const venueRegistrySchema = z.array(z.union([registryVenueSchema, registryPlatformSchema]));

/** One venue, resolved: its `VenueId`, its base URL if it has one, and both ways to look up an asset. */
export interface ResolvedVenue {
  readonly venueId: VenueId;
  readonly baseUrl: string | undefined;
  readonly byCode: ReadonlyMap<string, AssetId>;
  readonly byIssuer: ReadonlyMap<string, AssetId>;
  /**
   * Set only for a merchant of a platform (`platforms.ts`): the one account a
   * payment to this venue may go to, the one in its venue id. A challenge that
   * names another payee is refused before anything is signed, whatever the
   * Mandate says.
   */
  readonly payTo?: string;
}

/** A platform row, resolved: where it lives, where its directory is, and the only assets its merchants may quote. */
export interface ResolvedPlatform {
  readonly slug: string;
  readonly host: string;
  readonly directoryUrl: string;
  readonly byCode: ReadonlyMap<string, AssetId>;
  readonly byIssuer: ReadonlyMap<string, AssetId>;
}

/** A validated, ready-to-query registry. Build one with {@link loadVenueRegistry}. */
export interface VenueRegistry {
  readonly venues: ReadonlyMap<VenueId, ResolvedVenue>;
  /**
   * Platforms whose merchants become venues only once `platforms.ts` has read
   * their directory. Absent in a registry built by hand, which is the same as
   * having none.
   */
  readonly platforms?: ReadonlyMap<string, ResolvedPlatform>;
}

function invalidRegistry(message: string, details?: Record<string, unknown>): AgentPassError {
  return new AgentPassError("InvalidVenueRegistry", message, { details });
}

/**
 * Validates and indexes a raw registry (parsed JSON, typically). Every row is
 * checked against {@link venueRegistrySchema}; a duplicate venue id or a
 * venue with two rows for the same asset code or issuer is refused rather
 * than silently keeping the last one — an ambiguous table is exactly the
 * kind of thing that must not resolve to a guess.
 *
 * @throws AgentPassError `InvalidVenueRegistry` on a malformed row, a
 * duplicate venue, or a duplicate asset code/issuer within one venue.
 */
export function loadVenueRegistry(raw: unknown): VenueRegistry {
  const parsed = venueRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidRegistry("the venue registry does not match the expected schema", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const venues = new Map<VenueId, ResolvedVenue>();
  const platforms = new Map<string, ResolvedPlatform>();

  for (const row of parsed.data) {
    if ("kind" in row) {
      if (platforms.has(row.slug)) {
        throw invalidRegistry(`the registry names platform "${row.slug}" more than once`, { platform: row.slug });
      }
      const { byCode, byIssuer } = indexAssets(`platform "${row.slug}"`, row.assets);
      platforms.set(row.slug, { slug: row.slug, host: row.host, directoryUrl: row.directoryUrl, byCode, byIssuer });
      continue;
    }
    const venueId = venueIdSchema.parse(makeVenueId(row.slug, row.address));
    if (venues.has(venueId)) {
      throw invalidRegistry(`the registry names venue "${venueId}" more than once`, { venueId });
    }

    const { byCode, byIssuer } = indexAssets(`venue "${venueId}"`, row.assets);
    venues.set(venueId, { venueId, baseUrl: row.baseUrl, byCode, byIssuer });
  }

  // A platform slug is the prefix of every venue it produces (`platforms.ts`),
  // so a fixed venue under that prefix would be ambiguous: whose is it?
  for (const venueId of venues.keys()) {
    for (const slug of platforms.keys()) {
      if (venueId.startsWith(`${slug}-`) || venueId.startsWith(`${slug}:`)) {
        throw invalidRegistry(`venue "${venueId}" uses the slug of platform "${slug}"`, { venueId, platform: slug });
      }
    }
  }

  return { venues: Object.freeze(venues), platforms: Object.freeze(platforms) };
}

function indexAssets(
  owner: string,
  assets: readonly { code: string; issuer: string }[],
): { byCode: Map<string, AssetId>; byIssuer: Map<string, AssetId> } {
  const byCode = new Map<string, AssetId>();
  const byIssuer = new Map<string, AssetId>();
  for (const asset of assets) {
    const assetId = assetIdSchema.parse(makeAssetId(asset.code, asset.issuer));
    if (byCode.has(asset.code)) {
      throw invalidRegistry(`${owner} names asset code "${asset.code}" more than once`, { owner, code: asset.code });
    }
    if (byIssuer.has(asset.issuer)) {
      throw invalidRegistry(`${owner} names issuer "${asset.issuer}" more than once`, { owner, issuer: asset.issuer });
    }
    byCode.set(asset.code, assetId);
    byIssuer.set(asset.issuer, assetId);
  }
  return { byCode, byIssuer };
}

function requireVenue(registry: VenueRegistry, venueId: VenueId): ResolvedVenue {
  const venue = registry.venues.get(venueId);
  if (venue === undefined) {
    throw new AgentPassError("InvalidProduct", `no registry entry for venue "${venueId}"`, { details: { venueId } });
  }
  return venue;
}

/**
 * Resolves a venue's own asset code (what a discovery catalogue quotes,
 * e.g. `"USDC"`) to the {@link AssetId} it names — the generic sibling of
 * `bazaar.ts`'s old, venue-specific `mapAsset`.
 *
 * @throws AgentPassError `InvalidProduct` for a venue the registry does not
 * have, or an asset code that venue's row does not list.
 */
export function mapAssetCodeForVenue(registry: VenueRegistry, venueId: VenueId, code: string): AssetId {
  const venue = requireVenue(registry, venueId);
  const assetId = venue.byCode.get(code);
  if (assetId === undefined) {
    throw new AgentPassError(
      "InvalidProduct",
      `venue "${venueId}" quoted an asset code its registry entry has no issuer for: "${code}"`,
      { details: { assetCode: code, venueId } },
    );
  }
  return assetId;
}

/**
 * Resolves a live payment challenge's issuer or SAC contract address to the
 * {@link AssetId} it names — the generic sibling of `bazaar.ts`'s old
 * `mapAssetContract`.
 *
 * @throws AgentPassError `InvalidProduct` for a venue the registry does not
 * have, or an issuer/contract that venue's row does not list.
 */
export function mapAssetIssuerForVenue(registry: VenueRegistry, venueId: VenueId, issuer: string): AssetId {
  const venue = requireVenue(registry, venueId);
  const assetId = venue.byIssuer.get(issuer);
  if (assetId === undefined) {
    throw new AgentPassError(
      "InvalidProduct",
      `venue "${venueId}" named an asset contract its registry entry does not recognise: "${issuer}"`,
      { details: { assetContract: issuer, venueId } },
    );
  }
  return assetId;
}

/** A venue's `baseUrl`, for a caller that needs to fetch its catalogue — `undefined` for a venue with none. */
export function baseUrlForVenue(registry: VenueRegistry, venueId: VenueId): string | undefined {
  return requireVenue(registry, venueId).baseUrl;
}
