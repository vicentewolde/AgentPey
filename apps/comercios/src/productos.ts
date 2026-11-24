/**
 * One product across stores: the same perfume, concentration and size sold by
 * several public stores, so a page can say "Lattafa Khamrah EDP 100 ml: price
 * in N stores in Chile". A PILOT, for Arabic perfume houses only: titles there
 * follow brand + name + concentration + ml, and the same names repeat across
 * many pyme stores.
 *
 * Precision over reach: two titles are the same product only when, after
 * leaving out the words every store adds ("perfume", "unisex", "original"...),
 * the name words are exactly the same, with the same size and concentration.
 * "Khamrah", "Khamrah Qahwa" and "Khamrah Dukhan" stay three products. Decants,
 * testers, sets and body mists are left out: they are not the bottle.
 */
import { clp, DISCLOSURE, escapeHtml, FRESHNESS_RULE, guideUrl, longDate, num, searchForm } from "./guia.js";
import { brandUrl, pageHead } from "./marcas.js";
import { z } from "zod";

import { ownName, PriceRowSchema, searchText, type PriceRow } from "./precios.js";

/** Arabic perfume houses sold in Chile, as their names read once searchText-ed. */
export const PILOT_HOUSES = [
  "lattafa", "armaf", "afnan", "rasasi", "al haramain", "maison alhambra", "ard al zaafaran", "french avenue", "rayhaan",
  "fragrance world", "zimaya", "emir", "paris corner", "bharara", "orientica", "khadlaj", "nusuk", "asdaaf", "al wataniah",
  "swiss arabian", "ajmal", "riiffs", "fa paris", "pendora", "camara",
] as const;

/** Words stores add around a name that do not change which perfume it is. */
const FILLER = new Set(
  ("perfume perfumes parfum parfums perfum fragancia fragance fragrance eau de du la le el los las y e para for pour by of the " +
    "hombre hombres mujer mujeres men man women woman him her homme femme unisex unisexo masculino femenino caballero dama " +
    "original originales sellado sellada nuevo nueva new arabe arabes arabic importado " +
    "spray vapo vaporizador natural ml oz fl botella frasco").split(" "),
);
/** Not the full bottle, or not the perfume itself. */
const NOT_THE_BOTTLE = /\b(decant|decants|muestra|muestras|sample|samples|tester|testers|probador|set|sets|kit|pack|estuche|coffret|gift|regalo|body|mist|splash|desodorante|deo|deodorant|crema|locion|lotion|shower|gel|aceite|oil|attar|hair|cabello|mini|miniatura|travel|refill|recarga|vial|roll|combo|duo|trio|x2|x3|2x|3x)\b/;
const CONCENTRATION: readonly [RegExp, string][] = [
  [/\bextrait\b|\bextracto\b/, "Extrait"],
  [/\bedp\b|\beau de parfum\b|\beau de perfume\b/, "EDP"],
  [/\bedt\b|\beau de toilette\b/, "EDT"],
  [/\bedc\b|\beau de cologne\b/, "EDC"],
  [/\bparfum\b/, "Parfum"],
];

export interface ProductKey { readonly house: string; readonly name: string; readonly concentration: string; readonly ml: number }

/** What a title says it is, or undefined when it is not one full bottle of a pilot house's perfume. */
export function productKey(row: Pick<PriceRow, "title" | "brand">): ProductKey | undefined {
  // "Lattafa Pride" is Lattafa's premium line, written either way: one house.
  const text = searchText(ownName(row.title)).replace(/\blattafa pride\b/g, "lattafa");
  const brand = searchText(row.brand ?? "");
  const house = [...PILOT_HOUSES].sort((a, b) => b.length - a.length).find((h) => ` ${text} `.includes(` ${h} `) || brand === h || brand.startsWith(`${h} `));
  if (house === undefined || NOT_THE_BOTTLE.test(text)) return undefined;
  const sizes = [...new Set([...text.matchAll(/\b(\d{2,3})ml\b/g)].map((m) => Number(m[1])))];
  if (sizes.length !== 1) return undefined; // none, or two sizes in one title (a set, or a list)
  const ml = sizes[0]!;
  const concentration = CONCENTRATION.find(([re]) => re.test(text))?.[1] ?? "";
  const houseWords = new Set(house.split(" "));
  const words = text.split(" ").filter((w) => w !== "" && !houseWords.has(w) && !FILLER.has(w) && !/^\d+(ml|oz)$/.test(w) && w !== String(ml) && !["edp", "edt", "edc", "extrait", "extracto", "toilette", "cologne", "perfume"].includes(w));
  if (words.length === 0 || words.length > 4) return undefined; // no name, or a description rather than a name
  return { house, name: words.join(" "), concentration, ml };
}

