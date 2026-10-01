import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validates mandates against the official AP2 v0.2 JSON Schemas, vendored
 * unmodified in ./ap2-v0.2. No network: every $ref resolves to a file in that
 * folder, keyed by the schema's own $id.
 */
const ROOT = fileURLToPath(new URL("./ap2-v0.2/schemas", import.meta.url));

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsonFiles(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

function createValidator(): Ajv2020 {
  // strict: false because the AP2 schemas carry their own annotation keywords
  // (`x-selectively-disclosable-array`) that Ajv does not know.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("uri", (value: string) => URL.canParse(value));
  for (const file of jsonFiles(ROOT)) {
    ajv.addSchema(JSON.parse(readFileSync(file, "utf8")) as object);
  }
  return ajv;
}

const ajv = createValidator();

/**
 * Keyed by each schema's own $id, which at e1ea56d does not always match its
 * file name: open_payment_mandate.json says `payment_mandate_open.json`, and
 * open_checkout_mandate.json has no `.json` at all. Their relative $refs
 * still resolve to types/*.json, so the files stay byte-for-byte upstream.
 */
export const AP2_SCHEMA = {
  openCheckoutMandate: "https://ap2-protocol.org/schemas/open_checkout_mandate",
  openPaymentMandate: "https://ap2-protocol.org/schemas/payment_mandate_open.json",
} as const;

/** The validation errors of `value` against an AP2 schema, as readable lines; empty when it is valid. */
export function ap2Errors(schema: string, value: unknown): string[] {
  const validate: ValidateFunction | undefined = ajv.getSchema(schema);
  if (validate === undefined) throw new TypeError(`unknown AP2 schema ${schema}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`);
}
