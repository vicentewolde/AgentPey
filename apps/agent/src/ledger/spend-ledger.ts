/**
 * The state `B-16` said this project would eventually need: memory of past
 * spending, so a daily total can mean something.
 *
 * `checkScope` (T12) and `checkMandate` (T17) are both pure — no clock, no
 * network, no memory between calls — because that is what makes `perTx`
 * checkable without state. `perDay` cannot be: "has this already spent 200
 * today" is a question about the past, and a pure function has no past to ask
 * about. This is that memory, kept behind a narrow port so the in-memory
 * implementation below can later be swapped for something durable without
 * changing anything that calls it.
 *
 * `subject` is deliberately opaque here: whether a daily budget is tracked per
 * credential, per mandate, or per agent is a composition decision for T19
 * (PolicyRail decides which authority it is enforcing for), not something
 * this port bakes in. It is just the key whoever calls `record`/`spentOn`
 * agrees to use consistently.
 *
 * The day boundary is UTC, always — the same timezone discipline the rest of
 * the project already uses for every `validFrom`/`validUntil`/`issuedAt`
 * (`z.iso.datetime()` accepts only `Z`-suffixed UTC timestamps). A boundary
 * that moved with a server's local timezone would make "today" ambiguous
 * depending on where the process runs.
 */
import { AgentPassError } from "@agentpass/core";

import { fromScaledAmount, toScaledAmount } from "../scope/amount.js";

export interface SpendLedgerEntry {
  /** Whose daily budget this counts against — opaque to the ledger. */
  readonly subject: string;
  /**
   * De-duplication key. Recording the same `intentId` twice — a retried
   * purchase, a re-delivered message — counts once, not twice.
   */
  readonly intentId: string;
  readonly currency: string;
  /** This entry's amount, as a decimal string. */
  readonly amount: string;
  /** Which UTC day this counts toward. */
  readonly at: Date;
}

export interface SpendLedger {
  /** Total already recorded for `subject`+`currency`, on the UTC day of `at`. */
  spentOn(subject: string, currency: string, at: Date): Promise<string>;
  /**
   * Records `entry`. If `entry.intentId` was already recorded — under any
   * subject or currency — this is a no-op: the first recording stands.
   */
  record(entry: SpendLedgerEntry): Promise<void>;
  /**
   * Whether `intentId` has already been recorded. Lets a caller distinguish
   * "authorising this purchase for the first time" from "re-verifying a
   * purchase already counted" — `spentOn` alone cannot, because a recorded
   * amount is already folded into its total (`G-8`).
   */
  hasRecorded(intentId: string): Promise<boolean>;
  /**
   * Gives back the spend `intentId` reserved, because the purchase it
   * reserved it for provably never reached the network (`C-113`, T92).
   *
   * `M-15` chose to record on authorising rather than on paying, and named
   * this as the missing remedy in the same breath: "un intent autorizado que
   * nunca se convierte en pago consume presupuesto del día igual. El remedio
   * es una liberación (`release`/`void`) cuando la compra falla — y hoy no
   * existe nada que pueda decirle a PolicyRail que una compra falló". Fase 4
   * built the thing that can say so; this is the remedy it was waiting for.
   *
   * Only ever called for a failure that happened **before anything signed
   * left the process**. A payment that may have been sent is never released:
   * over-counting is fail-closed, under-counting is not, and that half of
   * `M-15` is unchanged.
   *
   * Nothing about `subject`, `currency`, `amount` or the day is passed in:
   * all four are read off the recorded entry, so a release cannot land on the
   * wrong day or give back the wrong amount. Idempotent — releasing twice
   * releases once.
   *
   * @throws AgentPassError `SpendNotRecorded` when `intentId` has no recorded
   * spend to give back.
   */
  release(input: ReleaseSpendInput): Promise<void>;
  /**
   * Runs `work` as one critical section for `subject`: no other `atomically`
   * call for the same subject — in this process, or, for a ledger backed by
   * shared durable storage, in any other process pointed at the same store —
   * can read or write `subject`'s totals until `work` resolves.
   *
   * This is the piece `checkDailyLimit`'s own docstring names and defers:
   * "whether `spentOn` and `record` happen atomically... this function only
   * ever sees numbers it was handed." A caller that reads `spentOn`, decides,
   * and calls `record` as three separate calls — even serialised in-process
   * (`M-15`) — leaves a gap between the read and the write that a second
   * *process* can land in. `work` receives its own `spentOn`/`hasRecorded`/
   * `record`, scoped to this one critical section, so the whole
   * read-decide-write sequence is what gets to be atomic — not just the write.
   *
   * Optional: a ledger that cannot outlive one process (the in-memory and
   * file-backed implementations) has nothing further to gain from this over
   * the in-process serialisation a caller already does, so it may omit this
   * method entirely. Only a ledger shared across processes (`@agentpey/vault`'s
   * Postgres backend) needs to implement it for real.
   */
  atomically?<T>(subject: string, work: (locked: LockedSpendLedger) => Promise<T>): Promise<T>;
}

