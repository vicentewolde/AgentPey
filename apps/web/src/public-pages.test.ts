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
  for (const name of ["landing.html", "consent.html", "revocar.html", "resolve/responder.html", "resolve/confirmar.html", "resolve/evidencia.html", "tiendas.html", "en-vivo.html"]) {
    it(`${name} never combines timeZoneName with dateStyle or timeStyle`, async () => {
      const html = await readFile(resolve(PUBLIC_DIR, name), "utf8");
      const combined = /\{[^}]*(dateStyle|timeStyle)[^}]*timeZoneName[^}]*\}|\{[^}]*timeZoneName[^}]*(dateStyle|timeStyle)[^}]*\}/;

      expect(html).not.toMatch(combined);
    });
  }

  // T143: every signing page loads the wallet layer from this origin, never a CDN, and says what it signs, so the
  // picker offers only the wallets that can (LOBSTR signs testnet transactions for mainnet: not where one is signed).
  const needs: Record<string, string> = { "consent.html": "message transaction", "revocar.html": "message transaction", "resolve/responder.html": "message transaction", "resolve/confirmar.html": "transaction", "wallet-lab.html": "message" };
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
    expect(html).toContain('<a id="return-link" class="ap-btn">');
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

  it("the landing's live buttons go to the live pages, never to the removed demo (C-120, R-31)", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");

    expect(html).not.toContain('href="/consent"');
    expect(html).not.toContain('href="/sign"');
    // The closing button opens the RealOps pilot (C-120); the hero's goes to /en-vivo (R-31).
    const close = html.slice(html.indexOf('<div class="close">'));
    expect(close).toMatch(/<a class="btn" href="https:\/\/realops\.agentpey\.com">/);
    const hero = html.slice(html.indexOf('<header class="hero">'), html.indexOf("</header>"));
    expect(hero).toMatch(/<a class="btn" href="\/en-vivo">/);
  });

  // T185 review: the store prepares the transaction and is the party paid, so the page reads it before the wallet does.
  it("resolve/confirmar.html checks the store's transaction itself, against the escrow the assistant's link names", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "resolve/confirmar.html"), "utf8");
    expect(html).toContain('import { checkConfirmXdr } from "./confirmar.js";');
    expect(html).toContain("checkConfirmXdr(prepared.xdr, { escrow: escrow, orderId: order.orderId, source: address }) !== null");
    expect(html).toContain('query.get("escrow")');
    expect(html.indexOf("checkConfirmXdr(prepared.xdr")).toBeLessThan(html.indexOf("AgentpeyWallet.signTransaction"));
  });

  // T185: the evidence page hashes a file in the browser and sends it only to the store's dispute, never to a third party.
  it("resolve/evidencia.html hashes in the browser, shows the evidence code, and sends the file only to the store", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "resolve/evidencia.html"), "utf8");
    expect(html).toContain('crypto.subtle.digest("SHA-256"');
    expect(html).toContain('var CODE_PREFIX = "ap-evidence:v1:";');
    expect(html).toContain('from "./responder.js"');
    expect(html).toContain('storeCall("/evidence"');
    expect(html.match(/fetch\(/g)?.length).toBe(1);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).not.toMatch(/cdnjs|unpkg\.com|jsdelivr/);
    expect(html).not.toContain("\u2014");
    expect(html.match(/data-tr="es"/g)?.length).toBe(html.match(/data-tr="en"/g)?.length);
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

  // T207 (Y-7): the 3D scene gave way to the medal of the brand's posts; the landing loads no Three.js and no CDN script.
  it("landing.html draws its hero without Three.js or a CDN, with the brand's one stylesheet", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");
    expect(html).not.toContain("three.min.js");
    expect(html).not.toContain("scene.js");
    expect(html).not.toMatch(/cdnjs|unpkg\.com|jsdelivr/);
    expect(html).toContain('href="/brand/agentpey.css"');
    expect(html).toContain('class="medal"');
  });

  // T152: the landing's numbers are read live, never written by hand, and it points at the live pages.
  it("landing.html reads its hero numbers from /api/live and links to /en-vivo", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "landing.html"), "utf8");
    expect(html).toContain('fetch("/api/live"');
    for (const id of ["live-stores", "live-purchases", "live-usdc", "live-disputes"]) expect(html).toContain(`id="${id}">…</b>`);
    expect(html).not.toMatch(/id="stat-(tests|commits)"/);
    // Every text in English has its Spanish pair.
    expect(html.match(/data-tr="es"/g)?.length).toBe(html.match(/data-tr="en"/g)?.length);
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

  // Start-Up Chile page (apart from the Fase 10 sprint): the free audit form posts to /api/auditoria and shows answers as
  // text; the Stellar landing is one link away.
  it("comercios.html posts the demo request to /api/auditoria, never says audit to visitors, and writes nothing as HTML", async () => {
    const html = await readFile(resolve(PUBLIC_DIR, "comercios.html"), "utf8");
    expect(html).toContain('fetch("/api/auditoria"');
    expect(html.replace(/\/api\/auditoria/g, "")).not.toMatch(/auditor[ií]a/i);
    expect(html).toContain('href="/brand/agentpey.css"');
    expect(html).toContain('href="/stellar"');
    expect(html).toContain('name="sitio_web"');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).not.toMatch(/cdnjs|unpkg\.com|jsdelivr/);
    expect(html).not.toContain("\u2014");
  });
});
