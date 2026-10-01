import { z } from "zod";

import { VitrineeError } from "./errors.js";
import { currencyDecimals, parseDecimal } from "./money.js";

/**
 * The Universal Commerce Protocol surface of a storefront
 * (docs/fase-7-estandar-comercio-agentico/SPEC.md §4). Vitrinee implements UCP
 * 2026-04-08 (E-2) next to its own agent-storefront manifest, which stays as it is.
 */
export const UCP_VERSION = "2026-04-08";
export const UCP_PROFILE_PATH = "/.well-known/ucp";
/** Every UCP REST route lives under this prefix, so none collides with the routes that predate UCP. */
export const UCP_REST_PREFIX = "/ucp/v1";

export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
export const UCP_CATALOG_SEARCH = "dev.ucp.shopping.catalog.search";
export const UCP_CATALOG_LOOKUP = "dev.ucp.shopping.catalog.lookup";

const UCP_DOCS = `https://ucp.dev/${UCP_VERSION}`;
export const UCP_SPEC_URLS = {
  service: { spec: `${UCP_DOCS}/specification/overview`, schema: `${UCP_DOCS}/services/shopping/rest.openapi.json` },
  catalogSearch: { spec: `${UCP_DOCS}/specification/catalog/search`, schema: `${UCP_DOCS}/schemas/shopping/catalog_search.json` },
  catalogLookup: { spec: `${UCP_DOCS}/specification/catalog/lookup`, schema: `${UCP_DOCS}/schemas/shopping/catalog_lookup.json` },
  checkout: { spec: `${UCP_DOCS}/specification/checkout`, schema: `${UCP_DOCS}/schemas/shopping/checkout.json` },
  fulfillment: { spec: `${UCP_DOCS}/specification/fulfillment`, schema: `${UCP_DOCS}/schemas/shopping/fulfillment.json` },
  order: { spec: `${UCP_DOCS}/specification/order`, schema: `${UCP_DOCS}/schemas/shopping/order.json` },
} as const;

export const UCP_CHECKOUT = "dev.ucp.shopping.checkout";
export const UCP_FULFILLMENT = "dev.ucp.shopping.fulfillment";
export const UCP_ORDER = "dev.ucp.shopping.order";

/** AgentPey's extension: a signed receipt, anchored on Stellar, on the checkout and the order. */
export const RECEIPT_EXTENSION = "com.agentpey.shopping.receipt";
export const RECEIPT_EXTENSION_VERSION = "2026-09-30";
export const RECEIPT_EXTENSION_SPEC_URL = "https://agentpey.com/ucp/extensions/receipt/spec";
export const RECEIPT_EXTENSION_SCHEMA_URL = "https://agentpey.com/ucp/extensions/receipt/schema.json";

/**
 * AgentPey's payment handler for UCP: an x402 "exact" payment on Stellar,
 * carried as the payment credential of Complete Checkout (E-1). UCP binds a
 * handler's `spec` and `schema` URLs to its namespace, hence agentpey.com.
 */
export const STELLAR_X402_HANDLER = "com.agentpey.stellar_x402";
export const STELLAR_X402_HANDLER_ID = "stellar_x402";
/** The handler is versioned on its own calendar, independent of the UCP release it plugs into. */
export const STELLAR_X402_HANDLER_VERSION = "2026-09-30";
export const STELLAR_X402_INSTRUMENT_TYPE = "stellar_x402";
export const STELLAR_X402_SPEC_URL = "https://agentpey.com/ucp/handlers/stellar-x402/spec";
export const STELLAR_X402_SCHEMA_URL = "https://agentpey.com/ucp/handlers/stellar-x402/schema.json";

const reverseDomainName = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/);
const versionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What a business declares about the handler in its profile: where and in what a payment settles. */
export const stellarX402BusinessConfigSchema = z.strictObject({
  x402_version: z.literal(2),
  scheme: z.literal("exact"),
  /** CAIP-2 network id. */
  network: z.literal("stellar:testnet"),
  asset: z.strictObject({
    code: z.string().min(1),
    /** SEP-41 contract of the asset. */
    contract: z.string().regex(/^C[A-Z2-7]{55}$/),
    decimals: z.number().int().min(0).max(18),
  }),
  /** The account the payment is transferred to. */
  pay_to: z.string().regex(/^G[A-Z2-7]{55}$/),
  facilitator: z.url(),
});
export type StellarX402BusinessConfig = z.infer<typeof stellarX402BusinessConfigSchema>;

