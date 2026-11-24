/**
 * Big stores, for comparison only: multitiendas and pharmacy and perfume
 * chains, read for the products the pyme stores already make a page for. They
 * never enter the guides or the pyme order; a product page shows them apart,
 * "para comparar". Each is read from its public product sitemaps, only the
 * pages whose address names a pilot house, with the same polite fetcher
 * (robots.txt, a gap between requests). A store that blocks us is left out.
 */
import { BlockedByRobots, type Fetcher } from "./http.js";
import { fromProductPage, sitemapLocs } from "./ingest/platforms.js";
import type { Product } from "./model.js";
import { plausiblePrice, type PriceRow } from "./precios.js";
import { PILOT_HOUSES } from "./productos.js";

export interface BigStore {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  /** The sitemap index that lists the product sitemaps. */
  readonly sitemap: string;
  /** Product sitemaps to leave out (a marketplace's third-party sellers). */
  readonly skip?: RegExp;
}

/** Checked 2026-11-22: robots.txt lets us read their product pages, and the pages carry schema.org Product with a price. */
export const BIG_STORES: readonly BigStore[] = [
  { id: "gr-paris", name: "Paris", domain: "paris.cl", sitemap: "https://www.paris.cl/sitemap_index.xml" },
  { id: "gr-ripley", name: "Ripley", domain: "ripley.cl", sitemap: "https://simple.ripley.cl/sitemap_ripley_index.xml", skip: /_3P/ },
  { id: "gr-lider", name: "Lider", domain: "lider.cl", sitemap: "https://www.lider.cl/siteindex.xml" },
  { id: "gr-hites", name: "Hites", domain: "hites.com", sitemap: "https://www.hites.com/sitemap_index.xml" },
  { id: "gr-cruzverde", name: "Cruz Verde", domain: "cruzverde.cl", sitemap: "https://www.cruzverde.cl/sitemap_index.xml" },
];

/** House names as they appear in a product address: "al haramain" → "al-haramain". */
const HOUSE_SLUGS = PILOT_HOUSES.map((h) => h.replace(/ /g, "-"));

/** Whether a product address names a pilot house as a whole word of its path. */
export function namesPilotHouse(url: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return false;
  }
  return HOUSE_SLUGS.some((h) => new RegExp(`(^|[^a-z0-9])${h.replace(/-/g, "[-_ ]")}([^a-z0-9]|$)`).test(path));
}

export interface BigRead { readonly products: Product[]; readonly urls: number; readonly opened: number; readonly failed: number; readonly notes: string[] }

/**
 * Whether an address may be one of these products: it names the house, every
 * name word and the size. The page's own title decides afterwards; this only
 * spares opening thousands of pages that cannot match.
 */
export function mayBeOneOf(keys: readonly { house: string; name: string; ml: number }[]): (url: string) => boolean {
  const wanted = keys.map((k) => ({ words: [...k.house.split(" "), ...k.name.split(" ")].filter((w) => w.length > 0), ml: String(k.ml) }));
  return (url) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
      return false;
    }
    const words = new Set(path.split(/[^a-z0-9]+/).filter((w) => w !== ""));
    const joined = path.replace(/[^a-z0-9]+/g, " ");
    return wanted.some((k) => k.words.every((w) => words.has(w)) && new RegExp(`(^| )${k.ml} ?ml( |$)`).test(joined));
  };
}

/** The pilot products one big store sells: matching addresses from its product sitemaps (at most 60), then each page's structured data. */
export async function readBigStore(store: BigStore, fetcher: Fetcher, options: { maxPages?: number; wanted?: (url: string) => boolean; log?: (line: string) => void } = {}): Promise<BigRead> {
  const maxPages = options.maxPages ?? 600;
  const log = options.log ?? (() => {});
  const notes: string[] = [];
  const index = await fetcher.text(store.sitemap).catch((error: unknown) => ({ status: error instanceof BlockedByRobots ? 403 : 0, body: "", url: store.sitemap }));
  if (index.status !== 200) return { products: [], urls: 0, opened: 0, failed: 0, notes: [`índice de sitemaps: HTTP ${index.status}`] };
  const maps = sitemapLocs(index.body).filter((l) => /product/i.test(l) && (store.skip === undefined || !store.skip.test(l))).slice(0, 60);
  const urls = new Set<string>();
  for (const map of maps) {
    const res = await fetcher.text(map).catch(() => undefined);
    if (res === undefined || res.status !== 200) {
      notes.push(`${map}: no se pudo leer`);
      continue;
    }
    for (const u of sitemapLocs(res.body)) if (namesPilotHouse(u) && (options.wanted === undefined || options.wanted(u))) urls.add(u);
    log(`${store.id}: ${maps.indexOf(map) + 1} de ${maps.length} sitemaps, ${urls.size} páginas de casas árabes`);
  }
  const products: Product[] = [];
  let opened = 0;
  let failed = 0;
  for (const u of [...urls].slice(0, maxPages)) {
    opened++;
    const res = await fetcher.text(u).catch(() => undefined);
    if (res === undefined || res.status !== 200) {
      failed++;
      continue;
    }
    const p = fromProductPage(store.id, u, res.body);
    if (p !== undefined) products.push(p);
    if (opened % 100 === 0) log(`${store.id}: ${opened} páginas abiertas, ${products.length} productos`);
  }
  if (urls.size > maxPages) notes.push(`Se abrieron ${maxPages} de ${urls.size} páginas`);
  if (failed > 0) notes.push(`${failed} páginas no respondieron`);
  return { products, urls: urls.size, opened, failed, notes };
}

/** A big store's products as price rows: in stock, with a plausible price, cheapest per address; `readAt` undefined (too old or never read) gives none. */
export function bigPriceRows(store: BigStore, products: readonly Product[], readAt: string | undefined): PriceRow[] {
  if (readAt === undefined) return [];
  const cheapest = new Map<string, PriceRow>();
  for (const p of products) {
    if (p.price === undefined || !plausiblePrice(p.price) || p.available === false || !/^https?:\/\//.test(p.url)) continue;
    const price = Math.round(p.price);
    const before = p.compareAtPrice !== undefined && p.compareAtPrice > p.price ? Math.round(p.compareAtPrice) : undefined;
    const row: PriceRow = {
      storeId: store.id, store: store.name, domain: store.domain, title: p.title.trim().slice(0, 200), price, url: p.url, readAt: readAt.slice(0, 10),
      ...(p.brand === undefined || p.brand.trim() === "" ? {} : { brand: p.brand.trim() }),
      ...(before === undefined ? {} : { before }),
      ...(p.gtin === undefined ? {} : { gtin: p.gtin }),
    };
    const prev = cheapest.get(p.url);
    if (prev === undefined || row.price < prev.price) cheapest.set(p.url, row);
  }
  return [...cheapest.values()];
}
