/**
 * `Idempotency-Key` on the UCP checkout (T131): the same key with the same
 * request gets the first answer back, unchanged; the same key with a
 * different request is a conflict (409), never a second effect.
 *
 * Kept in memory, per storefront, for a day, and bounded: at most
 * {@link MAX_ENTRIES} answers and {@link MAX_BYTES} of them, oldest dropped
 * first, so nobody can grow a store's memory by sending keys (the UCP routes
 * have no authentication). That is enough for what it protects: a platform
 * retrying a request it is unsure about. Losing an answer costs at most a
 * duplicate `incomplete` session; a checkout is still never charged twice,
 * because `complete` reads the session's own state first.
 */
import { createHash } from "node:crypto";

export type IdempotencyLookup =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" };

interface Entry {
  hash: string;
  status: number;
  /** The answer as sent, serialized once: what is replayed and what the byte bound counts. */
  json: string;
  at: number;
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 1_000;
export const MAX_BYTES = 2 * 1024 * 1024;

/** The request's fingerprint: method, path and body, as the platform sent them. */
export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest("hex");
}

export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly now: () => Date) {}

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  lookup(key: string, hash: string): IdempotencyLookup {
    const entry = this.entries.get(key);
    if (entry === undefined || this.now().getTime() - entry.at > IDEMPOTENCY_TTL_MS) return { kind: "new" };
    return entry.hash === hash ? { kind: "replay", status: entry.status, body: JSON.parse(entry.json) as unknown } : { kind: "conflict" };
  }

  remember(key: string, hash: string, status: number, body: unknown): void {
    const json = JSON.stringify(body ?? null);
    // An answer larger than the whole bound is not kept: a retry runs again, which is safe.
    if (json.length > MAX_BYTES) return;
    this.drop(key);
    this.entries.set(key, { hash, status, json, at: this.now().getTime() });
    this.bytes += json.length;
    // Oldest first: a Map iterates in insertion order.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.json.length;
    this.entries.delete(key);
  }
}
