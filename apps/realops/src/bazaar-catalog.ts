/**
 * Reading the bazaar's live catalogue — the "discover" layer, and nothing else.
 *
 * **This whole file sits on the harmless side of the boundary** (`PILOTO-F9.md`
 * § 4.1). It talks to a third party over the network and believes nothing it
 * says. What it produces is a list of *candidates* for a screen to draw. It
 * chooses no venue, quotes no price anyone pays, and names no payee: the venue
 * comes from `venues.json` on AgentPey's side, the price comes from the
 * merchant's own 402 and is re-checked by `reconcileTerms`, and the payout
 * account is compared against the signed Mandate's `payTo`. A bazaar that is
 * down, lying, or replaced by an attacker can make this screen wrong; it cannot
 * make a payment happen.
 *
 * So the prices and descriptions below are *displayed*, never decided on. The
 * same rule `B-19` already sets for the agent: no third-party prose reaches a
 * decision.
 *
 * **What it corrects about the raw feed** — three things found against the live
 * deployment on 2026-09-22, not read from documentation:
 *
 * 1. `GET /api/discovery/search?query=*` returns the same resource twice.
 *    `ai-video-scriptwriter` appears in two rows whose `input` arrays disagree
 *    (`durationSeconds` is `"string"` in one and `"number"` in the other). So
 *    rows are deduplicated by id, and the row kept is the more described one,
 *    because the descriptions are what the form shows a person.
 * 2. A listed resource is not necessarily a resource the merchant is charging
 *    for. `ai-video-scriptwriter` advertises `/api/script`, which answers `404`
 *    on every host the bazaar is reachable at. A catalogue entry is a claim;
 *    {@link preflightResource} checks it.
 * 3. The bazaar's single-resource route (`/api/discovery/resources/{id}`) is
 *    dead, as `bazaar.ts` already recorded. There is nothing to fetch per id:
 *    the list is the only transport.
 */
import { AgentPassError } from "@agentpass/core";
import { z } from "zod";

/** One input the merchant requires to serve a resource. Becomes one field in the form. */
export interface ResourceInput {
  readonly name: string;
  /** The merchant's own word for the type. Used to pick an input widget, never to validate money. */
  readonly type: string;
  readonly required: boolean;
  readonly description?: string;
}

/** One thing the bazaar says it sells. A claim, not an offer, and never a permission. */
export interface BazaarResource {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The merchant's declared price. Shown to a person; discarded before any decision (`C-77`). */
  readonly declaredAmount: string;
  readonly declaredAsset: string;
  /** The account the catalogue says collects. Only ever compared, never trusted. */
  readonly declaredPayTo: string;
  readonly routeTemplate?: string;
  readonly inputs: readonly ResourceInput[];
}

/**
 * Whether the merchant actually serves a resource it lists.
 *
 * **What the probe can and cannot answer.** It asks the paid route without
 * filling in a single parameter, so the only question it puts is "do you serve
 * this?" — never "would you sell me this exact thing", which cannot be asked
 * without inventing values the person has not chosen.
 *
 * - `sellable` — the merchant serves the route: it quoted (`402`), or it
 *   rejected the empty request on its own terms (a `4xx` that is not a missing
 *   route). Both mean the counter is open.
 * - `unavailable` — `404`, `405` or `410`: the merchant lists this but serves
 *   no such route. The live `ai-video-scriptwriter` is exactly this.
 * - `unknown` — the merchant erred (`5xx`), the check could not be made, or
 *   the route has a placeholder outside its query string that cannot be
 *   probed without inventing a value. Not the same as a refusal, and the
 *   screen says so rather than inventing either answer.
 */
export type ResourceAvailability = "sellable" | "unavailable" | "unknown";

export interface CheckedResource extends BazaarResource {
  readonly availability: ResourceAvailability;
}

/**
 * Deliberately not strict: this is third-party shape a merchant may extend, and
 * a schema that rejected an added field would turn a harmless upstream change
 * into an outage on this screen. Same posture `x402-catalog.ts` takes.
 */
const resourceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  payment: z.object({
    asset: z.string(),
    amount: z.string(),
    destination: z.string(),
  }),
  routeTemplate: z.string().optional(),
  input: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string(),
        required: z.boolean(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

const searchResponseSchema = z.object({
  ok: z.boolean(),
  results: z.array(z.object({ resource: resourceSchema })),
});

function catalogueError(message: string, baseUrl: string, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details: { baseUrl } });
}

function toResource(row: z.infer<typeof resourceSchema>): BazaarResource {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    declaredAmount: row.payment.amount,
    declaredAsset: row.payment.asset,
    declaredPayTo: row.payment.destination,
    ...(row.routeTemplate === undefined ? {} : { routeTemplate: row.routeTemplate }),
    inputs: (row.input ?? []).map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required,
      ...(input.description === undefined ? {} : { description: input.description }),
    })),
  };
}

/**
 * How well described a row is, for picking between duplicates.
 *
 * Counts inputs that carry a description, because that is the only difference
 * that reaches a person: the form's help text. Ties keep the first row, so the
 * result does not depend on the order the merchant happened to answer in.
 */
