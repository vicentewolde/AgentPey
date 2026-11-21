import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tienda } from "./base.js";
import { openDb } from "./db.js";
import { buildGuide, DISCLOSURE, GUIDE_RUBROS, guideHtml, INDEXNOW_KEY, sitemapXml, type GuideInput } from "./guia.js";
import { BRAND_ORDER_RULE, brandHtml, brandsIndexHtml, brandSlug, buildBrandPages, normalGtin, OFFERS_PER_STORE, summarize } from "./marcas.js";
import type { Product } from "./model.js";
import { importBrandPages, migrate, pgStore, sqliteStore, type Queryable } from "./store.js";

const tienda = (id: string, over: Partial<Tienda> = {}): Tienda => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), domain: `${id}.cl`, origin: `https://www.${id}.cl`, rubro: "Salud y Belleza",
  categories: ["Salud y Belleza"], platform: "shopify", segment: "pyme", bfSlug: id, bfLink: `https://${id}.cl`, checkedAt: "2026-11-18T03:00:00.000Z", ...over,
});

const product = (store: string, i: number, over: Partial<Product> = {}): Product => ({
  storeId: store, id: `${store}-${i}`, title: `Producto ${i}`, description: "", url: `https://${store}.cl/p/${i}`, images: [],
  price: 1000 * (i + 1), compareAtPrice: undefined, available: true, brand: undefined, sku: undefined, gtin: undefined,
  category: undefined, tags: [], attributes: {}, variants: [], ...over,
});

/** A store with `n` unbranded products (enough catalogue to be listed) plus the given ones. */
const store = (t: Tienda, extra: Partial<Product>[], readAt = "2026-11-18T05:00:00.000Z"): GuideInput => ({
  tienda: t, readAt,
  products: [...Array.from({ length: 10 }, (_, i) => product(t.id, i)), ...extra.map((e, i) => product(t.id, 100 + i, e))],
});

const lattafa = (price: number, over: Partial<Product> = {}): Partial<Product> => ({ brand: "Lattafa", title: `Lattafa ${price}`, price, ...over });

describe("which brands get a page", () => {
  const pages = buildBrandPages([
    store(tienda("alisha"), [lattafa(25990), lattafa(19990, { brand: "LATTAFA" }), { brand: "Solo Aqui", price: 5000 }]),
    store(tienda("perfumeria"), [lattafa(18990), { brand: "Genérico", price: 100 }, { brand: "Generico", price: 100 }]),
    store(tienda("piloto", { sources: ["piloto"] }), [lattafa(1000), { brand: "Solo Aqui", price: 4000 }]),
    store(tienda("grande", { segment: "grande" }), [lattafa(900)]),
    store(tienda("rota"), [lattafa(500, { url: "javascript:alert(1)" }), lattafa(0)]),
    store(tienda("agotada"), [lattafa(300, { available: false })]),
    { ...store(tienda("sinleer"), [lattafa(700)]), readAt: undefined },
  ], "2026-11-20");

  it("makes one page per brand two or more public stores sell with a price", () => {
    expect(pages.map((p) => p.slug)).toEqual(["lattafa"]);
  });

  it("merges the ways stores write it, and prefers the one not in capitals", () => {
    expect(pages[0]!.brand).toBe("Lattafa");
  });

  it("leaves out pilot-only and big stores, unread catalogues, bad links, zero prices, out of stock and generic brands", () => {
    expect(pages[0]!.stores.map((s) => s.id)).toEqual(["perfumeria", "alisha"]);
    expect(pages.some((p) => p.slug.startsWith("generic"))).toBe(false);
  });

  it("orders stores by their lowest price, and lists each store's cheapest first", () => {
    expect(pages[0]!.stores.map((s) => s.priceMin)).toEqual([18990, 19990]);
    expect(pages[0]!.stores[1]!.offers.map((o) => o.price)).toEqual([19990, 25990]);
  });

  it("dates every store by its own reading", () => {
    expect(pages[0]!.stores[0]!.readAt).toBe("2026-11-18");
  });
});

describe("the offers of a store", () => {
  it("shows at most a few, cheapest first, without the same listing twice, with the price before a sale", () => {
    const many = Array.from({ length: 9 }, (_, i) => lattafa(10000 + i * 1000));
    const [p] = buildBrandPages([
      store(tienda("uno"), [...many, lattafa(10000), lattafa(30000, { compareAtPrice: 40000 })]),
      store(tienda("dos"), [lattafa(30000, { compareAtPrice: 40000 })]),
    ], "2026-11-20");
    const uno = p!.stores.find((s) => s.id === "uno")!;
    expect(uno.offers).toHaveLength(OFFERS_PER_STORE);
    expect(uno.offers.map((o) => o.price)).toEqual([10000, 11000, 12000, 13000, 14000]);
    expect(uno.products).toBe(11);
    expect(p!.stores.find((s) => s.id === "dos")!.offers[0]).toMatchObject({ price: 30000, before: 40000 });
  });
});

