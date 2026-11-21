import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { openDb } from "./db.js";
import { BUILD_READ_AGE_DAYS, buildGuide, FRESHNESS_RULE, freshReadAt, GUIDE_RUBROS, guideHtml, MAX_READ_AGE_DAYS } from "./guia.js";
import { brandHtml, buildBrandPages } from "./marcas.js";
import type { Product } from "./model.js";
import { MIN_PREVIOUS, publishDrop, rereadVerdict } from "./semanal.js";
import { importBrandPages, importGuides, migrate, publishedTotals, type Queryable } from "./store.js";

const product = (store: string, i: number): Product => ({
  storeId: store, id: `${store}-${i}`, title: `Lattafa ${i}`, description: "", url: `https://${store}.cl/p/${i}`, images: [],
  price: 1000 * (i + 1), compareAtPrice: undefined, available: true, brand: "Lattafa", sku: undefined, gtin: undefined,
  category: undefined, tags: [], attributes: {}, variants: [],
});

describe("a weekly re-read", () => {
  it("replaces a catalogue when it reads about as much as before, or the store is new", () => {
    expect(rereadVerdict(400, 380)).toEqual({ replace: true });
    expect(rereadVerdict(400, 1500)).toEqual({ replace: true });
    expect(rereadVerdict(0, 3)).toEqual({ replace: true });
    expect(rereadVerdict(MIN_PREVIOUS - 1, 1)).toEqual({ replace: true });
  });

  it("keeps the previous reading when it fails or reads less than half", () => {
    expect(rereadVerdict(400, undefined)).toMatchObject({ replace: false, reason: "la lectura falló" });
    expect(rereadVerdict(400, 150)).toMatchObject({ replace: false, reason: "leyó 150 productos, antes 400" });
    expect(rereadVerdict(400, 0)).toMatchObject({ replace: false });
  });

  it("takes the same smaller size two weeks running as the store's real size, so it does not stay frozen and vanish", () => {
    expect(rereadVerdict(400, 120, 130)).toEqual({ replace: true });
    expect(rereadVerdict(400, 120, 300)).toMatchObject({ replace: false });
    expect(rereadVerdict(400, 120, undefined)).toMatchObject({ replace: false });
  });

  it("dates a store by its last reading that replaced the catalogue, not by a kept or failed one", () => {
    const db = openDb(":memory:");
    db.replaceCatalogue("uno", [product("uno", 1)], "shopify products.json", []);
    const good = db.lastGoodRun("uno")!;
    db.recordKeptRun("uno", "conservado", 0, ["leyó 0 productos, antes 400"]);
    db.recordKeptRun("uno", "falló", 0, ["timeout"]);
    expect(db.lastGoodRun("uno")).toEqual(good);
    expect(db.lastRun("uno")!.method).toBe("falló");
    expect(db.products("uno")).toHaveLength(1);
    db.replaceCatalogue("dos", [], "falló", ["timeout"]);
    expect(db.lastGoodRun("dos")).toBeUndefined();
  });
});

describe("how old a reading may be", () => {
  it(`builds with readings up to ${BUILD_READ_AGE_DAYS} days old, so a page left up for a week never shows one older than ${MAX_READ_AGE_DAYS}`, () => {
    expect(BUILD_READ_AGE_DAYS + 7).toBe(MAX_READ_AGE_DAYS);
    expect(freshReadAt("2026-11-18T05:00:00.000Z", "2026-11-20")).toBe("2026-11-18T05:00:00.000Z");
    expect(freshReadAt("2026-11-01T23:59:00.000Z", "2026-11-15")).toBe("2026-11-01T23:59:00.000Z");
    expect(freshReadAt("2026-11-01T00:00:00.000Z", "2026-11-16")).toBeUndefined();
    expect(freshReadAt(undefined, "2026-11-20")).toBeUndefined();
  });

  it("says so on the guides and on the brand pages", () => {
    const t = (id: string) => ({
      id, name: id, domain: `${id}.cl`, origin: `https://www.${id}.cl`, rubro: "Salud y Belleza", categories: ["Salud y Belleza"],
      platform: "shopify" as const, segment: "pyme" as const, bfSlug: id, bfLink: `https://${id}.cl`, checkedAt: "2026-11-18T03:00:00.000Z",
    });
    const inputs = ["uno", "dos"].map((id) => ({ tienda: t(id), readAt: "2026-11-18T05:00:00.000Z", products: Array.from({ length: 10 }, (_, i) => product(id, i)) }));
    const g = buildGuide(GUIDE_RUBROS.find((r) => r.slug === "salud-y-belleza")!, inputs, "2026-11-20");
    expect(guideHtml(g, GUIDE_RUBROS)).toContain(FRESHNESS_RULE);
    expect(brandHtml(buildBrandPages(inputs, "2026-11-20")[0]!, GUIDE_RUBROS)).toContain(FRESHNESS_RULE);
  });
});

describe("publishing the week's pages", () => {
  it("refuses a publish that drops the stores or the brand pages by more than the limit", () => {
    expect(publishDrop({ guideStores: 133, brands: 1028, prices: 160000 }, { guideStores: 130, brands: 1000, prices: 150000 }, 30)).toBeUndefined();
    expect(publishDrop({ guideStores: 133, brands: 1028, prices: 160000 }, { guideStores: 0, brands: 0, prices: 0 }, 30)).toBe("tiendas en las guías: 0, antes 133 (cae más de 30%)");
    expect(publishDrop({ guideStores: 133, brands: 1028, prices: 160000 }, { guideStores: 133, brands: 600, prices: 160000 }, 30)).toMatch(/^páginas de marcas/);
    expect(publishDrop({ guideStores: 0, brands: 0, prices: 0 }, { guideStores: 5, brands: 2, prices: 9 }, 30)).toBeUndefined();
    expect(publishDrop({ guideStores: 133, brands: 1028, prices: 160000 }, { guideStores: 133, brands: 1028, prices: 1000 }, 30)).toMatch(/^precios del buscador/);
  });

  it("reads what Postgres publishes now", async () => {
    const pglite = new PGlite();
    const q = pglite as unknown as Queryable;
    await migrate(q);
    expect(await publishedTotals(q)).toEqual({ guideStores: 0, brands: 0, prices: 0 });
    const t = (id: string) => ({
      id, name: id, domain: `${id}.cl`, origin: `https://www.${id}.cl`, rubro: "Salud y Belleza", categories: ["Salud y Belleza"],
      platform: "shopify" as const, segment: "pyme" as const, bfSlug: id, bfLink: `https://${id}.cl`, checkedAt: "2026-11-18T03:00:00.000Z",
    });
    const inputs = ["uno", "dos"].map((id) => ({ tienda: t(id), readAt: "2026-11-18T05:00:00.000Z", products: Array.from({ length: 10 }, (_, i) => product(id, i)) }));
    const local = openDb(":memory:");
    const g = buildGuide(GUIDE_RUBROS.find((r) => r.slug === "salud-y-belleza")!, inputs, "2026-11-20");
    local.saveGuide(g.slug, g);
    local.replaceBrandPages(buildBrandPages(inputs, "2026-11-20").map((p) => ({ slug: p.slug, brand: p.brand, stores: p.stores.length, priceMin: p.stores[0]!.priceMin, updatedAt: p.updatedAt, data: p })));
    await importGuides(q, local);
    await importBrandPages(q, local);
    expect(await publishedTotals(q)).toEqual({ guideStores: 2, brands: 1, prices: 0 });
    await pglite.close();
  }, 30_000);
});