function describedness(resource: BazaarResource): number {
  return resource.inputs.filter((input) => input.description !== undefined).length;
}

/** One row per id, keeping the better described duplicate. Order of first appearance. */
export function deduplicate(resources: readonly BazaarResource[]): readonly BazaarResource[] {
  const byId = new Map<string, BazaarResource>();
  for (const resource of resources) {
    const existing = byId.get(resource.id);
    if (existing === undefined || describedness(resource) > describedness(existing)) {
      byId.set(resource.id, resource);
    }
  }
  return [...byId.values()];
}

/**
 * Fills `{name}` placeholders in a route template.
 *
 * Every value is URL-encoded, and a placeholder with no value is left as-is
 * rather than blanked, so a template this does not understand produces a URL
 * the merchant will reject instead of a plausible-looking wrong one.
 */
export function fillRoute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

/** The statuses that mean "there is no such route here", as opposed to "your request was wrong". */
const ROUTE_ABSENT = new Set([404, 405, 410]);

/**
 * Asks the merchant whether it serves a route at all, without paying and
 * without inventing anything.
 *
 * **Parameters are deliberately not filled in.** The first version of this did
 * fill them, with made-up values, and the live bazaar answered `400
 * INVALID_QUOTE_INPUT` — it validates before it quotes. So an open shop looked
 * shut, on the very screen built to tell those apart. Inventing better values
 * would be guessing on a person's behalf at what they want to buy, which is
 * the one thing this pilot does not do. Asking the bare route answers the only
 * question that can honestly be asked without them, and answers it cleanly:
 * `/api/x402/swap-risk` replies `400` (served, validating) while `/api/script`
 * replies `404` (not served). Both checked live on 2026-09-22.
 *
 * Nothing is signed and nothing is spent. The body is not even read: only the
 * status is. The quote that matters is the one AgentPey fetches for itself at
 * purchase time and re-checks against the Mandate.
 */
export async function preflightResource(
  baseUrl: string,
  resource: BazaarResource,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResourceAvailability> {
  if (resource.routeTemplate === undefined) return "unknown";
  const path = resource.routeTemplate.split("?")[0]!;
  // A placeholder in the path itself cannot be dropped the way a query string
  // can, and filling it would be the guess this function just refused to make.
  if (path.includes("{")) return "unknown";

  try {
    const response = await fetchImpl(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (ROUTE_ABSENT.has(response.status)) return "unavailable";
    // A merchant erroring is not a merchant refusing to sell, and must not be
    // reported as one.
    if (response.status >= 500) return "unknown";
    return "sellable";
  } catch {
    // Unreachable, timed out, aborted: we do not know. Saying "unavailable"
    // here would blame the merchant for our own network.
    return "unknown";
  }
}

export interface BazaarCatalogOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** How long a read is reused before going back to the merchant. */
  readonly cacheMs?: number;
  readonly now?: () => Date;
}

export interface BazaarCatalog {
  /**
   * The merchant's catalogue, deduplicated and preflighted.
   *
   * @throws AgentPassError `NetworkError` when the merchant is unreachable,
   * answers non-2xx, answers something that is not JSON, or answers a shape
   * this does not recognise. Never `undefined`, never a silent empty list: a
   * catalogue that failed to load and a catalogue that is empty are different
   * facts and the screen shows them differently.
   */
  list(): Promise<readonly CheckedResource[]>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_MS = 60_000;

export function createBazaarCatalog(options: BazaarCatalogOptions): BazaarCatalog {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? (() => new Date());

  let cached: { readonly at: number; readonly resources: readonly CheckedResource[] } | undefined;
  /** In-flight read, so ten simultaneous visitors make one round of requests, not ten. */
  let inFlight: Promise<readonly CheckedResource[]> | undefined;

  async function read(): Promise<readonly CheckedResource[]> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/discovery/search?query=*`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw catalogueError("could not reach the bazaar's catalogue", baseUrl, error);
    }
    if (!response.ok) {
      throw new AgentPassError("NetworkError", "the bazaar's catalogue answered with a non-2xx status", {
        details: { baseUrl, status: response.status },
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw catalogueError("the bazaar's catalogue did not answer with JSON", baseUrl, error);
    }

    const parsed = searchResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentPassError("NetworkError", "the bazaar's catalogue answered with an unexpected shape", {
        details: {
          baseUrl,
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
    }
    if (!parsed.data.ok) {
      throw catalogueError("the bazaar's catalogue reported a failed search", baseUrl);
    }

    const resources = deduplicate(parsed.data.results.map((row) => toResource(row.resource)));
    // Probed together: the page waits for the slowest, not for the sum.
    const availabilities = await Promise.all(
      resources.map((resource) => preflightResource(baseUrl, resource, fetchImpl, timeoutMs)),
    );
    return resources.map((resource, index) => ({ ...resource, availability: availabilities[index]! }));
  }

  return {
    async list() {
      const at = now().getTime();
      if (cached !== undefined && at - cached.at < cacheMs) return cached.resources;
      // A second visitor arriving mid-read waits for the same read. A failure
      // clears it, so a broken catalogue is retried rather than remembered.
      inFlight ??= read()
        .then((resources) => {
          cached = { at: now().getTime(), resources };
          return resources;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