const PerfumeKeySchema = z.object({ house: z.string(), name: z.string(), concentration: z.string(), ml: z.number().int().positive() });
/** A product of any kind known by its barcode (GTIN-14, zero-padded) and the name its stores give it. */
const CodeKeySchema = z.object({ gtin: z.string().regex(/^\d{14}$/), brand: z.string(), name: z.string() });
export type CodeKey = z.infer<typeof CodeKeySchema>;

export const ProductGroupSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  key: z.union([CodeKeySchema, PerfumeKeySchema]),
  /** One offer per store, its lowest price for that product, cheapest first. */
  offers: z.array(PriceRowSchema).min(1),
  /** The same product at big stores (multitiendas, pharmacies...), one per store, cheapest first: shown for comparison, outside the pyme order. */
  reference: z.array(PriceRowSchema).default([]),
});
export type ProductGroup = z.infer<typeof ProductGroupSchema>;

/** Whether a group is matched by barcode rather than by perfume name. */
export const isCodeKey = (k: ProductGroup["key"]): k is CodeKey => "gtin" in k;

const slugOf = (k: ProductKey) => [k.house, k.name, k.concentration, `${k.ml}ml`].filter((x) => x !== "").join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Pilot products in at least `minStores` stores. A missing concentration joins
 * the group of the same name and size only when that name has a single
 * concentration: "Khamrah 100ml" is the EDP when no store sells another.
 */
export function matchProducts(rows: readonly PriceRow[], minStores = 3, bigRows: readonly PriceRow[] = []): ProductGroup[] {
  const keyed = rows.map((row) => ({ row, key: productKey(row) })).filter((x): x is { row: PriceRow; key: ProductKey } => x.key !== undefined);
  const base = (k: ProductKey) => `${k.house}|${k.name}|${k.ml}`;
  const concentrations = new Map<string, Set<string>>();
  for (const { key } of keyed) if (key.concentration !== "") concentrations.set(base(key), (concentrations.get(base(key)) ?? new Set()).add(key.concentration));
  const groups = new Map<string, { key: ProductKey; byStore: Map<string, PriceRow> }>();
  for (const { row, key } of keyed) {
    let k = key;
    if (k.concentration === "") {
      const known = concentrations.get(base(k));
      if (known !== undefined && known.size > 1) continue; // ambiguous: EDP or EDT?
      if (known !== undefined) k = { ...k, concentration: [...known][0]! };
    }
    const id = slugOf(k);
    const g = groups.get(id) ?? { key: k, byStore: new Map<string, PriceRow>() };
    const prev = g.byStore.get(row.storeId);
    if (prev === undefined || row.price < prev.price) g.byStore.set(row.storeId, row);
    groups.set(id, g);
  }
  // Big stores only join a product the pyme stores already make a page for, by the same key and the same concentration rule.
  const reference = new Map<string, Map<string, PriceRow>>();
  for (const row of bigRows) {
    let k = productKey(row);
    if (k === undefined) continue;
    if (k.concentration === "") {
      // The same rule as the pyme stores': ambiguous is left out, a single known concentration fills it, none keeps it empty.
      const known = concentrations.get(base(k));
      if (known !== undefined && known.size > 1) continue;
      if (known !== undefined) k = { ...k, concentration: [...known][0]! };
    }
    const id = slugOf(k);
    const byStore = reference.get(id) ?? new Map<string, PriceRow>();
    const prev = byStore.get(row.storeId);
    if (prev === undefined || row.price < prev.price) byStore.set(row.storeId, row);
    reference.set(id, byStore);
  }
  const cheapestFirst = (a: PriceRow, b: PriceRow) => a.price - b.price || a.store.localeCompare(b.store);
  return [...groups]
    .filter(([, g]) => g.byStore.size >= minStores)
    .map(([slug, g]) => ({ slug, key: g.key, offers: [...g.byStore.values()].sort(cheapestFirst), reference: [...(reference.get(slug)?.values() ?? [])].sort(cheapestFirst) }))
    .sort((a, b) => b.offers.length - a.offers.length || a.slug.localeCompare(b.slug));
}

