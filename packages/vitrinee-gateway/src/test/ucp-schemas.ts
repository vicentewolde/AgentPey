import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validates gateway output against the official UCP JSON Schemas, vendored
 * unmodified in ./ucp-2026-04-08 (E-2) and ./ucp-2026-08-25 (T133, R-6). No
 * network: every $ref resolves to a file in that folder, keyed by the schema's
 * own $id. One validator per version: both versions use the same $ids.
 */
const ROOT = fileURLToPath(new URL("./ucp-2026-04-08", import.meta.url));
const ROOT_2026_08_25 = fileURLToPath(new URL("./ucp-2026-08-25", import.meta.url));

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsonFiles(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

/**
 * Upstream bug in v2026-04-08: discovery/profile.json has $id
 * `https://ucp.dev/schemas/discovery/profile.json` but refers to
 * `../schemas/ucp.json`, which resolves to `/schemas/schemas/ucp.json`. The
 * intended target is `/schemas/ucp.json`. Fixed in memory; the vendored file
 * stays byte-for-byte upstream.
 */
function upstreamFix(text: string): string {
  return text.includes('"$id": "https://ucp.dev/schemas/discovery/profile.json"') ? text.replaceAll('"../schemas/ucp.json', '"../ucp.json') : text;
}

function createValidator(root: string): Ajv2020 {
  // strict: false because the UCP schemas carry their own annotation keywords
  // (`ucp_request`, `name`, `version`) that Ajv does not know.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("uri", (value: string) => URL.canParse(value));
  ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)) && /T/.test(value));
  for (const file of jsonFiles(root)) {
    ajv.addSchema(JSON.parse(upstreamFix(readFileSync(file, "utf8"))) as object);
  }
  return ajv;
}

const ajv = createValidator(ROOT);
const ajv2026_08_25 = createValidator(ROOT_2026_08_25);

export const UCP_SCHEMA = {
  businessProfile: "https://ucp.dev/schemas/discovery/profile.json#/$defs/business_profile",
  searchResponse: "https://ucp.dev/schemas/shopping/catalog_search.json#/$defs/search_response",
  lookupResponse: "https://ucp.dev/schemas/shopping/catalog_lookup.json#/$defs/lookup_response",
  getProductResponse: "https://ucp.dev/schemas/shopping/catalog_lookup.json#/$defs/get_product_response",
  searchRequest: "https://ucp.dev/schemas/shopping/catalog_search.json#/$defs/search_request",
  errorResponse: "https://ucp.dev/schemas/shopping/types/error_response.json",
} as const;

/** The same names in UCP `2026-08-25`, where the profile and the shared types moved. */
export const UCP_SCHEMA_2026_08_25 = {
  businessProfile: "https://ucp.dev/schemas/profile.json#/$defs/business_schema",
  searchResponse: "https://ucp.dev/schemas/shopping/catalog_search.json#/$defs/search_response",
  lookupResponse: "https://ucp.dev/schemas/shopping/catalog_lookup.json#/$defs/lookup_response",
  getProductResponse: "https://ucp.dev/schemas/shopping/catalog_lookup.json#/$defs/get_product_response",
  checkout: "https://ucp.dev/schemas/shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout",
  order: "https://ucp.dev/schemas/shopping/order.json",
  errorResponse: "https://ucp.dev/schemas/common/types/error_response.json",
} as const;

/** The validation errors of `value` against a UCP schema, as readable lines; empty when it is valid. */
export function ucpErrors(schema: string, value: unknown, version: "2026-04-08" | "2026-08-25" = "2026-04-08"): string[] {
  const validate: ValidateFunction | undefined = (version === "2026-08-25" ? ajv2026_08_25 : ajv).getSchema(schema);
  if (validate === undefined) throw new TypeError(`unknown UCP schema ${schema}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`);
}

/** Registers extra schemas (the handler's own) next to the vendored ones. */
export function addSchema(schema: object): void {
  ajv.addSchema(schema);
  ajv2026_08_25.addSchema(structuredClone(schema));
}
