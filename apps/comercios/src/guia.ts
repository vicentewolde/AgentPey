/**
 * AgentPey's public guides: "online stores of <rubro> in Chile", built only
 * from facts the base already holds (each store's public catalogue, read on a
 * known date). Two goals: be a page AI assistants can cite when someone asks
 * about the rubro, and show what AgentPey's data is.
 *
 * Rules the code enforces, not just the copy:
 * - Only stores from the public lists (blackfriday.cl, cyber.cl). A store that
 *   is only in the pilot is left out: naming it publicly needs its OK.
 * - The order is public and the same for everyone: products with a published
 *   price, most first, then by name. Nothing about who is a client goes in.
 * - No scores and nothing about what a store lacks: a store whose catalogue
 *   could not be read is simply not listed.
 * - Every figure carries the date its catalogue was read.
 *
 * The guide is computed once by the CLI (`base guia`), saved as JSON in the
 * local base and imported to the panel's Postgres; the server only renders it.
 * The page needs no JavaScript.
 */
import { z } from "zod";

import type { Tienda } from "./base.js";
import type { Product } from "./model.js";

/** The rubros with a guide, in blackfriday.cl's names, and the address of each. */
export const GUIDE_RUBROS: readonly { slug: string; rubro: string; title: string; shortTitle: string }[] = [
  { slug: "ropa-y-calzado", rubro: "Vestuario y Calzado", title: "Tiendas online de ropa y calzado en Chile", shortTitle: "Ropa y calzado" },
  { slug: "hogar-y-decoracion", rubro: "Hogar y Decoración", title: "Tiendas online de hogar y decoración en Chile", shortTitle: "Hogar y decoración" },
  { slug: "salud-y-belleza", rubro: "Salud y Belleza", title: "Tiendas online de salud y belleza en Chile", shortTitle: "Salud y belleza" },
];

/** Stores with fewer products with a price than this are left out: too little to describe. */
export const MIN_PRICED = 5;
/** The catalogue reader stops at this many products: a store at the cap has at least this many. */
export const READ_CAP = 1500;
/** Catalogues are read again every week; a store not read for longer than this leaves the pages until it is read again. */
export const MAX_READ_AGE_DAYS = 21;
export const FRESHNESS_RULE = `Leemos los catálogos de nuevo cada semana. Si no pudimos leer una tienda en los últimos ${MAX_READ_AGE_DAYS} días, sale de estas páginas hasta la próxima lectura.`;

/** A built page stays published until next week's run: building with a week less keeps MAX_READ_AGE_DAYS true every day. */
export const BUILD_READ_AGE_DAYS = MAX_READ_AGE_DAYS - 7;

/** `readAt` when it is at most BUILD_READ_AGE_DAYS before `today` (YYYY-MM-DD), else undefined: an old price is left out, not shown. */
export function freshReadAt(readAt: string | undefined, today: string): string | undefined {
  if (readAt === undefined) return undefined;
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${readAt.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  return age <= BUILD_READ_AGE_DAYS ? readAt : undefined;
}

export const GuideStoreSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  domain: z.string(),
  /** Products read from the public catalogue, and how many of them show a price. */
  products: z.number().int().nonnegative(),
  priced: z.number().int().nonnegative(),
  /** True when the reader stopped at READ_CAP: the store has at least that many. */
  capped: z.boolean(),
  /** YYYY-MM-DD, the day the catalogue was read. */
  readAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Whole CLP. 8 in 10 priced products cost between p10 and p90. */
  priceP10: z.number().int().nonnegative(),
  priceMedian: z.number().int().nonnegative(),
  priceP90: z.number().int().nonnegative(),
  /** Products showing a crossed-out "before" price that day. */
  onSale: z.number().int().nonnegative(),
  categories: z.array(z.string()),
  brands: z.array(z.string()),
  lists: z.array(z.enum(["blackfriday", "cyber"])),
});
export type GuideStore = z.infer<typeof GuideStoreSchema>;

