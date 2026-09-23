/**
 * Bridges the x402 middleware and the checkout handler. With the `upfront`
 * payment flow the facilitator settles *before* the handler runs, and the
 * SDK reports that settlement through `onAfterSettle`, not through the
 * request. This ledger keeps the settlement for a few minutes keyed by the
 * signed transaction, so the handler can pick it up from the request's own
 * PAYMENT-SIGNATURE header and never creates an order for money that did not
 * move.
 */
export interface SettlementRecord {
  txHash: string;
  network: string;
  payer: string | undefined;
  payTo: string;
  asset: string;
  amountAtomic: string;
  settledAt: string;
}

export class SettlementLedger {
  private readonly entries = new Map<string, { record: SettlementRecord; at: number }>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  put(key: string, record: SettlementRecord): void {
    this.prune();
    this.entries.set(key, { record, at: this.now() });
  }

  /** Returns and forgets: one settlement fulfils exactly one order. */
  take(key: string): SettlementRecord | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    return entry.record;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(key);
  }
}

/** The base64 XDR the payer signed — unique per payment, present in payload and header alike. */
export function paymentKeyFromPayload(payload: unknown): string | undefined {
  const inner = (payload as { payload?: { transaction?: unknown } } | undefined)?.payload;
  const transaction = inner?.transaction;
  return typeof transaction === "string" && transaction.length > 0 ? transaction : undefined;
}

export function decodePaymentHeader(header: string | undefined): unknown {
  if (header === undefined || header === "") return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function paymentKeyFromHeader(header: string | undefined): string | undefined {
  return paymentKeyFromPayload(decodePaymentHeader(header));
}
