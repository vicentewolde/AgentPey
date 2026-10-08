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
  for (const name of ["landing.html", "consent.html", "revocar.html", "resolve/responder.html", "tiendas.html", "en-vivo.html"]) {
    it(`${name} never combines timeZoneName with dateStyle or timeStyle`, async () => {
      const html = await readFile(resolve(PUBLIC_DIR, name), "utf8");
      const combined = /\{[^}]*(dateStyle|timeStyle)[^}]*timeZoneName[^}]*\}|\{[^}]*timeZoneName[^}]*(dateStyle|timeStyle)[^}]*\}/;

      expect(html).not.toMatch(combined);
    });
  }

  // T143: every signing page loads the wallet layer from this origin, never a CDN, and says what it signs, so the
  // picker offers only the wallets that can (LOBSTR signs testnet transactions for mainnet: not where one is signed).
  const needs: Record<string, string> = { "consent.html": "message transaction", "revocar.html": "message transaction", "resolve/responder.html": "message", "wallet-lab.html": "message" };
  for (const [name, signs] of Object.entries(needs)) {
    it(`${name} loads /wallet-kit.js from this origin for "${signs}", and no wallet script from a CDN`, async () => {
      const html = await readFile(resolve(PUBLIC_DIR, name), "utf8");
      expect(html).toContain(`<script src="/wallet-kit.js" data-needs="${signs}"></script>`);
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

  // T141: the store list is built from /api/stores, which carries text from the directory: never as HTML.
  it("tiendas.html reads /api/stores and never writes what it reads as HTML", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "tiendas.html"), "utf8");
    expect(html).toContain('fetch("/api/stores"');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).not.toContain("\u2014");
  });

  it("landing.html links to the store list", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");
    expect(html).toContain('href="/tiendas"');
  });

  // T152: the landing's numbers are read live, never written by hand, and it points at the live pages.
  it("landing.html reads its hero numbers from /api/live and links to /en-vivo", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");
    expect(html).toContain('fetch("/api/live"');
    for (const id of ["live-stores", "live-purchases", "live-usdc", "live-disputes"]) expect(html).toContain(`id="${id}">…</b>`);
    expect(html).not.toMatch(/id="stat-(tests|commits)"/);
    expect(html).toContain('href="/en-vivo"');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).not.toContain("\u2014");
  });

  // T151: the live feed renders what /api/live returns, which carries text from stores and receipts: never as HTML.
  it("en-vivo.html polls /api/live and never writes what it reads as HTML", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "en-vivo.html"), "utf8");
    expect(html).toContain('fetch("/api/live"');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).not.toContain("\u2014");
  });
});

