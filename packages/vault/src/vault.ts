/**
 * MandateVault (Fase 5, T27): a durable, tamper-evident record of every
 * `PolicyRail` decision — granted or refused — so the daily-spend memory
 * survives a restart, and a refusal is not lost the moment the response is
 * sent.
 *
 * Every prior phase's decision state was ephemeral by design, and said so out
 * loud: `SpendLedger`'s in-memory implementation (Fase 3, `apps/agent`)
 * "loses everything on restart — fine for a pilot and for tests, not for
 * anything that needs to survive one." This is that something.
 *
 * `MandateVault` is deliberately typed to satisfy `SpendLedger`'s three
 * methods (`spentOn`, `record`, `hasRecorded`) **structurally**, without
 * importing that type — the same pattern `RegistryAccess` already established
 * in `@agentpey/mandate` (T20): a package stays ignorant of an app's types,
 * and TypeScript's structural typing is what makes the app's `PolicyRail`
 * accept a `MandateVault` wherever it expects a `SpendLedger`, with no
 * adapter code anywhere. `packages/*` never depends on `apps/*` in this repo;
 * this keeps that true.
 *
 * Append-only, hash-chained JSON Lines on disk: each record's hash covers its
 * own fields and the previous record's hash, so editing any old line breaks
 * every hash after it. It is the same "off-chain document, hash that can be
 * anchored on-chain" shape credentials and mandates already use — `verify()`
 * here is the offline half of that. Anchoring the chain's head on Stellar
 * after a real payment, closing the on-chain half of the loop, is a later
 * milestone (T28), not this one: this file only has to make the claim
 * checkable, not yet checked by anyone but the vault's own owner.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { AgentPassError } from "@agentpass/core";

import { computeHash, scaleAmount, unscaleAmount, utcDayKey } from "./internal/amount.js";

export interface VaultGrantedEntry {
  readonly kind: "granted";
  readonly subject: string;
  readonly intentId: string;
  readonly currency: string;
  readonly amount: string;
  readonly at: string;
}

export interface VaultRefusedEntry {
  readonly kind: "refused";
  readonly subject: string;
  readonly intentId: string;
  readonly code: string;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly at: string;
}

/**
 * That a `granted` decision's payment settled and got anchored on-chain
 * (Fase 5, T28) — the third thing that can happen to an intent, after
 * `granted`/`refused`. Kept in the same chain as everything else, so the act
 * of anchoring is itself part of the tamper-evident history, not just its
 * on-chain result.
 */
export interface VaultAnchoredEntry {
  readonly kind: "anchored";
  readonly subject: string;
  readonly intentId: string;
  /** The Stellar transaction hash the payment itself settled as. */
  readonly paymentTx: string;
  /** `sha256(<granted record's hash> + ":" + paymentTx)` — what got anchored. */
  readonly linkHash: string;
  /** The transaction hash of the anchoring call itself. */
  readonly anchorTx: string;
  readonly at: string;
}

/**
 * That a `granted` decision's spend is given back, because the purchase it
 * reserved budget for provably never reached the network (Fase 6, T92,
 * `C-113` — the release `M-15` named and deferred: "el remedio es una
 * liberación (`release`/`void`) cuando la compra falla").
 *
 * An entry rather than an edit, because the chain is append-only: releasing
 * is a record that *subtracts*, and the grant it undoes stays exactly where
 * it was. Reading a day's total is `granted` minus `released`, and the
 * history of both is still there to read.
 *
 * `at` is the **granted entry's** day, never the moment of release. A grant
 * at 23:59 UTC released at 00:01 the next day would otherwise subtract from a
 * day it never added to, corrupting both.
 */
export interface VaultReleasedEntry {
  readonly kind: "released";
  readonly subject: string;
  readonly intentId: string;
  readonly currency: string;
  /** Exactly the granted entry's amount — this type cannot release a part of one. */
  readonly amount: string;
  /** The granted entry's `at`, copied verbatim. */
  readonly at: string;
  /** Why the purchase never happened — the refusal code that ended it. */
  readonly reason: string;
}

