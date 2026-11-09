/**
 * Payments the store never learned the outcome of (Fase 9, T180, X-32).
 *
 * `settle` can end in `unknown`: a timeout, a dropped connection or an unreadable answer from the facilitator, or a
 * refusal that names a transaction. The money may have moved, so the checkout stays `complete_in_progress` and is
 * never charged again; but nothing used to look for the payment afterwards, and a buyer who paid had no order.
 *
 * This module looks. For each held checkout with a transaction hash it reads Horizon, checks that the payment is the
 * one the checkout asked for (the payer that signed it, the amount, the USDC, and the escrow or merchant it names),
 * and only then records the settlement and finishes the checkout exactly as a normal `complete` would: the order,
 * the escrow `hold` and the receipt. A payment is never assumed: no hash, a transaction that failed, moved another
 * amount or reached another account sends the checkout to a person with the reason. A hash that is simply not there
 * yet (Horizon lags the ledger) is looked for again, with growing waits, for a day.
 *
 * Nothing here signs or sends a transaction: the `hold` is the one the store's own queue already sends for any paid
 * order, and the contract refuses a second `hold` on the same payment (`PaymentAlreadyHeld`).
 */
import { checkSettlement } from "@vitrinee/anchor";
import { payerFromTransactionXdr } from "../payer.js";
import { finish, type UcpCheckoutDeps } from "./checkout.js";
import type { CheckoutSession, CheckoutSessionPersistence } from "./sessions.js";

/** Waits between looks for a payment Horizon does not show yet; after the last, the same wait repeats until the deadline. */
export const RECONCILE_BACKOFF_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** How long a hash that never shows up is looked for before a person is asked to. */
export const RECONCILE_GIVE_UP_MS = 24 * 60 * 60_000;
/** How often the vigilante lists the held checkouts. */
export const RECONCILE_SWEEP_INTERVAL_MS = 60_000;

const HASH = /^[0-9a-f]{64}$/;

export interface ReconcileDeps {
  checkout: UcpCheckoutDeps;
  horizonUrl: string;
  fetchImpl?: typeof fetch;
}

export type ReconcileResult =
  /** The payment is the one asked for; with `applied`, the order exists now. */
  | { kind: "paid"; applied: boolean; transaction: string; orderId?: string }
  /** Nothing to conclude yet: look again. */
  | { kind: "retry"; reason: string }
  /** A person has to look; the payment is not assumed. */
  | { kind: "review"; reason: string }
  | { kind: "skipped"; reason: string };

export interface ReconcileOptions {
  /** Write the settlement and create the order. Without it nothing is saved and nothing is created. */
  apply: boolean;
  /** A hash a person found for a payment the store never recorded; it is verified like any other. */
  transaction?: string;
}

/** What reading the chain says about a held checkout's payment. */
export type PaymentVerdict =
  | { kind: "verified"; transaction: string; payer: string; closedAt?: string }
  | { kind: "retry"; reason: string }
  | { kind: "review"; reason: string };

/** The parts of a held checkout the chain has to confirm; needs no store, only Horizon. */
export type VerifiableSession = Pick<CheckoutSession, "status" | "settlement" | "settleAttempt" | "requirements" | "paymentKey">;

/**
 * Reads Horizon for the payment of one held checkout and says whether it is the one the checkout asked for: signed by
 * its payer, USDC, exactly the requirements' amount, and credited to the escrow (or merchant) they name.
 * Writes nothing and needs no store: the `reconcile:pending` script uses it on its own.
 */
