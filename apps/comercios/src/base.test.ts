import { describe, expect, it } from "vitest";

import { compare, cyberRubro, findEmails, galleryName, mailableEmail, parseBlackFriday, parseBlackFridayGallery, parseCyber, presence, segmentOf, type StoreInput, type Tienda } from "./base.js";
import { correoTexto, csvIndex, fichaHtml, improvements, resumenMd } from "./ficha.js";
import { cliError, UsageLimitError } from "./llm.js";
import { readiness } from "./readiness.js";
import type { Product } from "./model.js";

describe("the store lists", () => {
  it("reads blackfriday.cl's brands, merging repeats and preferring the brand's own site over an affiliate link", () => {
    const data = { paginas: [], marcas: [
      { p: "bpets", n: "Bpets", l: "https://www.bpets.cl/", c: ["Mascotas"] },
      { p: "bpets", n: "Bpets", l: "https://www.bpets.cl/", c: ["Marketplaces y Grandes Tiendas"] },
      { p: "nike", n: "Nike", l: "https://soicos.com/x?u=nike", c: ["Deportes y Outdoor"] },
    ], fichas: { nike: { sitio: "https://www.nike.cl" } }, edit: { bpets: { que_vende: ["Alimento", "para perros"] } } };
    const entries = parseBlackFriday(`<script>var x = ${JSON.stringify(data)};</script>`);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ slug: "bpets", categories: ["Mascotas", "Marketplaces y Grandes Tiendas"], sells: "Alimento para perros" });
    expect(entries[1]!.link).toBe("https://www.nike.cl");
  });

  it("reads cyber.cl's brands out of the escaped page data", () => {
    const brands = [{ id: 7, name: "Laika ", url: "https://laikamascotas.cl/", category: { name: "Mascotas" } }, { id: 8, name: "Sin sitio", url: "", category: { name: "Hogar" } }];
    const html = `<script>self.__next_f.push([1,"${JSON.stringify({ brands }).replace(/"/g, '\\"')}"])</script>`;
    expect(parseCyber(html)).toEqual([{ id: 7, name: "Laika", url: "https://laikamascotas.cl/", category: "Mascotas" }]);
  });

  it("puts cyber.cl's categories in blackfriday.cl's rubros", () => {
    expect(cyberRubro("Hogar")).toEqual({ rubro: "Hogar y Decoración", segment: "pyme" });
    expect(cyberRubro("Inmobiliarias").segment).toBe("no-tienda");
    expect(cyberRubro("Multitiendas y Supermercados").segment).toBe("grande");
  });

  it("leaves out stores with no catalogue and keeps manual overrides", () => {
    const e = { slug: "x", name: "X", link: "https://x.cl", categories: ["Viajes y Turismo"] };
    expect(segmentOf(e, "x.cl")).toBe("no-tienda");
    expect(segmentOf({ ...e, categories: ["Mascotas"] }, "x.cl", { x: "grande" })).toBe("grande");
  });
});

describe("past editions of blackfriday.cl (the brand gallery)", () => {
  const item = (classes: string, href: string, alt: string, title: string) =>
    `<div class="modula-item modula-simple-link ${classes}" >\n<div class="modula-item-content"><a data-image-id="1" class="modula-simple-link" href="${href}" target="_blank"></a>\n<img loading="lazy" class="pic" alt="${alt}" data-full="x.webp" title="${title}" src="x.webp" /></div></div>`;
  const page = [
    item("jtg-filter-all jtg-filter-salud-y-belleza", "https://mycocos.cl/", "Ofertas BlackSale en My Cocos", "MyCOCOS en Black Sale"),
    item("jtg-filter-all jtg-filter-hogar-y-decoracion", "https://www.bekoko.cl/?utm_source=bf&amp;x=1", "BEKOKO en black friday 2022", "BEKOKO en black friday 2022"),
    item("jtg-filter-all jtg-filter-infantil", "https://www.bekoko.cl/", "", "logo-bekoko"),
    item("jtg-filter-all jtg-filter-marketplaces-y-grandes-tiendas", "https://ad.soicos.com/abc", "Ofertas Blackfriday en abcdin", "abcdin en Black Friday"),
    item("jtg-filter-all jtg-filter-", "https://www.blackfriday.cl/marcas/serta/", "Serta blackfriday", "Serta"),
    item("jtg-filter-all jtg-filter-inmobiliaria jtg-filter-nueva-cosa", "https://club.cl/", "Black Friday en Club Casas", "x"),
    item("other-item", "https://notabrand.cl/", "x", "y"),
  ].join("\n");

  it("keeps each brand once, with its site, name and categories, and leaves out affiliate links and blackfriday.cl's own pages", () => {
    const got = parseBlackFridayGallery(page);
    expect(got.map((e) => e.slug)).toEqual(["mycocos.cl", "bekoko.cl", "club.cl"]);
    expect(got[0]).toEqual({ slug: "mycocos.cl", name: "My Cocos", link: "https://mycocos.cl/", categories: ["Salud y Belleza"] });
    expect(got[1]!.name).toBe("BEKOKO");
    expect(got[1]!.link).toBe("https://www.bekoko.cl/?utm_source=bf&x=1");
    expect(got[1]!.categories).toEqual(["Hogar y Decoración", "Infantil y Juguetería"]);
    expect(got[2]!.categories).toEqual(["Inmobiliarias"]);
    expect(segmentOf(got[2]!, "club.cl")).toBe("no-tienda");
  });

  it("reads the brand's name from the logo's alt or title, and gives none when they only name a file", () => {
    expect(galleryName("Ofertas Blackfriday en Café d&#039;Lara", "")).toBe("Café d'Lara");
    expect(galleryName("", "Barocco Café Blackfriday 2022")).toBe("Barocco Café");
    expect(galleryName("Black Friday en Amayra", "")).toBe("Amayra");
    expect(galleryName("Biostream - BlackFriday 2022", "")).toBe("Biostream");
    expect(galleryName("", "Logo_aresti")).toBe("");
    expect(galleryName("", "Logo My Cocos en Black Sale")).toBe("My Cocos");
  });

  it("finds nothing on a page without the gallery", () => {
    expect(parseBlackFridayGallery("<html><body>sin galería</body></html>")).toEqual([]);
  });
});

