import { describe, expect, it } from "vitest";

import { BIG_STORES, bigPriceRows, mayBeOneOf, namesPilotHouse, readBigStore } from "./grandes.js";
import type { Fetcher } from "./http.js";

const page = (name: string, price: number) => `<html><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name, brand: { "@type": "Brand", name: "Lattafa" }, offers: { "@type": "Offer", price, priceCurrency: "CLP", availability: "https://schema.org/InStock" } })}</script></html>`;

describe("big stores, for comparison", () => {
  it("open only addresses that name a pilot house as a word", () => {
    expect(namesPilotHouse("https://www.paris.cl/perfume-lattafa-khamrah-edp-100-ml-MK1.html")).toBe(true);
    expect(namesPilotHouse("https://www.paris.cl/al-haramain-amber-oud-edp-MK2.html")).toBe(true);
    expect(namesPilotHouse("https://www.paris.cl/zapatilla-emirates-MK3.html")).toBe(false);
    expect(namesPilotHouse("https://www.paris.cl/polera-camaras-MK4.html")).toBe(false);
    expect(namesPilotHouse("no es una url")).toBe(false);
  });

  it("read the product sitemaps the index lists, skip the rest, and keep each page's price", async () => {
    const store = { id: "gr-x", name: "X", domain: "x.cl", sitemap: "https://x.cl/index.xml", skip: /_3P/ };
    const bodies: Record<string, string> = {
      "https://x.cl/index.xml": "<sitemapindex><sitemap><loc>https://x.cl/productos_1P.xml</loc></sitemap><sitemap><loc>https://x.cl/productos_3P.xml</loc></sitemap><sitemap><loc>https://x.cl/categorias.xml</loc></sitemap></sitemapindex>",
      "https://x.cl/productos_1P.xml": "<urlset><url><loc>https://x.cl/lattafa-khamrah-edp-100ml</loc></url><url><loc>https://x.cl/polera-azul</loc></url></urlset>",
      "https://x.cl/lattafa-khamrah-edp-100ml": page("Lattafa Khamrah EDP 100 ml", 25990),
    };
    const asked: string[] = [];
    const fetcher: Fetcher = {
      text: async (url) => (asked.push(url), { status: url in bodies ? 200 : 404, body: bodies[url] ?? "", url }),
      json: async (url) => ({ status: 404, body: undefined, url }),
    };
    const r = await readBigStore(store, fetcher);
    expect(asked).toEqual(["https://x.cl/index.xml", "https://x.cl/productos_1P.xml", "https://x.cl/lattafa-khamrah-edp-100ml"]);
    expect(r.products.map((p) => [p.title, p.price])).toEqual([["Lattafa Khamrah EDP 100 ml", 25990]]);
    const rows = bigPriceRows(store, r.products, "2026-11-22T10:00:00Z");
    expect(rows).toMatchObject([{ storeId: "gr-x", store: "X", domain: "x.cl", price: 25990, readAt: "2026-11-22", brand: "Lattafa" }]);
    expect(bigPriceRows(store, r.products, undefined)).toEqual([]);
  });

  it("have ids apart from the pyme stores'", () => {
    expect(BIG_STORES.every((s) => s.id.startsWith("gr-"))).toBe(true);
  });
});

describe("which big-store pages are worth opening", () => {
  it("those naming the house, every name word and the size", () => {
    const may = mayBeOneOf([{ house: "lattafa", name: "khamrah", ml: 100 }, { house: "al haramain", name: "amber oud gold edition", ml: 60 }]);
    expect(may("https://www.paris.cl/perfume-lattafa-khamrah-edp-100-ml-unisex-MK1.html")).toBe(true);
    expect(may("https://www.paris.cl/lattafa-khamrah-qahwa-edp-100ml-MK2.html")).toBe(true); // the title decides later
    expect(may("https://www.paris.cl/lattafa-khamrah-edp-75-ml-MK3.html")).toBe(false);
    expect(may("https://www.paris.cl/lattafa-yara-edp-100-ml-MK4.html")).toBe(false);
    expect(may("https://www.paris.cl/al-haramain-amber-oud-gold-edition-edp-60ml-MK5.html")).toBe(true);
  });
});
