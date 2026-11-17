import { describe, expect, it } from "vitest";

import { openDb } from "./db.js";
import { conditionOf, openAiFeed, toOpenAiRow, validGtin } from "./feeds.js";
import { allowedByRobots, parseRobots } from "./http.js";
import { fromProductPage, fromShopify, fromVtex, fromWooCommerce, sitemapLocs } from "./ingest/platforms.js";
import { htmlToText, toClp, type Product, type Store } from "./model.js";
import { contradictsCondition, readiness } from "./readiness.js";

const store: Store = { id: "t", name: "Tienda T", origin: "https://t.cl", platform: "shopify", rubro: "audio", source: "piloto", sellsOnline: true };

const base: Product = {
  storeId: "t", id: "1", title: "Audífonos inalámbricos con cancelación de ruido", description: "x".repeat(200), url: "https://t.cl/products/a",
  images: ["https://t.cl/a.jpg"], price: 49990, compareAtPrice: undefined, available: true, brand: "Sony", sku: "A1", gtin: "4006381333931",
  category: "Audio > Audífonos", tags: [], attributes: { color: "negro", batería: "30 h" }, variants: [],
};

describe("prices in pesos", () => {
  it.each([
    ["12.990", 12990], ["$12.990", 12990], ["12990.00", 12990], ["1.299.990,00", 1299990], ["12990", 12990], [12990, 12990], ["", undefined], ["gratis", undefined],
  ])("%s → %s", (input, expected) => expect(toClp(input)).toBe(expected));
});

describe("platform mapping", () => {
  it("reads a Shopify product: cheapest variant, sale price, options as attributes", () => {
    const p = fromShopify("t", "https://t.cl", {
      id: 7, title: "Notebook", handle: "notebook", body_html: "<p>16 GB &amp; 512 GB</p>", vendor: "Lenovo", product_type: "Notebooks", tags: ["a", "b"],
      options: [{ name: "Color", values: ["Gris"] }, { name: "Title", values: ["Default Title"] }],
      variants: [{ id: 1, title: "Gris", price: "899990.00", compare_at_price: "999990.00", available: true, sku: "N1", barcode: "" }, { id: 2, title: "Azul", price: "949990", available: false }],
      images: [{ src: "https://cdn/x.jpg" }],
    });
    expect(p).toMatchObject({ id: "7", price: 899990, compareAtPrice: 999990, available: true, brand: "Lenovo", url: "https://t.cl/products/notebook", description: "16 GB & 512 GB", attributes: { Color: "Gris" } });
  });

  it("reads a WooCommerce Store API product with minor units", () => {
    const p = fromWooCommerce("t", {
      id: 3, name: "Arena &#8211; 10 kg", permalink: "https://t.cl/p/arena", sku: "AR", short_description: "<p>Aglomerante</p>",
      prices: { price: "1299000", regular_price: "1499000", currency_minor_unit: 2 }, is_in_stock: true,
      categories: [{ name: "Gatos" }, { name: "Arena" }], attributes: [{ name: "Peso", terms: [{ name: "10 kg" }] }], images: [],
    });
    expect(p).toMatchObject({ title: "Arena – 10 kg", price: 12990, compareAtPrice: 14990, category: "Gatos > Arena", attributes: { Peso: "10 kg" } });
  });

  it("reads a VTEX product with specifications", () => {
    const p = fromVtex("t", "https://t.cl", {
      productId: "9", productName: "Taladro", brand: "Bosch", link: "https://t.cl/taladro/p", description: "Taladro 750 W",
      categories: ["/Herramientas/", "/Herramientas/Eléctricas/"], allSpecifications: ["Potencia"], Potencia: ["750 W"],
      items: [{ itemId: "91", ean: "4006381333931", images: [{ imageUrl: "https://i/1.jpg" }], sellers: [{ commertialOffer: { Price: 59990, ListPrice: 69990, IsAvailable: true } }] }],
    });
    expect(p).toMatchObject({ price: 59990, compareAtPrice: 69990, available: true, category: "Herramientas > Eléctricas", attributes: { Potencia: "750 W" }, gtin: "4006381333931" });
  });

  it("reads schema.org Product from a page, including @graph and broken blocks", () => {
    const html = `<script type="application/ld+json">{broken</script>
      <script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Rascador","sku":"R1","brand":{"name":"Felix"},
      "image":["https://i/r.jpg"],"offers":{"price":"24990","availability":"https://schema.org/InStock"}}]}</script>`;
    expect(fromProductPage("t", "https://t.cl/rascador", html)).toMatchObject({ title: "Rascador", price: 24990, available: true, brand: "Felix", sku: "R1" });
    expect(fromProductPage("t", "https://t.cl/", "<html><title>Inicio</title></html>")).toBeUndefined();
  });

  it("reads sitemap locations", () => {
    expect(sitemapLocs("<urlset><url><loc>https://t.cl/a</loc></url><url><loc><![CDATA[https://t.cl/b?x=1&amp;y=2]]></loc></url></urlset>")).toEqual(["https://t.cl/a", "https://t.cl/b?x=1&y=2"]);
  });

  it("turns HTML into text", () => expect(htmlToText("<p>Hola&nbsp;<b>mundo</b></p><script>x()</script><p>chao</p>")).toBe("Hola mundo\nchao"));
});

