import { VitrineeError, isStellarAccount, isStellarContractId } from "@vitrinee/core";

/**
 * A store's brake on who may pay it (T172, VT-49).
 *
 * The checkout is public on purpose: anyone holding testnet USDC can buy. That left a store with no way to stop an
 * account that kept buying (the 2026-10-19 incident), nor to say who. Two switches, both off by default so that a
 * store which sets neither behaves exactly as before:
 *
 *   - `blocked`: payer accounts that are refused outright.
 *   - `limit`: at most `max` purchases per payer in a sliding window of `windowSeconds`.
 *
 * The payer is read from the transaction the payer signed (`payerFromTransactionXdr`), never from the request body,
 * and the check runs before anything settles: a refused payer moves no money.
 */
export interface PayerLimit {
  max: number;
  windowSeconds: number;
}

export interface PayerGuardSettings {
  blocked: readonly string[];
  limit: PayerLimit | undefined;
}

export type PayerAdmission =
  | { ok: true }
  | { ok: false; code: "payer_blocked" }
  | { ok: false; code: "payer_rate_limited"; retryAfterSeconds: number };

export const NO_PAYER_GUARD: PayerGuardSettings = { blocked: [], limit: undefined };

export class PayerGuard {
  private readonly blocked: ReadonlySet<string>;
  /** When each payer's recent purchases were admitted, oldest first. Includes the ones still settling. */
  private readonly recent = new Map<string, number[]>();

  /**
   * @param seed the purchases the store already has (its orders), so a restart does not forget the window
   */
  constructor(
    private readonly settings: PayerGuardSettings,
    private readonly now: () => number = Date.now,
    seed: Iterable<{ payer: string; at: number }> = [],
  ) {
    this.blocked = new Set(settings.blocked);
    for (const { payer, at } of seed) {
      if (Number.isFinite(at)) this.push(payer, at);
    }
  }

  /** Whether either switch is on. A store with neither skips the guard altogether. */
  get active(): boolean {
    return this.blocked.size > 0 || this.settings.limit !== undefined;
  }

  /**
   * Decides whether `payer` may pay now. An admitted payer takes a place in the window straight away, so two
   * purchases arriving together cannot both slip under the limit; give it back with `release` if the payment is
   * then refused. A payer that could not be read is admitted: its payment cannot settle anyway.
   */
  admit(payer: string | undefined): PayerAdmission {
    if (payer === undefined) return { ok: true };
    if (this.blocked.has(payer)) return { ok: false, code: "payer_blocked" };
    const { limit } = this.settings;
    if (limit === undefined) return { ok: true };
    const now = this.now();
    const windowMs = limit.windowSeconds * 1_000;
    const inWindow = (this.recent.get(payer) ?? []).filter((at) => now - at < windowMs);
    if (inWindow.length >= limit.max) {
      // The place frees when the oldest purchase in the window leaves it.
      const oldest = inWindow[0] ?? now;
      this.recent.set(payer, inWindow);
      return { ok: false, code: "payer_rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1_000)) };
    }
    inWindow.push(now);
    this.recent.set(payer, inWindow);
    return { ok: true };
  }

  /** Gives back the place an admitted payment took, because it did not settle. */
  release(payer: string | undefined): void {
    if (payer === undefined || this.settings.limit === undefined) return;
    const list = this.recent.get(payer);
    list?.pop();
  }

  private push(payer: string, at: number): void {
    const list = this.recent.get(payer) ?? [];
    list.push(at);
    list.sort((a, b) => a - b);
    this.recent.set(payer, list);
  }
}

const isPayerAccount = (value: string): boolean => isStellarAccount(value) || isStellarContractId(value);

/**
 * `BLOCKED_PAYERS`: payer accounts separated by commas (G... or C...).
 *
 * @throws VitrineeError `ConfigError` on anything that is not a Stellar account
 */
export function parseBlockedPayers(value: string | undefined, name = "BLOCKED_PAYERS"): string[] {
  if (value === undefined || value.trim() === "") return [];
  const accounts = value.split(",").map((a) => a.trim()).filter((a) => a !== "");
  for (const account of accounts) {
    if (!isPayerAccount(account)) {
      throw new VitrineeError("ConfigError", `invalid environment: ${name}: expected Stellar accounts separated by commas`, { details: { name } });
    }
  }
  return [...new Set(accounts)];
}

/**
 * `PAYER_LIMIT`: `<max>/<window in seconds>`, for example `3/3600` for three purchases an hour.
 *
 * @throws VitrineeError `ConfigError` on anything else, and on a zero limit or window
 */
export function parsePayerLimit(value: string | undefined, name = "PAYER_LIMIT"): PayerLimit | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const match = /^(\d{1,6})\/(\d{1,9})$/.exec(value.trim());
  const max = match === null ? 0 : Number(match[1]);
  const windowSeconds = match === null ? 0 : Number(match[2]);
  if (max < 1 || windowSeconds < 1) {
    throw new VitrineeError("ConfigError", `invalid environment: ${name}: expected <max>/<window in seconds>, both at least 1, such as 3/3600`, { details: { name } });
  }
  return { max, windowSeconds };
}
