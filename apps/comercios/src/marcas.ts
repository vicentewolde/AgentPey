/**
 * "Where to buy <brand> in Chile, and at what price": one public page per brand
 * that two or more stores sell, built only from the catalogues the base has
 * already read. The same rules as the rubro guides (guia.ts): only public facts
 * with their date, the stores that may be named in public (`keptStores`), a
 * public order that never depends on who is a client, and the disclosure.
 *
 * Its own value over the guides is the price: each store's cheapest products
 * of the brand, and, when two stores carry a product with the same barcode
 * (GTIN), that exact product side by side, cheapest first. That is the
 * question buyers ask AI assistants ("where is X cheapest in Chile?").
 */
import { z } from "zod";

import {
  brandLabel, brandSlugOf, clp, DISCLOSURE, escapeHtml, fold, guideUrl, keptStores, longDate, num, scriptJson, STYLE,
  type GuideInput,
} from "./guia.js";

/** Cheapest products shown per store. */
export const OFFERS_PER_STORE = 5;
/** Products with the same barcode in several stores, per page. */
export const SAME_PER_PAGE = 15;

const OfferSchema = z.object({
  title: z.string(),
  price: z.number().int().positive(),
  before: z.number().int().positive().optional(),
  url: z.string().url(),
  available: z.boolean().optional(),
});

const BrandStoreSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  domain: z.string(),
  readAt: z.string(),
  /** Products of the brand with a price in this store's catalogue. */
  products: z.number().int().positive(),
  priceMin: z.number().int().positive(),
  offers: z.array(OfferSchema).min(1),
});

const SameProductSchema = z.object({
  gtin: z.string(),
  title: z.string(),
  offers: z.array(z.object({ storeId: z.string(), store: z.string(), price: z.number().int().positive(), url: z.string().url(), readAt: z.string() })).min(2),
});

export const BrandPageSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  brand: z.string(),
  updatedAt: z.string(),
  readFrom: z.string(),
  readTo: z.string(),
  stores: z.array(BrandStoreSchema).min(2),
  same: z.array(SameProductSchema),
});
export type BrandPage = z.infer<typeof BrandPageSchema>;

/** What the index of brands needs, without every offer. */
export interface BrandSummary { slug: string; brand: string; stores: number; priceMin: number; updatedAt: string }

export const summarize = (p: BrandPage): BrandSummary => ({ slug: p.slug, brand: p.brand, stores: p.stores.length, priceMin: Math.min(...p.stores.map((s) => s.priceMin)), updatedAt: p.updatedAt });

export const BRAND_ORDER_RULE = "Ordenamos las tiendas por el precio más bajo que publicaban para un producto de esta marca, de menor a mayor, y los empates por orden alfabético. El orden es el mismo para todas y no cambia si una tienda trabaja con AgentPey.";

/** "Dolce & Gabbana" → "dolce-y-gabbana", "L'Oréal" → "l-oreal". */
export const brandSlug = brandSlugOf;

/** A barcode two stores can share: 8, 12, 13 or 14 digits, compared without leading zeros. */
export function normalGtin(raw: string | undefined): string | undefined {
  const d = (raw ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(d.length) || /^(\d)\1+$/.test(d)) return undefined;
  const core = d.replace(/^0+/, "");
  return core.length >= 7 ? core : undefined;
}

const isWebUrl = (u: string) => /^https?:\/\/[^\s]+$/i.test(u);
const isAllCaps = (s: string) => s === s.toUpperCase() && /[A-Z]/.test(s);
const shortTitle = (t: string) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > 140 ? `${s.slice(0, 137).trimEnd()}...` : s;
};

/**
 * Every brand that `minStores` or more of the public stores sell with a price
 * (products the store showed as out of stock are left out).
 * A brand is grouped by its slug, so "CAROLINA HERRERA" and "Carolina Herrera"
 * are one page, written the way most products write it (not all in capitals, when there is a choice).
 */
