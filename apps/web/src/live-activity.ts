/**
 * `GET /api/live` — the data behind `/en-vivo` (T151): what agents are doing
 * at the stores of the platform's directory, refreshed every few seconds.
 *
 * **Where each fact comes from.** The stores, from the directory (`C-141`).
 * Each purchase, from the network: the store's signing key sends one `anchor`
 * per receipt to `receipt-registry` (`VT-8`), Horizon lists them, and the
 * registry's own record gives the amount, the order and the time. Each
 * dispute, from the AgentResolve contract, keyed by the same receipt hash.
 * The products and the payment transaction come from the receipt itself,
 * fetched from the store's public UCP order and used only if its merchant
 * signature verifies, it names this store, and its SHA-256 is the hash the
 * registry anchored: then it is exactly what the network vouches for.
 *
 * **What counts as a purchase.** Only one whose receipt could be read and
 * checked, so its payment transaction is known. A hash the registry holds whose
 * receipt cannot be read (the store no longer has the order, or did not answer)
 * has an anchor but no proof of payment: it is listed apart under `incomplete`
 * and is in none of the totals. Nothing anchored is deleted or hidden.
 *
 * **Where the money stands (T195).** When the signed receipt names the store's
 * `purchase-escrow`, the purchase is read from that contract by its order: held,
 * confirmed by the buyer, released, under a claim, or refunded. A purchase that
 * is over never changes again, so it is read once; an open one, on every refresh.
 *
 * It only **shows** disputes. Nothing here opens, answers or resolves one, and
 * nothing connects a dispute to a chat, a payment, a dispatch or a webhook.
 *
 * Registry and dispute entries are read in one `getLedgerEntries` call per
 * refresh, not one per receipt: the page polls, and so does every viewer.
 */
import { AgentPassError } from "@agentpass/core";
import { checkReceiptSignature, stellarExpertContractUrl, stellarExpertTxUrl } from "@vitrinee/core";
import { z } from "zod";

import { formatUsdc, listAnchors, readDirectory, withTimeout, within, type DirectoryStore } from "./stores-directory.js";

/** A receipt as `receipt-registry` stores it (`@vitrinee/anchor`'s `AnchoredRecord`). */
export interface ReceiptEntry {
  readonly merchant: string;
  readonly amount: bigint;
  readonly orderRef: string;
  readonly timestamp: number;
}

/** A dispute as AgentResolve stores it (`@vitrinee/anchor`'s `DisputeRecord`, the fields shown). */
export interface DisputeEntry {
  readonly status: "open" | "resolved";
  readonly amountAtomic: bigint;
  readonly refundAtomic: bigint;
  readonly openedAt: number;
  readonly resolvedAt: number | null;
  readonly verdictHash: string | null;
}

/** A purchase as the store's `purchase-escrow` holds it (`@vitrinee/anchor`'s `EscrowPurchase`, the fields shown). */
export interface EscrowEntry {
  readonly status: "held" | "shipped" | "released" | "disputed" | "responded" | "resolved" | "expired";
  readonly amountAtomic: bigint;
  readonly refundAtomic: bigint;
  /** Unix seconds; `null` unless the buyer confirmed it (escrow v2, T182). */
  readonly confirmedAt: number | null;
  /** Unix seconds; `null` while the purchase is open. */
  readonly closedAt: number | null;
}

/**
 * What the public page says happened (T195): `held` until the buyer confirms or the window closes, `claim` while a
 * dispute is open, and at the end `confirmed`, `released` (the window closed, or a claim was turned down), `refunded`
 * or `partly_refunded`.
 */
export type EscrowOutcome = "held" | "confirmed" | "released" | "claim" | "refunded" | "partly_refunded";

/** The outcome an escrow record stands for. An expired dispute refunds in full (`expire`, T181). */
export function escrowOutcome(entry: EscrowEntry): EscrowOutcome {
  switch (entry.status) {
    case "held":
    case "shipped":
      return "held";
    case "released":
      return entry.confirmedAt !== null ? "confirmed" : "released";
    case "disputed":
    case "responded":
      return "claim";
    case "expired":
      return "refunded";
    case "resolved":
      return entry.refundAtomic <= 0n ? "released" : entry.refundAtomic >= entry.amountAtomic ? "refunded" : "partly_refunded";
  }
}

