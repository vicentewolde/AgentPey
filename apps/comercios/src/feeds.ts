/**
 * Problem 1, "entrar": the store's catalogue in the formats AI assistants read,
 * and the reasons a row would be rejected.
 *
 * OpenAI product feed: fields and rules from developers.openai.com/commerce/specs/feed,
 * read on 2026-11-11 (the page shows no version). On that date `target_countries`
 * accepted only US, CA and MX, so a Chilean feed is prepared, not submitted.
 */
import type { Product, Store } from "./model.js";

export type Availability = "in_stock" | "out_of_stock" | "unknown";

export interface OpenAiFeedRow {
  item_id: string;
  title: string;
  description: string;
  url: string;
  brand: string;
  seller_name: string;
  seller_url: string;
  image_url: string;
  additional_image_urls?: string[];
  availability: Availability;
  price: string;
  sale_price?: string;
  condition?: "new" | "refurbished" | "used";
  product_category?: string;
  gtin?: string;
  group_id?: string;
  listing_has_variations?: boolean;
}

export interface RowProblem {
  readonly field: string;
  /** "rechazo": OpenAI rejects the row; "aviso": accepted but weaker. */
  readonly level: "rechazo" | "aviso";
  readonly message: string;
}

const money = (clp: number): string => `${clp.toFixed(2)} CLP`;

/** Valid GTIN-8/12/13/14 with its check digit. */
export function validGtin(code: string | undefined): boolean {
  if (code === undefined || !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** "used"/"refurbished" when the title or category says so; the spec asks to always state it. */
export function conditionOf(p: Product): "new" | "refurbished" | "used" | undefined {
  const text = `${p.title} ${p.category ?? ""} ${p.tags.join(" ")}`.toLowerCase();
  if (/reacondicionad|refurbish|renovad/.test(text)) return "refurbished";
  if (/\busad[oa]s?\b|seminuev|segunda mano|open box/.test(text)) return "used";
  return undefined;
}

export function toOpenAiRow(store: Store, p: Product): { row: OpenAiFeedRow; problems: RowProblem[] } {
  const problems: RowProblem[] = [];
  const need = (field: string, ok: boolean, message: string) => {
    if (!ok) problems.push({ field, level: "rechazo", message });
  };
  need("title", p.title.trim() !== "", "sin título");
  need("url", /^https?:\/\//.test(p.url), "sin enlace al producto");
  need("brand", p.brand !== undefined && p.brand.trim() !== "", "sin marca");
  need("image_url", p.images.length > 0, "sin imagen");
  need("price", p.price !== undefined && p.price > 0, "sin precio visible");
  need("availability", p.available !== undefined, "no dice si hay stock");
  if (p.description.trim().length < 80) problems.push({ field: "description", level: "aviso", message: "descripción muy corta o vacía" });
  if (p.title.length > 150) problems.push({ field: "title", level: "aviso", message: "título de más de 150 caracteres" });
  if (p.gtin !== undefined && !validGtin(p.gtin)) problems.push({ field: "gtin", level: "aviso", message: "código de barras inválido" });
  if (p.gtin === undefined) problems.push({ field: "gtin", level: "aviso", message: "sin código de barras (GTIN)" });
  if (p.category === undefined) problems.push({ field: "product_category", level: "aviso", message: "sin categoría" });
  const condition = conditionOf(p);
  const sale = p.compareAtPrice !== undefined && p.price !== undefined && p.price < p.compareAtPrice;
  const row: OpenAiFeedRow = {
    item_id: `${store.id}-${p.id}`,
    title: p.title.slice(0, 150),
    description: p.description.slice(0, 5000),
    url: p.url,
    brand: p.brand ?? "",
    seller_name: store.name,
    seller_url: store.origin,
    image_url: p.images[0] ?? "",
    availability: p.available === undefined ? "unknown" : p.available ? "in_stock" : "out_of_stock",
    price: money(sale ? p.compareAtPrice! : (p.price ?? 0)),
  };
  if (p.images.length > 1) row.additional_image_urls = p.images.slice(1, 10);
  if (sale) row.sale_price = money(p.price!);
  if (condition !== undefined) row.condition = condition;
  if (p.category !== undefined) row.product_category = p.category;
  if (validGtin(p.gtin)) row.gtin = p.gtin!;
  return { row, problems };
}

export function openAiFeed(store: Store, products: readonly Product[]): { jsonl: string; rejected: number; problems: Map<string, RowProblem[]> } {
  const problems = new Map<string, RowProblem[]>();
  const lines: string[] = [];
  let rejected = 0;
  for (const p of products) {
    const r = toOpenAiRow(store, p);
    problems.set(p.id, r.problems);
    if (r.problems.some((x) => x.level === "rechazo")) rejected++;
    else lines.push(JSON.stringify(r.row));
  }
  return { jsonl: lines.join("\n") + (lines.length > 0 ? "\n" : ""), rejected, problems };
}

/** schema.org Product JSON-LD for one product, to paste in the product page when the platform does not emit it. */
export function productJsonLd(store: Store, p: Product): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    description: p.description.slice(0, 5000),
    image: p.images.slice(0, 5),
    sku: p.sku,
    gtin: validGtin(p.gtin) ? p.gtin : undefined,
    brand: p.brand === undefined ? undefined : { "@type": "Brand", name: p.brand },
    category: p.category,
    additionalProperty: Object.entries(p.attributes).map(([name, value]) => ({ "@type": "PropertyValue", name, value })),
    offers: p.price === undefined ? undefined : {
      "@type": "Offer",
      url: p.url,
      price: p.price,
      priceCurrency: "CLP",
      availability: p.available === false ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
      seller: { "@type": "Organization", name: store.name },
    },
  };
}

/** A short llms.txt: what the store is and where its catalogue is, for assistants that read it. */
export function llmsTxt(store: Store, products: readonly Product[], feedUrl: string): string {
  const categories = [...new Set(products.map((p) => p.category).filter((c): c is string => c !== undefined))].slice(0, 15);
  return [
    `# ${store.name}`,
    "",
    `> Tienda chilena de ${store.rubro}. Precios en pesos chilenos (CLP), IVA incluido. Despacho en Chile.`,
    "",
    "## Catálogo",
    `- [Catálogo completo en JSONL](${feedUrl}): ${products.length} productos, actualizado a diario.`,
    ...(categories.length > 0 ? ["", "## Categorías", ...categories.map((c) => `- ${c}`)] : []),
    "",
  ].join("\n");
}
