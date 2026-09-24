/**
 * The stores of the Vitrinee platform, read from its public directory (T104,
 * `C-141`).
 *
 * RealOps is a partner of AgentPey, not part of it, so it reads the same public
 * directory AgentPey reads and builds each store's venue id the same way:
 * `vitrinee-<slug>:<payout account>`. It keeps the same narrow rules, so a store
 * RealOps offers is one AgentPey would accept: the store lives at exactly
 * `https://<slug>.<platform host>`, its payout account is a classic account,
 * and anything else in the directory is skipped. None of this authorises a
 * payment: AgentPey decides at purchase time, against the signed Mandate.
 */
import { AgentPassError } from "@agentpass/core";
import { z } from "zod";

import { createBazaarCatalog, type BazaarCatalog } from "./bazaar-catalog.js";

export interface Storefront {
  readonly slug: string;
  readonly name: string;
  /** `vitrinee-<slug>:<payTo>`: what AgentPey calls this store once its directory names it. */
  readonly venueId: string;
  readonly payTo: string;
  readonly baseUrl: string;
  /** The store's own `ServiceCard` feed, the same reader the bazaar uses. */
  readonly catalog: BazaarCatalog;
}

export interface StorefrontDirectory {
  /** @throws AgentPassError `NetworkError` when the directory cannot be read. */
  list(): Promise<readonly Storefront[]>;
  get(slug: string): Promise<Storefront | undefined>;
}

export interface StorefrontDirectoryOptions {
  readonly directoryUrl: string;
  readonly platformHost: string;
  /** The platform's slug in AgentPey's `venues.json`. */
  readonly platformSlug?: string;
  readonly fetchImpl?: typeof fetch;
  readonly cacheMs?: number;
  readonly now?: () => number;
  /** Tests inject a fake feed per store. */
  readonly catalogFor?: (baseUrl: string) => BazaarCatalog;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const VENUE_SLUG_MAX = 40;

const entrySchema = z.object({ slug: z.string(), name: z.string().min(1).max(120), url: z.string(), payTo: z.string() });
const directorySchema = z.object({ comercios: z.array(z.unknown()) });

export function createStorefrontDirectory(options: StorefrontDirectoryOptions): StorefrontDirectory {
  const platformSlug = options.platformSlug ?? "vitrinee";
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  const scheme = options.platformHost === "localhost" ? "http" : "https";
  const catalogs = new Map<string, BazaarCatalog>();
  let cached: { at: number; stores: readonly Storefront[] } | undefined;

  function toStorefront(raw: unknown): Storefront | undefined {
    const entry = entrySchema.safeParse(raw);
    if (!entry.success) return undefined;
    const { slug, name, url, payTo } = entry.data;
    const venueSlug = `${platformSlug}-${slug}`;
    if (!SLUG.test(slug) || venueSlug.length > VENUE_SLUG_MAX || !ACCOUNT.test(payTo)) return undefined;
    const baseUrl = `${scheme}://${slug}.${options.platformHost}`;
    if (url.replace(/\/+$/, "") !== baseUrl) return undefined;
    let catalog = catalogs.get(baseUrl);
    if (catalog === undefined) {
      catalog = options.catalogFor?.(baseUrl) ?? createBazaarCatalog({ baseUrl, fetchImpl });
      catalogs.set(baseUrl, catalog);
    }
    return { slug, name, venueId: `${venueSlug}:${payTo}`, payTo, baseUrl, catalog };
  }

  async function list(): Promise<readonly Storefront[]> {
    if (cached !== undefined && now() - cached.at < cacheMs) return cached.stores;
    let body: unknown;
    try {
      const response = await fetchImpl(options.directoryUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`status ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new AgentPassError("NetworkError", "could not read the Vitrinee directory of stores", {
        cause: error,
        details: { directoryUrl: options.directoryUrl },
      });
    }
    const parsed = directorySchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentPassError("NetworkError", "the Vitrinee directory answered with an unexpected shape", {
        details: { directoryUrl: options.directoryUrl },
      });
    }
    const seen = new Set<string>();
    const stores = parsed.data.comercios.flatMap((raw) => {
      const store = toStorefront(raw);
      if (store === undefined || seen.has(store.slug)) return [];
      seen.add(store.slug);
      return [store];
    });
    cached = { at: now(), stores };
    return stores;
  }

  return {
    list,
    async get(slug) {
      return (await list()).find((store) => store.slug === slug);
    },
  };
}
