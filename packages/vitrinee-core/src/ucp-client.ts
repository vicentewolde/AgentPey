/**
 * A minimal UCP client for one storefront (T121): reads the business profile,
 * checks it the way UCP asks a platform to, and reads the catalog. It uses
 * only what the storefront publishes, so it works against any UCP business
 * that declares the Stellar x402 handler, not just Vitrinee. Moved here from
 * `scripts/vitrinee/lib` in T128, so AgentPey's MCP server reads stores the
 * same way the `vitrinee:ucp:list` client does.
 */
import { z } from "zod";

import { VitrineeError } from "./errors.js";
import {
  STELLAR_X402_HANDLER,
  UCP_CATALOG_SEARCH,
  UCP_PROFILE_PATH,
  UCP_SHOPPING_SERVICE,
  originMatchesNamespace,
  stellarX402BusinessConfigSchema,
  ucpBusinessProfileSchema,
  ucpSearchResponseSchema,
  type StellarX402BusinessConfig,
  type UcpBusinessProfile,
  type UcpProduct,
  ucpProductSchema,
} from "./ucp.js";

/** Identifies this client to the business. UCP wants a platform profile URL here; this client has none yet (T122). */
/** The platform profile a client names in `UCP-Agent` unless told otherwise: the test client's. */
const DEFAULT_UCP_AGENT_PROFILE = "https://agentpey.com/ucp/platform/test-client.json";
const MAX_PAGES = 50;

export interface UcpStorefront {
  profile: UcpBusinessProfile;
  endpoint: string;
  handler: StellarX402BusinessConfig;
  products: UcpProduct[];
}

export interface UcpClientOptions {
  readonly fetchImpl?: typeof fetch;
  /** The platform profile sent in `UCP-Agent`. */
  readonly agentProfile?: string;
}

async function getJson(options: UcpClientOptions, url: string, init?: RequestInit): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: { accept: "application/json", "UCP-Agent": `profile="${options.agentProfile ?? DEFAULT_UCP_AGENT_PROFILE}"`, ...init?.headers },
    });
  } catch (error) {
    throw new VitrineeError("NetworkError", `could not reach ${url}`, { details: { url }, cause: error });
  }
  if (!res.ok) throw new VitrineeError("NetworkError", `${url} answered ${res.status}`, { details: { url, status: res.status } });
  try {
    return await res.json();
  } catch (error) {
    throw new VitrineeError("ValidationError", `${url} did not answer JSON`, { details: { url }, cause: error });
  }
}

/**
 * Every capability and payment handler must name its `spec` and `schema`, and
 * both must live on the name's own domain. A profile that omits them, or
 * points them elsewhere, could be advertising a handler under somebody else's
 * name, so nothing from it is used. Services need only a matching `spec` when
 * they give one.
 */
export function assertNamespaceBinding(profile: UcpBusinessProfile): void {
  const check = (registry: Record<string, ReadonlyArray<{ spec?: string | undefined; schema?: string | undefined }>>, required: boolean) => {
    for (const [name, declarations] of Object.entries(registry)) {
      for (const declaration of declarations) {
        for (const [field, link] of [["spec", declaration.spec], ["schema", declaration.schema]] as const) {
          if (link === undefined) {
            if (required) throw new VitrineeError("ValidationError", `${name} declares no ${field} URL`, { details: { name, field } });
            continue;
          }
          if (!originMatchesNamespace(name, link)) {
            throw new VitrineeError("ValidationError", `${name} points at ${link}, outside its namespace`, { details: { name, link } });
          }
        }
      }
    }
  };
  check(profile.ucp.services, false);
  check(profile.ucp.capabilities ?? {}, true);
  check(profile.ucp.payment_handlers, true);
}

export interface UcpStoreProfile {
  profile: UcpBusinessProfile;
  endpoint: string;
  handler: StellarX402BusinessConfig;
}