export type VaultEntry = VaultGrantedEntry | VaultRefusedEntry | VaultAnchoredEntry | VaultReleasedEntry;

export interface VaultRecord {
  readonly seq: number;
  /** The previous record's `hash`, or `""` for the first record (`seq === 0`). */
  readonly prevHash: string;
  readonly hash: string;
  readonly entry: VaultEntry;
}

export interface RecordRefusalInput {
  readonly subject: string;
  readonly intentId: string;
  readonly code: string;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * What a caller has to know to release a spend: which intent, and why.
 *
 * Deliberately *not* subject/currency/amount/day — every one of those is read
 * off the granted entry being released, so a caller cannot release the wrong
 * amount, against the wrong subject, or out of the wrong day's bucket. The
 * only thing it supplies is the one fact the vault cannot know: why the
 * purchase never happened.
 */
export interface ReleaseSpendInput {
  readonly intentId: string;
  /** The refusal code that ended the purchase, for the record. */
  readonly reason: string;
}

export interface RecordAnchorInput {
  readonly subject: string;
  readonly intentId: string;
  readonly paymentTx: string;
  readonly linkHash: string;
  readonly anchorTx: string;
}

export interface VaultVerification {
  readonly ok: boolean;
  /** The first record whose stored hash does not match its recomputed hash, if any. */
  readonly brokenAtSeq?: number;
}

/** A `record()` entry, named here so `MandateVault` and `LockedVaultLedger` can share it without importing `apps/agent`'s own type. */
export interface VaultLedgerEntry {
  readonly subject: string;
  readonly intentId: string;
  readonly currency: string;
  readonly amount: string;
  readonly at: Date;
}

/**
 * The `spentOn`/`hasRecorded`/`record` trio, scoped to one `atomically`
 * critical section — mirrors `apps/agent/src/ledger/spend-ledger.ts`'s
 * `LockedSpendLedger` exactly, satisfied structurally like the rest of this
 * port (see the file docstring).
 */
export interface LockedVaultLedger {
  spentOn(subject: string, currency: string, at: Date): Promise<string>;
  hasRecorded(intentId: string): Promise<boolean>;
  record(entry: VaultLedgerEntry): Promise<void>;
  release(input: ReleaseSpendInput): Promise<void>;
}

export interface MandateVault {
  // The SpendLedger port (`apps/agent/src/ledger/spend-ledger.ts`), satisfied
  // structurally — see the file docstring.
  spentOn(subject: string, currency: string, at: Date): Promise<string>;
  record(entry: {
    readonly subject: string;
    readonly intentId: string;
    readonly currency: string;
    readonly amount: string;
    readonly at: Date;
  }): Promise<void>;
  hasRecorded(intentId: string): Promise<boolean>;
  /**
   * Gives back the spend a `granted` entry reserved, because the purchase it
   * reserved it for provably never reached the network (`C-113`).
   *
   * Only the caller knows that, and only for the failures that happened
   * *before* anything signed left the process — see `executeBazaarPayment`'s
   * own `paymentSent` marker. A payment that may have been sent is never
   * released: under-counting a day's spend is the one direction `M-15` calls
   * unsafe.
   *
   * Idempotent: releasing an already-released intent is a no-op, so a retry
   * cannot give the budget back twice.
   *
   * @throws AgentPassError `SpendNotRecorded` for an intent with no granted
   * entry — releasing something that was never reserved would silently credit
   * budget that was never spent.
   * @throws AgentPassError `SpendAlreadySettled` for an intent that has an
   * `anchored` entry. A payment that settled on-chain is exactly what this
   * must never give back.
   */
  release(input: ReleaseSpendInput): Promise<void>;

  /**
   * Closes the gap `SpendLedger.atomically` names: the read of `spentOn`, the
   * caller's decision, and the `record()` all happen inside one Postgres
   * transaction holding this tenant's advisory lock (the same lock `record`'s
   * own internal append already takes), so no other process sharing this
   * database can move the total out from under the decision. Optional on this
   * type only because `SpendLedger.atomically` is optional; every
   * `MandateVault` returned by this package implements it — a durable, shared
   * vault is exactly the case that needs it.
   */
  atomically?<T>(subject: string, work: (locked: LockedVaultLedger) => Promise<T>): Promise<T>;

