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
 * It only **shows** disputes. Nothing here opens, answers or resolves one, and
 * nothing connects a dispute to a chat, a payment, a dispatch or a webhook.
 *
 * Registry and dispute entries are read in one `getLedgerEntries` call per
 * refresh, not one per receipt: the page polls, and so does every viewer.
 */
import { AgentPassError } from "@agentpass/core";
import { checkReceiptSignature, stellarExpertTxUrl } from "@vitrinee/core";
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

export interface LiveDeps {
  readonly fetchImpl: typeof fetch;
  readonly directoryUrl: string;
  readonly horizonUrl: string;
  readonly registryId: string;
  readonly resolveId: string;
  /** Every receipt and dispute for these hashes, in one read; a hash with no entry is absent from the map. */
  readonly readLedger: (hashes: readonly string[]) => Promise<{ receipts: Map<string, ReceiptEntry>; disputes: Map<string, DisputeEntry> }>;
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
  readonly purchases: readonly LivePurchase[];
}

const DEFAULT_TTL_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PER_STORE = 20;
const MAX_SHOWN = 40;

const orderSchema = z.looseObject({ receipt: z.looseObject({ jws: z.string().max(20_000) }).optional() });

interface ReceiptFacts {
  readonly items: LiveItem[];
  readonly paymentTx: string;
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
      const res = await fetchImpl(url, { headers });
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
        .filter((c) => !factsCache.has(c.hash))
        .map(async (c) => {
          const facts = await readReceiptFacts(fetchImpl, c.base, c.receipt.orderRef, c.hash, c.store.signingDid);
          if (facts !== null) factsCache.set(c.hash, facts);
        }),
    );

    let usdc = 0n;
    let refunded = 0n;
    let open = 0;
    let resolved = 0;
    const purchases: LivePurchase[] = shown.map((c) => {
      usdc += c.receipt.amount;
      const d = ledger.disputes.get(c.hash);
      if (d !== undefined) {
        if (d.status === "open") open += 1;
        else {
          resolved += 1;
          refunded += d.refundAtomic;
        }
      }
      const facts = factsCache.get(c.hash);
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
      };
    });

    return {
      generated_at: new Date(now()).toISOString(),
      network: "stellar:testnet",
      registry: deps.registryId,
      resolve_contract: deps.resolveId,
      stores: perStoreAnchors.map(({ store, ok }) => ({ slug: store.slug, name: store.name, url: store.url.replace(/\/+$/, ""), ok })),
      totals: { purchases: purchases.length, usdc: formatUsdc(usdc), disputes_open: open, disputes_resolved: resolved, refunded_usdc: formatUsdc(refunded) },
      purchases,
    };
  }

  return {
    async read() {
      if (cached !== undefined && now() - cached.at < ttl) return cached.page;
      inFlight ??= build()
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
        });
      return inFlight;
    },
  };
}