describe("public contact addresses", () => {
  it("drops the JSON escape before an address and leaves out image names", () => {
    expect(findEmails('{"t":"Escríbenos\\ncontacto@volka.cl"} <img src="logo@2x.png"> <a href="mailto:Ventas@Volka.cl">')).toEqual(["contacto@volka.cl", "ventas@volka.cl"]);
  });

  it("uses only the store's own domain or a generic role address", () => {
    const page = "https://volka.cl/contacto";
    expect(mailableEmail([{ email: "soporte@getjusto.com", page }, { email: "diego@volka.cl", page }], "volka.cl")?.email).toBe("diego@volka.cl");
    expect(mailableEmail([{ email: "contacto.tienda@gmail.com", page }], "x.cl")?.email).toBe("contacto.tienda@gmail.com");
    expect(mailableEmail([{ email: "juan.perez@gmail.com", page }, { email: "mdeza@otra.com", page }], "x.cl")).toBeUndefined();
  });
});

const product = (id: string, extra: Partial<Product> = {}): Product => ({
  id, storeId: "a", url: `https://a.cl/p/${id}`, title: "Alimento para perro adulto 15 kg", description: "corto", price: 1000, currency: "CLP",
  images: ["https://a.cl/i.jpg"], attributes: {}, tags: [], ...extra,
} as Product);

const tienda = (id: string, name: string, domain: string, emails?: Tienda["emails"]): Tienda => ({
  id, name, domain, origin: `https://${domain}`, rubro: "Mascotas", categories: ["Mascotas"], platform: "shopify", segment: "pyme", bfSlug: id, bfLink: "",
  ...(emails ? { emails } : {}),
});

function input(t: Tienda, products: Product[], answers: { engine: string; text: string; urls: string[] }[]): StoreInput {
  const store = { id: t.id, name: t.name, origin: t.origin!, platform: "shopify" as const, rubro: t.rubro, source: "black-friday" as const, sellsOnline: true };
  return { tienda: t, store, readiness: products.length ? readiness(store, products) : undefined, products: products.length,
    answers: answers.map((a) => ({ ...a, question: "¿Dónde compro alimento para perro?", at: "2026-11-18T03:00:00Z" })), failed: 0 };
}

describe("the comparison by rubro and the sheet", () => {
  const a = tienda("a", "Alfa Mascotas", "alfa.cl", [{ email: "hola@alfa.cl", page: "https://alfa.cl/contacto" }]);
  const b = tienda("b", "Beta Pets", "beta.cl");
  const results = compare([
    input(a, [product("1"), product("2")], [
      { engine: "claude", text: "Te recomiendo Beta Pets y Falabella", urls: ["https://beta.cl/x", "https://www.falabella.com/y", "https://lider.cl/z"] },
      { engine: "chatgpt", text: "En Alfa Mascotas lo tienen", urls: ["https://alfa.cl/p/1"] },
    ]),
    input(b, [], [{ engine: "claude", text: "Prueba en Beta Pets", urls: ["https://beta.cl/"] }]),
  ]);
  const ra = results.find((r) => r.id === "a")!;

  it("counts the store's own answers and who shows up instead", () => {
    expect(ra).toMatchObject({ answers: 2, mentioned: 1, cited: 1, rubroStores: 2 });
    expect(ra.instead.map((i) => i.domain)).toEqual(expect.arrayContaining(["beta.cl", "falabella.com"]));
    expect(ra.example?.instead).toContain("beta.cl");
    expect(ra.rubroShare[0]!.id).toBe("b");
    expect(results.find((r) => r.id === "b")!.score).toBeUndefined();
  });

  it("writes a sheet with inline styles, the score, the dated-sample warning and the fixes", () => {
    const html = fichaHtml(ra, a, { at: "2026-11-18T03:00:00Z", method: "shopify", count: 2, notes: [] }, "2026-11-18");
    expect(html).not.toMatch(/<style|<link|<script/);
    expect(html).toContain(`${ra.score} / 100`);
    expect(html).toContain("no un ranking");
    expect(improvements(ra).length).toBeGreaterThan(0);
  });

  it("says so when the catalogue could not be read, without making up a score", () => {
    const rb = results.find((r) => r.id === "b")!;
    const html = fichaHtml(rb, b, { at: "2026-11-18", method: "falló", count: 0, notes: ["HTTP 403"] }, "2026-11-18");
    expect(html).toContain("No pudimos leer el catálogo");
    expect(html).toContain("HTTP 403");
  });

  it("drafts an email from the real sample, with the address's source and a way to opt out; with no address it says not to send", () => {
    const mail = correoTexto(ra, a, "2026-11-18");
    expect(mail).toContain("hola@alfa.cl  (fuente: https://alfa.cl/contacto)");
    expect(mail).toContain("BORRADOR");
    expect(mail).toMatch(/no quieres recibir más correos/);
    expect(mail).toContain("beta.cl");
    expect(correoTexto(results[1]!, b, "2026-11-18")).toContain("no enviar");
  });

  it("writes the CSV index with quoting and the summary by rubro", () => {
    expect(csvIndex(["a", "b"], [["x,y", 'di "hola"']])).toBe('a,b\n"x,y","di ""hola"""\n');
    expect(resumenMd(results, [a, b], new Map(), "2026-11-18")).toContain("### Mascotas");
  });
});