  /** Everything `record` is not: a refusal, kept instead of thrown away. */
  recordRefusal(input: RecordRefusalInput, at?: Date): Promise<void>;

  /** That a `granted` decision's payment settled and got anchored on-chain (T28). */
  recordAnchor(input: RecordAnchorInput, at?: Date): Promise<void>;

  /** The full chain, in order — or just one subject's slice of it. */
  list(subject?: string): readonly VaultRecord[];

  /** The latest record's hash, or `undefined` for an empty vault. */
  head(): string | undefined;

  /** Recomputes every hash from the stored entries and confirms none were edited after the fact. */
  verify(): VaultVerification;
}

/** @throws AgentPassError `VaultCorrupted` for a file that is not well-formed JSON Lines of {@link VaultRecord}s. */
function parseLine(line: string, path: string): VaultRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new AgentPassError("VaultCorrupted", `${path} contains a line that is not valid JSON`, {
      cause: error,
      details: { path },
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { seq?: unknown }).seq !== "number" ||
    typeof (parsed as { prevHash?: unknown }).prevHash !== "string" ||
    typeof (parsed as { hash?: unknown }).hash !== "string" ||
    typeof (parsed as { entry?: unknown }).entry !== "object"
  ) {
    throw new AgentPassError("VaultCorrupted", `${path} contains a record that is not a valid vault entry`, {
      details: { path },
    });
  }
  return parsed as VaultRecord;
}

/**
 * A {@link MandateVault} backed by an append-only JSON Lines file at `path`.
 * Rebuilds its in-memory state (totals, seen intents, chain head) from the
 * file on construction, so a restart picks up exactly where the process left
 * off — the durability `SpendLedger`'s in-memory implementation could not
 * offer.
 *
 * Every write is synchronous (`appendFileSync`) on purpose: Node runs
 * JavaScript single-threaded, so a synchronous write cannot interleave with
 * another call's read-modify-write of the in-memory state the way an
 * `await`-ing async write could. `LocalPolicyRail` already serialises
 * `authorise()` per subject (`M-15`); this adds no further locking because
 * none is needed within one process — the same limit already written down
 * for `SpendLedger` and `LocalPolicyRail` applies here too: durable within
 * this process's file, not across more than one process writing the same
 * path concurrently.
 *
 * @throws AgentPassError `VaultCorrupted` if `path` already exists and is not
 * well-formed JSON Lines of {@link VaultRecord}s.
 */
