/**
 * Price search at agentpey.com/chile/buscar?q=…: every in-stock product with a
 * price of the public stores (the same stores the guides may name), cheapest
 * first, with its store, its price and the date it was read. HTML for people
 * and for assistants that browse; `&formato=json` for programs. Built by
 * `cli base guia` with the pages, published with them (`setup-postgres --guias`).
 */
import { z } from "zod";

import { clp, DISCLOSURE, escapeHtml, FRESHNESS_RULE, guideUrl, keptStores, longDate, num, searchForm, searchUrl, STYLE, type GuideInput } from "./guia.js";

export { searchForm, searchUrl };

/** Results shown for one search: the cheapest ones. */
export const SEARCH_LIMIT = 40;
/** At most this many words of a query are used. */
export const MAX_TERMS = 6;
export const SEARCH_ORDER_RULE = "Ordenados del precio más bajo al más alto; a igual precio, en el orden de las guías. El orden no depende de ninguna relación con las tiendas.";
/** Matches are counted up to this many: past it the page says "más de". */
export const COUNT_CAP = 1000;
/**
 * Prices the search believes: above this (CLP) a reading is a misread, not a
 * price (one store came back a million times too high), and a row of nines is
 * a placeholder some stores use for "ask us".
 */
export const MAX_PRICE_CLP = 500_000_000;
export function plausiblePrice(price: number): boolean {
  return price > 0 && price <= MAX_PRICE_CLP && !/^9{6,}$/.test(String(Math.round(price)));
}

