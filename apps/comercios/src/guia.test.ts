import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tienda } from "./base.js";
import { openDb } from "./db.js";
import { AI_CRAWLERS, brandLabel, buildGuide, categoryLabel, citations, DISCLOSURE, GUIDE_RUBROS, guideHtml, GuideSchema, MIN_PRICED, READ_CAP, robotsTxt, sitemapXml, type GuideInput } from "./guia.js";
import type { Product } from "./model.js";
import { importGuides, migrate, pgStore, sqliteStore, type Queryable } from "./store.js";

const SALUD = GUIDE_RUBROS.find((r) => r.slug === "salud-y-belleza")!;

const tienda = (id: string, over: Partial<Tienda> = {}): Tienda => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), domain: `${id}.cl`, origin: `https://www.${id}.cl`, rubro: "Salud y Belleza",
  categories: ["Salud y Belleza"], platform: "shopify", segment: "pyme", bfSlug: id, bfLink: `https://${id}.cl`, checkedAt: "2026-11-18T03:00:00.000Z", ...over,
});

const product = (store: string, i: number, over: Partial<Product> = {}): Product => ({
  storeId: store, id: `${store}-${i}`, title: `Producto ${i}`, description: "", url: `https://${store}.cl/p/${i}`, images: [],
  price: 1000 * (i + 1), compareAtPrice: undefined, available: true, brand: undefined, sku: undefined, gtin: undefined,
  category: undefined, tags: [], attributes: {}, variants: [], ...over,
});

const input = (t: Tienda, n: number, over: (i: number) => Partial<Product> = () => ({}), readAt = "2026-11-18T05:00:00.000Z"): GuideInput =>
  ({ tienda: t, products: Array.from({ length: n }, (_, i) => product(t.id, i, over(i))), readAt });

describe("which stores a guide lists, and in what order", () => {
  const inputs = [
    input(tienda("chica"), 20),
    input(tienda("grande"), 300),
    input(tienda("empate-b"), READ_CAP),
    input(tienda("empate-a"), READ_CAP),
    input(tienda("poca"), MIN_PRICED - 1),
    input(tienda("sinprecio"), 50, () => ({ price: undefined })),
    input(tienda("piloto", { sources: ["piloto"] }), 900),
    input(tienda("multitienda", { segment: "grande" }), 900),
    input(tienda("otro-rubro", { rubro: "Mascotas" }), 900),
    { ...input(tienda("sinleer"), 30), readAt: undefined },
  ];
  const g = buildGuide(SALUD, inputs, "2026-11-20");

  it("orders by products with a price, the reading cap as a tie broken by name", () => {
    expect(g.stores.map((s) => s.id)).toEqual(["empate-a", "empate-b", "grande", "chica"]);
    expect(g.stores[0]!.capped).toBe(true);
  });

  it("leaves out pilot-only stores, big stores, other rubros, unread catalogues and stores with too few prices", () => {
    const ids = g.stores.map((s) => s.id);
    for (const out of ["piloto", "multitienda", "otro-rubro", "sinleer", "poca", "sinprecio"]) expect(ids).not.toContain(out);
  });

  it("keeps one entry for a store listed twice, with both lists", () => {
    const twice = buildGuide(SALUD, [
      input(tienda("kallfu", { domain: "tiendakallfu.cl", name: "Kallfu" }), 418),
      input(tienda("cy-kallfu", { domain: "kallfu.cl", name: "Kallfu", sources: ["cyber"] }), 416),
    ], "2026-11-20");
    expect(twice.stores).toHaveLength(1);
    expect(twice.stores[0]).toMatchObject({ domain: "tiendakallfu.cl", lists: ["blackfriday", "cyber"] });
  });

  it("dates every store by its own reading", () => {
    const old = buildGuide(SALUD, [input(tienda("vieja"), 10, undefined, "2026-11-11T09:00:00.000Z"), input(tienda("nueva"), 10)], "2026-11-20");
    expect(old.stores.map((s) => s.readAt).sort()).toEqual(["2026-11-11", "2026-11-18"]);
    expect([old.readFrom, old.readTo]).toEqual(["2026-11-11", "2026-11-18"]);
  });
});

