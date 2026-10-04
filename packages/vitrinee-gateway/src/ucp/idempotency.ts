/**
 * `Idempotency-Key` on the UCP checkout (T131): the same key with the same
 * request gets the first answer back, unchanged; the same key with a
 * different request is a conflict (409), never a second effect.
 *
 * Kept in memory, per storefront, for a day. That is enough for what it
 * protects: a platform retrying a request it is unsure about. Losing it on a
 * restart costs at most a duplicate `incomplete` session; a checkout is still
 * never charged twice, because `complete` reads the session's own state first.
 */
import { createHash } from "node:crypto";

export type IdempotencyLookup =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" };

interface Entry {
  hash: string;
  status: number;
  body: unknown;
  at: number;
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

/** The request's fingerprint: method, path and body, as the platform sent them. */
export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest("hex");
}

export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => Date) {}

  lookup(key: string, hash: string): IdempotencyLookup {
    const entry = this.entries.get(key);
    if (entry === undefined || this.now().getTime() - entry.at > IDEMPOTENCY_TTL_MS) return { kind: "new" };
    return entry.hash === hash ? { kind: "replay", status: entry.status, body: structuredClone(entry.body) } : { kind: "conflict" };
  }

  remember(key: string, hash: string, status: number, body: unknown): void {
    if (this.entries.size >= MAX_ENTRIES) {
      // Oldest first: a Map iterates in insertion order.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { hash, status, body: structuredClone(body), at: this.now().getTime() });
  }
}