export function buildBrandPages(inputs: readonly GuideInput[], today: string, minStores = 2): BrandPage[] {
  const brands = new Map<string, { names: Map<string, number>; stores: Map<string, { kept: ReturnType<typeof keptStores>[number]; products: GuideInput["products"][number][] }> }>();
  for (const kept of keptStores(inputs)) {
    for (const p of kept.input.products) {
      // Out of stock that day: an old price for something nobody can buy would read as "the cheapest".
      if (p.price === undefined || p.price <= 0 || p.available === false || p.brand === undefined || !isWebUrl(p.url)) continue;
      const label = brandLabel(p.brand, kept.input.tienda);
      if (label === undefined) continue;
      const slug = brandSlug(label);
      if (slug === "" || fold(label).length < 2) continue;
      const b = brands.get(slug) ?? { names: new Map(), stores: new Map() };
      b.names.set(label, (b.names.get(label) ?? 0) + 1);
      const s = b.stores.get(kept.store.id) ?? { kept, products: [] };
      s.products.push(p);
      b.stores.set(kept.store.id, s);
      brands.set(slug, b);
    }
  }
  const pages: BrandPage[] = [];
  for (const [slug, b] of brands) {
    if (b.stores.size < minStores) continue;
    const brand = [...b.names.entries()].sort((x, y) => Number(isAllCaps(x[0])) - Number(isAllCaps(y[0])) || y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
    const stores = [...b.stores.values()].map(({ kept, products }) => {
      const sorted = [...products].sort((x, y) => x.price! - y.price! || x.title.localeCompare(y.title, "es"));
      const seen = new Set<string>();
      const offers = [];
      for (const p of sorted) {
        const key = `${fold(p.title)}|${p.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offers.push({
          title: shortTitle(p.title), price: p.price!, url: p.url,
          ...(p.compareAtPrice !== undefined && p.compareAtPrice > p.price! ? { before: p.compareAtPrice } : {}),
          ...(p.available === undefined ? {} : { available: p.available }),
        });
        if (offers.length === OFFERS_PER_STORE) break;
      }
      const st = kept.store;
      return { id: st.id, name: st.name, url: st.url, domain: st.domain, readAt: st.readAt, products: products.length, priceMin: sorted[0]!.price!, offers };
    }).sort((x, y) => x.priceMin - y.priceMin || x.name.localeCompare(y.name, "es", { sensitivity: "base" }));

    // The same product (same barcode) in two or more stores: each store's cheapest listing of it.
    const byGtin = new Map<string, Map<string, { storeId: string; store: string; price: number; url: string; readAt: string; title: string }>>();
    for (const { kept, products } of b.stores.values()) {
      for (const p of products) {
        const g = normalGtin(p.gtin);
        if (g === undefined) continue;
        const m = byGtin.get(g) ?? new Map();
        const prev = m.get(kept.store.id);
        if (prev === undefined || p.price! < prev.price) m.set(kept.store.id, { storeId: kept.store.id, store: kept.store.name, price: p.price!, url: p.url, readAt: kept.store.readAt, title: shortTitle(p.title) });
        byGtin.set(g, m);
      }
    }
    const same = [...byGtin.entries()]
      .filter(([, m]) => m.size >= 2)
      .map(([gtin, m]) => {
        const offers = [...m.values()].sort((x, y) => x.price - y.price || x.store.localeCompare(y.store, "es"));
        return { gtin, title: offers[0]!.title, offers: offers.map(({ title: _t, ...o }) => o) };
      })
      .sort((x, y) => y.offers.length - x.offers.length || (y.offers.at(-1)!.price - y.offers[0]!.price) - (x.offers.at(-1)!.price - x.offers[0]!.price) || x.title.localeCompare(y.title, "es"))
      .slice(0, SAME_PER_PAGE);

    const reads = stores.map((s) => s.readAt).sort();
    pages.push(BrandPageSchema.parse({ slug, brand, updatedAt: today, readFrom: reads[0]!, readTo: reads.at(-1)!, stores, same }));
  }
  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Rendering

export const brandUrl = (slug?: string) => guideUrl(slug === undefined ? "marcas" : `marcas/${slug}`);

const dateSpan = (from: string, to: string) => (from === to ? `el ${longDate(from)}` : `entre el ${longDate(from)} y el ${longDate(to)}`);

function brandJsonLd(p: BrandPage, pageUrl: string): unknown {
  const items: unknown[] = [];
  for (const s of p.same) {
    items.push({
      "@type": "Product", name: s.title, brand: { "@type": "Brand", name: p.brand }, gtin: s.gtin,
      offers: {
        "@type": "AggregateOffer", priceCurrency: "CLP", lowPrice: s.offers[0]!.price, highPrice: s.offers.at(-1)!.price, offerCount: s.offers.length,
        offers: s.offers.map((o) => ({ "@type": "Offer", price: o.price, priceCurrency: "CLP", url: o.url, seller: { "@type": "OnlineStore", name: o.store } })),
      },
    });
  }
  for (const st of p.stores) {
    for (const o of st.offers) {
      items.push({
        "@type": "Product", name: o.title, brand: { "@type": "Brand", name: p.brand },
        offers: {
          "@type": "Offer", price: o.price, priceCurrency: "CLP", url: o.url, seller: { "@type": "OnlineStore", name: st.name, url: st.url },
          ...(o.available === undefined ? {} : { availability: o.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock" }),
        },
      });
    }
  }
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": pageUrl,
    url: pageUrl,
    name: `Dónde comprar ${p.brand} en Chile`,
    inLanguage: "es-CL",
    dateModified: p.updatedAt,
    publisher: { "@type": "Organization", name: "AgentPey", url: "https://agentpey.com" },
    isPartOf: { "@type": "WebSite", name: "Guías AgentPey", url: guideUrl() },
    mainEntity: { "@type": "ItemList", name: `${p.brand} en tiendas online de Chile`, numberOfItems: items.length, itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, item })) },
  };
}

function head(title: string, description: string, canonical: string, jsonLd?: unknown): string {
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index, follow, max-snippet:-1">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
${jsonLd === undefined ? "" : `<script type="application/ld+json">${scriptJson(jsonLd)}</script>\n`}<style>${STYLE}
.price{font-weight:600;white-space:nowrap}.best{font-size:.8rem;color:var(--accent);font-weight:600}
</style>
</head>`;
}

/** The page of one brand: plain HTML, readable with no JavaScript, with schema.org Product and Offer data. */
export function brandHtml(p: BrandPage, guides: readonly { slug: string; shortTitle: string }[] = []): string {
  const pageUrl = brandUrl(p.slug);
  const cheapest = [...p.stores].sort((a, b) => a.priceMin - b.priceMin)[0]!;
  const total = p.stores.reduce((a, s) => a + s.products, 0);
  const description = `${p.stores.length} tiendas online de Chile venden ${p.brand}, desde ${clp(cheapest.priceMin)}. Precios de cada tienda y el mismo producto comparado entre tiendas, de sus catálogos públicos. Actualizada el ${longDate(p.updatedAt)}.`;
  const same = p.same.map((s) => `<li><h3>${escapeHtml(s.title)}</h3><div class="table-wrap"><table><thead><tr><th>Tienda</th><th>Precio</th><th>Leído el</th></tr></thead><tbody>${s.offers.map((o, i) => `<tr><td><a href="${escapeHtml(o.url)}">${escapeHtml(o.store)}</a>${i === 0 ? ' <span class="best">más barato</span>' : ""}</td><td class="price">${clp(o.price)}</td><td><time datetime="${o.readAt}">${longDate(o.readAt)}</time></td></tr>`).join("")}</tbody></table></div><p class="muted">Código de barras ${escapeHtml(s.gtin)}.</p></li>`).join("\n");
  const stores = p.stores.map((s) => `<li id="${escapeHtml(s.id)}"><h3><a href="${escapeHtml(s.url)}">${escapeHtml(s.name)}</a> <span class="muted">${escapeHtml(s.domain)}</span></h3>
<p>${num(s.products)} ${s.products === 1 ? "producto" : "productos"} de ${escapeHtml(p.brand)} con precio, desde <span class="price">${clp(s.priceMin)}</span>.</p>
<ul class="facts">${s.offers.map((o) => `<li><a href="${escapeHtml(o.url)}">${escapeHtml(o.title)}</a>: <span class="price">${clp(o.price)}</span>${o.before === undefined ? "" : ` <span class="muted">(antes ${clp(o.before)})</span>`}</li>`).join("")}</ul>
<p class="muted">Catálogo leído el <time datetime="${s.readAt}">${longDate(s.readAt)}</time>.</p></li>`).join("\n");
  const guideLinks = guides.map((g) => `<a href="${escapeHtml(guideUrl(g.slug))}">${escapeHtml(g.shortTitle)}</a>`).join(" · ");
  return `${head(`${p.brand} en Chile: dónde comprar y precios por tienda (${p.updatedAt.slice(0, 4)}) · AgentPey`, description, pageUrl, brandJsonLd(p, pageUrl))}
<body>
<main>
<p class="eyebrow"><a href="${escapeHtml(brandUrl())}">Marcas</a> · actualizada el <time datetime="${p.updatedAt}">${longDate(p.updatedAt)}</time></p>
<h1>Dónde comprar ${escapeHtml(p.brand)} en Chile</h1>
<p class="lead">${p.stores.length} tiendas online chilenas con sitio propio venden ${escapeHtml(p.brand)}: ${num(total)} productos con precio en total. El más barato que encontramos cuesta <span class="price">${clp(cheapest.priceMin)}</span> en ${escapeHtml(cheapest.name)}.</p>
<p class="note">${escapeHtml(DISCLOSURE)}</p>
<p><strong>Cómo están ordenadas.</strong> ${escapeHtml(BRAND_ORDER_RULE)}</p>
<p class="muted">Son los precios que cada tienda publicaba el día que leímos su catálogo (la fecha está en cada una). Pueden haber cambiado: confírmalos en la tienda antes de comprar. Despacho y medios de pago no están incluidos.</p>
${p.same.length > 0 ? `
<h2>El mismo producto en varias tiendas</h2>
<p>Productos con el mismo código de barras en más de una tienda, del precio más bajo al más alto.</p>
<ol class="stores">
${same}
</ol>
` : ""}
<h2>Las tiendas</h2>
<p>Hasta ${OFFERS_PER_STORE} productos de ${escapeHtml(p.brand)} por tienda, los de menor precio.</p>
<ol class="stores">
${stores}
</ol>

<h2 id="metodologia">Metodología</h2>
<ul>
<li><strong>Qué tiendas entran.</strong> Tiendas online chilenas con sitio propio de las listas públicas de participantes de blackfriday.cl y cyber.cl, sin grandes tiendas, multitiendas ni marketplaces, que tenían productos de ${escapeHtml(p.brand)} con precio.</li>
<li><strong>De dónde salen los datos.</strong> Del catálogo público de cada tienda, leído ${dateSpan(p.readFrom, p.readTo)}, respetando su robots.txt. La marca es la que la propia tienda le pone a cada producto.</li>
<li><strong>Precios.</strong> En pesos chilenos, el precio más bajo de cada producto ese día. No contamos los productos que la tienda mostraba agotados. "Antes" es el precio tachado que mostraba la tienda. "El mismo producto" compara solo productos con el mismo código de barras (GTIN).</li>
<li><strong>Orden.</strong> ${escapeHtml(BRAND_ORDER_RULE)}</li>
<li><strong>Relación con AgentPey.</strong> ${escapeHtml(DISCLOSURE)} Nadie paga por aparecer.</li>
</ul>

<footer>
<p><a href="${escapeHtml(brandUrl())}">Todas las marcas</a>${guideLinks === "" ? "" : ` · Guías por rubro: ${guideLinks}`}</p>
<p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos. Actualizada el ${longDate(p.updatedAt)}.</p>
</footer>
</main>
</body>
</html>
`;
}

/** Every brand page, by letter, with how many stores sell it and its lowest price. */
export function brandsIndexHtml(brands: readonly BrandSummary[]): string {
  const sorted = [...brands].sort((a, b) => a.slug.localeCompare(b.slug));
  const groups = new Map<string, BrandSummary[]>();
  for (const b of sorted) {
    const letter = /^[a-z]/.test(b.slug) ? b.slug[0]!.toUpperCase() : "#";
    groups.set(letter, [...(groups.get(letter) ?? []), b]);
  }
  const updated = sorted.map((b) => b.updatedAt).sort().at(-1);
  const body = [...groups.entries()].map(([letter, bs]) => `<h2 id="${letter === "#" ? "num" : letter}">${letter}</h2>
<ul>${bs.map((b) => `<li><a href="${escapeHtml(brandUrl(b.slug))}">${escapeHtml(b.brand)}</a> <span class="muted">${b.stores} tiendas · desde ${clp(b.priceMin)}</span></li>`).join("")}</ul>`).join("\n");
  return `${head("Marcas en tiendas online de Chile: dónde comprar y a qué precio · AgentPey", `${num(brands.length)} marcas que venden dos o más tiendas online chilenas, con el precio de cada tienda, de sus catálogos públicos.`, brandUrl())}
<body>
<main>
<p class="eyebrow"><a href="${escapeHtml(guideUrl())}">Guías AgentPey</a>${updated === undefined ? "" : ` · actualizada el <time datetime="${updated}">${longDate(updated)}</time>`}</p>
<h1>Marcas en tiendas online de Chile</h1>
<p class="lead">${num(brands.length)} marcas que venden dos o más tiendas online chilenas con sitio propio. En cada una: qué tiendas la venden, sus precios y el mismo producto comparado entre tiendas.</p>
<p class="note">${escapeHtml(DISCLOSURE)}</p>
${body}
<footer><p>Hecha por <a href="https://agentpey.com">AgentPey</a> con datos públicos.</p></footer>
</main>
</body>
</html>
`;
}
