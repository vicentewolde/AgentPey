import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import type { Tienda } from "./base.js";
import { openDb } from "./db.js";
import { DISCLOSURE, guidesIndexHtml, sitemapXml } from "./guia.js";
import { brandsIndexHtml } from "./marcas.js";
import type { Product } from "./model.js";
import { buildPriceRows, COUNT_CAP, MAX_PRICE_CLP, MAX_TERMS, ownName, plausiblePrice, PriceRowSchema, SEARCH_ORDER_RULE, searchHtml, searchJson, searchTerms, searchText, searchUrl } from "./precios.js";
import { importPrices, migrate, pgStore, sqliteStore, type Queryable } from "./store.js";

const tienda = (id: string, over: Partial<Tienda> = {}): Tienda => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), domain: `${id}.cl`, origin: `https://www.${id}.cl`, rubro: "Salud y Belleza",
  categories: ["Salud y Belleza"], platform: "shopify", segment: "pyme", bfSlug: id, bfLink: `https://${id}.cl`, checkedAt: "2026-11-18T03:00:00.000Z", ...over,
});

const product = (store: string, i: number, over: Partial<Product> = {}): Product => ({
  storeId: store, id: `${store}-${i}`, title: `Producto ${i}`, description: "", url: `https://${store}.cl/p/${i}`, images: [],
  price: 1000 * (i + 1), compareAtPrice: undefined, available: true, brand: undefined, sku: undefined, gtin: undefined,
  category: undefined, tags: [], attributes: {}, variants: [], ...over,
});

const input = (t: Tienda, extra: Partial<Product>[]) => ({
  tienda: t, readAt: "2026-11-18T05:00:00.000Z",
  products: [...Array.from({ length: 10 }, (_, i) => product(t.id, i)), ...extra.map((e, i) => product(t.id, 100 + i, e))],
});

const inputs = [
  input(tienda("uno"), [
    { title: "Lattafa Khamrah EDP 100 ml", brand: "Lattafa", price: 25990, compareAtPrice: 32990 },
    { title: "Khamrah decant 5 ML", brand: "Lattafa", price: 4990 },
    { title: "Khamrah agotado", brand: "Lattafa", price: 100, available: false },
  ]),
  input(tienda("dos"), [
    { title: "Perfume Khamrah 100ml", brand: "Lattafa", price: 22990, gtin: "6291108730515" },
    { title: "Perfume Khamrah 100ml", brand: "Lattafa", price: 21990, url: "https://dos.cl/p/100" },
    { title: "Yara 150ml", brand: "Lattafa", price: 30000 },
    { title: "Mal enlace", price: 50, url: "javascript:alert(1)" },
    { title: "Khamrah mal leído", price: 9_999_999_000_000 },
    { title: "Khamrah consultar", price: 9_999_999 },
  ]),
  input(tienda("piloto", { sources: ["piloto"] }), [{ title: "Khamrah 100 ml", price: 1000 }]),
  input(tienda("grande", { segment: "grande" }), [{ title: "Khamrah 100 ml", price: 900 }]),
];
const rows = buildPriceRows(inputs);

describe("what the price search holds", () => {
  it("every in-stock product with a price of the public stores, and no pilot-only or big store", () => {
    const k = rows.filter((r) => r.text.includes("khamrah"));
    expect(k.map((r) => [r.row.storeId, r.row.price]).sort()).toEqual([["dos", 21990], ["uno", 25990], ["uno", 4990]]);
    expect(rows.some((r) => r.row.storeId === "piloto" || r.row.storeId === "grande")).toBe(false);
    expect(k.find((r) => r.row.price === 25990)!.row).toMatchObject({ before: 32990, readAt: "2026-11-18", domain: "uno.cl" });
    expect(rows.some((r) => r.row.url.startsWith("javascript"))).toBe(false);
    expect(rows.some((r) => r.row.price > MAX_PRICE_CLP || r.row.price === 9_999_999)).toBe(false);
    expect(plausiblePrice(53_990_000)).toBe(true);
    expect(() => PriceRowSchema.parse({ ...k[0]!.row, url: "javascript:alert(1)" })).toThrow();
  });

  it("keeps one row per address, at its lowest price", () => {
    expect(rows.filter((r) => r.row.url === "https://dos.cl/p/100").map((r) => r.row.price)).toEqual([21990]);
  });

  it("leaves out a store with no recent reading", () => {
    expect(buildPriceRows([{ ...input(tienda("vieja"), [{ title: "Khamrah", price: 1 }]), readAt: undefined }])).toEqual([]);
  });

  it("matches without accents or capitals, and \"100 ml\" as \"100ml\"", () => {
    expect(searchText("Crème Única 100 ML")).toBe("creme unica 100ml");
    expect(searchTerms("  Khamrah   100 ml ")).toEqual(["khamrah", "100ml"]);
    expect(searchTerms("a % _ ' ; --")).toEqual([]);
    expect(searchText(ownName("Perfume Armaan Ruh Al Oud EDP 100 ml Unisex - Inspirado en Khamrah"))).toBe("perfume armaan ruh al oud edp 100ml unisex");
    expect(ownName("Malaak Edp 100ml (Inspired by Khamrah)")).toBe("Malaak Edp 100ml");
    expect(searchText(ownName("Perfume X - tipo Khamrah"))).toBe("perfume x");
    for (const own of ["Lattafa Khamrah EDP 100 ML", "Polera tipo polo", "Cable USB tipo C", "Cama Tipo Sofa Ultra Suave", "PERFUME DUPE PARFUMS SALT WATER", "Boulevard. La versión de Flor. Libro 1", "Inspírate crema"]) {
      expect(ownName(own)).toBe(own);
    }
    expect(searchTerms("uno dos tres cuatro cinco seis siete ocho")).toHaveLength(MAX_TERMS);
  });
});

