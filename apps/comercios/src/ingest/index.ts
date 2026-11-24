/**
 * Read a store's public catalogue: the platform's public JSON where there is
 * one (Shopify, WooCommerce, VTEX), otherwise the sitemap and each product
 * page's structured data (Jumpseller, PrestaShop, own platforms).
 */
import type { Fetcher } from "../http.js";
import type { Product, Store } from "../model.js";
import { fromProductPage, fromShopify, fromVtex, fromWooCommerce, sitemapLocs } from "./platforms.js";

export interface IngestOptions {
  readonly maxProducts?: number;
  /** Product pages to open when reading from the sitemap. */
  readonly maxPages?: number;
  readonly log?: (line: string) => void;
}

export interface IngestResult {
  readonly products: Product[];
  readonly method: string;
  readonly notes: string[];
}

type Json = Record<string, unknown>;

export async function ingestStore(store: Store, fetcher: Fetcher, options: IngestOptions = {}): Promise<IngestResult> {
  const max = options.maxProducts ?? 2000;
  const log = options.log ?? (() => {});
  const notes: string[] = [];
  const done = (products: Product[], method: string): IngestResult => ({ products: dedupe(products).slice(0, max), method, notes });

  if (store.platform === "shopify") {
    const out: Product[] = [];
    for (let page = 1; out.length < max && page <= 40; page++) {
      const res = await fetcher.json<{ products?: Json[] }>(`${store.origin}/products.json?limit=250&page=${page}`);
      const batch = res.body?.products ?? [];
      if (res.status !== 200) notes.push(`products.json página ${page}: HTTP ${res.status}`);
      if (batch.length === 0) break;
      out.push(...batch.map((p) => fromShopify(store.id, store.origin, p)));
      log(`${store.id}: ${out.length} productos`);
    }
    if (out.length > 0) return done(out, "shopify products.json");
    notes.push("products.json no respondió; se usa el sitemap");
  }

  if (store.platform === "woocommerce") {
    const out: Product[] = [];
    for (let page = 1; out.length < max && page <= 100; page++) {
      const res = await fetcher.json<Json[]>(`${store.origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
      const batch = Array.isArray(res.body) ? res.body : [];
      if (res.status !== 200 && page === 1) notes.push(`Store API: HTTP ${res.status}`);
      if (batch.length === 0) break;
      out.push(...batch.map((p) => fromWooCommerce(store.id, p)));
      log(`${store.id}: ${out.length} productos`);
    }
    if (out.length > 0) return done(out, "woocommerce store api");
    notes.push("La Store API de WooCommerce no respondió; se usa el sitemap");
  }

  if (store.platform === "vtex") {
    const out: Product[] = [];
    for (let from = 0; out.length < max && from < 2500; from += 50) {
      const res = await fetcher.json<Json[]>(`${store.origin}/api/catalog_system/pub/products/search?_from=${from}&_to=${from + 49}`);
      const batch = Array.isArray(res.body) ? res.body : [];
      if (res.status >= 400 && from === 0) notes.push(`catálogo VTEX: HTTP ${res.status}`);
      if (batch.length === 0) break;
      out.push(...batch.map((p) => fromVtex(store.id, store.origin, p)));
      log(`${store.id}: ${out.length} productos`);
      if (batch.length < 50) break;
    }
    if (out.length > 0) return done(out, "vtex catalog api");
    notes.push("El catálogo público de VTEX no respondió; se usa el sitemap");
  }

  const limit = Math.min(options.maxPages ?? 400, max);
  const fromSitemap = await readPages(store, fetcher, await productUrlsFromSitemaps(store, fetcher, notes), limit, notes, log);
  if (fromSitemap.length > 0) return done(fromSitemap, "sitemap + datos estructurados de cada página");
  notes.push("Se recorre el sitio desde la portada");
  return done(await crawl(store, fetcher, limit, notes, log), "recorrido del sitio + datos estructurados de cada página");
}

async function readPages(store: Store, fetcher: Fetcher, urls: string[], limit: number, notes: string[], log: (l: string) => void): Promise<Product[]> {
  const out: Product[] = [];
  let opened = 0;
  for (const url of urls) {
    if (opened >= limit) {
      notes.push(`Se abrieron ${limit} de ${urls.length} páginas candidatas`);
      break;
    }
    opened++;
    try {
      const page = await fetcher.text(url);
      if (page.status !== 200) continue;
      const product = fromProductPage(store.id, page.url, page.body);
      if (product !== undefined && product.title !== "") out.push(product);
    } catch (error) {
      if (opened <= 3) notes.push(`${url}: ${(error as Error).message}`);
    }
    if (opened % 25 === 0) log(`${store.id}: ${opened} páginas, ${out.length} productos`);
  }
  return out;
}

/**
 * How likely a same-site link leads to products: 0 a product page, 1 a listing
 * (category, collection, catalogue) that links to products, 2 anything else.
 * A link with a query string is a filtered or sorted copy of a page: last.
 */
export function linkTier(url: string): 0 | 1 | 2 | 3 {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 3;
  }
  if (u.search !== "") return 3;
  const path = u.pathname.toLowerCase();
  if (/\/(products?|producto|productos\/[^/]+\/[^/]+|item|articulo|ficha|detalle|p)\/[^/]+|\.html?$|\/p$/.test(path)) return 0;
  if (/\/(collections?|coleccion(es)?|categor(y|ia|ias|ies)|catalogo|catalog|tienda|shop|departamento|linea|marca|brand)s?(\/|$)|\/\d+-[a-z]/.test(path)) return 1;
  return 2;
}

/** The queue of a crawl: product pages first, then listings, then the rest; one visit per address. */
export class CrawlQueue {
  private readonly tiers: [string[], string[], string[], string[]] = [[], [], [], []];
  private readonly known = new Set<string>();

  push(url: string): void {
    if (this.known.has(url)) return;
    this.known.add(url);
    this.tiers[linkTier(url)].push(url);
  }

  shift(): string | undefined {
    for (const t of this.tiers) if (t.length > 0) return t.shift();
    return undefined;
  }

  get size(): number {
    return this.tiers.reduce((n, t) => n + t.length, 0);
  }
}

/** Pages a crawl opens without finding a single product before it gives up: the site does not mark its products up. */
export const FRUITLESS_PAGES = 120;

/** From the home page over same-site links: product pages first, then listings, then the rest. */
async function crawl(store: Store, fetcher: Fetcher, limit: number, notes: string[], log: (l: string) => void): Promise<Product[]> {
  const out: Product[] = [];
  const seen = new Set<string>();
  const queue = new CrawlQueue();
  queue.push(store.origin + "/");
  let opened = 0;
  let site = store.origin;
  const maxOpen = limit * 3;
  while (queue.size > 0 && out.length < limit && opened < maxOpen) {
    if (out.length === 0 && opened >= FRUITLESS_PAGES) {
      notes.push(`Ningún producto en las primeras ${FRUITLESS_PAGES} páginas: se deja de recorrer`);
      break;
    }
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    opened++;
    let body: string;
    let finalUrl: string;
    try {
      const page = await fetcher.text(url);
      if (page.status !== 200) continue;
      body = page.body;
      finalUrl = page.url;
    } catch {
      continue;
    }
    // A home page that moves to another host (a renamed store, a "tienda." subdomain) is read there.
    if (opened === 1 && !sameSite(finalUrl, site)) {
      site = new URL(finalUrl).origin;
      notes.push(`La portada lleva a ${site}`);
    }
    const product = fromProductPage(store.id, finalUrl, body);
    if (product !== undefined && product.title !== "") out.push(product);
    const links = [...body.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1]!, finalUrl).toString().split("#")[0]!;
        } catch {
          return "";
        }
      })
      .filter((l) => l !== "" && sameSite(l, site) && !seen.has(l) && !/\.(jpg|jpeg|png|webp|gif|pdf|css|js|svg|ico|xml|zip)(\?|$)|\/(cart|carrito|checkout|login|account|mi-cuenta|my-account|wp-admin|contacto|contact|inicio-sesion|registro|wishlist|blog|noticias)(\/|$)|[?&](add|order|sort|orderby|filter|q)=/i.test(l));
    for (const l of links) queue.push(l);
    if (opened % 25 === 0) log(`${store.id}: ${opened} páginas, ${out.length} productos`);
  }
  notes.push(`Recorrido: ${opened} páginas abiertas`);
  return out;
}

/** Sitemaps from robots.txt and the usual places, followed one level into indexes; product-looking URLs first. */
async function productUrlsFromSitemaps(store: Store, fetcher: Fetcher, notes: string[]): Promise<string[]> {
  const candidates = new Set<string>();
  try {
    const robots = await fetcher.text(`${store.origin}/robots.txt`);
    for (const m of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.add(m[1]!);
  } catch {
    /* robots.txt is optional */
  }
  for (const p of ["/sitemap.xml", "/sitemap_index.xml", "/1_index_sitemap.xml", "/sitemap_products_1.xml"]) candidates.add(store.origin + p);

  const pages = new Set<string>();
  const seenMaps = new Set<string>();
  const queue = [...candidates];
  while (queue.length > 0 && seenMaps.size < 30) {
    const map = queue.shift()!;
    if (seenMaps.has(map)) continue;
    seenMaps.add(map);
    let body: string;
    try {
      const res = await fetcher.text(map);
      if (res.status !== 200 || !/<(urlset|sitemapindex)/i.test(res.body)) continue;
      body = res.body;
    } catch {
      continue;
    }
    const locs = sitemapLocs(body);
    if (/<sitemapindex/i.test(body)) {
      // Product sitemaps first; skip images, posts, pages and categories when the index names them.
      const ranked = locs.filter((l) => !/image|post|page|categor|blog|author|tag|manufacturer|supplier|cms/i.test(l));
      ranked.sort((a, b) => Number(/product|producto/i.test(b)) - Number(/product|producto/i.test(a)));
      queue.unshift(...ranked);
    } else {
      for (const l of locs) if (sameSite(l, store.origin)) pages.add(l);
    }
  }
  if (pages.size === 0) notes.push("No se encontró un sitemap con páginas");
  const all = [...pages].filter((u) => !/\.(jpg|jpeg|png|webp|gif|pdf)$/i.test(u));
  // Product pages first, then listings, then the rest; a stable sort keeps the sitemap's own order within each.
  return all.map((u, i) => ({ u, i, t: linkTier(u) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.u);
}

function sameSite(url: string, origin: string): boolean {
  try {
    const a = new URL(url).host.replace(/^www\./, "");
    const b = new URL(origin).host.replace(/^www\./, "");
    return a === b;
  } catch {
    return false;
  }
}

function dedupe(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    const key = p.url || p.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
