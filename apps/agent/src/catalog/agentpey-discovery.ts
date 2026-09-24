/**
 * AgentPey's own discovery index: every registered venue's catalogue, served
 * as {@link ServiceCandidate}s through the same interface Periplo answers.
 *
 * **What it is for.** Two things, and it is worth being blunt about which is
 * which. It is the fallback when the public catalogue is down, which is a
 * real operational need — a third-party service that goes dark on the day of
 * an external test turns a pilot into an incident. And it is a way to make
 * discovery something a person can actually see, at a URL, instead of a
 * hidden call to a merchant this repo already knows about.
 *
 * **What it is not, said out loud.** An index over one's own registry does
 * not prove *open* discovery. It proves the mechanism: an instruction becomes
 * a query, a query becomes candidates, candidates become a purchase only
 * after the registry, the credential and the Mandate have each had their say.
 * Periplo is what makes the discovery open; this is what makes it survivable.
 * Claiming otherwise would be worth less than the honesty.
 *
 * **Why it cannot widen permission.** Its rows *are* the registry — every
 * candidate it can possibly emit comes from a venue already in `venues.json`.
 * It still routes each one through `toCandidate`, so venue resolution happens
 * in exactly one place for every source rather than being assumed here
 * because "these ones are ours". An assumption like that is correct right up
 * to the commit where it is not.
 */
import { AgentPassError } from "@agentpass/core";

import type { CatalogAdapter } from "./catalog.js";
import {
  MAX_CANDIDATES,
  matchesQuery,
  parseQuery,
  toCandidate,
  type CatalogSource,
  type RegisteredCandidate,
  type ServiceCandidate,
} from "./discovery.js";
import type { VenueId } from "./ids.js";
import type { VenueRegistry } from "./registry.js";
import type { X402ServiceRoute } from "./x402-catalog.js";

/** How long a fetched index is reused before the venues are asked again. */
export const DEFAULT_INDEX_TTL_MS = 30_000;

export interface AgentPeyDiscoveryOptions {
  readonly registry: VenueRegistry;
  /**
   * When given, the registry each index build uses: `registry` with every
   * platform's current merchants added (`platforms.ts`, T104). Without it, the
   * index covers `registry` as it is.
   */
  readonly resolveRegistry?: (registry: VenueRegistry) => Promise<VenueRegistry>;
  /**
   * Builds the catalogue adapter for one venue — injected rather than
   * constructed here so the index can be tested without a network, and so the
   * caller decides the timeout policy (`fetchWithTimeout`). Receives the
   * registry the venue was resolved in.
   */
  readonly catalogFor: (venueId: VenueId, registry: VenueRegistry) => CatalogAdapter;
  /** Called for each venue that failed, so one merchant being down is visible and not silent. */
  readonly onVenueError?: (venueId: VenueId, error: unknown) => void;
  readonly cacheTtlMs?: number;
  /** Injected for tests. */
  readonly now?: () => number;
}

interface CachedIndex {
  readonly candidates: readonly ServiceCandidate[];
  readonly builtAt: number;
}

/**
 * The registry's venues, as a searchable catalogue.
 *
 * A venue that fails is skipped, not fatal: one merchant being unreachable
 * must not hide the others. All of them failing *is* fatal, and throws
 * `CatalogUnavailable` — because returning an empty list would tell a caller
 * "there is nothing for sale" when the truth is "nobody answered", and those
 * two facts lead a person to two different actions.
 *
 * @throws AgentPassError `CatalogUnavailable` when every venue with a base URL failed.
 */
