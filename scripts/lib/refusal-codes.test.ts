import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXPLAINED_CODES } from "../../apps/realops/src/refusals.js";
import { REFUSAL_CODES_DOC, renderRefusalCodesMarkdown } from "./refusal-codes.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("the refusal codes table", () => {
  it("matches what RealOps shows people (run `pnpm run docs:refusal-codes` if this fails)", async () => {
    const committed = await readFile(resolve(root, REFUSAL_CODES_DOC), "utf8");

    expect(committed).toBe(renderRefusalCodesMarkdown());
  });

  it("lists every code RealOps explains, once", () => {
    const markdown = renderRefusalCodesMarkdown();

    for (const code of EXPLAINED_CODES) {
      expect(markdown.split(`| \`${code}\` |`)).toHaveLength(2);
    }
  });
});
