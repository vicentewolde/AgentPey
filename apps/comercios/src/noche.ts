/**
 * The night shift: work that needs Claude (the subscription, `claude -p`)
 * runs while nobody is using the plan, and stops on its own at the plan's
 * usage limit, at a set hour or after a set number of stores. Its first task
 * reads every public store's shipping, returns, warranty and payment pages
 * (politicas.ts). Each store tried is recorded, so a store whose pages could
 * not be read is not retried every night.
 */

export interface PolicyCandidate {
  readonly id: string;
  /** Products in its last good catalogue reading; stores with a catalogue go first. */
  readonly products: number;
  /** When its policy pages were last tried (read, empty or failed), ISO; undefined if never. */
  readonly triedAt: string | undefined;
}

/** Stores due for a policy reading: never tried, or tried more than `days` days before `now`; catalogue stores first, bigger first. */
export function policyTargets(candidates: readonly PolicyCandidate[], now: Date, days: number, max = Infinity): PolicyCandidate[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return candidates
    .filter((c) => c.triedAt === undefined || c.triedAt < cutoff)
    .sort((a, b) => Number(a.triedAt !== undefined) - Number(b.triedAt !== undefined) || b.products - a.products || a.id.localeCompare(b.id))
    .slice(0, max);
}

/**
 * The moment to stop for `--hasta HH:MM`, in local time: today at that hour,
 * or tomorrow when that hour has already passed (a run started at 23:00 with
 * --hasta 06:30 stops the next morning).
 */
export function deadline(start: Date, hhmm: string): Date | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (m === null || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  const d = new Date(start);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= start.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** SQLite's "database is locked" (the weekly job may hold a long write transaction). */
export const isBusy = (error: unknown): boolean => /SQLITE_BUSY|database is locked/i.test(String((error as { message?: unknown })?.message ?? error));

/** Run a database write, waiting and trying again while the database is busy, instead of counting the store as failed. */
export async function retryBusy<T>(write: () => T, tries = 8, waitMs = 15_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return write();
    } catch (error) {
      if (!isBusy(error) || i >= tries) throw error;
      await sleep(waitMs);
    }
  }
}

export type StopReason = "límite del plan" | "hora de término" | "tope de tiendas" | "terminó la lista";

/** One line for the night's log: what was done, how long it took and why it stopped, to estimate how much a plan window holds. */
export function nightSummary(r: { start: Date; end: Date; tried: number; saved: number; empty: number; failed: number; calls: number; reason: StopReason; detail?: string }): string {
  const minutes = Math.round((r.end.getTime() - r.start.getTime()) / 60_000);
  const perHour = minutes > 0 ? ((r.calls * 60) / minutes).toFixed(1) : "-";
  return [
    `inicio ${r.start.toISOString()} · fin ${r.end.toISOString()} · ${minutes} min`,
    `tiendas probadas ${r.tried}: ${r.saved} con política guardada, ${r.empty} sin páginas de políticas, ${r.failed} con error`,
    `consultas a Claude ${r.calls} (${perHour} por hora)`,
    `se detuvo por: ${r.reason}${r.detail === undefined ? "" : ` (${r.detail.slice(0, 200)})`}`,
  ].join("\n");
}