export async function verifyStrandedPayment(deps: Pick<ReconcileDeps, "horizonUrl" | "fetchImpl">, session: VerifiableSession, hint?: string): Promise<PaymentVerdict> {
  const transaction = hint ?? session.settleAttempt?.transaction ?? null;
  if (transaction === null) {
    return { kind: "review", reason: "the facilitator never reported a transaction for this checkout, so no payment can be assumed; find it by hand and pass it with --tx" };
  }
  if (!HASH.test(transaction)) return { kind: "review", reason: "the transaction hash is not a 64-digit hex hash" };
  const requirements = session.requirements;
  if (requirements === null) return { kind: "review", reason: "the checkout kept no payment requirements to compare the payment with" };
  const payer = session.paymentKey === null ? undefined : payerFromTransactionXdr(session.paymentKey);
  if (payer === undefined) return { kind: "review", reason: "the payer of this checkout cannot be read from its signed transaction" };
  let check;
  try {
    check = await checkSettlement(
      {
        settlementTxHash: transaction,
        payerAccount: payer,
        // Only read when the payment is not an escrow's: then `payTo` is the merchant's own account.
        merchantAccount: requirements.payTo,
        amountUSDCAtomic: requirements.amount,
        ...(requirements.payTo.startsWith("C") ? { escrow: { contract: requirements.payTo } } : {}),
      },
      { horizonUrl: deps.horizonUrl, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) },
    );
  } catch (error) {
    return { kind: "retry", reason: `Horizon could not be read: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
  }
  if (!check.ok) {
    const reason = check.reason ?? "the payment could not be verified";
    // Not there yet, or Horizon had a bad moment: the payment may still show up. Anything else is a verdict on it.
    return /not found|Horizon (effects )?answered/.test(reason) ? { kind: "retry", reason } : { kind: "review", reason };
  }
  return { kind: "verified", transaction, payer, ...(check.closedAt === undefined ? {} : { closedAt: check.closedAt }) };
}

/**
 * Looks for the payment of one held checkout and, with `apply`, finishes it.
 * Never charges: it reads Horizon and finishes from what the chain says.
 */
export async function reconcileSession(deps: ReconcileDeps, session: CheckoutSession, options: ReconcileOptions): Promise<ReconcileResult> {
  const { checkout } = deps;
  if (session.status !== "complete_in_progress" || session.settlement !== null) {
    return { kind: "skipped", reason: `the checkout is ${session.status}${session.settlement === null ? "" : " and already has its settlement"}` };
  }
  const verdict = await verifyStrandedPayment(deps, session, options.transaction);
  if (verdict.kind !== "verified") return verdict;
  const requirements = session.requirements!;
  const { transaction, payer } = verdict;
  if (!options.apply) return { kind: "paid", applied: false, transaction };

  const lock = `ucp:${session.id}`;
  if (checkout.inFlight.has(lock)) return { kind: "retry", reason: "the checkout is being changed or completed right now" };
  checkout.inFlight.add(lock);
  try {
    session.settlement = {
      txHash: transaction,
      network: requirements.network,
      payer,
      payTo: requirements.payTo,
      asset: requirements.asset,
      amountAtomic: requirements.amount,
      settledAt: verdict.closedAt ?? checkout.now().toISOString(),
    };
    session.updatedAt = checkout.now().toISOString();
    await checkout.sessions.save(session);
    checkout.log("ucp settlement reconciled", { checkoutId: session.id, txHash: transaction, payTo: requirements.payTo });
    try {
      await finish(checkout, session);
    } catch (error) {
      // The payment is real and recorded on the session; what failed is turning it into an order. A person decides.
      const reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
      return { kind: "review", reason: `the payment was verified but the order could not be made: ${reason}` };
    }
    return { kind: "paid", applied: true, transaction, ...(session.orderId === null ? {} : { orderId: session.orderId }) };
  } finally {
    checkout.inFlight.delete(lock);
  }
}

/** Marks a checkout for a person and keeps the reason on the session. */
async function markReview(deps: ReconcileDeps, session: CheckoutSession, reason: string): Promise<void> {
  const now = deps.checkout.now().toISOString();
  session.reconcile = { attempts: session.reconcile?.attempts ?? 0, nextAt: null, lastReason: reason, review: { reason, at: now } };
  session.updatedAt = now;
  await deps.checkout.sessions.save(session);
  deps.checkout.log("ucp checkout needs manual review", { checkoutId: session.id, reason });
}

/** Applies one result to a session found by the sweep: schedule the next look, or hand it to a person. */
async function record(deps: ReconcileDeps, session: CheckoutSession, result: ReconcileResult): Promise<void> {
  if (result.kind === "review") return markReview(deps, session, result.reason);
  if (result.kind !== "retry") return;
  const now = deps.checkout.now();
  const heldSince = Date.parse(session.settleAttempt?.at ?? session.updatedAt);
  if (Number.isFinite(heldSince) && now.getTime() - heldSince > RECONCILE_GIVE_UP_MS) {
    return markReview(deps, session, `no payment was found for this transaction in a day (${result.reason})`);
  }
  const attempts = (session.reconcile?.attempts ?? 0) + 1;
  const wait = RECONCILE_BACKOFF_MS[Math.min(attempts - 1, RECONCILE_BACKOFF_MS.length - 1)]!;
  session.reconcile = { attempts, nextAt: new Date(now.getTime() + wait).toISOString(), lastReason: result.reason, review: null };
  session.updatedAt = now.toISOString();
  await deps.checkout.sessions.save(session);
}

export interface SessionReconcilerOptions extends ReconcileDeps {
  intervalMs?: number;
}

/** The vigilante: lists the held checkouts every minute and reconciles the ones due. One pass at a time. */
export class SessionReconciler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: SessionReconcilerOptions) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setInterval(() => void this.sweepOnce(), this.options.intervalMs ?? RECONCILE_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async idle(): Promise<void> {
    while (this.running !== undefined) await this.running.catch(() => undefined);
  }

  /** One pass over the held checkouts. Never rejects: a failure is logged and the next pass tries again. */
  sweepOnce(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const pass = this.pass()
      .catch((error: unknown) => this.options.checkout.log("checkout reconciliation failed", { error: error instanceof Error ? error.message.slice(0, 300) : String(error) }))
      .finally(() => {
        this.running = undefined;
      });
    this.running = pass;
    return pass;
  }

  private async pass(): Promise<void> {
    const sessions: CheckoutSessionPersistence = this.options.checkout.sessions;
    const held = (await sessions.listStranded?.()) ?? [];
    const now = this.options.checkout.now().getTime();
    for (const session of held) {
      if (this.stopped) return;
      if (session.reconcile?.review != null) continue;
      if (session.reconcile?.nextAt != null && Date.parse(session.reconcile.nextAt) > now) continue;
      try {
        const result = await reconcileSession(this.options, session, { apply: true });
        await record(this.options, session, result);
      } catch (error) {
        this.options.checkout.log("checkout reconciliation step failed", { checkoutId: session.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      }
    }
  }
}
