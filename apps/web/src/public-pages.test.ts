import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));

/**
 * The hosted signing and revocation pages have no tests of their own, and T89
 * found why that matters: a date option (`timeZoneName` next to `dateStyle`)
 * makes `toLocaleString` throw, which would stop `/consent/{id}` from loading
 * its invitation at all. These read the files as text and pin the few things
 * that break a page without any test noticing.
 */
describe("the static pages", () => {
  for (const name of ["landing.html", "consent.html", "revocar.html"]) {
    it(`${name} never combines timeZoneName with dateStyle or timeStyle`, async () => {
      const html = await readFile(resolve(PUBLIC_DIR, name), "utf8");
      const combined = /\{[^}]*(dateStyle|timeStyle)[^}]*timeZoneName[^}]*\}|\{[^}]*timeZoneName[^}]*(dateStyle|timeStyle)[^}]*\}/;

      expect(html).not.toMatch(combined);
    });
  }

  it("the landing's live buttons go to RealOps, not to the removed demo", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");

    expect(html).not.toContain('href="/consent"');
    expect(html).not.toContain('href="/sign"');
    expect(html.match(/href="https:\/\/realops\.agentpey\.com"/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
