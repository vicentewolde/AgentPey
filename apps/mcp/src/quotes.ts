/**
 * The quotes this server handed out and has not been paid yet (T128).
 *
 * `quote` opens a checkout at the store and signs the agent's purchase intent;
 * `pay` needs both, plus the venue the store is. They live here, in memory,
 * for a few minutes: a restart only costs asking for the quote again. A quote
 * is taken out when it is paid, so the same id never pays twice.
 *
 * Nothing in a stored quote is trusted at payment time: `pay` reads the store's
 * profile and the checkout again (`payUcpQuote`, `recheck`).
 */
import { randomUUID } from "node:crypto";

import { AgentPassError } from "@agentpass/core";
import type { PurchaseIntent, UcpQuote, VenueId } from "@agentpey/agent";

export interface QuoteEntry {
  readonly id: string;
  readonly quote: UcpQuote;
  readonly venueId: VenueId;
  readonly intent: PurchaseIntent;
  readonly expiresAt: Date;
}

export interface QuoteBookOptions {
  /** How long a quote may be paid. Never longer than its intent is valid. */
  readonly ttlMs?: number;
  /** A ceiling, so calls cannot grow memory without bound. The oldest quote goes first. */
  readonly max?: number;
  readonly now?: () => Date;
}

export const DEFAULT_QUOTE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_QUOTES = 200;

export class QuoteBook {
  private readonly entries = new Map<string, QuoteEntry>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => Date;

  constructor(options: QuoteBookOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_QUOTE_TTL_MS;
    this.max = options.max ?? DEFAULT_MAX_QUOTES;
    this.now = options.now ?? (() => new Date());
  }

  issue(input: Omit<QuoteEntry, "id" | "expiresAt">): QuoteEntry {
    this.prune();
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const intentEnds = new Date(input.intent.expiresAt).getTime();
    const expiresAt = new Date(Math.min(this.now().getTime() + this.ttlMs, intentEnds));
    const entry: QuoteEntry = { ...input, id: `q_${randomUUID()}`, expiresAt };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /**
   * Takes the quote out, so it can be paid once.
   *
   * @throws AgentPassError `QuoteNotFound` for an id never issued or already taken.
   * @throws AgentPassError `QuoteExpired` for a quote past its window; it is dropped.
   */
  take(id: string): QuoteEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new AgentPassError("QuoteNotFound", "no quote with that id is waiting to be paid: ask for a new quote", { details: { quoteId: id } });
    }
    this.entries.delete(id);
    if (entry.expiresAt.getTime() <= this.now().getTime()) {
      throw new AgentPassError("QuoteExpired", "the quote expired: ask for a new quote", { details: { quoteId: id, expiredAt: entry.expiresAt.toISOString() } });
    }
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, entry] of this.entries) if (entry.expiresAt.getTime() <= now) this.entries.delete(id);
  }
}