describe("searching", () => {
  it("finds rows with every word, cheapest first, the same in SQLite and Postgres", async () => {
    const local = openDb(":memory:");
    local.replacePrices(rows.map((r) => ({ storeId: r.row.storeId, text: r.text, price: r.row.price, data: r.row })));
    const lite = await sqliteStore(local).searchPrices(searchTerms("khamrah 100 ml"), 40);
    expect(lite.rows.map((r) => r.price)).toEqual([21990, 25990]);
    expect(lite.total).toBe(2);
    expect((await sqliteStore(local).searchPrices(searchTerms("50ml"), 40)).rows).toEqual([]);
    expect((await sqliteStore(local).searchPrices(["%", "_a", "kham'"], 40)).rows).toEqual([]);
    const pglite = new PGlite();
    const q = pglite as unknown as Queryable;
    await migrate(q);
    expect(await importPrices(q, local)).toBe(rows.length);
    expect(await importPrices(q, local)).toBe(rows.length);
    const pg = await pgStore(q).searchPrices(searchTerms("KHAMRAH"), 2);
    expect(pg.rows.map((r) => r.price)).toEqual([4990, 21990]);
    expect(pg.total).toBe(3);
    expect((await pgStore(q).searchPrices(searchTerms("150ml"), 40)).rows.map((r) => r.title)).toEqual(["Yara 150ml"]);
    expect((await pgStore(q).searchPrices(searchTerms("50ml"), 40)).rows).toEqual([]);
    expect(await pgStore(q).searchPrices(searchTerms("no existe"), 40)).toEqual({ total: 0, rows: [] });
    await pglite.close();
  }, 30_000);
});

describe("the search page", () => {
  const result = { query: "khamrah <b>", terms: ["khamrah", "b"], total: 1, rows: [{ ...rows.find((r) => r.row.storeId === "dos" && r.text.includes("khamrah"))!.row, title: "Khamrah <i>x</i>" }] };

  it("lists each result with its store, price and date, the order rule and the disclosure, and asks not to be indexed", () => {
    const html = searchHtml(result);
    expect(html).toContain("$21.990");
    expect(html).toContain("Khamrah &lt;i&gt;x&lt;/i&gt;");
    expect(html).toContain("Dos");
    expect(html).toContain('<time datetime="2026-11-18">');
    expect(html).toContain(SEARCH_ORDER_RULE);
    expect(html).toContain(DISCLOSURE);
    expect(html).toContain('<meta name="robots" content="noindex, follow">');
    expect(html).toContain("khamrah &lt;b&gt;");
    expect(html).not.toContain("khamrah <b>");
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/puntaje|—/);
  });

  it("the empty page may be indexed, and the box is on the guides and brand indexes", () => {
    expect(searchHtml(undefined)).toContain('<meta name="robots" content="index, follow">');
    const form = `action="${searchUrl()}" method="get"`;
    expect(guidesIndexHtml([], 0)).toContain(form);
    expect(brandsIndexHtml([])).toContain(form);
    expect(sitemapXml([], [{ slug: "lattafa", updatedAt: "2026-11-20" }])).toContain(`<loc>${searchUrl()}</loc>`);
  });

  it("gives the same results in JSON, with the rules", () => {
    const json = searchJson(result) as { results: { priceClp: number; store: string; url: string }[]; order: string; disclosure: string };
    expect(json.results).toEqual([expect.objectContaining({ priceClp: 21990, store: "Dos", url: "https://dos.cl/p/100" })]);
    expect(searchJson({ ...result, total: COUNT_CAP + 1 })).toMatchObject({ total: COUNT_CAP, totalIsAtLeast: true });
    expect(searchHtml({ ...result, total: COUNT_CAP + 1 })).toContain("Más de 1.000 productos");
    expect(json.order).toBe(SEARCH_ORDER_RULE);
    expect(json.disclosure).toBe(DISCLOSURE);
    expect(searchUrl("khamrah 100ml", true)).toBe("https://agentpey.com/chile/buscar?q=khamrah%20100ml&formato=json");
  });
});
