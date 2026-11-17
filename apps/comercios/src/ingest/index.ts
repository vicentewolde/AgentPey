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

/** Breadth-first from the home page over same-site links, product-looking links first. */
async function crawl(store: Store, fetcher: Fetcher, limit: number, notes: string[], log: (l: string) => void): Promise<Product[]> {
  const out: Product[] = [];
  const seen = new Set<string>();
  const queue: string[] = [store.origin + "/"];
  let opened = 0;
  const maxOpen = limit * 3;
  while (queue.length > 0 && out.length < limit && opened < maxOpen) {
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
    const product = fromProductPage(store.id, finalUrl, body);
    if (product !== undefined && product.title !== "") out.push(product);
    const links = [...body.matchAll(/href=["']([^"'#]+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1]!, finalUrl).toString().split("#")[0]!;
        } catch {
          return "";
        }
      })
      .filter((l) => l !== "" && sameSite(l, store.origin) && !seen.has(l) && !/\.(jpg|jpeg|png|webp|gif|pdf|css|js|svg|ico)(\?|$)|\/(cart|carrito|checkout|login|account|mi-cuenta|my-account|wp-admin|contacto|contact)|[?&](add|order|sort|orderby|filter|q)=/i.test(l));
    const productLike = (u: string) => /\/(products?|producto|p)\/|\.html$|\/\d+-/i.test(u);
    for (const l of links.filter(productLike)) if (!queue.includes(l)) queue.unshift(l);
    for (const l of links.filter((u) => !productLike(u))) if (!queue.includes(l)) queue.push(l);
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
  const productLike = (u: string) => /\/(products?|producto|p)\/|\/p$|\.html$|-\d+\.html|\/\d+-/i.test(u);
  return [...all.filter(productLike), ...all.filter((u) => !productLike(u))];
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
