/**
 * Problem 2, "que lo entiendan": a 0–100 score of how well an AI assistant can
 * read a catalogue, and the gaps behind it. Deterministic (no model), so the
 * same catalogue always gets the same score and before/after is comparable.
 */
import { conditionOf, toOpenAiRow, validGtin } from "./feeds.js";
import type { Product, Store } from "./model.js";

export interface Check {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  /** Share of products that pass, 0–1. */
  readonly pass: number;
  readonly failing: readonly string[];
  /** True when the store's public data cannot show this field (it may still exist inside the platform); left out of the score. */
  readonly notVisible?: boolean;
}

export interface Readiness {
  readonly score: number;
  readonly products: number;
  readonly checks: readonly Check[];
  /** Feed rows OpenAI would reject today. */
  readonly rejected: number;
}

const CHECKS: { key: string; label: string; weight: number; ok: (p: Product) => boolean }[] = [
  { key: "precio", label: "Precio visible", weight: 15, ok: (p) => p.price !== undefined && p.price > 0 },
  { key: "stock", label: "Dice si hay stock", weight: 10, ok: (p) => p.available !== undefined },
  { key: "marca", label: "Marca", weight: 10, ok: (p) => (p.brand ?? "").trim() !== "" },
  { key: "imagen", label: "Imagen", weight: 5, ok: (p) => p.images.length > 0 },
  { key: "descripcion", label: "Descripción útil (más de 150 caracteres)", weight: 15, ok: (p) => p.description.trim().length >= 150 },
  { key: "atributos", label: "Atributos concretos (medidas, material, compatibilidad…)", weight: 15, ok: (p) => Object.keys(p.attributes).length >= 2 || /\d+\s?(cm|mm|kg|g|gb|tb|w|mah|pulgadas|"|ml|l)\b/i.test(p.description) },
  { key: "categoria", label: "Categoría", weight: 10, ok: (p) => p.category !== undefined },
  { key: "gtin", label: "Código de barras válido", weight: 5, ok: (p) => validGtin(p.gtin) },
  { key: "condicion", label: "Estado coherente (nuevo, usado o reacondicionado)", weight: 5, ok: (p) => !contradictsCondition(p) },
  { key: "titulo", label: "Título claro (20–150 caracteres)", weight: 10, ok: (p) => p.title.length >= 20 && p.title.length <= 150 },
];

/** The title says used/refurbished but the description says new, or the other way round. */
export function contradictsCondition(p: Product): boolean {
  const c = conditionOf(p);
  const d = p.description.toLowerCase();
  if (c === "used" || c === "refurbished") return /totalmente nuevo|producto nuevo|nuevo sellado|nuevo en caja/.test(d);
  return false;
}

export function readiness(store: Store, products: readonly Product[]): Readiness {
  if (products.length === 0) return { score: 0, products: 0, checks: [], rejected: 0 };
  const checks: Check[] = CHECKS.map((c) => {
    const failing = products.filter((p) => !c.ok(p));
    // Shopify's public catalogue never includes barcodes: a 0% there says nothing about the store.
    const notVisible = c.key === "gtin" && store.platform === "shopify" && failing.length === products.length;
    return { key: c.key, label: c.label, weight: c.weight, pass: 1 - failing.length / products.length, failing: failing.map((p) => p.id), ...(notVisible ? { notVisible } : {}) };
  });
  const counted = checks.filter((c) => c.notVisible !== true);
  const total = counted.reduce((a, c) => a + c.weight, 0);
  const score = Math.round((counted.reduce((a, c) => a + c.weight * c.pass, 0) / total) * 100);
  const rejected = products.filter((p) => toOpenAiRow(store, p).problems.some((x) => x.level === "rechazo")).length;
  return { score, products: products.length, checks, rejected };
}
