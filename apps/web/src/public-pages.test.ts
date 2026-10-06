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
  for (const name of ["landing.html", "consent.html", "revocar.html", "resolve/responder.html"]) {
    it(`${name} never combines timeZoneName with dateStyle or timeStyle`, async () => {
      const html = await readFile(resolve(PUBLIC_DIR, name), "utf8");
      const combined = /\{[^}]*(dateStyle|timeStyle)[^}]*timeZoneName[^}]*\}|\{[^}]*timeZoneName[^}]*(dateStyle|timeStyle)[^}]*\}/;

      expect(html).not.toMatch(combined);
    });
  }

  // T143: every signing page loads the wallet layer from this origin, never a CDN, and offers any wallet that signs
  // messages instead of naming one.
  for (const name of ["consent.html", "revocar.html", "resolve/responder.html", "wallet-lab.html"]) {
    it(`${name} loads /wallet-kit.js from this origin, and no wallet script from a CDN`, async () => {
      const html = await readFile(resolve(PUBLIC_DIR, name), "utf8");
      expect(html).toContain('<script src="/wallet-kit.js"></script>');
      expect(html).not.toMatch(/unpkg\.com|jsdelivr|freighter-api|freighterApi/);
      expect(html).not.toContain("\u2014");
    });
  }

  it("consent.html puts Connect wallet in the top bar, before the consent itself (T108)", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "consent.html"), "utf8");
    const button = html.indexOf('id="wallet-btn"');
    expect(button).toBeGreaterThan(html.indexOf('class="utils"'));
    expect(button).toBeLessThan(html.indexOf('<header class="hero">'));
    expect(html).not.toContain('id="wallet-panel"');
    expect(html).toContain('<a id="return-link" class="btn big">');
  });

  it("resolve/responder.html signs with the tested module, shows no em dash, and every Spanish line has its English one (T126)", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "resolve/responder.html"), "utf8");

    // The page builds the signed message only through responder.js, the module
    // `packages/resolve/src/responder-page.test.ts` holds to the verifier.
    expect(html).toContain('from "./responder.js"');
    expect(html).not.toMatch(/Stellar Signed Message|canonicalJson\(/);
    expect(html).not.toContain("—");
    expect(html.match(/data-tr="es"/g)?.length).toBe(html.match(/data-tr="en"/g)?.length);
  });

  it("the landing's live buttons go to RealOps, not to the removed demo", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");

    expect(html).not.toContain('href="/consent"');
    expect(html).not.toContain('href="/sign"');
    expect(html.match(/href="https:\/\/realops\.agentpey\.com"/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
