/**
 * Map each platform's public catalogue format to `Product`. Pure functions over
 * already-fetched JSON, so they are tested with fixtures and no network.
 */
import { htmlToText, toClp, decodeEntities, type Product, type Variant } from "../model.js";

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

function minDefined(values: (number | undefined)[]): number | undefined {
  const xs = values.filter((x): x is number => x !== undefined && x > 0);
  return xs.length === 0 ? undefined : Math.min(...xs);
}

/** `/products.json` of a Shopify store. */
export function fromShopify(storeId: string, origin: string, p: Json): Product {
  const variants: Variant[] = arr(p.variants).map((raw) => {
    const v = obj(raw);
    return { id: String(v.id ?? ""), title: str(v.title) ?? "", price: toClp(v.price), available: typeof v.available === "boolean" ? v.available : undefined, sku: str(v.sku) };
  });
  const cheapest = variants.reduce<Variant | undefined>((best, v) => (v.price !== undefined && (best?.price === undefined || v.price < best.price) ? v : best), undefined);
  const firstRaw = obj(arr(p.variants).find((raw) => toClp(obj(raw).price) === cheapest?.price) ?? arr(p.variants)[0]);
  const compare = toClp(firstRaw.compare_at_price);
  const attributes: Record<string, string> = {};
  for (const raw of arr(p.options)) {
    const o = obj(raw);
    const name = str(o.name);
    const values = arr(o.values).map(String).filter((x) => x !== "Default Title");
    if (name !== undefined && name !== "Title" && values.length > 0) attributes[name] = values.join(", ");
  }
  const tags = Array.isArray(p.tags) ? p.tags.map(String) : (str(p.tags) ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    storeId,
    id: String(p.id),
    title: decodeEntities(str(p.title) ?? ""),
    description: htmlToText(str(p.body_html)),
    url: `${origin}/products/${str(p.handle) ?? ""}`,
    images: arr(p.images).map((i) => str(obj(i).src)).filter((x): x is string => x !== undefined),
    price: cheapest?.price,
    compareAtPrice: compare !== undefined && cheapest?.price !== undefined && compare > cheapest.price ? compare : undefined,
    available: variants.some((v) => v.available === true) ? true : variants.every((v) => v.available === false) ? false : undefined,
    brand: str(p.vendor),
    sku: variants[0]?.sku,
    gtin: str(firstRaw.barcode),
    category: str(p.product_type),
    tags,
    attributes,
    variants,
  };
}

/** WooCommerce Store API `/wp-json/wc/store/v1/products`. */
export function fromWooCommerce(storeId: string, p: Json): Product {
  const prices = obj(p.prices);
  const minor = Number(prices.currency_minor_unit ?? 0);
  const scale = (v: unknown): number | undefined => {
    const n = toClp(str(v));
    return n === undefined ? undefined : Math.round(n / 10 ** (Number.isFinite(minor) ? minor : 0));
  };
  const price = scale(prices.price);
  const regular = scale(prices.regular_price);
  const attributes: Record<string, string> = {};
  for (const raw of arr(p.attributes)) {
    const a = obj(raw);
    const name = str(a.name);
    const terms = arr(a.terms).map((t) => str(obj(t).name)).filter((x): x is string => x !== undefined);
    if (name !== undefined && terms.length > 0) attributes[decodeEntities(name)] = decodeEntities(terms.join(", "));
  }
  const brands = arr(p.brands).map((b) => str(obj(b).name)).filter((x): x is string => x !== undefined);
  return {
    storeId,
    id: String(p.id),
    title: decodeEntities(str(p.name) ?? ""),
    description: htmlToText([str(p.short_description), str(p.description)].filter(Boolean).join("\n")),
    url: str(p.permalink) ?? "",
    images: arr(p.images).map((i) => str(obj(i).src)).filter((x): x is string => x !== undefined),
    price,
    compareAtPrice: regular !== undefined && price !== undefined && regular > price ? regular : undefined,
    available: typeof p.is_in_stock === "boolean" ? p.is_in_stock : undefined,
    brand: brands[0] ?? attributes.Marca ?? attributes.marca,
    sku: str(p.sku),
    gtin: undefined,
    category: arr(p.categories).map((c) => decodeEntities(str(obj(c).name) ?? "")).filter(Boolean).join(" > ") || undefined,
    tags: arr(p.tags).map((t) => decodeEntities(str(obj(t).name) ?? "")).filter(Boolean),
    attributes,
    variants: [],
  };
}

/** VTEX public catalogue `/api/catalog_system/pub/products/search`. */
export function fromVtex(storeId: string, origin: string, p: Json): Product {
  const items = arr(p.items).map(obj);
  const variants: Variant[] = items.map((it) => {
    const offer = obj(obj(arr(it.sellers)[0]).commertialOffer);
    return { id: String(it.itemId ?? ""), title: str(it.name) ?? "", price: toClp(offer.Price), available: typeof offer.IsAvailable === "boolean" ? offer.IsAvailable : undefined, sku: str(it.itemId) };
  });
  const firstOffer = obj(obj(arr(items[0]?.sellers)[0]).commertialOffer);
  const price = minDefined(variants.map((v) => v.price));
  const list = toClp(firstOffer.ListPrice);
  const attributes: Record<string, string> = {};
  for (const name of arr(p.allSpecifications).map(String)) {
    const values = arr(p[name]).map(String);
    if (values.length > 0) attributes[name] = values.join(", ");
  }
  const categories = arr(p.categories).map(String);
  const deepest = categories.sort((a, b) => b.length - a.length)[0];
  return {
    storeId,
    id: String(p.productId),
    title: decodeEntities(str(p.productName) ?? ""),
    description: htmlToText(str(p.description)),
    url: str(p.link) ?? `${origin}/${str(p.linkText) ?? ""}/p`,
    images: items.flatMap((it) => arr(it.images).map((i) => str(obj(i).imageUrl))).filter((x): x is string => x !== undefined).slice(0, 8),
    price,
    compareAtPrice: list !== undefined && price !== undefined && list > price ? list : undefined,
    available: variants.some((v) => v.available === true) ? true : variants.length > 0 ? false : undefined,
    brand: str(p.brand),
    sku: str(p.productReference),
    gtin: str(items[0]?.ean),
    category: deepest?.split("/").filter(Boolean).join(" > "),
    tags: [],
    attributes,
    variants,
  };
}