/** The store's business profile, checked the way UCP asks a platform to. */
export async function readUcpStoreProfile(baseUrl: string, options: UcpClientOptions = {}): Promise<UcpStoreProfile> {
  const origin = baseUrl.replace(/\/+$/, "");
  const parsed = ucpBusinessProfileSchema.safeParse(await getJson(options, `${origin}${UCP_PROFILE_PATH}`));
  if (!parsed.success) {
    throw new VitrineeError("ValidationError", "the business profile is not a UCP profile", { details: { issues: parsed.error.issues } });
  }
  const profile = parsed.data;
  assertNamespaceBinding(profile);

  const endpoint = profile.ucp.services[UCP_SHOPPING_SERVICE]?.find((service) => service.transport === "rest")?.endpoint;
  if (endpoint === undefined) throw new VitrineeError("ValidationError", "the profile declares no REST shopping service", {});
  if (profile.ucp.capabilities?.[UCP_CATALOG_SEARCH] === undefined) {
    throw new VitrineeError("ValidationError", `the profile does not declare ${UCP_CATALOG_SEARCH}`, {});
  }
  const handlerConfig = stellarX402BusinessConfigSchema.safeParse(profile.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0]?.config);
  if (!handlerConfig.success) {
    throw new VitrineeError("ValidationError", `the profile does not declare a usable ${STELLAR_X402_HANDLER}`, {
      details: { issues: handlerConfig.error.issues },
    });
  }

  return { profile, endpoint, handler: handlerConfig.data };
}

/**
 * The products a store's own catalog search returns for `query`, one page.
 * The store decides what matches; nothing is filtered here.
 */
export async function searchUcpStore(baseUrl: string, query: string, options: UcpClientOptions & { limit?: number } = {}): Promise<UcpStoreProfile & { products: UcpProduct[] }> {
  const store = await readUcpStoreProfile(baseUrl, options);
  const body = await getJson(options, `${store.endpoint}/catalog/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, pagination: { limit: options.limit ?? 20 } }),
  });
  const result = ucpSearchResponseSchema.safeParse(body);
  if (!result.success) {
    throw new VitrineeError("ValidationError", "catalog/search did not return a UCP search response", { details: { issues: result.error.issues } });
  }
  return { ...store, products: result.data.products };
}

const productResponseSchema = z.looseObject({ product: ucpProductSchema.optional() });

/** One product by id, from the store's `catalog/product`; `null` when the store has no such product. */
export async function getUcpProduct(baseUrl: string, id: string, options: UcpClientOptions = {}): Promise<UcpProduct | null> {
  const store = await readUcpStoreProfile(baseUrl, options);
  const body = await getJson(options, `${store.endpoint}/catalog/product`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const result = productResponseSchema.safeParse(body);
  if (!result.success) {
    throw new VitrineeError("ValidationError", "catalog/product did not return a UCP product response", { details: { issues: result.error.issues } });
  }
  return result.data.product ?? null;
}

/** The store's profile and its whole catalog, page by page. */
export async function readUcpStorefront(baseUrl: string, options: UcpClientOptions = {}): Promise<UcpStorefront> {
  const { profile, endpoint, handler } = await readUcpStoreProfile(baseUrl, options);
  const products: UcpProduct[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getJson(options, `${endpoint}/catalog/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "*", pagination: { limit: 50, ...(cursor === undefined ? {} : { cursor }) } }),
    });
    const result = ucpSearchResponseSchema.safeParse(body);
    if (!result.success) {
      throw new VitrineeError("ValidationError", "catalog/search did not return a UCP search response", { details: { issues: result.error.issues } });
    }
    products.push(...result.data.products);
    if (result.data.pagination?.has_next_page !== true) return { profile, endpoint, handler, products };
    const next = result.data.pagination.cursor;
    if (next === undefined || next === cursor) {
      throw new VitrineeError("ValidationError", "catalog/search announced a next page without a new cursor", { details: { cursor } });
    }
    cursor = next;
  }
  throw new VitrineeError("ValidationError", `catalog/search has more than ${MAX_PAGES} pages; refusing to list a partial catalog`, {
    details: { pages: MAX_PAGES },
  });
}