const entitySchema = z.looseObject({
  version: versionSchema,
  spec: z.url().optional(),
  schema: z.url().optional(),
  id: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const serviceSchema = entitySchema.extend({
  transport: z.enum(["rest", "mcp", "a2a", "embedded"]),
  endpoint: z.url().optional(),
});

const paymentHandlerSchema = entitySchema.extend({
  id: z.string().min(1),
  available_instruments: z.array(z.looseObject({ type: z.string().min(1) })).min(1).optional(),
});

const signingKeySchema = z.looseObject({ kid: z.string().min(1), kty: z.string().min(1) });

/**
 * A business profile as a client needs to read it. Deliberately loose: the
 * official JSON Schemas are the contract (the gateway's tests validate against
 * them); this only guarantees the fields a reader walks.
 */
export const ucpBusinessProfileSchema = z.looseObject({
  ucp: z.looseObject({
    version: versionSchema,
    services: z.record(reverseDomainName, z.array(serviceSchema)),
    capabilities: z.record(reverseDomainName, z.array(entitySchema)).optional(),
    payment_handlers: z.record(reverseDomainName, z.array(paymentHandlerSchema)),
  }),
  signing_keys: z.array(signingKeySchema).optional(),
});
export type UcpBusinessProfile = z.infer<typeof ucpBusinessProfileSchema>;

const priceSchema = z.looseObject({
  /** ISO 4217 minor units. A JSON integer by the UCP schema; see `toMinorUnits`. */
  amount: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const descriptionSchema = z.looseObject({ plain: z.string().optional(), html: z.string().optional(), markdown: z.string().optional() });

const variantSchema = z.looseObject({
  id: z.string().min(1),
  sku: z.string().optional(),
  title: z.string(),
  description: descriptionSchema,
  price: priceSchema,
  availability: z.looseObject({ available: z.boolean().optional(), status: z.string().optional() }).optional(),
});

export const ucpProductSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  description: descriptionSchema,
  price_range: z.looseObject({ min: priceSchema, max: priceSchema }),
  variants: z.array(variantSchema).min(1),
});
export type UcpProduct = z.infer<typeof ucpProductSchema>;

export const ucpSearchResponseSchema = z.looseObject({
  ucp: z.looseObject({ version: versionSchema, status: z.enum(["success", "error"]).optional() }),
  products: z.array(ucpProductSchema),
  pagination: z.looseObject({ has_next_page: z.boolean(), cursor: z.string().optional(), total_count: z.number().int().min(0).optional() }).optional(),
});
export type UcpSearchResponse = z.infer<typeof ucpSearchResponseSchema>;

/**
 * A local-currency decimal string as the JSON integer UCP asks for ("34990"
 * CLP → 34990, "12.50" USD → 1250). The arithmetic stays in `bigint` (VT-7);
 * the conversion to `number` happens only here, at the wire, and refuses an
 * amount a JSON number cannot hold exactly (VT-36).
 */
export function toMinorUnits(amountLocal: string, currency: string): number {
  const minor = parseDecimal(amountLocal, currencyDecimals(currency));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VitrineeError("ValidationError", "amount is too large to express as a UCP integer", {
      details: { amountLocal, currency },
    });
  }
  return Number(minor);
}

/**
 * The host a UCP name answers to: its first two labels, reversed
 * (`com.agentpey.stellar_x402` → `agentpey.com`, `dev.ucp.shopping` → `ucp.dev`).
 */
export function namespaceAuthority(name: string): string {
  const labels = name.split(".");
  const [tld, domain] = labels;
  if (labels.length < 2 || tld === undefined || domain === undefined || tld === "" || domain === "") {
    throw new VitrineeError("ValidationError", `"${name}" is not a reverse-domain name`, { details: { name } });
  }
  return `${domain}.${tld}`;
}

/**
 * UCP's spec-URL binding: the origin of a capability's or handler's `spec` and
 * `schema` URL must be its namespace authority, over HTTPS. A platform that
 * skips this check lets anyone publish a handler under somebody else's name.
 */
export function originMatchesNamespace(name: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.port === "" && parsed.hostname === namespaceAuthority(name);
}