/** A valid GTIN-8/12/13/14 as 14 digits, or undefined (wrong length, all zeros or a bad check digit: often a SKU in the wrong field). */
export function normalGtin(raw: string | undefined): string | undefined {
  const g = (raw ?? "").trim();
  if (!/^(\d{8}|\d{12,14})$/.test(g) || /^0+$/.test(g)) return undefined;
  const d = g.padStart(14, "0").split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += d[i]! * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === d[13] ? g.padStart(14, "0") : undefined;
}

/** Prices for one barcode further apart than this are taken as a wrongly loaded code, and the page is not made. */
export const CODE_MAX_SPREAD = 3;

const mostCommon = (xs: readonly string[]): string | undefined => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]?.[0];
};

/**
 * Products of any rubro that `minStores` or more pyme stores sell under the
 * same valid barcode. Pilot perfumes are left to `matchProducts` (one page per
 * product). Big stores join a page by the same barcode, for comparison only.
 */
export function matchByCode(rows: readonly PriceRow[], minStores = 2, bigRows: readonly PriceRow[] = []): ProductGroup[] {
  const byCode = new Map<string, Map<string, PriceRow>>();
  const add = (into: Map<string, Map<string, PriceRow>>, row: PriceRow) => {
    const gtin = normalGtin(row.gtin);
    if (gtin === undefined) return;
    const byStore = into.get(gtin) ?? new Map<string, PriceRow>();
    const prev = byStore.get(row.storeId);
    if (prev === undefined || row.price < prev.price) byStore.set(row.storeId, row);
    into.set(gtin, byStore);
  };
  for (const row of rows) if (productKey(row) === undefined) add(byCode, row);
  const reference = new Map<string, Map<string, PriceRow>>();
  for (const row of bigRows) add(reference, row);
  const cheapestFirst = (a: PriceRow, b: PriceRow) => a.price - b.price || a.store.localeCompare(b.store);
  const out: ProductGroup[] = [];
  for (const [gtin, byStore] of byCode) {
    if (byStore.size < minStores) continue;
    const offers = [...byStore.values()].sort(cheapestFirst);
    if (offers.at(-1)!.price > offers[0]!.price * CODE_MAX_SPREAD) continue;
    const brand = mostCommon(offers.flatMap((o) => (o.brand === undefined ? [] : [o.brand.trim()]))) ?? "";
    const name = [...offers].map((o) => o.title.trim()).sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
    const words = `${searchText(name).includes(searchText(brand)) ? "" : brand} ${name}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70).replace(/-+$/, "");
    const slug = `${words === "" ? "producto" : words}-${gtin.replace(/^0+/, "")}`;
    const ref = [...(reference.get(gtin)?.values() ?? [])].filter((r) => !byStore.has(r.storeId)).sort(cheapestFirst);
    out.push({ slug, key: { gtin, brand, name }, offers, reference: ref });
  }
  return out.sort((a, b) => b.offers.length - a.offers.length || a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Rendering

export const productUrl = (slug?: string) => guideUrl(slug === undefined ? "productos" : `productos/${slug}`);

/** Words joining a name that the key leaves out ("Club de Nuit") are put back for the page. */
const CONNECTORS = new Set(["de", "du", "la", "le", "el", "of", "the", "y", "e"]);
const titleCase = (w: string) => (w.length <= 2 && CONNECTORS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));

/** "Lattafa Khamrah EDP 100 ml": the house as stores write it most, the name words in the order of the shortest title. */
export function productName(g: ProductGroup): string {
  if (isCodeKey(g.key)) return g.key.brand === "" || searchText(g.key.name).includes(searchText(g.key.brand)) ? g.key.name : `${g.key.brand} ${g.key.name}`;
  const houses = new Map<string, number>();
  for (const o of g.offers) if (o.brand !== undefined && searchText(o.brand) === g.key.house) houses.set(o.brand, (houses.get(o.brand) ?? 0) + 1);
  const houseLabel = [...houses].sort((a, b) => b[1] - a[1])[0]?.[0];
  const house = houseLabel !== undefined && houseLabel !== houseLabel.toUpperCase() ? houseLabel : g.key.house.split(" ").map(titleCase).join(" ");
  const nameWords = new Set(g.key.name.split(" "));
  const shortest = [...g.offers].map((o) => searchText(ownName(o.title)).split(" ")).sort((a, b) => a.length - b.length)[0]!;
  const first = shortest.findIndex((w) => nameWords.has(w));
  const last = shortest.findLastIndex((w) => nameWords.has(w));
  const span = first === -1 ? [...nameWords] : shortest.slice(first, last + 1).filter((w) => nameWords.has(w) || CONNECTORS.has(w));
  const name = new Set(span.filter((w) => nameWords.has(w))).size === nameWords.size ? span : [...nameWords];
  return [house, name.map(titleCase).join(" "), g.key.concentration, `${g.key.ml} ml`].filter((x) => x !== "").join(" ");
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
};

export const PRODUCT_ORDER_RULE = "Ordenadas del precio más bajo al más alto; a igual precio, por nombre de la tienda. El orden no depende de ninguna relación con las tiendas.";
export const MATCH_RULE = "Contamos como el mismo producto los que tienen el mismo nombre, la misma concentración (EDP, EDT, Extrait) y el mismo tamaño, sin importar cómo lo escribe cada tienda. No contamos decants, testers, sets ni body mists, ni los perfumes que el nombre solo menciona como referencia (\"inspirado en…\").";

export const CODE_RULE = `Contamos como el mismo producto los que llevan el mismo código de barras (GTIN o EAN) en los datos de la página de cada tienda. Si entre tiendas el precio de un mismo código difiere más de ${CODE_MAX_SPREAD} veces, no hacemos la página: suele ser un código mal cargado.`;
export const CODE_BIG_RULE = "Las tiendas grandes y las tiendas de las propias marcas van aparte, solo para comparar: leemos su catálogo público respetando su robots.txt, y las que nos bloquean no aparecen. En algunas de ellas el vendedor puede ser un tercero que vende en su sitio.";

export const BIG_RULE = "Las tiendas grandes (multitiendas y cadenas de farmacias y perfumerías) van aparte, solo para comparar: leemos las páginas de estos perfumes en su sitemap público, respetando su robots.txt, y las que nos bloquean no aparecen. En algunas de ellas el vendedor puede ser un tercero que vende en su sitio.";

/** One line comparing the cheapest pyme store with the cheapest big store. */
function bigSummary(pymeLow: number, big: PriceRow): string {
  const d = big.price - pymeLow;
  if (d === 0) return `La más barata, ${escapeHtml(big.store)}, lo tiene al mismo precio que la tienda con sitio propio más barata.`;
  return d > 0
    ? `La más barata, ${escapeHtml(big.store)}, lo vende a ${clp(big.price)}: ${clp(d)} más que la tienda con sitio propio más barata.`
    : `La más barata, ${escapeHtml(big.store)}, lo vende a ${clp(big.price)}: ${clp(-d)} menos que la tienda con sitio propio más barata.`;
}

/** The page of one product across stores: plain HTML, schema.org Product with an AggregateOffer. */
/** The newest reading among a product's offers: the date the page shows as its update. */
export const productUpdated = (g: ProductGroup): string => g.offers.map((o) => o.readAt).sort().at(-1)!;

export function productHtml(g: ProductGroup, today = productUpdated(g)): string {
  const name = productName(g);
  const pageUrl = productUrl(g.slug);
  const prices = g.offers.map((o) => o.price);
  const low = prices[0]!, high = prices.at(-1)!;
  const reads = g.offers.map((o) => o.readAt).sort();
  const description = `${name}: precio en ${g.offers.length} tiendas online de Chile, desde ${clp(low)} hasta ${clp(high)}. Precios de sus catálogos públicos, leídos el ${longDate(reads.at(-1)!)}.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": pageUrl,
    name,
    brand: { "@type": "Brand", name: isCodeKey(g.key) ? g.key.brand || name : name.split(" ").slice(0, g.key.house.split(" ").length).join(" ") },
    ...(isCodeKey(g.key) ? { gtin: g.key.gtin } : {}),
    url: pageUrl,
    offers: {
      "@type": "AggregateOffer", priceCurrency: "CLP", lowPrice: low, highPrice: high, offerCount: g.offers.length,
      offers: g.offers.map((o) => ({ "@type": "Offer", price: o.price, priceCurrency: "CLP", url: o.url, availability: "https://schema.org/InStock", seller: { "@type": "OnlineStore", name: o.store, url: `https://${o.domain}` } })),
    },
  };
  const rows = g.offers.map((o, i) => `<tr><td><a href="${escapeHtml(o.url)}">${escapeHtml(o.store)}</a>${i === 0 ? ' <span class="best">más barato</span>' : ""}<br><span class="muted">${escapeHtml(o.domain)}</span></td><td class="price">${clp(o.price)}${o.before === undefined ? "" : `<br><span class="muted"><s>${clp(o.before)}</s></span>`}</td><td><time datetime="${o.readAt}">${longDate(o.readAt)}</time></td></tr>`).join("");
  const titles = [...g.offers, ...g.reference].map((o) => `<li>${escapeHtml(o.store)}: ${escapeHtml(o.title)}</li>`).join("");
  const bigRows = g.reference.map((o) => `<tr><td><a href="${escapeHtml(o.url)}">${escapeHtml(o.store)}</a><br><span class="muted">${escapeHtml(o.domain)}</span></td><td class="price">${clp(o.price)}${o.before === undefined ? "" : `<br><span class="muted"><s>${clp(o.before)}</s></span>`}</td><td><time datetime="${o.readAt}">${longDate(o.readAt)}</time></td></tr>`).join("");
  const big = g.reference.length === 0 ? "" : `<h2 id="tiendas-grandes">En tiendas grandes, para comparar</h2>
<p>${g.reference.length === 1 ? "Una tienda grande lo vende" : `${g.reference.length} tiendas grandes lo venden`} con stock. ${bigSummary(low, g.reference[0]!)} No entran al orden de arriba, que es solo de tiendas con sitio propio.</p>
<div class="table-wrap"><table><thead><tr><th>Tienda grande</th><th>Precio</th><th>Leído el</th></tr></thead><tbody>${bigRows}</tbody></table></div>`;
  return `${pageHead(`${name}: precio en ${g.offers.length} tiendas de Chile (${today.slice(0, 4)}) · AgentPey`, description, pageUrl, jsonLd)}
<body>
<main>
<p class="eyebrow"><a href="${escapeHtml(productUrl())}">Productos</a> · actualizada el <time datetime="${today}">${longDate(today)}</time></p>
<h1>${escapeHtml(name)}: precio en Chile</h1>
<p class="lead">${g.offers.length} tiendas online chilenas con sitio propio lo venden con stock. El precio más bajo entre ellas es <span class="price">${clp(low)}</span> en ${escapeHtml(g.offers[0]!.store)}; el más alto, <span class="price">${clp(high)}</span>. La mitad lo vende a ${clp(median(prices))} o menos. Entre la tienda más barata y la más cara hay ${clp(high - low)} de diferencia.</p>
<p class="note">${escapeHtml(DISCLOSURE)}</p>
<div class="table-wrap"><table><thead><tr><th>Tienda</th><th>Precio</th><th>Leído el</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><strong>Cómo están ordenadas.</strong> ${escapeHtml(PRODUCT_ORDER_RULE)}</p>
${big}
<p class="muted">Son los precios que cada tienda publicaba el día que leímos su catálogo. Pueden haber cambiado: confírmalos en la tienda antes de comprar. Despacho y medios de pago no están incluidos.</p>
${searchForm()}
<h2 id="metodologia">Metodología</h2>
<ul>
<li><strong>Qué tiendas entran.</strong> Tiendas online chilenas con sitio propio de las listas públicas de participantes de blackfriday.cl y cyber.cl, actuales y de ediciones anteriores, sin grandes tiendas, multitiendas ni marketplaces. ${escapeHtml(isCodeKey(g.key) ? CODE_BIG_RULE : BIG_RULE)}</li>
<li><strong>El mismo producto.</strong> ${escapeHtml(isCodeKey(g.key) ? CODE_RULE : MATCH_RULE)}${isCodeKey(g.key) ? ` Código: ${g.key.gtin.replace(/^0+(?=\d{13}$)/, "")}.` : ""} Así lo nombra cada tienda:<ul>${titles}</ul></li>
<li><strong>Precios.</strong> En pesos chilenos, el más bajo de cada tienda para este producto el día de la lectura. No contamos productos agotados. "Antes" es el precio tachado que mostraba la tienda. ${escapeHtml(FRESHNESS_RULE)}</li>
<li><strong>Relación con AgentPey.</strong> ${escapeHtml(DISCLOSURE)} Nadie paga por aparecer.</li>
</ul>
<footer>
<p><a href="${escapeHtml(productUrl())}">Todos los productos</a> · <a href="${escapeHtml(brandUrl())}">Marcas</a> · <a href="${escapeHtml(guideUrl())}">Guías por rubro</a></p>
<p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos.</p>
</footer>
</main>
</body>
</html>
`;
}