export const GuideSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  rubro: z.string(),
  title: z.string(),
  shortTitle: z.string(),
  /** YYYY-MM-DD, when this guide was computed. */
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** First and last day a listed catalogue was read. */
  readFrom: z.string(),
  readTo: z.string(),
  /** Days the public lists were read. */
  listsReadFrom: z.string(),
  listsReadTo: z.string(),
  stores: z.array(GuideStoreSchema),
  /** Brands sold by at least two listed stores, and which stores (with that brand's product count). */
  brands: z.array(z.object({ brand: z.string(), stores: z.array(z.object({ id: z.string(), name: z.string(), products: z.number().int() })) })),
});
export type Guide = z.infer<typeof GuideSchema>;

export interface GuideInput {
  readonly tienda: Tienda;
  readonly products: readonly Product[];
  /** The latest catalogue reading, if any. */
  readonly readAt: string | undefined;
}

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Labels that say who it is for, or that it is on sale, not what it is. */
const GENERIC = /^(hombres?|mujer(es)?|nin[oa]s?|kids|unisex|bebes?|vestuario|ropa|productos?|todos?|todo|inicio|home|catalogo|tienda|shop|sale|ofertas?|outlet|nuevos?|new|newarrivals|novedades|lomasvendido|masvendidos|remate(final)?|avancetemporada|ultimastallas|ventadirecta|descuentos?.*|cyber.*|blackfriday.*|regalo.*|tarjetasderegalo|muestras|agotados|productoregular|materialpromocional|preventa|especiales|hogar|para.*|nuevo.*|.*giftcard.*|servicios?|servicio.*|default.*|varios|otros|general|joyas|hotsale.*|liquidacion.*|ultimasunidades|coleccion.*|temporada.*|destacados?|promociones?|promo.*|ofertashot|generic[oa]s?|sinmarca|nomarca|otramarca|marcagenerica|otras?|importad[oa]s?)$/;

/** A SKU-like code ("PACKCASMARA001", "MS-0000-150"), not a name. */
const looksLikeCode = (s: string) => /\d/.test(s) && !/\s/.test(s.trim());

function tidy(label: string): string {
  const t = label.replace(/\s+/g, " ").trim();
  // ALL CAPS reads as shouting in a list: keep the first letter only.
  return t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3}/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t;
}

/**
 * The store's own name used as a label ("Kayser" in Kayser Shop, "mycocos.cl").
 * A word the name merely contains is not the name: "Perfumes" stays in Alisha Perfumes.
 */
function ownName(label: string, t: Tienda): boolean {
  const f = fold(label);
  const names = [fold(t.name), fold((t.domain ?? "").replace(/^www\./, "").split(".")[0] ?? "")].filter((x) => x.length >= 3);
  return f === "" || names.some((n) => f.includes(n) || (f.length >= 4 && n.startsWith(f)));
}