export interface LiveDeps {
  readonly fetchImpl: typeof fetch;
  readonly directoryUrl: string;
  readonly horizonUrl: string;
  readonly registryId: string;
  readonly resolveId: string;
  /** Every receipt and dispute for these hashes, in one read; a hash with no entry is absent from the map. */
  readonly readLedger: (hashes: readonly string[]) => Promise<{ receipts: Map<string, ReceiptEntry>; disputes: Map<string, DisputeEntry> }>;
  /** A purchase in a store's escrow by its order, `null` if the contract holds none (T195). Without it, no escrow is read. */
  readonly readEscrow?: (contractId: string, orderRef: string) => Promise<EscrowEntry | null>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /** Purchases read per store, newest first. */
  readonly perStore?: number;
}

export interface LiveItem {
  readonly title: string;
  readonly quantity: number;
}

export interface LiveDispute {
  readonly status: "open" | "resolved";
  readonly amount_usdc: string;
  readonly refund_usdc: string;
  readonly opened_at: string;
  readonly resolved_at: string | null;
  readonly verdict_hash: string | null;
}

export interface LiveEscrow {
  readonly contract: string;
  readonly contract_url: string;
  readonly outcome: EscrowOutcome;
  readonly refund_usdc: string;
  readonly confirmed_at: string | null;
  readonly closed_at: string | null;
}

export interface LivePurchase {
  readonly store: string;
  readonly store_name: string;
  readonly hash: string;
  readonly order_ref: string;
  readonly amount_usdc: string;
  readonly at: string;
  /** From the anchored, signed receipt; `null` when the store did not answer or the receipt did not check out. */
  readonly items: readonly LiveItem[] | null;
  /** The payment's transaction, from the same receipt; `null` under the same conditions. */
  readonly payment_tx: string | null;
  readonly payment_url: string | null;
  /** The transaction that anchored the receipt hash in the registry (from Horizon). */
  readonly anchor_tx: string;
  readonly anchor_url: string;
  readonly verify_url: string;
  readonly dispute: LiveDispute | null;
  /** Where the payment stands in the store's escrow, read from the contract; `null` if paid directly or not read. */
  readonly escrow: LiveEscrow | null;
}

export interface LivePage {
  readonly generated_at: string;
  readonly network: "stellar:testnet";
  readonly registry: string;
  readonly resolve_contract: string;
  readonly stores: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly url: string; readonly ok: boolean }>;
  readonly totals: {
    readonly purchases: number;
    readonly usdc: string;
    readonly disputes_open: number;
    readonly disputes_resolved: number;
    readonly refunded_usdc: string;
  };
  /** Purchases that count: each has its receipt checked, so a payment transaction. Newest first. */
  readonly purchases: readonly LivePurchase[];
  /** Anchored hashes whose receipt could not be read (`items` and `payment_tx` are `null`). Not counted in `totals`. */
  readonly incomplete: readonly LivePurchase[];
}

const DEFAULT_TTL_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PER_STORE = 20;
const MAX_SHOWN = 40;
/** A receipt that could not be read is not asked for again before this (T151 review): the page polls for every viewer. */
const MISS_RETRY_MS = 10 * 60_000;
/** Receipts kept in memory; each is small and never changes, and the page shows at most `MAX_SHOWN`. */
const MAX_FACTS = 500;

const orderSchema = z.looseObject({ receipt: z.looseObject({ jws: z.string().max(20_000) }).optional() });

interface ReceiptFacts {
  readonly items: LiveItem[];
  readonly paymentTx: string;
  /** The `purchase-escrow` the signed receipt says the payment went into, or `null` (paid directly). */
  readonly escrow: string | null;
}

/** Seconds since the epoch, as the ledger stores them, to an ISO date. */
function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The products and the payment of an anchored receipt, read from the store's
 * order and trusted only when the receipt is the anchored one: signature by
 * the store's signing key, and SHA-256 equal to the hash the registry holds.
 */
