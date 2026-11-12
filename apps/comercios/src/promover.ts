/**
 * Problem 5, "gastar bien" — a SIMULATION. There are no ads inside AI
 * assistants in Chile yet (OpenAI's feed accepts US, CA and MX only, 11-nov-2026),
 * so this ranks which products would be worth promoting first, from data we do
 * have: in stock, a listing an assistant can use, a price that can carry a
 * promotion, and AI answers where the store did not show up. The owner adds
 * margin when known; without it, price stands in. Every screen says "simulación".
 */
import type { Product } from "./model.js";

export interface PromoteInput {
  readonly products: readonly Product[];
  /** Listing score 0–10 from the AI review, by product id, when there is one. */
  readonly listingScore: ReadonlyMap<string, number>;
  /** Margin share 0–1 by product id, when the owner gave it. */
  readonly margin?: ReadonlyMap<string, number>;
  /** Words from buyer questions where the store did not appear (missed demand). */
  readonly missedDemand: readonly string[];
}

export interface PromoteRow {
  readonly product: Product;
  readonly score: number;
  readonly reasons: readonly string[];
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function rankForPromotion(input: PromoteInput, k = 10): PromoteRow[] {
  const demand = input.missedDemand.map(fold).filter((w) => w.length > 3);
  const rows = input.products
    .filter((p) => p.available !== false && p.price !== undefined && p.price > 0)
    .map((p) => {
      const reasons: string[] = [];
      const text = fold(`${p.title} ${p.category ?? ""}`);
      const hits = demand.filter((w) => text.includes(w)).length;
      const listing = input.listingScore.get(p.id);
      const margin = input.margin?.get(p.id);
      const value = Math.log10(p.price!) * (margin ?? 0.3);
      let score = value;
      if (hits > 0) {
        score *= 1 + Math.min(hits, 4) * 0.5;
        reasons.push(`la gente pregunta por esto y la IA no te nombra (${hits} coincidencias)`);
      }
      if (listing !== undefined) {
        score *= 0.5 + listing / 10;
        if (listing < 5) reasons.push("primero hay que mejorar la ficha");
      }
      if (p.compareAtPrice !== undefined) {
        score *= 1.2;
        reasons.push("está en oferta");
      }
      if (margin === undefined) reasons.push("sin margen informado: se usa el precio");
      return { product: p, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
  return rows.slice(0, k);
}