describe("what each store's entry says", () => {
  const t = tienda("alisha", { name: "Alisha Perfumes" });
  const g = buildGuide(SALUD, [
    input(t, 100, (i) => ({
      price: i === 0 ? 1 : 10_000 + i * 100,
      compareAtPrice: i < 30 ? 99_999 : undefined,
      category: i < 50 ? "Mujer > Perfumes" : i < 70 ? "PERFUME" : i < 90 ? "Cyber 2026" : "PACK001",
      brand: i < 60 ? "Lattafa" : i < 80 ? "Alisha Perfumes" : "Gift Card",
    })),
    input(tienda("otra"), 10, () => ({ brand: "LATTAFA" })),
  ], "2026-11-20");
  const s = g.stores.find((x) => x.id === "alisha")!;

  it("names what it sells and its brands as the store writes them, without audience, sale tags, codes or its own name", () => {
    expect(s.categories).toEqual(["Perfumes"]);
    expect(s.brands).toEqual(["Lattafa"]);
    expect(categoryLabel("Hombre > Vestuario > Poleras", t)).toBe("Poleras");
    expect(categoryLabel("Para Ella, Para Él", t)).toBeUndefined();
    expect(brandLabel("MS-0000-150", t)).toBeUndefined();
  });

  it("gives the 10–90% price band, which leaves out a $1 product", () => {
    expect(s.priceP10).toBeGreaterThan(10_000);
    expect(s.priceMedian).toBeGreaterThan(s.priceP10);
    expect(s.onSale).toBe(30);
  });

  it("lists a brand sold by two stores in the brand table", () => {
    expect(g.brands[0]).toMatchObject({ brand: "Lattafa" });
    expect(g.brands[0]!.stores.map((x) => x.id)).toEqual(["alisha", "otra"]);
  });
});

describe("the page", () => {
  const g = buildGuide(SALUD, [input(tienda("uno", { name: "Uno <b>&" }), 40), input(tienda("dos"), 30)], "2026-11-20");
  const html = guideHtml(g, GUIDE_RUBROS);

  it("shows the disclosure, the order rule, the update date and the method in the HTML itself", () => {
    expect(html).toContain(DISCLOSURE);
    expect(html).toContain("Cómo están ordenadas");
    expect(html).toContain('<time datetime="2026-11-20">20 de noviembre de 2026</time>');
    expect(html).toContain('id="metodologia"');
    expect(html).toContain('<link rel="canonical" href="https://agentpey.com/chile/salud-y-belleza">');
    expect(html).toContain('<a href="https://agentpey.com/chile/ropa-y-calzado">Ropa y calzado</a>');
  });

  it("needs no JavaScript: the only script is the structured data", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="application/ld+json">']);
  });

  it("carries a schema.org ItemList in the same order as the page", () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!) as { dateModified: string; mainEntity: { "@type": string; itemListElement: { position: number; item: { name: string; url: string } }[] } };
    expect(ld.dateModified).toBe("2026-11-20");
    expect(ld.mainEntity["@type"]).toBe("ItemList");
    expect(ld.mainEntity.itemListElement.map((x) => [x.position, x.item.url])).toEqual([[1, "https://www.uno.cl/"], [2, "https://www.dos.cl/"]]);
  });

  it("escapes store names and has no score, grade or em dash", () => {
    expect(html).toContain("Uno &lt;b&gt;&amp;");
    expect(html).not.toContain("<b>&");
    expect(html).not.toMatch(/puntaje \d|\/100|—/);
  });
});

