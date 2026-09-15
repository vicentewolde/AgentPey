/**
 * Rewrites the refusal codes table from `apps/realops/src/refusals.ts`.
 *
 *   pnpm run docs:refusal-codes
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REFUSAL_CODES_DOC, renderRefusalCodesMarkdown } from "./lib/refusal-codes.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = resolve(root, REFUSAL_CODES_DOC);
await writeFile(target, renderRefusalCodesMarkdown());
process.stdout.write(`wrote ${REFUSAL_CODES_DOC}\n`);
