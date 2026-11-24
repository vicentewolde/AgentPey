import { describe, expect, it } from "vitest";

import type { Fetcher } from "../http.js";
import type { Store } from "../model.js";
import { CrawlQueue, FRUITLESS_PAGES, ingestStore, linkTier } from "./index.js";
import { fromMicrodata, fromProductPage } from "./platforms.js";

const store: Store = { id: "z", name: "Zapatos Z", origin: "https://z.cl", platform: "prestashop", rubro: "calzado", source: "black-friday", sellsOnline: true };

/** A fetcher over a fixed set of pages; anything else is a 404. */
function fakeFetcher(pages: Record<string, string>): Fetcher & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async text(url: string) {
      opened.push(url);
      const body = pages[url];
      return { status: body === undefined ? 404 : 200, body: body ?? "", url };
    },
    async json(url: string) {
      opened.push(url);
      return { status: 404, body: undefined, url };
    },
  };
}

const productPage = (name: string, price: number) =>
  `<script type="application/ld+json">{"@type":"Product","name":"${name}","offers":{"price":"${price}","availability":"https://schema.org/InStock"}}</script>`;

describe("crawl order", () => {
  it("ranks product pages, then listings, then the rest, and filtered copies last", () => {
    expect(linkTier("https://z.cl/producto/zapatos/1-2-zapato.html")).toBe(0);
    expect(linkTier("https://z.cl/products/zapato-negro")).toBe(0);
    expect(linkTier("https://z.cl/zapato-negro/p")).toBe(0);
    expect(linkTier("https://z.cl/detalle/galaxy-watch-9")).toBe(0);
    expect(linkTier("https://z.cl/ficha/4160/soporte")).toBe(0);
    expect(linkTier("https://z.cl/catalogo/33-zapatos-mujer")).toBe(1);
    expect(linkTier("https://z.cl/collections/verano")).toBe(1);
    expect(linkTier("https://z.cl/nosotros")).toBe(2);
    expect(linkTier("https://z.cl/catalogo/33-zapatos-mujer?feature=1")).toBe(3);
    expect(linkTier("no es una dirección")).toBe(3);
  });

  it("gives each address once, best tier first", () => {
    const q = new CrawlQueue();
    for (const u of ["https://z.cl/nosotros", "https://z.cl/catalogo/1-a", "https://z.cl/products/b", "https://z.cl/products/b", "https://z.cl/catalogo/1-a?x=1"]) q.push(u);
    expect(q.size).toBe(4);
    expect([q.shift(), q.shift(), q.shift(), q.shift(), q.shift()]).toEqual([
      "https://z.cl/products/b", "https://z.cl/catalogo/1-a", "https://z.cl/nosotros", "https://z.cl/catalogo/1-a?x=1", undefined,
    ]);
  });

  it("reaches the products behind many category links and their filtered copies", async () => {
    const categories = Array.from({ length: 40 }, (_, i) => `<a href="/catalogo/${i}-cat">c</a><a href="/catalogo/${i}-cat?feature=${i}">f</a>`).join("");
    const pages: Record<string, string> = {
      "https://z.cl/": `${categories}<a href="/content/4-nosotros">n</a>`,
      "https://z.cl/catalogo/0-cat": `${categories}<a href="https://z.cl/producto/a/1-zapato-negro.html#/talla-37">z</a><a href="/producto/a/2-zapato-blanco.html">z</a>`,
      "https://z.cl/producto/a/1-zapato-negro.html": productPage("Zapato negro", 49990),
      "https://z.cl/producto/a/2-zapato-blanco.html": productPage("Zapato blanco", 39990),
    };
    const fetcher = fakeFetcher(pages);
    const r = await ingestStore(store, fetcher, { maxPages: 2 });
    expect(r.products.map((p) => p.title).sort()).toEqual(["Zapato blanco", "Zapato negro"]);
    expect(fetcher.opened.filter((u) => u.includes("?feature"))).toEqual([]);
  });
});

describe("a home page on another host", () => {
  it("reads the site the home page leads to", async () => {
    const pages: Record<string, string> = {
      "https://tienda.z2.cl/": `<a href="https://tienda.z2.cl/products/bota">b</a><a href="https://otro.cl/products/x">x</a>`,
      "https://tienda.z2.cl/products/bota": productPage("Bota", 59990),
    };
    const base = fakeFetcher(pages);
    const fetcher: Fetcher = {
      text: async (url) => (url === "https://z.cl/" ? { ...(await base.text("https://tienda.z2.cl/")), url: "https://tienda.z2.cl/" } : base.text(url)),
      json: base.json,
    };
    const r = await ingestStore(store, fetcher, { maxPages: 5 });
    expect(r.products.map((p) => p.title)).toEqual(["Bota"]);
    expect(r.notes).toContain("La portada lleva a https://tienda.z2.cl");
    expect(base.opened).not.toContain("https://otro.cl/products/x");
  });
});

describe("a site without marked-up products", () => {
  it("stops crawling after FRUITLESS_PAGES pages without one", async () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < 400; i++) pages[i === 0 ? "https://z.cl/" : `https://z.cl/pagina-${i}`] = `<a href="/pagina-${i + 1}">s</a><a href="/pagina-${i + 2}">s</a>`;
    const fetcher = fakeFetcher(pages);
    const r = await ingestStore(store, fetcher, { maxPages: 200 });
    expect(r.products).toEqual([]);
    expect(fetcher.opened.filter((u) => /pagina-|z\.cl\/$/.test(u)).length).toBe(FRUITLESS_PAGES);
    expect(r.notes.some((n) => n.startsWith("Ningún producto"))).toBe(true);
  });
});

describe("microdata", () => {
  const html = `<html><head><meta property="og:image" content="https://z.cl/a.jpg"></head><body>
    <div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Bota &amp; cuero</h1>
      <span itemprop="sku">B-1</span>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <span itemprop="price" content="59990">$59.990</span>
        <link itemprop="availability" href="https://schema.org/InStock" content="https://schema.org/InStock">
      </div>
    </div></body></html>`;

  it("reads a product marked up with itemprop name and price", () => {
    expect(fromMicrodata("z", "https://z.cl/bota", html)).toMatchObject({ title: "Bota & cuero", price: 59990, sku: "B-1", available: true, images: ["https://z.cl/a.jpg"] });
    expect(fromProductPage("z", "https://z.cl/bota", html)).toMatchObject({ title: "Bota & cuero", price: 59990 });
  });

  it("reads the price from the element's text when there is no content attribute", () => {
    const text = `<div itemtype="http://schema.org/Product"><span itemprop="name">Bota</span><b itemprop="price">$ 12.990</b></div>`;
    expect(fromMicrodata("z", "https://z.cl/bota", text)).toMatchObject({ title: "Bota", price: 12990 });
  });

  it("needs a product type, a name and a price", () => {
    expect(fromMicrodata("z", "https://z.cl/", `<span itemprop="name">Inicio</span>`)).toBeUndefined();
    expect(fromMicrodata("z", "https://z.cl/", `<div itemtype="https://schema.org/Product"><span itemprop="name">Sin precio</span></div>`)).toBeUndefined();
  });
});