describe("robots.txt", () => {
  const rules = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /checkout\nDisallow: /*?q=\nAllow: /");
  it("uses the * group when there is none for us", () => expect(rules).toEqual(["/checkout", "/*?q="]));
  it("blocks what it disallows and nothing else", () => {
    expect(allowedByRobots(rules, "/checkout/1")).toBe(false);
    expect(allowedByRobots(rules, "/search?q=x")).toBe(false);
    expect(allowedByRobots(rules, "/products.json")).toBe(true);
  });
});

describe("OpenAI feed and readiness", () => {
  it("validates GTIN check digits", () => {
    expect(validGtin("4006381333931")).toBe(true);
    expect(validGtin("4006381333932")).toBe(false);
    expect(validGtin("123")).toBe(false);
  });

  it("builds a valid row with a sale price and rejects rows without price or brand", () => {
    const { row, problems } = toOpenAiRow(store, { ...base, price: 39990, compareAtPrice: 49990 });
    expect(row).toMatchObject({ item_id: "t-1", price: "49990.00 CLP", sale_price: "39990.00 CLP", availability: "in_stock", seller_name: "Tienda T", gtin: "4006381333931" });
    expect(problems.filter((p) => p.level === "rechazo")).toEqual([]);
    const feed = openAiFeed(store, [base, { ...base, id: "2", price: undefined, brand: undefined }]);
    expect(feed.rejected).toBe(1);
    expect(feed.jsonl.trim().split("\n")).toHaveLength(1);
    expect(feed.problems.get("2")!.map((p) => p.field)).toEqual(expect.arrayContaining(["price", "brand"]));
  });

  it("states the condition and catches a used title with a 'new' description", () => {
    const used = { ...base, title: "Amplificador EXA100 (USADO)", description: "EQUIPO TOTALMENTE NUEVO" };
    expect(conditionOf(used)).toBe("used");
    expect(contradictsCondition(used)).toBe(true);
    expect(conditionOf({ ...base, title: "iPhone 13 reacondicionado" })).toBe("refurbished");
  });

  it("leaves Shopify's invisible barcodes out of the score", () => {
    const r = readiness(store, [{ ...base, gtin: undefined }]);
    expect(r.checks.find((c) => c.key === "gtin")!.notVisible).toBe(true);
    expect(r.score).toBe(100);
    expect(readiness({ ...store, platform: "woocommerce" }, [{ ...base, gtin: undefined }]).score).toBeLessThan(100);
  });

  it("scores a complete catalogue at 100 and an empty-ish one lower", () => {
    expect(readiness(store, [base]).score).toBe(100);
    const weak = readiness(store, [{ ...base, description: "", attributes: {}, brand: undefined, gtin: undefined, category: undefined }]);
    expect(weak.score).toBeLessThan(60);
    expect(weak.rejected).toBe(1);
  });
});

describe("local storage", () => {
  it("replaces a store's catalogue and remembers the run", () => {
    const db = openDb(":memory:");
    db.replaceCatalogue("t", [base, { ...base, id: "2" }], "test", ["nota"]);
    db.replaceCatalogue("t", [base], "test", []);
    expect(db.products("t")).toHaveLength(1);
    expect(db.lastRun("t")).toMatchObject({ method: "test", count: 1, notes: [] });
    db.close();
  });
});