/** All JSON-LD blocks of a page, with `@graph` flattened. Broken blocks are skipped. */
export function jsonLdNodes(html: string): Json[] {
  const nodes: Json[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      try {
        data = JSON.parse(m[1]!.trim().replace(/[\u0000-\u001f]+/g, " "));
      } catch {
        continue;
      }
    }
    const stack = Array.isArray(data) ? [...data] : [data];
    while (stack.length > 0) {
      const n = obj(stack.shift());
      if (Array.isArray(n["@graph"])) stack.push(...(n["@graph"] as unknown[]));
      if (Object.keys(n).length > 0) nodes.push(n);
    }
  }
  return nodes;
}

const isType = (n: Json, type: string): boolean => {
  const t = n["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
};

function meta(html: string, prop: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop.replace(/[:.]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop.replace(/[:.]/g, "\\$&")}["']`, "i");
  const m = re.exec(html);
  const v = m?.[1] ?? m?.[2];
  return v === undefined || v.trim() === "" ? undefined : decodeEntities(v.trim());
}

/**
 * A product page of any platform: schema.org Product in JSON-LD first, then
 * Open Graph product tags. Undefined when the page is not a product.
 */
export function fromProductPage(storeId: string, url: string, html: string): Product | undefined {
  const product = jsonLdNodes(html).find((n) => isType(n, "Product") || isType(n, "ProductGroup"));
  if (product === undefined) {
    const ogType = meta(html, "og:type");
    const amount = meta(html, "product:price:amount");
    if (ogType !== "product" && amount === undefined) return undefined;
    const title = meta(html, "og:title");
    if (title === undefined) return undefined;
    const image = meta(html, "og:image");
    return {
      storeId, id: new URL(url).pathname, title, description: meta(html, "og:description") ?? meta(html, "description") ?? "", url,
      images: image === undefined ? [] : [image], price: toClp(amount), compareAtPrice: undefined,
      available: meta(html, "product:availability")?.toLowerCase().includes("in") , brand: meta(html, "product:brand"),
      sku: undefined, gtin: undefined, category: undefined, tags: [], attributes: {}, variants: [],
    };
  }
  const variantNodes = arr(product.hasVariant).map(obj);
  const offerNodes = [product, ...variantNodes].flatMap((n) => {
    const o = n.offers;
    return Array.isArray(o) ? o.map(obj) : o === undefined ? [] : [obj(o)];
  });
  const prices = offerNodes.map((o) => toClp(o.price ?? o.lowPrice));
  const availability = offerNodes.map((o) => str(o.availability)?.toLowerCase());
  const brandRaw = product.brand;
  const brand = typeof brandRaw === "string" ? brandRaw : str(obj(Array.isArray(brandRaw) ? brandRaw[0] : brandRaw).name);
  const images = (Array.isArray(product.image) ? product.image : [product.image])
    .map((i) => (typeof i === "string" ? i : str(obj(i).url) ?? str(obj(i).contentUrl)))
    .filter((x): x is string => x !== undefined);
  const attributes: Record<string, string> = {};
  for (const raw of arr(product.additionalProperty)) {
    const a = obj(raw);
    const name = str(a.name);
    const value = str(a.value);
    if (name !== undefined && value !== undefined) attributes[name] = value;
  }
  for (const key of ["color", "material", "size", "weight", "model", "pattern"]) {
    const v = product[key];
    const s = typeof v === "string" ? v : str(obj(v).value) ?? str(obj(v).name);
    if (s !== undefined) attributes[key] = s;
  }
  const category = product.category;
  return {
    storeId,
    id: str(product.productID) ?? str(product.sku) ?? new URL(url).pathname,
    title: decodeEntities(str(product.name) ?? meta(html, "og:title") ?? ""),
    description: htmlToText(str(product.description) ?? meta(html, "og:description")),
    url: str(product.url) ?? url,
    images: images.length > 0 ? images : [meta(html, "og:image")].filter((x): x is string => x !== undefined),
    price: minDefined(prices),
    compareAtPrice: undefined,
    available: availability.some((a) => a?.includes("instock") === true) ? true : availability.length > 0 && availability.every((a) => a?.includes("outofstock") === true) ? false : undefined,
    brand,
    sku: str(product.sku),
    gtin: str(product.gtin13) ?? str(product.gtin) ?? str(product.gtin12) ?? str(product.gtin14) ?? str(product.gtin8),
    category: typeof category === "string" && !/^\d+$/.test(category) ? category : str(obj(category).name),
    tags: [],
    attributes,
    variants: variantNodes.map((v) => ({ id: str(v.sku) ?? str(v.productID) ?? "", title: str(v.name) ?? "", price: toClp(obj(Array.isArray(v.offers) ? v.offers[0] : v.offers).price), available: undefined, sku: str(v.sku) })),
  };
}

/** `<loc>` entries of a sitemap or sitemap index. */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!.trim()));
}