/** The first part of a category path that says what the product is ("Hombre > Vestuario > Poleras" → "Poleras"). */
export function categoryLabel(category: string, t: Tienda): string | undefined {
  for (const part of category.split(/\s*(?:>|\/|\|)\s*|\s+-\s+/)) {
    const p = part.trim();
    if (p.length < 3 || p.length > 40 || looksLikeCode(p) || GENERIC.test(fold(p)) || /%|hasta|\(/i.test(p) || ownName(p, t)) continue;
    return tidy(p);
  }
  return undefined;
}

export function brandLabel(brand: string, t: Tienda): string | undefined {
  const b = brand.trim();
  if (b.length < 2 || b.length > 40 || looksLikeCode(b) || GENERIC.test(fold(b)) || /gift ?card|tarjeta/i.test(b) || ownName(b, t)) return undefined;
  return b;
}

/** Same label in singular or plural, any case: "Perfume", "PERFUMES". */
const labelKey = (s: string) => fold(s).replace(/s$/, "").replace(/e$/, "");

/** The most frequent labels, merged by `labelKey`, each written as most products write it. */
function topLabels(labels: readonly string[], n: number, min: number): string[] {
  const groups = new Map<string, Map<string, number>>();
  for (const l of labels) {
    const k = labelKey(l);
    const g = groups.get(k) ?? new Map<string, number>();
    g.set(l, (g.get(l) ?? 0) + 1);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({ label: [...g.entries()].sort((a, b) => b[1] - a[1])[0]![0], count: [...g.values()].reduce((a, b) => a + b, 0) }))
    .filter((x) => x.count >= min)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"))
    .slice(0, n)
    .map((x) => x.label);
}

const quantile = (sorted: readonly number[], q: number) => sorted[Math.round(q * (sorted.length - 1))]!;

/** One store's entry, or undefined when its catalogue gives too little to describe. */
export function guideStore(input: GuideInput): GuideStore | undefined {
  const { tienda: t, products, readAt } = input;
  if (readAt === undefined || t.origin === undefined || t.domain === undefined) return undefined;
  const prices = products.map((p) => p.price).filter((x): x is number => x !== undefined && x > 0).sort((a, b) => a - b);
  if (prices.length < MIN_PRICED) return undefined;
  const lists = (t.sources ?? ["blackfriday"]).filter((s): s is "blackfriday" | "cyber" => s === "blackfriday" || s === "cyber");
  const min = products.length >= 40 ? 2 : 1;
  return {
    id: t.id, name: t.name.trim(), url: `${t.origin}/`, domain: t.domain.replace(/^www\./, ""),
    products: products.length, priced: prices.length, capped: products.length >= READ_CAP, readAt: readAt.slice(0, 10),
    priceP10: quantile(prices, 0.1), priceMedian: quantile(prices, 0.5), priceP90: quantile(prices, 0.9),
    onSale: products.filter((p) => p.price !== undefined && p.compareAtPrice !== undefined && p.compareAtPrice > p.price).length,
    categories: topLabels(products.map((p) => (p.category === undefined ? undefined : categoryLabel(p.category, t))).filter((x): x is string => x !== undefined), 5, min),
    brands: topLabels(products.map((p) => (p.brand === undefined ? undefined : brandLabel(p.brand, t))).filter((x): x is string => x !== undefined), 5, min),
    lists,
  };
}

/** The public order: products with a price, most first (a store at the reading cap ties with the others there), then by name. */
export function byPublicOrder(a: GuideStore, b: GuideStore): number {
  const size = (s: GuideStore) => (s.capped ? READ_CAP : s.priced);
  return size(b) - size(a) || a.name.localeCompare(b.name, "es", { sensitivity: "base" });
}

/**
 * The stores that may be named in public, once each: pymes, not only in the
 * pilot, with enough catalogue to describe (`guideStore`). A store listed
 * twice (the same domain, or the same name on two domains, like kallfu.cl and
 * tiendakallfu.cl) is kept once, with its larger reading. In the public order.
 */
export function keptStores(inputs: readonly GuideInput[]): { store: GuideStore; input: GuideInput }[] {
  const eligible = inputs.filter((i) => i.tienda.segment === "pyme" && (i.tienda.sources ?? ["blackfriday"]).some((s) => s !== "piloto"));
  // One entry per store: the same domain, or the same name on two domains (kallfu.cl and tiendakallfu.cl).
  const byDomain = new Map<string, { store: GuideStore; input: GuideInput }>();
  for (const input of eligible) {
    const store = guideStore(input);
    if (store === undefined) continue;
    const key = [...byDomain.keys()].find((k) => k === store.domain || fold(byDomain.get(k)!.store.name) === fold(store.name)) ?? store.domain;
    const prev = byDomain.get(key);
    if (prev === undefined || store.products > prev.store.products) {
      byDomain.set(key, { store: prev === undefined ? store : { ...store, lists: [...new Set([...prev.store.lists, ...store.lists])].sort() }, input });
    } else {
      prev.store = { ...prev.store, lists: [...new Set([...prev.store.lists, ...store.lists])].sort() };
    }
  }
  return [...byDomain.values()].sort((a, b) => byPublicOrder(a.store, b.store));
}

/**
 * The guide of one rubro. Stores outside the target segment, only in the
 * pilot, or with too little catalogue are left out; a store listed twice
 * (blackfriday.cl and cyber.cl under two ids) is kept once, with its larger reading.
 */
export function buildGuide(meta: (typeof GUIDE_RUBROS)[number], inputs: readonly GuideInput[], today: string): Guide {
  const kept = keptStores(inputs.filter((i) => i.tienda.rubro === meta.rubro));
  // Brands across stores: a buyer asking "where do I buy <brand> in Chile" gets every store that sells it.
  const brandStores = new Map<string, { names: Map<string, number>; stores: { id: string; name: string; products: number }[] }>();
  for (const { store, input } of kept) {
    const counts = new Map<string, { label: string; n: number }>();
    for (const p of input.products) {
      const label = p.brand === undefined ? undefined : brandLabel(p.brand, input.tienda);
      if (label === undefined) continue;
      const k = fold(label);
      const c = counts.get(k) ?? { label, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    for (const [k, c] of counts) {
      if (c.n < 2) continue;
      const entry = brandStores.get(k) ?? { names: new Map<string, number>(), stores: [] };
      entry.names.set(c.label, (entry.names.get(c.label) ?? 0) + c.n);
      entry.stores.push({ id: store.id, name: store.name, products: c.n });
      brandStores.set(k, entry);
    }
  }
  const brands = [...brandStores.values()]
    .filter((b) => b.stores.length >= 2)
    .map((b) => ({ brand: [...b.names.entries()].sort((x, y) => y[1] - x[1])[0]![0], stores: [...b.stores].sort((x, y) => y.products - x.products || x.name.localeCompare(y.name, "es")) }))
    .sort((a, b) => b.stores.length - a.stores.length || b.stores.reduce((s, x) => s + x.products, 0) - a.stores.reduce((s, x) => s + x.products, 0))
    .slice(0, 20);
  const reads = kept.map((k) => k.store.readAt).sort();
  const listDays = kept.map((k) => k.input.tienda.checkedAt?.slice(0, 10)).filter((x): x is string => x !== undefined).sort();
  return GuideSchema.parse({
    slug: meta.slug, rubro: meta.rubro, title: meta.title, shortTitle: meta.shortTitle, updatedAt: today,
    readFrom: reads[0] ?? today, readTo: reads.at(-1) ?? today,
    listsReadFrom: listDays[0] ?? today, listsReadTo: listDays.at(-1) ?? today,
    stores: kept.map((k) => k.store), brands,
  });
}

// ---------------------------------------------------------------------------
// Measuring: does an AI answer about the rubro cite the guide?

const hostOfUrl = (u: string): string | undefined => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
};

/** Answers that link or write agentpey.com (any subdomain), and every domain the answers link, by number of answers. */
export function citations(answers: readonly { text: string; urls: readonly string[] }[]): { answers: number; agentpey: number; domains: { domain: string; count: number }[] } {
  const counts = new Map<string, number>();
  let agentpey = 0;
  for (const a of answers) {
    const hosts = new Set(a.urls.map(hostOfUrl).filter((h): h is string => h !== undefined));
    for (const h of hosts) counts.set(h, (counts.get(h) ?? 0) + 1);
    if ([...hosts].some((h) => h === "agentpey.com" || h.endsWith(".agentpey.com")) || /\bagentpey\.com\b/i.test(a.text)) agentpey++;
  }
  return { answers: answers.length, agentpey, domains: [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([domain, count]) => ({ domain, count })) };
}

// ---------------------------------------------------------------------------
// Rendering

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Same rule as marcas.ts `brandSlug` (kept here so guia.ts imports nothing from it). */
export const brandSlugOf = (label: string) => label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " y ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** "2026-11-18" → "18 de noviembre de 2026". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} de ${MONTHS[(m ?? 1) - 1]} de ${y}`;
}

function dateSpan(from: string, to: string): string {
  return from === to ? `el ${longDate(from)}` : `entre el ${longDate(from)} y el ${longDate(to)}`;
}

export const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;
export const num = (n: number) => n.toLocaleString("es-CL");

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON inside <script>: "</" would close the tag early. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

function joinEs(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} y ${xs.at(-1)}`;
}

const LIST_NAMES: Record<"blackfriday" | "cyber", string> = { blackfriday: "blackfriday.cl", cyber: "cyber.cl" };

/**
 * Where the guides are published: the main domain, one folder per country
 * (`/chile`, later others), the address search engines and AI assistants weigh
 * most. The gateway sends exactly these paths to this app (apps/gateway, hosts.ts
 * `isGuidePath`); every link and canonical points here, whichever host served the page.
 */
export const GUIDE_ORIGIN = "https://agentpey.com";
export const GUIDE_PATH = "/chile";
export const guideUrl = (slug?: string): string => `${GUIDE_ORIGIN}${GUIDE_PATH}${slug === undefined ? "" : `/${slug}`}`;

/**
 * IndexNow (Bing, Yandex, Seznam, Naver...): tells search engines at once that
 * a page changed. The key is public by design, published at its own address
 * under /chile/, which lets it announce exactly the pages under /chile/.
 */
export const INDEXNOW_KEY = "8a17a2a4c5ea7883fd8b38300e5db3e0";
export const indexNowKeyUrl = () => guideUrl(`${INDEXNOW_KEY}.txt`);

export const DISCLOSURE = "AgentPey trabaja o puede trabajar con algunas de estas tiendas. El orden no depende de eso.";
export const ORDER_RULE = "Ordenamos las tiendas por la cantidad de productos con precio publicado que leímos en su catálogo, de más a menos. Las que tienen 1.500 o más quedan empatadas, y los empates van por orden alfabético. El orden es el mismo para todas y no cambia si una tienda trabaja con AgentPey.";

function storeDescription(s: GuideStore): string {
  const parts = [s.categories.length > 0 ? `Vende: ${s.categories.join(", ")}.` : "", s.brands.length > 0 ? `Marcas: ${s.brands.join(", ")}.` : "", `Precio mediano ${clp(s.priceMedian)} (catálogo leído el ${longDate(s.readAt)}).`];
  return parts.filter((p) => p !== "").join(" ");
}

function jsonLd(g: Guide, pageUrl: string): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": pageUrl,
    url: pageUrl,
    name: g.title,
    inLanguage: "es-CL",
    datePublished: g.updatedAt,
    dateModified: g.updatedAt,
    description: `${g.stores.length} tiendas online de ${g.shortTitle.toLowerCase()} en Chile con sitio propio: qué vende cada una, marcas y rango de precios, según sus catálogos públicos.`,
    publisher: { "@type": "Organization", name: "AgentPey", url: "https://agentpey.com" },
    isPartOf: { "@type": "WebSite", name: "Guías AgentPey", url: guideUrl() },
    mainEntity: {
      "@type": "ItemList",
      name: g.title,
      itemListOrder: "https://schema.org/ItemListOrderDescending",
      numberOfItems: g.stores.length,
      itemListElement: g.stores.map((s, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "OnlineStore",
          name: s.name,
          url: s.url,
          description: storeDescription(s),
          priceRange: `${clp(s.priceP10)} a ${clp(s.priceP90)} CLP`,
          areaServed: { "@type": "Country", name: "Chile" },
          ...(s.brands.length > 0 ? { brand: s.brands.map((b) => ({ "@type": "Brand", name: b })) } : {}),
        },
      })),
    },
  };
}

export const STYLE = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5d5b55;--line:#e3e0d8;--card:#fff;--accent:#2f5d50;--note:#fff6dc;--note-line:#e8d48f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a9a69d;--line:#33322e;--card:#1c1c1a;--accent:#8fc5b2;--note:#2b2617;--note-line:#5e5225}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--accent)}h1{font-size:clamp(1.6rem,4.5vw,2.3rem);line-height:1.15;margin:.2em 0 .4em}
h2{font-size:1.3rem;margin:2em 0 .6em}h3{font-size:1.08rem;margin:0}
.eyebrow{font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.lead{font-size:1.08rem}.muted{color:var(--muted)}
.note{background:var(--note);border:1px solid var(--note-line);border-radius:10px;padding:12px 16px;font-weight:600}
ol.stores{list-style:none;padding:0;margin:0;counter-reset:s}
ol.stores>li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px;counter-increment:s}
ol.stores>li h3::before{content:counter(s) ". ";color:var(--muted)}
.facts{margin:.5em 0 0;padding:0;list-style:none}.facts li{margin:.15em 0}
table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.table-wrap{overflow-x:auto}footer{margin-top:3em;font-size:.9rem;color:var(--muted)}

.search{margin:1.25rem 0}.search label{display:block;font-weight:600;margin-bottom:.35rem}.search div{display:flex;gap:.5rem}.search input{flex:1;min-width:0;font:inherit;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}.search button{font:inherit;padding:.55rem 1rem;border:0;border-radius:8px;background:var(--accent);color:var(--bg);font-weight:600;cursor:pointer}.price{font-weight:600;white-space:nowrap}`;

/** The page of one guide: plain HTML, readable with no JavaScript, with schema.org ItemList data. */
export function guideHtml(g: Guide, others: readonly { slug: string; shortTitle: string }[] = [], brandSlugs: ReadonlySet<string> = new Set()): string {
  const pageUrl = guideUrl(g.slug);
  const total = g.stores.reduce((a, s) => a + s.products, 0);
  const anyCapped = g.stores.some((s) => s.capped);
  const description = `${g.stores.length} tiendas online de ${g.shortTitle.toLowerCase()} con sitio propio en Chile: qué vende cada una, sus marcas y sus precios, sacado de sus catálogos públicos. Actualizada el ${longDate(g.updatedAt)}.`;
  const lists = [...new Set(g.stores.flatMap((s) => s.lists))].map((l) => LIST_NAMES[l]);
  const items = g.stores.map((s) => {
    const count = s.capped ? `${num(READ_CAP)} o más` : num(s.products);
    const facts = [
      s.categories.length > 0 ? `<li><strong>Qué vende:</strong> ${escapeHtml(s.categories.join(", "))}</li>` : "",
      s.brands.length > 0 ? `<li><strong>Marcas que más aparecen:</strong> ${escapeHtml(s.brands.join(", "))}</li>` : "",
      `<li><strong>Precios:</strong> 8 de cada 10 productos cuestan entre ${clp(s.priceP10)} y ${clp(s.priceP90)}; el precio mediano es ${clp(s.priceMedian)}</li>`,
      `<li><strong>Productos en su catálogo:</strong> ${count}${s.onSale > 0 ? `, ${num(s.onSale)} con precio rebajado ese día` : ""}</li>`,
      `<li class="muted">Catálogo leído el <time datetime="${s.readAt}">${longDate(s.readAt)}</time>. Aparece en ${escapeHtml(joinEs(s.lists.map((l) => LIST_NAMES[l])))}.</li>`,
    ].filter((x) => x !== "").join("");
    return `<li id="${escapeHtml(s.id)}"><h3><a href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a> <span class="muted">${escapeHtml(s.domain)}</span></h3><ul class="facts">${facts}</ul></li>`;
  }).join("\n");
  const brandCell = (name: string) => { const slug = brandSlugOf(name); return brandSlugs.has(slug) ? `<a href="${escapeHtml(guideUrl(`marcas/${slug}`))}">${escapeHtml(name)}</a>` : escapeHtml(name); };
  const brandRows = g.brands.map((b) => `<tr><td>${brandCell(b.brand)}</td><td>${b.stores.map((s) => `<a href="#${escapeHtml(s.id)}">${escapeHtml(s.name)}</a> (${num(s.products)})`).join(", ")}</td></tr>`).join("");
  const otherLinks = others.filter((o) => o.slug !== g.slug).map((o) => `<a href="${escapeHtml(guideUrl(o.slug))}">${escapeHtml(o.shortTitle)}</a>`).join(" · ");
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(g.title)} (${g.updatedAt.slice(0, 4)}) · Guía AgentPey</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index, follow, max-snippet:-1">
<link rel="canonical" href="${escapeHtml(pageUrl)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(g.title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta property="article:modified_time" content="${g.updatedAt}">
<script type="application/ld+json">${scriptJson(jsonLd(g, pageUrl))}</script>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Guía AgentPey · actualizada el <time datetime="${g.updatedAt}">${longDate(g.updatedAt)}</time></p>
<h1>${escapeHtml(g.title)}</h1>
<p class="lead">${g.stores.length} tiendas de ${escapeHtml(g.shortTitle.toLowerCase())} con tienda online propia, que no son grandes tiendas ni marketplaces. Para cada una: qué vende, qué marcas tiene y entre qué precios se mueve, según su propio catálogo público.</p>
<p class="note">${escapeHtml(DISCLOSURE)}</p>
<p><strong>Cómo están ordenadas.</strong> ${escapeHtml(ORDER_RULE)}</p>
<p class="muted">Despacho, cambios y medios de pago no están en esta versión: todavía no los tenemos leídos para todas las tiendas. Revísalos en el sitio de cada una antes de comprar.</p>

<h2>Las tiendas</h2>
<ol class="stores">
${items}
</ol>

${g.brands.length > 0 ? `<h2>Dónde encontrar cada marca</h2>
<p>Marcas que venden al menos dos de estas tiendas, con cuántos productos de esa marca tenía cada una en su catálogo. ${brandSlugs.size > 0 ? `Los precios de cada marca, tienda por tienda, están en <a href="${escapeHtml(guideUrl("marcas"))}">Marcas</a>.` : ""}</p>
<div class="table-wrap"><table><thead><tr><th>Marca</th><th>Tiendas (productos)</th></tr></thead><tbody>${brandRows}</tbody></table></div>` : ""}

<h2 id="metodologia">Metodología</h2>
<ul>
<li><strong>Qué tiendas entran.</strong> Las de ${escapeHtml(g.shortTitle.toLowerCase())} que aparecen en las listas públicas de participantes de ${escapeHtml(joinEs(lists))}, leídas ${dateSpan(g.listsReadFrom, g.listsReadTo)}. Quedan fuera las grandes tiendas, las multitiendas y los marketplaces. También quedan fuera las tiendas cuyo catálogo no pudimos leer o que tenían menos de ${MIN_PRICED} productos con precio.</li>
<li><strong>De dónde salen los datos.</strong> Del catálogo público de cada tienda (la lista de productos que su propio sitio publica), leído ${dateSpan(g.readFrom, g.readTo)}. Leímos hasta ${num(READ_CAP)} productos por tienda, respetando su robots.txt. En total, ${num(total)} productos${anyCapped ? " (más, en las tiendas que llegaron al tope)" : ""}. ${escapeHtml(FRESHNESS_RULE)}</li>
<li><strong>Qué vende y marcas.</strong> Son las categorías y marcas que más se repiten en sus productos, tal como la tienda las escribe. No incluimos las que solo dicen para quién es (hombre, mujer), ofertas ni el nombre de la propia tienda.</li>
<li><strong>Precios.</strong> En pesos chilenos, el precio más bajo de cada producto el día de la lectura. "8 de cada 10 productos cuestan entre A y B" deja fuera el 10% más barato y el 10% más caro. "Precio rebajado" cuenta los productos que mostraban un precio anterior tachado ese día.</li>
<li><strong>Qué no medimos.</strong> No ponemos notas ni puntajes, ni opiniones de clientes. Despacho, cambios y medios de pago tampoco están todavía.</li>
<li><strong>Orden.</strong> ${escapeHtml(ORDER_RULE)}</li>
<li><strong>Relación con AgentPey.</strong> ${escapeHtml(DISCLOSURE)} Nadie paga por aparecer en esta guía.</li>
</ul>

<footer>
${otherLinks === "" ? "" : `<p>Otras guías: ${otherLinks}</p>`}
<p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos. Actualizada el ${longDate(g.updatedAt)}.</p>
</footer>
</main>
</body>
</html>
`;
}

export function guidesIndexHtml(guides: readonly { slug: string; title: string; updatedAt: string; stores: number }[], brands = 0): string {
  const rows = guides.map((g) => `<li><a href="${escapeHtml(guideUrl(g.slug))}">${escapeHtml(g.title)}</a> <span class="muted">${g.stores} tiendas · actualizada el ${longDate(g.updatedAt)}</span></li>`).join("\n");
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guías de tiendas online en Chile · AgentPey</title>
<meta name="description" content="Guías de tiendas online chilenas con sitio propio, por rubro, hechas con sus catálogos públicos.">
<link rel="canonical" href="${escapeHtml(guideUrl())}">
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Guías AgentPey</p>
<h1>Tiendas online en Chile, por rubro</h1>
<p class="lead">Tiendas con sitio propio que no son grandes tiendas ni marketplaces, con lo que vende cada una y sus precios, sacado de sus catálogos públicos.</p>
<p class="note">${escapeHtml(DISCLOSURE)}</p>
${searchForm()}
<ul>
${rows}
</ul>
${brands > 0 ? `<p><a href="${escapeHtml(guideUrl("marcas"))}">${num(brands)} marcas</a>: dónde comprar cada una y a qué precio, tienda por tienda.</p>` : ""}
<footer><p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos.</p></footer>
</main>
</body>
</html>
`;
}

