/**
 * The weekly re-read of every public catalogue (`cli base ingest --todas`, run
 * by scripts/semanal.sh). A re-read replaces a store's catalogue only when it
 * looks complete: a store whose site was down that night, or that answered
 * with a fraction of its products, keeps the previous reading and its date,
 * and drops out of the pages once that date is too old (guia.ts → freshReadAt).
 */

/** A re-read with less than this share of the previous count is taken as partial. */
export const MIN_SHARE = 0.5;
/** Below this many products before, a drop is ordinary catalogue change, not a partial read. */
export const MIN_PREVIOUS = 20;

export type RereadVerdict = { replace: true } | { replace: false; reason: string };

/** Two partial readings in a row within this share of each other are the store's new size, not a bad night. */
export const SAME_SIZE = 0.2;

/**
 * Whether a reading of `now` products (undefined: it failed) should replace a
 * catalogue of `previous`. `lastKept` is the count of the run just before, when
 * that run was itself kept as partial: the same smaller size two weeks running
 * is taken as real (a store that shrank must not stay frozen and then vanish).
 */
export function rereadVerdict(previous: number, now: number | undefined, lastKept?: number): RereadVerdict {
  if (now === undefined) return previous > 0 ? { replace: false, reason: "la lectura falló" } : { replace: true };
  if (previous >= MIN_PREVIOUS && now < previous * MIN_SHARE) {
    if (lastKept !== undefined && Math.abs(now - lastKept) <= Math.max(lastKept, now) * SAME_SIZE) return { replace: true };
    return { replace: false, reason: `leyó ${now} productos, antes ${previous}` };
  }
  return { replace: true };
}

/** Published totals of the /chile pages: stores across the guides, brand pages, and rows of the price search. */
export interface PublishedTotals { readonly guideStores: number; readonly brands: number; readonly prices: number }

/** A publish shrinking either total by more than `maxDropPct`% is refused: a bug or a blocked night must not empty the pages. */
export function publishDrop(before: PublishedTotals, after: PublishedTotals, maxDropPct: number): string | undefined {
  for (const [name, b, a] of [["tiendas en las guías", before.guideStores, after.guideStores], ["páginas de marcas", before.brands, after.brands], ["precios del buscador", before.prices, after.prices]] as const) {
    if (b > 0 && a < b * (1 - maxDropPct / 100)) return `${name}: ${a}, antes ${b} (cae más de ${maxDropPct}%)`;
  }
  return undefined;
}
