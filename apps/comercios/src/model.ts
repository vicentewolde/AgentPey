/**
 * The one product shape every platform is normalised into. Prices are whole
 * Chilean pesos (CLP has no minor unit), so they are integers.
 */
export type Platform = "shopify" | "woocommerce" | "vtex" | "jumpseller" | "prestashop" | "propia";

/** How a store came into the demo. Only "piloto" stores said yes; the rest are public-data diagnostics. */
export type StoreOrigin = "piloto" | "black-friday";

export interface Store {
  readonly id: string;
  readonly name: string;
  /** Origin with scheme and no trailing slash, e.g. https://hifi.cl */
  readonly origin: string;
  readonly platform: Platform;
  readonly rubro: string;
  readonly source: StoreOrigin;
  /** False for stores that sell by quotation (no cart), like Luminova. */
  readonly sellsOnline: boolean;
}

export interface Product {
  readonly storeId: string;
  /** Stable id within the store (platform id, or the URL path when there is none). */
  readonly id: string;
  readonly title: string;
  /** Plain text, HTML removed. */
  readonly description: string;
  readonly url: string;
  readonly images: readonly string[];
  /** Lowest current price across variants, whole CLP. Undefined when the store shows no price. */
  readonly price: number | undefined;
  /** "Before" price when the product is on sale. */
  readonly compareAtPrice: number | undefined;
  readonly available: boolean | undefined;
  readonly brand: string | undefined;
  readonly sku: string | undefined;
  readonly gtin: string | undefined;
  readonly category: string | undefined;
  readonly tags: readonly string[];
  /** Named attributes found in structured data (color, talla, material…). */
  readonly attributes: Readonly<Record<string, string>>;
  readonly variants: readonly Variant[];
}

export interface Variant {
  readonly id: string;
  readonly title: string;
  readonly price: number | undefined;
  readonly available: boolean | undefined;
  readonly sku: string | undefined;
}

/** Whole pesos from "12.990", "12990.00", 12990, "$12.990". Undefined when it is not a price. */
export function toClp(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  if (typeof value !== "string") return undefined;
  const s = value.replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return undefined;
  // A separator followed by 1–2 digits at the end is a decimal part ("12990.00", "1.299.990,00"); a group of
  // three is thousands ("12.990"). Pesos have no cents, so the decimal part is dropped.
  const n = Number(s.replace(/[.,]\d{1,2}$/, "").replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string | undefined | null): string {
  if (html === undefined || html === null) return "";
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