export async function readReceiptFacts(
  fetchImpl: typeof fetch,
  storeUrl: string,
  orderRef: string,
  anchoredHash: string,
  signingDid: string,
): Promise<ReceiptFacts | null> {
  if (!/^ord_[a-z0-9]{1,64}$/.test(orderRef)) return null;
  // The store's own order route carries the receipt for every sale; the UCP order only for UCP checkouts.
  const sources: Array<[string, Record<string, string>]> = [
    [`${storeUrl}/orders/${orderRef}`, { accept: "application/json" }],
    [`${storeUrl}/ucp/v1/orders/${orderRef}`, { accept: "application/json", "UCP-Agent": 'profile="https://agentpey.com/.well-known/ucp"' }],
  ];
  let jws: string | undefined;
  for (const [url, headers] of sources) {
    try {
      // A redirect is not followed: the receipt is read from the store's own origin or not at all.
      const res = await fetchImpl(url, { headers, redirect: "error" });
      if (!res.ok) continue;
      const parsed = orderSchema.safeParse(await res.json());
      jws = parsed.success ? parsed.data.receipt?.jws : undefined;
      if (jws !== undefined) break;
    } catch {
      // Try the next source.
    }
  }
  if (jws === undefined) return null;
  try {
    const checked = checkReceiptSignature(jws);
    if (!checked.ok || checked.claims === null || checked.hash !== anchoredHash || checked.claims.merchantDid !== signingDid) return null;
    return {
      items: checked.claims.items.map((item) => ({ title: item.name, quantity: item.quantity })),
      paymentTx: checked.claims.settlementTxHash,
      escrow: checked.claims.escrow?.contract ?? null,
    };
  } catch {
    return null;
  }
}