describe("the plan's usage limit", () => {
  it("is told apart from any other failed run", () => {
    expect(cliError({ subtype: "success", result: "You've hit your limit · resets 2:10am" })).toBeInstanceOf(UsageLimitError);
    expect(cliError({ subtype: "success", result: "You've hit your 5-hour limit · resets 3:10am (America/Santiago)" })).toBeInstanceOf(UsageLimitError);
    expect(cliError({ subtype: "error_max_turns", result: "" })).not.toBeInstanceOf(UsageLimitError);
  });
});

describe("a store that is also a product brand", () => {
  it("counts as recommended only when the answer sends the buyer to its own site", () => {
    const store = { id: "osoji", name: "Osoji", origin: "https://osoji.cl", platform: "shopify" as const, rubro: "Hogar", source: "black-friday" as const, sellsOnline: true };
    const elsewhere = presence(store, { engine: "claude", text: "El Osoji Mix OM6 está en Ripley", urls: ["https://simple.ripley.cl/robot-osoji"] });
    expect(elsewhere).toMatchObject({ mentioned: false, brandOnly: true, cited: false });
    const own = presence(store, { engine: "chatgpt", text: "Cómpralo en osoji.cl", urls: [] });
    expect(own).toMatchObject({ mentioned: true, brandOnly: false });
  });
});

describe("a repeated sample", () => {
  it("counts the questions asked twice to the same engine and how many changed verdict", () => {
    const t = tienda("a", "Alfa Mascotas", "alfa.cl");
    const [r] = compare([input(t, [], [
      { engine: "chatgpt", text: "en alfa.cl", urls: [] },
      { engine: "chatgpt", text: "en otro lado", urls: [] },
      { engine: "claude", text: "en otro lado", urls: [] },
    ])]);
    expect(r).toMatchObject({ repeated: 1, changed: 1, answers: 3, mentioned: 1 });
  });
});

describe("the one-page report", () => {
  it("fits the store's numbers, the rubro comparison and a way to talk, without making up a score", async () => {
    const { informeHtml } = await import("./ficha.js");
    const t = tienda("a", "Alfa Mascotas", "alfa.cl");
    const [r] = compare([input(t, [], [{ engine: "claude", text: "En falabella.com y lider.cl", urls: ["https://falabella.com/x", "https://lider.cl/y"] }])]);
    const html = informeHtml(r!, t, undefined, "2026-11-18");
    expect(html).toContain("@page{size:A4");
    expect(html).toContain("Ninguna respuesta envió al comprador a alfa.cl");
    expect(html).toContain("No alcanzamos a leer tu catálogo");
    expect(html).toContain("vicente@agentpey.com");
  });
});

describe("the rubro's general questions", () => {
  it("rank the sites the AI sends buyers to and count the store's own", () => {
    const t = tienda("a", "Alfa Mascotas", "alfa.cl");
    const general = new Map([["Mascotas", [
      { engine: "claude", question: "¿Dónde compro alimento?", text: "x", urls: ["https://www.falabella.com/a", "https://alfa.cl/p"], at: "2026-11-18" },
      { engine: "claude", question: "¿Arena para gato?", text: "x", urls: ["https://falabella.com/b", "https://www.google.com/s"], at: "2026-11-18" },
    ]]]);
    const [r] = compare([input(t, [], [])], general);
    expect(r!.general).toEqual({ answers: 2, mentioned: 1, top: [{ domain: "falabella.com", count: 2 }, { domain: "alfa.cl", count: 1 }] });
  });
});