/**
 * What a caller supplies to release a spend: which intent, and why. Mirrors
 * `@agentpey/vault`'s `ReleaseSpendInput` exactly — the same structural
 * satisfaction the rest of this port already relies on.
 */
export interface ReleaseSpendInput {
  readonly intentId: string;
  /** The refusal code that ended the purchase, kept with the release. */
  readonly reason: string;
}

/** The `spentOn`/`hasRecorded`/`record`/`release` group, scoped to one `atomically` critical section. */
export interface LockedSpendLedger {
  spentOn(subject: string, currency: string, at: Date): Promise<string>;
  hasRecorded(intentId: string): Promise<boolean>;
  record(entry: SpendLedgerEntry): Promise<void>;
  release(input: ReleaseSpendInput): Promise<void>;
}

/** `YYYY-MM-DD`, in UTC. The bucket a spend counts toward. */
export function utcDayKey(at: Date): string {
  const iso = at.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}

/**
 * An in-memory {@link SpendLedger}. Loses everything on restart — fine for a
 * pilot and for tests, not for anything that needs to survive one.
 */
export function createInMemorySpendLedger(): SpendLedger {
  // subject -> currency -> day -> scaled total
  const totals = new Map<string, Map<string, Map<string, bigint>>>();
  // The recorded entries themselves, not just their ids: `release` reads the
  // subject, currency, amount and day back off the entry rather than trusting
  // a caller to repeat them (`C-113`).
  const recorded = new Map<string, SpendLedgerEntry>();
  const released = new Set<string>();

  /** Adds `amount` (negative to release) to one subject/currency/day bucket. */
  function addToTotals(subject: string, currency: string, day: string, amount: bigint): void {
    const bySubject = totals.get(subject) ?? new Map<string, Map<string, bigint>>();
    totals.set(subject, bySubject);

    const byCurrency = bySubject.get(currency) ?? new Map<string, bigint>();
    bySubject.set(currency, byCurrency);

    byCurrency.set(day, (byCurrency.get(day) ?? 0n) + amount);
  }

  return {
    async spentOn(subject: string, currency: string, at: Date): Promise<string> {
      const total = totals.get(subject)?.get(currency)?.get(utcDayKey(at)) ?? 0n;
      return fromScaledAmount(total);
    },

    async record(entry: SpendLedgerEntry): Promise<void> {
      // "Already recorded" means granted *and not released*: once a spend is
      // given back, authorising the same intent again has to count again.
      if (recorded.has(entry.intentId) && !released.has(entry.intentId)) return;

      // Throws InvalidAmount for anything malformed — the same validation
      // every other amount in the project goes through, never a bespoke copy.
      const amount = toScaledAmount(entry.amount);

      addToTotals(entry.subject, entry.currency, utcDayKey(entry.at), amount);

      // Marked only after every step above succeeded: a rejected entry (a bad
      // amount) must remain retryable under the same intentId, not silently
      // and permanently ignored.
      recorded.set(entry.intentId, entry);
      released.delete(entry.intentId);
    },

    async hasRecorded(intentId: string): Promise<boolean> {
      return recorded.has(intentId) && !released.has(intentId);
    },

    async release(input: ReleaseSpendInput): Promise<void> {
      if (released.has(input.intentId)) return;

      const entry = recorded.get(input.intentId);
      if (entry === undefined) {
        throw new AgentPassError("SpendNotRecorded", "no recorded spend to release for that intent", {
          details: { intentId: input.intentId },
        });
      }

      // The entry's own day, never today's: a spend recorded at 23:59 UTC and
      // released at 00:01 must come back out of the day it went into.
      addToTotals(entry.subject, entry.currency, utcDayKey(entry.at), -toScaledAmount(entry.amount));
      released.add(input.intentId);
    },
  };
}