describe("the same product in several stores", () => {
  it("puts the stores that carry the same barcode side by side, cheapest first", () => {
    const [p] = buildBrandPages([
      store(tienda("uno"), [lattafa(25990, { gtin: "06291108730515", title: "Khamrah 100 ml" }), lattafa(20000, { gtin: "6291108730515" })]),
      store(tienda("dos"), [lattafa(22990, { gtin: "6291108730515", title: "Lattafa Khamrah EDP 100ml" })]),
      store(tienda("tres"), [lattafa(15000, { gtin: "1111111111111" })]),
    ], "2026-11-20");
    expect(p!.same).toHaveLength(1);
    expect(p!.same[0]!.offers.map((o) => [o.storeId, o.price])).toEqual([["uno", 20000], ["dos", 22990]]);
  });

  it("only accepts real barcode lengths", () => {
    expect(normalGtin("0789-1234-5678-9")).toBe("789123456789");
    expect(normalGtin("RHD011")).toBeUndefined();
    expect(normalGtin("1155")).toBeUndefined();
    expect(normalGtin("0000000000000")).toBeUndefined();
  });
});

describe("slugs", () => {
  it("are plain and stable", () => {
    expect(brandSlug("Dolce & Gabbana")).toBe("dolce-y-gabbana");
    expect(brandSlug("L'Oréal Paris")).toBe("l-oreal-paris");
    expect(brandSlug("  Antü Baby ")).toBe("antu-baby");
  });
});

describe("the page", () => {
  const [p] = buildBrandPages([
    store(tienda("uno", { name: "Uno <b>&" }), [lattafa(25990, { title: "Khamrah <script>", gtin: "6291108730515" })]),
    store(tienda("dos"), [lattafa(22990, { gtin: "6291108730515" })]),
  ], "2026-11-20");
  const html = brandHtml(p!, GUIDE_RUBROS);

  it("says where to buy and from what price, with the disclosure, the order rule and the date", () => {
    expect(html).toContain("<h1>Dónde comprar Lattafa en Chile</h1>");
    expect(html).toContain("$22.990");
    expect(html).toContain(DISCLOSURE);
    expect(html).toContain(BRAND_ORDER_RULE);
    expect(html).toContain('<link rel="canonical" href="https://agentpey.com/chile/marcas/lattafa">');
    expect(html).toContain("confírmalos en la tienda");
  });

  it("carries Product and Offer data in pesos, and no other script", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="application/ld+json">']);
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!) as { mainEntity: { itemListElement: { item: { "@type": string; gtin?: string; offers: { "@type": string; lowPrice?: number; priceCurrency: string } } }[] } };
    const first = ld.mainEntity.itemListElement[0]!.item;
    expect(first).toMatchObject({ "@type": "Product", gtin: "6291108730515", offers: { "@type": "AggregateOffer", lowPrice: 22990, priceCurrency: "CLP" } });
  });

  it("escapes what stores write and has no score or em dash", () => {
    expect(html).toContain("Uno &lt;b&gt;&amp;");
    expect(html).not.toContain("<script>\"");
    expect(html).not.toContain("Khamrah <script>");
    expect(html).not.toMatch(/puntaje|\s\d+\/100\b|—/);
  });

  it("is listed in the index of brands, the sitemap and the guides", () => {
    expect(brandsIndexHtml([summarize(p!)])).toContain('<a href="https://agentpey.com/chile/marcas/lattafa">Lattafa</a>');
    expect(sitemapXml([], [summarize(p!)])).toContain("<loc>https://agentpey.com/chile/marcas/lattafa</loc><lastmod>2026-11-20</lastmod>");
    const g = buildGuide(GUIDE_RUBROS.find((r) => r.slug === "salud-y-belleza")!, [
      store(tienda("uno"), [lattafa(1000), lattafa(2000)]),
      store(tienda("dos"), [lattafa(1500), lattafa(2500)]),
    ], "2026-11-20");
    expect(guideHtml(g, GUIDE_RUBROS, new Set(["lattafa"]))).toContain('<a href="https://agentpey.com/chile/marcas/lattafa">Lattafa</a>');
    expect(guideHtml(g, GUIDE_RUBROS)).not.toContain("/chile/marcas/lattafa");
  });

  it("publishes an IndexNow key that only names pages under /chile", () => {
    expect(INDEXNOW_KEY).toMatch(/^[a-f0-9]{32}$/);
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

  it("imports the pages the CLI saved, replacing the previous ones, and serves them back checked", async () => {
    const local = openDb(":memory:");
    const pages = buildBrandPages([store(tienda("uno"), [lattafa(1000)]), store(tienda("dos"), [lattafa(2000)])], "2026-11-20");
    local.replaceBrandPages([{ slug: "vieja", brand: "Vieja", stores: 2, priceMin: 1, updatedAt: "2026-11-01", data: pages[0] }]);
    local.replaceBrandPages(pages.map((p) => ({ ...summarize(p), data: p })));
    expect(local.brandSummaries().map((b) => b.slug)).toEqual(["lattafa"]);
    expect(await sqliteStore(local).brandPage("lattafa")).toEqual(pages[0]);
    const q = pglite as unknown as Queryable;
    expect(await importBrandPages(q, local)).toBe(1);
    expect(await importBrandPages(q, local)).toBe(1);
    const pg = pgStore(q);
    expect(await pg.brandSummaries()).toEqual([summarize(pages[0]!)]);
    expect(await pg.brandPage("lattafa")).toEqual(pages[0]);
    expect(await pg.brandPage("no-existe")).toBeUndefined();
  });
});
