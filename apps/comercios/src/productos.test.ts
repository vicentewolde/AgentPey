import { describe, expect, it } from "vitest";

import { DISCLOSURE } from "./guia.js";
import type { PriceRow } from "./precios.js";
import { BIG_RULE, MATCH_RULE, matchProducts, productHtml, productKey, productName, productsIndexHtml } from "./productos.js";

let n = 0;
const row = (store: string, title: string, price: number, brand?: string): PriceRow => ({
  storeId: store, store: store.toUpperCase(), domain: `${store}.cl`, title, brand, price, url: `https://${store}.cl/p/${++n}`, readAt: "2026-11-21",
});

describe("which titles are the same product", () => {
  it("reads house, name, concentration and size, whatever the store adds around them", () => {
    expect(productKey(row("a", "Perfume Lattafa Khamrah EDP 100 ML Unisex", 1))).toEqual({ house: "lattafa", name: "khamrah", concentration: "EDP", ml: 100 });
    expect(productKey(row("b", "Khamrah Lattafa Edp 100 Ml Unisex", 1))).toEqual(productKey(row("a", "LATTAFA KHAMRAH EDP 100ML", 1)));
    expect(productKey(row("c", "Perfume Club de Nuit Intense Overdose Extrait de Parfum 100 ml de Armaf para Hombre", 1))).toMatchObject({ house: "armaf", name: "club nuit intense overdose", concentration: "Extrait" });
    expect(productKey(row("d", "Lattafa Pride Art Of Universe EDP 100 ML", 1))).toEqual(productKey(row("e", "Art Of Universe Lattafa Edp 100Ml Unisex", 1)));
    expect(productKey(row("f", "Yara 100ML EDP Mujer", 1, "Lattafa"))).toMatchObject({ house: "lattafa", name: "yara" });
  });

  it("keeps variants apart: Khamrah, Khamrah Qahwa and 100 ml against 75 ml", () => {
    const k = productKey(row("a", "Lattafa Khamrah EDP 100 ML", 1));
    expect(productKey(row("a", "Lattafa Khamrah Qahwa EDP 100 ML", 1))).not.toEqual(k);
    expect(productKey(row("a", "Lattafa Khamrah EDP 75 ML", 1))).not.toEqual(k);
    expect(productKey(row("a", "Lattafa Khamrah EDT 100 ML", 1))).not.toEqual(k);
  });

  it("leaves out what is not one full bottle, a reference only, or not a pilot house", () => {
    for (const t of ["Decant Lattafa Khamrah 10 ml", "Lattafa Khamrah Tester EDP 100 ML", "Set Lattafa Yara EDP 100 ML + Body Mist", "Lattafa Yara Body Mist 250 ml", "Lattafa Khamrah EDP", "Lattafa Khamrah 100 ml y 50 ml", "Perfume Armaan EDP 100 ml - Inspirado en Khamrah", "Dior Sauvage EDP 100 ml"]) {
      expect(productKey(row("a", t, 1)), t).toBeUndefined();
    }
  });
});

describe("the groups", () => {
  const rows = [
    row("a", "Lattafa Khamrah EDP 100 ML", 30000), row("a", "Lattafa Khamrah EDP 100 ML Unisex", 28000),
    row("b", "Perfume Lattafa Khamrah 100 ml", 26000), row("c", "LATTAFA KHAMRAH EDP 100ML", 32000),
    row("d", "Lattafa Khamrah Qahwa EDP 100 ML", 35000), row("e", "Lattafa Khamrah Qahwa EDP 100 ML", 34000),
    row("a", "Lattafa Asad EDP 100 ML", 20000), row("b", "Lattafa Asad EDT 100 ML", 21000), row("c", "Lattafa Asad 100 ML", 22000), row("d", "Lattafa Asad EDP 100 ML", 23000),
  ];
  const groups = matchProducts(rows);

  it("take each store once at its lowest price, need three stores, and fill a missing concentration only when it is the only one", () => {
    expect(groups.map((g) => g.slug)).toEqual(["lattafa-khamrah-edp-100ml"]);
    expect(groups[0]!.offers.map((o) => [o.storeId, o.price])).toEqual([["b", 26000], ["a", 28000], ["c", 32000]]);
    expect(matchProducts(rows, 2).map((g) => g.slug)).toEqual(["lattafa-khamrah-edp-100ml", "lattafa-asad-edp-100ml", "lattafa-khamrah-qahwa-edp-100ml"]);
  });

  it("make a page with every store's price, the rules, schema.org data and the names each store uses", () => {
    const g = groups[0]!;
    expect(productName(g)).toBe("Lattafa Khamrah EDP 100 ml");
    const html = productHtml(g, "2026-11-22");
    expect(html).toContain("<title>Lattafa Khamrah EDP 100 ml: precio en 3 tiendas de Chile (2026) · AgentPey</title>");
    expect(html).toContain("$26.000");
    expect(html).toContain('"@type":"AggregateOffer"');
    expect(html).toContain('"lowPrice":26000');
    expect(html).toContain(DISCLOSURE);
    expect(html).toContain("Perfume Lattafa Khamrah 100 ml");
    expect(html).toContain(MATCH_RULE.slice(0, 40));
    expect(html).not.toMatch(/<script(?! type="application\/ld\+json")/);
    expect(html).not.toMatch(/—/);
    expect(productsIndexHtml(groups, "2026-11-22")).toContain('href="https://agentpey.com/chile/productos/lattafa-khamrah-edp-100ml"');
  });

  it("show big stores apart, only on products the pyme stores already make a page for, outside their order", () => {
    const big = [row("gr-paris", "Perfume Lattafa Khamrah 100 ml", 24000), row("gr-paris", "Lattafa Khamrah EDP 100 ML", 25000), row("gr-lider", "Lattafa Khamrah EDP 100ML", 29990), row("gr-lider", "Lattafa Yara EDP 100 ML", 20000)];
    const withBig = matchProducts(rows, 3, big);
    expect(withBig.map((g) => g.slug)).toEqual(["lattafa-khamrah-edp-100ml"]);
    expect(withBig[0]!.offers.map((o) => o.storeId)).toEqual(["b", "a", "c"]);
    expect(withBig[0]!.reference.map((o) => [o.storeId, o.price])).toEqual([["gr-paris", 24000], ["gr-lider", 29990]]);
    const html = productHtml(withBig[0]!, "2026-11-22");
    expect(html).toContain("En tiendas grandes, para comparar");
    expect(html).toContain("$2.000 menos que la tienda con sitio propio más barata");
    expect(html).toContain(BIG_RULE.slice(0, 40));
    expect(html).toContain('"offerCount":3');
    expect(productHtml(groups[0]!, "2026-11-22")).not.toContain("En tiendas grandes");
  });
});