/** Builds the live page, sharing one answer for `ttlMs`; a failed rebuild keeps serving the last one. */
export function createLiveActivity(deps: LiveDeps): { read(): Promise<LivePage> } {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const perStore = deps.perStore ?? DEFAULT_PER_STORE;
  const fetchImpl = withTimeout(deps.fetchImpl, timeoutMs);
  /** What each anchored receipt says, by its hash: a receipt never changes, so each is read once. */
  const factsCache = new Map<string, ReceiptFacts>();
  /** When a receipt that could not be read may be tried again. */
  const missedUntil = new Map<string, number>();
  /** Escrow records that are over, by receipt hash: a closed purchase never changes, so it is not read again. */
  const closedEscrow = new Map<string, EscrowEntry>();
  let cached: { at: number; page: LivePage } | undefined;
  let inFlight: Promise<LivePage> | undefined;

  async function build(): Promise<LivePage> {
    const directory = await readDirectory(fetchImpl, deps.directoryUrl);
    const perStoreAnchors = await Promise.all(
      directory.stores.map(async (store) => {
        const signing = store.signingDid.slice("did:stellar:testnet:".length);
        try {
          const anchors = await listAnchors(fetchImpl, deps.horizonUrl, deps.registryId, signing, perStore);
          return { store, signing, anchors, ok: true };
        } catch {
          return { store, signing, anchors: [] as Array<{ hash: string; txHash: string }>, ok: false };
        }
      }),
    );

    const hashes = perStoreAnchors.flatMap((entry) => entry.anchors.map((anchor) => anchor.hash));
    const ledger = hashes.length === 0 ? { receipts: new Map(), disputes: new Map() } : await within(deps.readLedger(hashes), timeoutMs, "ledger read");

    const candidates: Array<{ store: DirectoryStore; base: string; hash: string; txHash: string; receipt: ReceiptEntry }> = [];
    for (const { store, signing, anchors } of perStoreAnchors) {
      const base = store.url.replace(/\/+$/, "");
      for (const anchor of anchors) {
        const receipt = ledger.receipts.get(anchor.hash);
        // Shown only if the registry still holds it, for this store: Horizon alone is not enough.
        if (receipt === undefined || receipt.merchant !== signing) continue;
        candidates.push({ store, base, hash: anchor.hash, txHash: anchor.txHash, receipt });
      }
    }
    candidates.sort((a, b) => b.receipt.timestamp - a.receipt.timestamp);
    const shown = candidates.slice(0, MAX_SHOWN);

    await Promise.all(
      shown
        .filter((c) => !factsCache.has(c.hash) && (missedUntil.get(c.hash) ?? 0) <= now())
        .map(async (c) => {
          const facts = await readReceiptFacts(fetchImpl, c.base, c.receipt.orderRef, c.hash, c.store.signingDid);
          if (facts === null) {
            missedUntil.set(c.hash, now() + MISS_RETRY_MS);
            return;
          }
          missedUntil.delete(c.hash);
          factsCache.set(c.hash, facts);
          // Oldest first out, so memory stays bounded however long the server runs.
          while (factsCache.size > MAX_FACTS) factsCache.delete(factsCache.keys().next().value as string);
        }),
    );

    const escrows = new Map<string, EscrowEntry>();
    const readEscrow = deps.readEscrow;
    if (readEscrow !== undefined) {
      await Promise.all(
        shown.map(async (c) => {
          const contract = factsCache.get(c.hash)?.escrow ?? null;
          if (contract === null) return;
          const known = closedEscrow.get(c.hash);
          if (known !== undefined) {
            escrows.set(c.hash, known);
            return;
          }
          try {
            const entry = await within(readEscrow(contract, c.receipt.orderRef), timeoutMs, "escrow read");
            if (entry === null) return;
            escrows.set(c.hash, entry);
            if (entry.closedAt !== null) closedEscrow.set(c.hash, entry);
            while (closedEscrow.size > MAX_FACTS) closedEscrow.delete(closedEscrow.keys().next().value as string);
          } catch {
            // Shown without its escrow state this time; the next refresh tries again.
          }
        }),
      );
    }

    const all: LivePurchase[] = shown.map((c) => {
      const d = ledger.disputes.get(c.hash);
      const facts = factsCache.get(c.hash);
      const e = escrows.get(c.hash);
      return {
        store: new URL(c.base).host,
        store_name: c.store.name,
        hash: c.hash,
        order_ref: c.receipt.orderRef,
        amount_usdc: formatUsdc(c.receipt.amount),
        at: isoFromSeconds(c.receipt.timestamp),
        items: facts?.items ?? null,
        payment_tx: facts?.paymentTx ?? null,
        payment_url: facts === undefined ? null : stellarExpertTxUrl(facts.paymentTx),
        anchor_tx: c.txHash,
        anchor_url: stellarExpertTxUrl(c.txHash),
        verify_url: `${c.base}/receipts/${c.hash}`,
        dispute:
          d === undefined
            ? null
            : {
                status: d.status,
                amount_usdc: formatUsdc(d.amountAtomic),
                refund_usdc: formatUsdc(d.refundAtomic),
                opened_at: isoFromSeconds(d.openedAt),
                resolved_at: d.resolvedAt === null ? null : isoFromSeconds(d.resolvedAt),
                verdict_hash: d.verdictHash,
              },
        escrow:
          e === undefined || facts?.escrow == null
            ? null
            : {
                contract: facts.escrow,
                contract_url: stellarExpertContractUrl(facts.escrow),
                outcome: escrowOutcome(e),
                refund_usdc: formatUsdc(e.refundAtomic),
                confirmed_at: e.confirmedAt === null ? null : isoFromSeconds(e.confirmedAt),
                closed_at: e.closedAt === null ? null : isoFromSeconds(e.closedAt),
              },
      };
    });
    // A record without a payment transaction is not a purchase this page can vouch for (see the header).
    const purchases = all.filter((p) => p.payment_tx !== null);
    const incomplete = all.filter((p) => p.payment_tx === null);

    let usdc = 0n;
    let refunded = 0n;
    let open = 0;
    let resolved = 0;
    for (const c of shown) {
      if (!factsCache.has(c.hash)) continue;
      usdc += c.receipt.amount;
      const d = ledger.disputes.get(c.hash);
      if (d === undefined) continue;
      if (d.status === "open") open += 1;
      else {
        resolved += 1;
        refunded += d.refundAtomic;
      }
    }

    return {
      generated_at: new Date(now()).toISOString(),
      network: "stellar:testnet",
      registry: deps.registryId,
      resolve_contract: deps.resolveId,
      stores: perStoreAnchors.map(({ store, ok }) => ({ slug: store.slug, name: store.name, url: store.url.replace(/\/+$/, ""), ok })),
      totals: { purchases: purchases.length, usdc: formatUsdc(usdc), disputes_open: open, disputes_resolved: resolved, refunded_usdc: formatUsdc(refunded) },
      purchases,
      incomplete,
    };
  }

  return {
    async read() {
      if (cached !== undefined && now() - cached.at < ttl) return cached.page;
      const refresh = (inFlight ??= build()
        .then((page) => {
          cached = { at: now(), page };
          return page;
        })
        .catch((error: unknown) => {
          if (cached === undefined) {
            throw error instanceof AgentPassError ? error : new AgentPassError("NetworkError", "the live activity could not be read", { cause: error, details: {} });
          }
          cached = { at: now(), page: cached.page };
          return cached.page;
        })
        .finally(() => {
          inFlight = undefined;
        }));
      // Past its window, the last page is served at once while the next one builds (T151 review): no viewer waits
      // on a slow store. Only the very first read waits.
      return cached !== undefined ? cached.page : refresh;
    },
  };
}
