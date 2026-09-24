/**
 * Merchants of a platform, read from its public directory (T104, `C-141`).
 *
 * AgentPey trusts a platform (one row in `venues.json`, `registry.ts`), not
 * each of its merchants. This module reads the platform's directory and turns
 * every merchant in it into an ordinary venue of the registry, so every
 * function downstream (`baseUrlForVenue`, `mapAssetCodeForVenue`,
 * `createX402Catalog`…) keeps failing closed exactly as it did for a fixed row.
 *
 * What the directory can and cannot do, which is the whole point:
 *
 * - **It can add a merchant.** That merchant becomes payable only by a Mandate
 *   a person signed that names it; appearing here pays nobody.
 * - **It cannot choose the merchant's URL.** The store is `https://<slug>.<host>`,
 *   built here from the platform row; a directory entry naming any other URL
 *   is dropped. (`http` only for a `localhost` platform, for local runs.)
 * - **It cannot add an asset.** Every merchant gets the platform row's assets,
 *   never anything the directory says.
 * - **It cannot take a fixed venue's place.** A merchant's venue id is
 *   `<platform>-<merchant>:<payout account>`, a prefix no fixed row may use
 *   (`loadVenueRegistry` refuses it), and an id already in the registry wins.
 *
 * If the directory cannot be read, the platform contributes no merchants:
 * paying them is refused, not guessed.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { makeVenueId, parseVenueId, type VenueId } from "./ids.js";
import type { ResolvedPlatform, ResolvedVenue, VenueRegistry } from "./registry.js";

/** How long one directory answer is reused. Short: a new merchant should appear within a minute. */
export const DEFAULT_DIRECTORY_TTL_MS = 30_000;

const directoryEntrySchema = z.object({
  slug: z.string(),
  name: z.string().optional(),
  url: z.string(),
  payTo: z.string(),
});

const directorySchema = z.object({ comercios: z.array(z.unknown()) });

export interface PlatformExpansionOptions {
  readonly fetchImpl?: typeof fetch;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Called for a directory that could not be read, or an entry that was dropped. Never throws. */
  readonly onIssue?: (platform: string, issue: string, details?: Record<string, unknown>) => void;
  /**
   * When given, only a platform whose merchants could be this venue is read.
   * An unknown venue outside every platform then costs no network call at all.
   */
  readonly onlyFor?: string;
}

interface CachedDirectory {
  readonly at: number;
  readonly entries: readonly unknown[];
}

// Per `fetch` implementation, so a test's fake never sees another test's answers.
const caches = new WeakMap<typeof fetch, Map<string, CachedDirectory>>();

function storeUrl(platform: ResolvedPlatform, slug: string): string {
  const scheme = platform.host === "localhost" ? "http" : "https";
  return `${scheme}://${slug}.${platform.host}`;
}

async function readDirectory(platform: ResolvedPlatform, options: PlatformExpansionOptions): Promise<readonly unknown[] | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cache = caches.get(fetchImpl);
  if (cache === undefined) {
    cache = new Map();
    caches.set(fetchImpl, cache);
  }
  const hit = cache.get(platform.directoryUrl);
  if (hit !== undefined && now() - hit.at < (options.ttlMs ?? DEFAULT_DIRECTORY_TTL_MS)) return hit.entries;

  try {
    const response = await fetchImpl(platform.directoryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) {
      options.onIssue?.(platform.slug, "directory answered with a non-2xx status", { status: response.status });
      return undefined;
    }
    const parsed = directorySchema.safeParse(await response.json());
    if (!parsed.success) {
      options.onIssue?.(platform.slug, "directory answered with an unexpected shape");
      return undefined;
    }
    cache.set(platform.directoryUrl, { at: now(), entries: parsed.data.comercios });
    return parsed.data.comercios;
  } catch (error) {
    options.onIssue?.(platform.slug, "directory could not be reached", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/** The venue a directory entry becomes, or the reason it is dropped. */
function toVenue(platform: ResolvedPlatform, raw: unknown): { venue: ResolvedVenue } | { dropped: string; details: Record<string, unknown> } {
  const entry = directoryEntrySchema.safeParse(raw);
  if (!entry.success) return { dropped: "malformed entry", details: {} };
  const { slug, url, payTo } = entry.data;
  if (!StrKey.isValidEd25519PublicKey(payTo)) return { dropped: "payout account is not a Stellar account", details: { slug } };
  let venueId: VenueId;
  try {
    venueId = parseVenueId(makeVenueId(`${platform.slug}-${slug}`, payTo)).venueId;
  } catch {
    return { dropped: "slug does not make a valid venue id", details: { slug } };
  }
  const expected = storeUrl(platform, slug);
  if (url.replace(/\/+$/, "") !== expected) {
    return { dropped: "store URL is not the platform's own subdomain for this merchant", details: { slug, url, expected } };
  }
  return { venue: { venueId, baseUrl: expected, byCode: platform.byCode, byIssuer: platform.byIssuer, payTo } };
}

/**
 * The registry with every platform's current merchants added as venues.
 * Fixed rows are never replaced. The input registry is not modified.
 */
export async function expandPlatformVenues(registry: VenueRegistry, options: PlatformExpansionOptions = {}): Promise<VenueRegistry> {
  const platforms = [...(registry.platforms?.values() ?? [])].filter(
    (platform) => options.onlyFor === undefined || options.onlyFor.startsWith(`${platform.slug}-`),
  );
  if (platforms.length === 0) return registry;

  const venues = new Map(registry.venues);
  for (const platform of platforms) {
    const entries = await readDirectory(platform, options);
    if (entries === undefined) continue;
    for (const raw of entries) {
      const result = toVenue(platform, raw);
      if ("dropped" in result) {
        options.onIssue?.(platform.slug, `directory entry dropped: ${result.dropped}`, result.details);
        continue;
      }
      if (venues.has(result.venue.venueId)) {
        options.onIssue?.(platform.slug, "directory entry dropped: venue already registered", { venueId: result.venue.venueId });
        continue;
      }
      venues.set(result.venue.venueId, result.venue);
    }
  }
  return { venues: Object.freeze(venues), ...(registry.platforms === undefined ? {} : { platforms: registry.platforms }) };
}
