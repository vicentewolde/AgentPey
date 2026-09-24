/**
 * `GET /discovery/search` — AgentPey's own discovery index, served publicly.
 *
 * This is the route `PILOTO-F9.md` § 4.3 asked for: the fallback for when the
 * public catalogue is down, and the thing that makes discovery a URL a person
 * can open instead of a hidden call between two services that already know
 * each other. It is read-only, unauthenticated, and answers only about venues
 * that are already in `venues.json`, or merchants a registered platform's
 * directory names (T104).
 *
 * **One deliberate departure from the plan, with its reason.** § 4.3 proposed
 * serving the bazaar's `ServiceCard` shape, so `createX402Catalog` could read
 * this endpoint as if it were a venue. Building it showed why that is wrong:
 * a `ServiceCard` has no field naming which venue a card belongs to, because
 * a merchant's own feed never needs one — it is all the same merchant. This
 * index spans every registered venue, so in that shape a consumer could not
 * tell whose product it was looking at, and the one thing a candidate must
 * carry is exactly the venue. So it serves the candidate shape instead, with
 * `venue` on every row, and `registered` stated rather than implied.
 *
 * **Why an unauthenticated route here is not a new attack surface.** It reads,
 * it writes nothing, it holds no secret, and every field it can emit is
 * already public by construction — `venues.json` is in the repository. What it
 * *does* do is make outbound calls to the registered venues, so those are
 * bounded: a hard timeout per venue, a short-lived cache shared across
 * callers, a capped result count, and a query that is length-checked before it
 * is used at all.
 */
import { AgentPassError, isAgentPassError } from "@agentpass/core";
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  createAgentPeyDiscovery,
  createX402Catalog,
  expandPlatformVenues,
  fetchWithTimeout,
  parseQuery,
  DEFAULT_VENUE_REGISTRY,
  type CatalogSource,
  type ServiceCandidate,
  type VenueRegistry,
} from "@agentpey/agent";

export interface DiscoveryResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One row of the public answer. Snake case, like `/v1` — this is a machine-readable surface. */
interface DiscoveryRow {
  readonly venue: string | null;
  readonly registered: boolean;
  readonly product_id: string | null;
  readonly resource_url: string;
  readonly title: string | null;
  readonly description: string;
}

function toRow(candidate: ServiceCandidate): DiscoveryRow {
  return {
    venue: candidate.registered ? candidate.venueId : null,
    registered: candidate.registered,
    product_id: candidate.productId ?? null,
    resource_url: candidate.resourceUrl,
    title: candidate.title ?? null,
    description: candidate.description,
  };
}

/**
 * Answers one discovery request.
 *
 * `400` for a query this will not put in a URL, `503` for "no venue answered"
 * — which is a different fact from an empty list and is reported as one, the
 * same distinction `createAgentPeyDiscovery` refuses to blur.
 */
export async function handleDiscoverySearch(
  source: CatalogSource,
  rawQuery: string | null,
): Promise<DiscoveryResponse> {
  let query: string;
  try {
    query = parseQuery(rawQuery ?? "*");
  } catch (error) {
    const typed = isAgentPassError(error)
      ? error
      : new AgentPassError("InvalidArguments", "invalid query", { cause: error });
    return { status: 400, body: { ok: false, code: typed.code, message: typed.message, details: typed.details } };
  }

  try {
    const candidates = await source.search(query);
    return {
      status: 200,
      body: {
        ok: true,
        source: source.sourceId,
        query,
        results: candidates.map(toRow),
      },
    };
  } catch (error) {
    if (isAgentPassError(error) && error.code === "CatalogUnavailable") {
      return {
        status: 503,
        body: { ok: false, code: error.code, message: error.message, details: error.details },
      };
    }
    throw error;
  }
}

export interface PublicDiscoveryOptions {
  readonly registry?: VenueRegistry;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly onVenueError?: (venueId: string, error: unknown) => void;
}

/**
 * The index this server publishes: every registered venue's own catalogue,
 * each fetched through a `fetch` that gives up rather than hanging.
 */
export function createPublicDiscovery(options: PublicDiscoveryOptions = {}): CatalogSource {
  const registry = options.registry ?? DEFAULT_VENUE_REGISTRY;
  const timedFetch = fetchWithTimeout(
    options.fetchImpl ?? fetch,
    options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );

  return createAgentPeyDiscovery({
    registry,
    // Every platform's current merchants, read from its directory (T104).
    resolveRegistry: (base) => expandPlatformVenues(base, { fetchImpl: timedFetch }),
    catalogFor: (venueId, resolved) => createX402Catalog({ venueId, registry: resolved, fetchImpl: timedFetch }),
    onVenueError: options.onVenueError,
  });
}