/** Crawlers named on purpose: the AI assistants' search and user agents are welcome on the guides. */
export const AI_CRAWLERS = ["OAI-SearchBot", "ChatGPT-User", "GPTBot", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot"] as const;

/**
 * The panel's own robots.txt (panel.agentpey.com). Everyone may read its public
 * pages; click redirects (/ir/), the API, the measurement script and single
 * diagnosis results stay out: a crawler following /ir/ would count as a visit
 * to the store. The guides live on the main domain, so it points there.
 */
export function robotsTxt(): string {
  return [
    `# AgentPey comercios. The public store guides are at ${guideUrl()}, open to search engines and AI assistants.`,
    ...AI_CRAWLERS.map((ua) => `User-agent: ${ua}`),
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /ir/",
    "Disallow: /m/",
    "Disallow: /diagnostico/",
    "",
    `Sitemap: ${guideUrl("sitemap.xml")}`,
    "",
  ].join("\n");
}

/** The guides' sitemap, served at agentpey.com/chile/sitemap.xml: the index and each guide, with its date. */
export function sitemapXml(guides: readonly { slug: string; updatedAt: string }[], brands: readonly { slug: string; updatedAt: string }[] = []): string {
  const brandsDate = [...brands].map((b) => b.updatedAt).sort().at(-1);
  const urls = [
    `<url><loc>${escapeHtml(guideUrl())}</loc>${guides.length > 0 ? `<lastmod>${[...guides].map((g) => g.updatedAt).sort().at(-1)}</lastmod>` : ""}</url>`,
    ...guides.map((g) => `<url><loc>${escapeHtml(guideUrl(g.slug))}</loc><lastmod>${g.updatedAt}</lastmod></url>`),
    ...(brands.length === 0 ? [] : [`<url><loc>${escapeHtml(guideUrl("marcas"))}</loc><lastmod>${brandsDate}</lastmod></url>`]),
    ...brands.map((b) => `<url><loc>${escapeHtml(guideUrl(`marcas/${b.slug}`))}</loc><lastmod>${b.updatedAt}</lastmod></url>`),
    ...(brands.length === 0 ? [] : [`<url><loc>${escapeHtml(searchUrl())}</loc><lastmod>${brandsDate}</lastmod></url>`]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** Address of the price search (precios.ts); with a query, its results page, or their JSON. */
export function searchUrl(q?: string, json = false): string {
  const base = guideUrl("buscar");
  if (q === undefined) return base;
  return `${base}?q=${encodeURIComponent(q)}${json ? "&formato=json" : ""}`;
}

/** The search box, a plain GET form: works with no JavaScript. */
export function searchForm(q = ""): string {
  return `<form class="search" action="${escapeHtml(searchUrl())}" method="get" role="search"><label for="q">Buscar un producto y comparar precios</label><div><input id="q" name="q" type="search" value="${escapeHtml(q)}" placeholder="Ej.: khamrah 100ml" maxlength="200"><button type="submit">Buscar</button></div></form>`;
}