describe("robots.txt and the sitemap", () => {
  it("names every AI crawler, opens the guides and keeps click redirects out", () => {
    const txt = robotsTxt();
    for (const ua of ["OAI-SearchBot", "ClaudeBot", "Google-Extended", "PerplexityBot"]) expect(AI_CRAWLERS).toContain(ua);
    for (const ua of AI_CRAWLERS) expect(txt).toContain(`User-agent: ${ua}\n`);
    expect(txt).toContain("Allow: /\n");
    expect(txt).toContain("Disallow: /ir/");
    expect(txt).not.toMatch(/Disallow: \/\s*$/m);
    expect(txt).toContain("Sitemap: https://agentpey.com/chile/sitemap.xml");
  });

  it("lists each guide with its date", () => {
    const xml = sitemapXml([{ slug: "salud-y-belleza", updatedAt: "2026-11-20" }]);
    expect(xml).toContain("<loc>https://agentpey.com/chile</loc><lastmod>2026-11-20</lastmod>");
    expect(xml).toContain("<loc>https://agentpey.com/chile/salud-y-belleza</loc><lastmod>2026-11-20</lastmod>");
  });
});

describe("from the local base to the panel's Postgres", () => {
  let pglite: PGlite;
  beforeAll(async () => {
    pglite = new PGlite();
    await migrate(pglite as unknown as Queryable);
  });
  afterAll(async () => {
    await pglite.close();
  });

  it("imports the guides the CLI saved and serves the same guide back, checked against its schema", async () => {
    const local = openDb(":memory:");
    const g = buildGuide(SALUD, [input(tienda("uno"), 40)], "2026-11-20");
    local.saveGuide(g.slug, g);
    expect(await sqliteStore(local).guides()).toEqual([g]);
    const q = pglite as unknown as Queryable;
    expect(await importGuides(q, local)).toEqual(["salud-y-belleza"]);
    expect(await importGuides(q, local)).toEqual(["salud-y-belleza"]); // a re-run replaces, not duplicates
    expect(await pgStore(q).guides()).toEqual([g]);
  });

  it("refuses a stored guide that does not match the schema", async () => {
    const local = openDb(":memory:");
    local.saveGuide("rota", { slug: "rota", stores: "no" });
    await expect(sqliteStore(local).guides()).rejects.toThrow();
    expect(() => GuideSchema.parse({ slug: "rota" })).toThrow();
  });

  it("drops a renamed guide from the local base, so it is not published again", () => {
    const local = openDb(":memory:");
    for (const slug of ["vestuario-y-calzado", "ropa-y-calzado"]) local.saveGuide(slug, {});
    expect(local.dropGuidesExcept(GUIDE_RUBROS.map((r) => r.slug))).toEqual(["vestuario-y-calzado"]);
    expect(local.guides().map((x) => x.slug)).toEqual(["ropa-y-calzado"]);
  });
});

describe("measuring the guide", () => {
  it("counts answers that cite agentpey.com, on any subdomain or written out, and the domains cited", () => {
    const c = citations([
      { text: "Mira falabella", urls: ["https://www.falabella.com/x", "https://falabella.com/y"] },
      { text: "Según la guía", urls: ["https://agentpey.com/chile/salud-y-belleza"] },
      { text: "Revisa agentpey.com", urls: [] },
      { text: "Otra", urls: ["https://panel.agentpey.com/x"] },
      { text: "agentpeyx.com no cuenta", urls: ["https://notagentpey.com/"] },
    ]);
    expect(c.agentpey).toBe(3);
    expect(c.domains).toContainEqual({ domain: "falabella.com", count: 1 });
    expect(c.domains.map((d) => d.domain)).toEqual(expect.arrayContaining(["agentpey.com", "panel.agentpey.com"]));
  });
});

describe("a store from a past edition of cyber.cl", () => {
  it("says so, and says nothing more when it is also on this year's list", () => {
    const g = buildGuide(SALUD, [
      input(tienda("antes", { sources: ["cyber-anterior"] }), 20),
      input(tienda("ahora", { sources: ["cyber", "cyber-anterior"] }), 20),
    ], "2026-11-22");
    expect(g.stores.find((s) => s.id === "antes")!.lists).toEqual(["cyber-anterior"]);
    expect(g.stores.find((s) => s.id === "ahora")!.lists).toEqual(["cyber"]);
    expect(guideHtml(g, GUIDE_RUBROS)).toContain("Aparece en ediciones anteriores de cyber.cl.");
  });
});
