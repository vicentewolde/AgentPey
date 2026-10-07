/**
 * A team's spending for one month, read from its MandateVault (T146).
 *
 * Pure: it takes the vault's records and returns numbers, so the arithmetic is
 * tested without a network or a file. A month is a UTC calendar month, the
 * same clock the daily limit uses (`M-16`). What a month "spent" is what the
 * vault granted in it minus what it released (`C-113`): a release is a record
 * that subtracts, never an edit.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError } from "@agentpass/core";
import type { VaultRecord } from "@agentpey/vault";

export interface MonthPayment {
  readonly intentId: string;
  readonly amount: string;
  readonly currency: string;
  readonly at: string;
  /** Set once the payment settled and was anchored (`anchored` entry). */
  readonly paymentTx: string | null;
  readonly anchorTx: string | null;
  readonly released: boolean;
}

export interface MonthRefusal {
  readonly intentId: string;
  readonly code: string;
  readonly reason: string;
  readonly at: string;
}

export interface MonthSummary {
  readonly month: string;
  readonly payments: readonly MonthPayment[];
  readonly refusals: readonly MonthRefusal[];
  /** Granted minus released, seven decimals. */
  readonly spent: string;
  readonly currency: string | null;
  /** How many UTC days of the month had at least one payment that was not released. */
  readonly activeDays: number;
}

/** Where `team:pay` keeps the team's vault and `team:summary` reads it. Local, never versioned. */
export const TEAM_VAULT_PATH = resolve(fileURLToPath(new URL("../..", import.meta.url)), ".team-budget/vault.jsonl");

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SCALE = 10_000_000n;

/** Decimal string to seven-decimal atomic units, exactly; never through a float. */
export function toUnits(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value);
  if (match === null) {
    throw new AgentPassError("InvalidAmount", `not a non-negative amount with at most seven decimals: ${value}`, { details: { value } });
  }
  return BigInt(match[1] ?? "0") * SCALE + BigInt((match[2] ?? "").padEnd(7, "0"));
}

export function fromUnits(units: bigint): string {
  return `${units / SCALE}.${(units % SCALE).toString().padStart(7, "0")}`;
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** `YYYY-MM` for the UTC month `at` falls in. */
export function currentMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * @throws AgentPassError `InvalidArguments` for a month that is not `YYYY-MM`.
 * @throws AgentPassError `InvalidAmount` for a vault that mixes currencies in
 * one month: adding USDC to anything else would be a number that means nothing.
 */
export function summarizeMonth(records: readonly VaultRecord[], month: string): MonthSummary {
  if (!MONTH.test(month)) {
    throw new AgentPassError("InvalidArguments", `month must be YYYY-MM, got ${month}`, { details: { month } });
  }

  const anchored = new Map<string, { paymentTx: string; anchorTx: string }>();
  const released = new Set<string>();
  for (const { entry } of records) {
    if (entry.kind === "anchored") anchored.set(entry.intentId, { paymentTx: entry.paymentTx, anchorTx: entry.anchorTx });
    if (entry.kind === "released") released.add(entry.intentId);
  }

  const payments: MonthPayment[] = [];
  const refusals: MonthRefusal[] = [];
  const days = new Set<string>();
  let spent = 0n;
  let currency: string | null = null;

  for (const { entry } of records) {
    if (monthOf(entry.at) !== month) continue;
    if (entry.kind === "granted") {
      if (currency !== null && currency !== entry.currency) {
        throw new AgentPassError("InvalidAmount", `the vault mixes ${currency} and ${entry.currency} in ${month}`, {
          details: { month, currencies: [currency, entry.currency] },
        });
      }
      currency = entry.currency;
      const wasReleased = released.has(entry.intentId);
      const link = anchored.get(entry.intentId);
      payments.push({
        intentId: entry.intentId,
        amount: entry.amount,
        currency: entry.currency,
        at: entry.at,
        paymentTx: link?.paymentTx ?? null,
        anchorTx: link?.anchorTx ?? null,
        released: wasReleased,
      });
      if (!wasReleased) {
        spent += toUnits(entry.amount);
        days.add(entry.at.slice(0, 10));
      }
    } else if (entry.kind === "refused") {
      refusals.push({ intentId: entry.intentId, code: entry.code, reason: entry.reason, at: entry.at });
    }
  }

  return { month, payments, refusals, spent: fromUnits(spent), currency, activeDays: days.size };
}