export const PriceRowSchema = z.object({
  storeId: z.string(),
  store: z.string(),
  domain: z.string(),
  title: z.string(),
  brand: z.string().optional(),
  price: z.number().int().positive(),
  before: z.number().int().positive().optional(),
  url: z.string().url().regex(/^https?:\/\//),
  gtin: z.string().optional(),
  readAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type PriceRow = z.infer<typeof PriceRowSchema>;

/** Lowercase, no accents, words split by one space, "100 ml" written "100ml": what both the rows and the queries are matched on. */
export function searchText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/(\d) (ml|cc|l|lt|g|gr|kg|mg|cm|mm|m|oz|un|u)\b/g, "$1$2")
    .trim();
}

/** Phrases that introduce another product named only as a reference; "tipo" only after a separator ("Perfume X - tipo Khamrah", not "Cable tipo C"). */
const REFERENCE = /(?:^|[\s(\[,|–-])(?:inspirad[oa]s?\s+(?:en|por)|inspired\s+by|similar(?:es)?\s+a|alternativa\s+a|equivalente\s+a|dupe\s+(?:de|of)|(?<=[(\[,|–-]\s*)tipo)(?=\s)[\s\S]*$/i;

/**
 * A title without the product it only names as a reference ("Perfume Armaan,
 * inspirado en Khamrah"): searching for Khamrah must not list what is not Khamrah.
 */
export function ownName(title: string): string {
  const own = title.replace(REFERENCE, "").trim();
  return own === "" ? title : own;
}

/** Terms the stores accept: only what searchText leaves, so LIKE sees no wildcard whoever calls it. */
export function cleanTerms(terms: readonly string[]): string[] {
  return terms.filter((t) => /^[a-z0-9]{2,}$/.test(t)).slice(0, MAX_TERMS);
}

/** The words of a query (at least two characters each, at most MAX_TERMS), or none. */
export function searchTerms(q: string): string[] {
  return [...new Set(searchText(q.slice(0, 200)).split(" ").filter((w) => w.length >= 2))].slice(0, MAX_TERMS);
}

/** One row per in-stock product with a price and a web address, of the stores the guides may name (keptStores). */
export function buildPriceRows(inputs: readonly GuideInput[]): { row: PriceRow; text: string }[] {
  const out: { row: PriceRow; text: string }[] = [];
  for (const { store, input } of keptStores(inputs)) {
    // One row per address, at its lowest price: the page promises "el precio más bajo de cada producto".
    const cheapest = new Map<string, (typeof input.products)[number]>();
    for (const p of input.products) {
      if (p.price === undefined || !plausiblePrice(p.price) || p.available === false || !/^https?:\/\//.test(p.url)) continue;
      const prev = cheapest.get(p.url);
      if (prev === undefined || p.price < prev.price!) cheapest.set(p.url, p);
    }
    for (const p of cheapest.values()) {
      const price = Math.round(p.price!);
      const before = p.compareAtPrice !== undefined && p.compareAtPrice > p.price! ? Math.round(p.compareAtPrice) : undefined;
      const row: PriceRow = {
        storeId: store.id, store: store.name, domain: store.domain, title: p.title.trim().slice(0, 200), price, url: p.url, readAt: store.readAt,
        ...(p.brand === undefined || p.brand.trim() === "" ? {} : { brand: p.brand.trim() }),
        ...(before === undefined ? {} : { before }),
        ...(p.gtin === undefined ? {} : { gtin: p.gtin }),
      };
      out.push({ row, text: searchText(`${ownName(row.title)} ${row.brand ?? ""}`) });
    }
  }
  return out;
}

export interface SearchResult { readonly query: string; readonly terms: readonly string[]; readonly total: number; readonly rows: readonly PriceRow[] }

/** The JSON answer: the same rows as the page, with the rules that apply to them. */
export function searchJson(r: SearchResult): unknown {
  return {
    query: r.query, total: Math.min(r.total, COUNT_CAP), totalIsAtLeast: r.total > COUNT_CAP, shown: r.rows.length, order: SEARCH_ORDER_RULE, freshness: FRESHNESS_RULE, disclosure: DISCLOSURE,
    note: "Precios en pesos chilenos tal como cada tienda los publicaba el día de la lectura. Confírmalos en la tienda antes de comprar.",
    results: r.rows.map((x) => ({ title: x.title, brand: x.brand, store: x.store, domain: x.domain, priceClp: x.price, beforeClp: x.before, url: x.url, gtin: x.gtin, readAt: x.readAt })),
  };
}

export function searchHtml(r: SearchResult | undefined): string {
  const q = r?.query ?? "";
  const title = q === "" ? "Buscar precios en tiendas online de Chile · AgentPey" : `${q}: precios en tiendas online de Chile · AgentPey`;
  const rows = r?.rows.map((x) => `<tr><td><a href="${escapeHtml(x.url)}">${escapeHtml(x.title)}</a>${x.brand === undefined ? "" : `<br><span class="muted">${escapeHtml(x.brand)}</span>`}</td><td>${escapeHtml(x.store)}<br><span class="muted">${escapeHtml(x.domain)}</span></td><td class="price">${clp(x.price)}${x.before === undefined ? "" : `<br><span class="muted"><s>${clp(x.before)}</s></span>`}</td><td><time datetime="${x.readAt}">${longDate(x.readAt)}</time></td></tr>`).join("") ?? "";
  let body = "";
  if (r !== undefined && r.terms.length === 0) body = `<p>Escribe al menos una palabra de dos letras.</p>`;
  else if (r !== undefined && r.total === 0) body = `<p>No encontramos productos con stock que digan "${escapeHtml(q)}". Prueba con menos palabras o solo la marca.</p>`;
  else if (r !== undefined) {
    body = `<p>${r.total > COUNT_CAP ? `Más de ${num(COUNT_CAP)} productos` : `${num(r.total)} ${r.total === 1 ? "producto" : "productos"}`} con stock${r.total > r.rows.length ? `; aquí están los ${r.rows.length} más baratos` : ""}. <a href="${escapeHtml(searchUrl(q, true))}">Ver en JSON</a>.</p>
<div class="table-wrap"><table><thead><tr><th>Producto</th><th>Tienda</th><th>Precio</th><th>Leído</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Busca un producto y compara su precio en tiendas online chilenas con sitio propio, del más barato al más caro, con la fecha de cada precio.">
<meta name="robots" content="${q === "" ? "index" : "noindex"}, follow">
<link rel="canonical" href="${escapeHtml(searchUrl())}">
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow"><a href="${escapeHtml(guideUrl())}">Guías AgentPey</a> · <a href="${escapeHtml(guideUrl("marcas"))}">Marcas</a></p>
<h1>Buscar precios en tiendas online de Chile</h1>
<p class="lead">Productos con stock de tiendas online chilenas con sitio propio, del precio más bajo al más alto, con la fecha en que leímos cada precio.</p>
${searchForm(q)}
${body}
<h2 id="metodologia">Cómo funciona</h2>
<ul>
<li><strong>Qué tiendas.</strong> Las mismas de las guías: tiendas online chilenas con sitio propio de las listas públicas de participantes de blackfriday.cl y cyber.cl, sin grandes tiendas, multitiendas ni marketplaces.</li>
<li><strong>Precios.</strong> En pesos chilenos, el precio más bajo de cada producto el día de la lectura, tal como la tienda lo publicaba. No mostramos productos agotados. Confírmalos en la tienda antes de comprar. ${escapeHtml(FRESHNESS_RULE)}</li>
<li><strong>Búsqueda.</strong> Un producto aparece si su nombre o su marca contiene todas las palabras buscadas, sin importar tildes ni mayúsculas. Cada palabra tiene que estar al comienzo de una palabra del nombre: "50ml" no encuentra "150ml". No cuenta lo que el nombre solo menciona como referencia ("inspirado en…").</li>
<li><strong>Orden.</strong> ${escapeHtml(SEARCH_ORDER_RULE)}</li>
<li><strong>Relación con AgentPey.</strong> ${escapeHtml(DISCLOSURE)} Nadie paga por aparecer.</li>
<li><strong>Para programas.</strong> Agrega <code>&amp;formato=json</code> a la dirección para recibir los mismos resultados en JSON.</li>
</ul>
<footer><p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos.</p></footer>
</main>
</body>
</html>
`;
}
