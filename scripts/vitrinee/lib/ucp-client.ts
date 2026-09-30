/**
 * A minimal UCP client for one storefront (T121): reads the business profile,
 * checks it the way UCP asks a platform to, and lists the catalog. It uses
 * only what the storefront publishes, so it works against any UCP business
 * that declares the Stellar x402 handler, not just Vitrinee.
 */
import {
  STELLAR_X402_HANDLER,
  UCP_CATALOG_SEARCH,
  UCP_PROFILE_PATH,
  UCP_SHOPPING_SERVICE,
  VitrineeError,
  originMatchesNamespace,
  stellarX402BusinessConfigSchema,
  ucpBusinessProfileSchema,
  ucpSearchResponseSchema,
  type StellarX402BusinessConfig,
  type UcpBusinessProfile,
  type UcpProduct,
} from "../../../packages/vitrinee-core/src/index.js";

/** Identifies this client to the business. UCP wants a platform profile URL here; this client has none yet (T122). */
const UCP_AGENT = 'profile="https://agentpey.com/ucp/platform/test-client.json"';
const MAX_PAGES = 50;

export interface UcpStorefront {
  profile: UcpBusinessProfile;
  endpoint: string;
  handler: StellarX402BusinessConfig;
  products: UcpProduct[];
}

async function getJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers: { accept: "application/json", "UCP-Agent": UCP_AGENT, ...init?.headers } });
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

export async function readUcpStorefront(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<UcpStorefront> {
  const origin = baseUrl.replace(/\/+$/, "");
  const parsed = ucpBusinessProfileSchema.safeParse(await getJson(fetchImpl, `${origin}${UCP_PROFILE_PATH}`));
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

  const products: UcpProduct[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getJson(fetchImpl, `${endpoint}/catalog/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "*", pagination: { limit: 50, ...(cursor === undefined ? {} : { cursor }) } }),
    });
    const result = ucpSearchResponseSchema.safeParse(body);
    if (!result.success) {
      throw new VitrineeError("ValidationError", "catalog/search did not return a UCP search response", { details: { issues: result.error.issues } });
    }
    products.push(...result.data.products);
    if (result.data.pagination?.has_next_page !== true) return { profile, endpoint, handler: handlerConfig.data, products };
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