export function createFileMandateVault(options: { readonly path: string }): MandateVault {
  const { path } = options;

  const records: VaultRecord[] = [];
  const totals = new Map<string, Map<string, Map<string, bigint>>>();
  /** Every `granted` entry, by intent — `release` reads the amount and day back off it. */
  const grants = new Map<string, VaultGrantedEntry>();
  const releasedIntents = new Set<string>();
  const anchoredIntents = new Set<string>();

  /** Adds `scaled` (negative to release) to one subject/currency/day bucket. */
  function addToTotals(subject: string, currency: string, day: string, scaled: bigint): void {
    const bySubject = totals.get(subject) ?? new Map<string, Map<string, bigint>>();
    totals.set(subject, bySubject);
    const byCurrency = bySubject.get(currency) ?? new Map<string, bigint>();
    bySubject.set(currency, byCurrency);
    byCurrency.set(day, (byCurrency.get(day) ?? 0n) + scaled);
  }

  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      const record = parseLine(line, path);
      records.push(record);
      const { entry } = record;
      if (entry.kind === "granted") {
        grants.set(entry.intentId, entry);
        addToTotals(entry.subject, entry.currency, entry.at.slice(0, entry.at.indexOf("T")), scaleAmount(entry.amount));
      }
      // A release subtracts from the day its *grant* landed on, which is the
      // day it carries — never the day it was written.
      if (entry.kind === "released") {
        releasedIntents.add(entry.intentId);
        addToTotals(entry.subject, entry.currency, entry.at.slice(0, entry.at.indexOf("T")), -scaleAmount(entry.amount));
      }
      if (entry.kind === "anchored") anchoredIntents.add(entry.intentId);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }

  function append(entry: VaultEntry): VaultRecord {
    const seq = records.length;
    const prevHash = records.at(-1)?.hash ?? "";
    const record: VaultRecord = { seq, prevHash, hash: computeHash(seq, prevHash, entry), entry };
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
    return record;
  }

  return {
    async spentOn(subject, currency, at) {
      const total = totals.get(subject)?.get(currency)?.get(utcDayKey(at)) ?? 0n;
      return unscaleAmount(total);
    },

    async record(entry) {
      // "Already recorded" is *granted and not released*: once a spend is
      // given back, the same intent authorised again has to count again, or
      // the release would hand out budget for free (`C-113`).
      if (grants.has(entry.intentId) && !releasedIntents.has(entry.intentId)) return;

      // Validates the amount, and throws `InvalidAmount` before anything is
      // appended — a rejected entry must stay retryable under the same
      // intentId, not silently and permanently ignored (mirrors the
      // in-memory `SpendLedger`'s own rule).
      const scaled = scaleAmount(entry.amount);

      const granted: VaultGrantedEntry = {
        kind: "granted",
        subject: entry.subject,
        intentId: entry.intentId,
        currency: entry.currency,
        amount: entry.amount,
        at: entry.at.toISOString(),
      };
      append(granted);
      addToTotals(entry.subject, entry.currency, utcDayKey(entry.at), scaled);

      grants.set(entry.intentId, granted);
      // Re-granting after a release makes this intent live again, so the next
      // release is a fresh one rather than a no-op against the old record.
      releasedIntents.delete(entry.intentId);
    },

    async hasRecorded(intentId) {
      return grants.has(intentId) && !releasedIntents.has(intentId);
    },

    async release(input) {
      if (releasedIntents.has(input.intentId)) return;

      const granted = grants.get(input.intentId);
      if (granted === undefined) {
        throw new AgentPassError("SpendNotRecorded", "no granted spend to release for that intent", {
          details: { intentId: input.intentId },
        });
      }
      if (anchoredIntents.has(input.intentId)) {
        throw new AgentPassError("SpendAlreadySettled", "that intent's payment is anchored on-chain and cannot be released", {
          details: { intentId: input.intentId },
        });
      }

      append({
        kind: "released",
        subject: granted.subject,
        intentId: granted.intentId,
        currency: granted.currency,
        amount: granted.amount,
        at: granted.at,
        reason: input.reason,
      });
      addToTotals(
        granted.subject,
        granted.currency,
        granted.at.slice(0, granted.at.indexOf("T")),
        -scaleAmount(granted.amount),
      );
      releasedIntents.add(input.intentId);
    },

    async recordRefusal(input, at) {
      append({
        kind: "refused",
        subject: input.subject,
        intentId: input.intentId,
        code: input.code,
        reason: input.reason,
        details: input.details,
        at: (at ?? new Date()).toISOString(),
      });
    },

    async recordAnchor(input, at) {
      anchoredIntents.add(input.intentId);
      append({
        kind: "anchored",
        subject: input.subject,
        intentId: input.intentId,
        paymentTx: input.paymentTx,
        linkHash: input.linkHash,
        anchorTx: input.anchorTx,
        at: (at ?? new Date()).toISOString(),
      });
    },

    list(subject) {
      return subject === undefined ? records.slice() : records.filter((r) => r.entry.subject === subject);
    },

    head() {
      return records.at(-1)?.hash;
    },

    verify() {
      let prevHash = "";
      for (const record of records) {
        const expected = computeHash(record.seq, prevHash, record.entry);
        if (record.hash !== expected || record.prevHash !== prevHash) {
          return { ok: false, brokenAtSeq: record.seq };
        }
        prevHash = record.hash;
      }
      return { ok: true };
    },
  };
}