export function createAgentPeyDiscovery(options: AgentPeyDiscoveryOptions): CatalogSource {
  const ttlMs = options.cacheTtlMs ?? DEFAULT_INDEX_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cached: CachedIndex | undefined;

  async function buildIndex(): Promise<readonly ServiceCandidate[]> {
    const registry = options.resolveRegistry === undefined ? options.registry : await options.resolveRegistry(options.registry);
    const venues = [...registry.venues.values()].filter((venue) => venue.baseUrl !== undefined);
    if (venues.length === 0) return [];

    const results = await Promise.allSettled(
      venues.map(async (venue) => ({
        venue,
        products: await options.catalogFor(venue.venueId, registry).listProducts(),
      })),
    );

    const candidates: ServiceCandidate[] = [];
    let failures = 0;

    for (const [index, result] of results.entries()) {
      const venue = venues[index]!;
      if (result.status === "rejected") {
        failures += 1;
        options.onVenueError?.(venue.venueId, result.reason);
        continue;
      }

      for (const product of result.value.products) {
        const candidate = toCandidate(registry, {
          source: "agentpey",
          // The venue's own base URL: this index names *where* a service
          // lives and *which* product it is, and leaves the paid route to
          // the merchant, exactly as the purchase path already does.
          resourceUrl: venue.baseUrl!,
          title: product.name,
          description: product.description,
          productId: product.id,
        });
        if (candidate !== undefined) candidates.push(candidate);
      }
    }

    if (failures === venues.length) {
      throw new AgentPassError("CatalogUnavailable", "no registered venue answered its catalogue", {
        details: { venues: venues.length, source: "agentpey" },
      });
    }

    return candidates;
  }

  return {
    sourceId: "agentpey",

    async search(rawQuery: string): Promise<readonly ServiceCandidate[]> {
      const query = parseQuery(rawQuery);

      const fresh = cached !== undefined && now() - cached.builtAt < ttlMs;
      const candidates = fresh ? cached!.candidates : await buildIndex();
      if (!fresh) cached = { candidates, builtAt: now() };

      return candidates
        .filter((candidate) => matchesQuery(query, [candidate.title, candidate.description, candidate.productId]))
        .slice(0, MAX_CANDIDATES);
    },
  };
}

/** A candidate resolved all the way down to something a purchase can name. */
export interface PayableService {
  readonly venueId: VenueId;
  readonly productId: string;
}

/** The path half of a route template, with its query string and placeholders dropped. */
function templatePath(routeTemplate: string): string {
  const [path] = routeTemplate.split("?");
  return (path ?? "").replace(/\/+$/, "") || "/";
}

/**
 * Turns a registered candidate into the `(venue, product)` pair
 * `executeTenantPurchase` takes — by asking the merchant, never the catalogue.
 *
 * This is the join Periplo cannot do for us: it indexes URLs, so a candidate
 * that came from it has a resource URL and no product id. The merchant's own
 * card feed is what says which of its products lives at that URL, and the
 * merchant is also the only party with standing to say so.
 *
 * A candidate that already carries a product id is still checked against that
 * feed rather than believed — an id that no longer exists must fail here,
 * where the answer is "that is not for sale", rather than three layers later
 * with a stranger error.
 *
 * Ambiguity refuses. Two of a merchant's routes resolving to one URL is a
 * merchant this code cannot read unambiguously, and picking one of them would
 * be the guess that `ids.ts` spends its whole docstring arguing against.
 *
 * @throws AgentPassError `ProductNotFound` when the merchant's feed has no
 * product for this candidate.
 * @throws AgentPassError `InvalidProduct` when more than one does.
 */
export async function resolvePayableService(
  candidate: RegisteredCandidate,
  listRoutes: (venueId: VenueId) => Promise<readonly X402ServiceRoute[]>,
): Promise<PayableService> {
  const { venueId } = candidate;
  const routes = await listRoutes(venueId);

  if (candidate.productId !== undefined) {
    const known = routes.some((route) => route.id === candidate.productId);
    if (!known) {
      throw new AgentPassError(
        "ProductNotFound",
        `venue "${venueId}" has no paid route for product "${candidate.productId}"`,
        { details: { venueId, productId: candidate.productId, source: candidate.source } },
      );
    }
    return { venueId, productId: candidate.productId };
  }

  let candidatePath: string;
  try {
    candidatePath = templatePath(new URL(candidate.resourceUrl).pathname);
  } catch {
    throw new AgentPassError("ProductNotFound", "the candidate's resource URL cannot be read as a path", {
      details: { venueId, resourceUrl: candidate.resourceUrl },
    });
  }

  const matches = routes.filter((route) => templatePath(route.routeTemplate) === candidatePath);

  if (matches.length === 0) {
    throw new AgentPassError("ProductNotFound", `venue "${venueId}" offers nothing at that URL`, {
      details: { venueId, resourceUrl: candidate.resourceUrl, source: candidate.source },
    });
  }
  if (matches.length > 1) {
    throw new AgentPassError("InvalidProduct", `venue "${venueId}" offers more than one product at that URL`, {
      details: { venueId, resourceUrl: candidate.resourceUrl, productIds: matches.map((route) => route.id) },
    });
  }

  return { venueId, productId: matches[0]!.id };
}