/** Every product page: the perfumes by house, then the products matched by barcode by brand, each with its store count and lowest price. */
export function productsIndexHtml(groups: readonly ProductGroup[], today = groups.map(productUpdated).sort().at(-1) ?? ""): string {
  const perfumes = groups.filter((g) => !isCodeKey(g.key));
  const coded = groups.filter((g) => isCodeKey(g.key));
  const section = (gs: readonly ProductGroup[], label: (g: ProductGroup) => string) => {
    const by = new Map<string, ProductGroup[]>();
    for (const g of gs) by.set(label(g), [...(by.get(label(g)) ?? []), g]);
    return [...by].sort((a, b) => a[0].localeCompare(b[0], "es")).map(([h, list]) => `<h3>${escapeHtml(h)}</h3>
<ul>${[...list].sort((a, b) => a.slug.localeCompare(b.slug)).map((g) => `<li><a href="${escapeHtml(productUrl(g.slug))}">${escapeHtml(productName(g))}</a> <span class="muted">${g.offers.length} tiendas · desde ${clp(g.offers[0]!.price)}</span></li>`).join("")}</ul>`).join("\n");
  };
  const houseOf = (g: ProductGroup) => (isCodeKey(g.key) ? "" : g.key.house.split(" ").map(titleCase).join(" "));
  const brandOf = (g: ProductGroup) => (isCodeKey(g.key) && g.key.brand !== "" ? g.key.brand : "Otras marcas");
  return `${pageHead("Productos en Chile: el mismo producto comparado entre tiendas · AgentPey", `${num(groups.length)} productos que venden varias tiendas online chilenas, con el precio de cada tienda.`, productUrl())}
<body>
<main>
<p class="eyebrow"><a href="${escapeHtml(guideUrl())}">Guías AgentPey</a> · actualizada el <time datetime="${today}">${longDate(today)}</time></p>
<h1>El mismo producto, precio por tienda en Chile</h1>
<p class="lead">${num(groups.length)} productos que venden varias tiendas online chilenas con sitio propio. En cada uno, el precio de cada tienda, del más barato al más caro.</p>
<p class="note">${escapeHtml(DISCLOSURE)}</p>
<h2 id="perfumes">Perfumes árabes (${num(perfumes.length)})</h2>
<p class="muted">Tres o más tiendas. ${escapeHtml(MATCH_RULE)}</p>
${section(perfumes, houseOf)}
${coded.length === 0 ? "" : `<h2 id="por-codigo">Por código de barras (${num(coded.length)})</h2>
<p class="muted">Dos o más tiendas. ${escapeHtml(CODE_RULE)}</p>
${section(coded, brandOf)}`}
<footer><p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos.</p></footer>
</main>
</body>
</html>
`;
}
