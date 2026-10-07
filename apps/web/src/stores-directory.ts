/**
 * `GET /api/stores` — the data behind `/tiendas` (T141): the stores an agent
 * can buy from today, each with its UCP profile and its latest receipt.
 *
 * **Nothing here comes from AgentPey's own database.** The list is the
 * platform's public directory (`C-141`); the receipt count is
 * `receipt-registry`'s `count(merchant)`; the latest receipt is found in
 * Horizon, because a store's signing key is the source account of every
 * `anchor` it sends (`VT-8`), and Horizon keeps that history (Soroban RPC
 * events only keep seven days, so a store with a quiet week would show
 * nothing). A hash Horizon names is shown only if the registry still holds it,
 * and the amount, order and date shown are the registry's record, not
 * Horizon's copy of the arguments.
 *
 * One store that does not answer never hides the others: its row says so
 * instead. Only the directory itself failing is an error, since without it
 * there is no list to show.
 */
import { AgentPassError } from "@agentpass/core";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";

/** The registry reads this needs; `ReceiptRegistryClient` from `@vitrinee/anchor` satisfies it. */
export interface StoresRegistry {
  readonly contractId: string;
  count(merchant: string): Promise<number>;
  get(hashHex: string): Promise<{ amount: bigint; orderRef: string; ledger: number; timestamp: number } | null>;
}

export interface StoresDirectoryDeps {
  readonly fetchImpl: typeof fetch;
  readonly directoryUrl: string;
  readonly horizonUrl: string;
  readonly registry: StoresRegistry;
  readonly now?: () => number;
  /** How long one answer is shared across callers. */
  readonly ttlMs?: number;
}

export interface LatestReceipt {
  readonly hash: string;
  readonly tx_hash: string;
  /** USDC, as a decimal string with seven decimals (the registry stores atomic units). */
  readonly amount_usdc: string;
  readonly order_ref: string;
  readonly anchored_at: string;
  readonly verify_url: string;
  readonly explorer_url: string;
}

export interface StoreRow {
  readonly slug: string;
  readonly name: string;
  readonly url: string;
  readonly ucp_profile_url: string;
  readonly signing_account: string;
  /** `null` when the registry did not answer. */
  readonly receipts_anchored: number | null;
  /** `none` is a fact (no anchored receipt); `unavailable` is "could not tell right now". */
  readonly latest: { readonly status: "found"; readonly receipt: LatestReceipt } | { readonly status: "none" } | { readonly status: "unavailable" };
}

export interface StoresPage {
  readonly platform_host: string;
  readonly network: "stellar:testnet";
  readonly registry: string;
  readonly generated_at: string;
  readonly stores: readonly StoreRow[];
}

const DEFAULT_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
/** Horizon pages of operations read per store before giving up on finding an `anchor`. */
const MAX_PAGES = 3;
const PAGE_SIZE = 50;
const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";

const directorySchema = z.object({
  platformHost: z.string().min(1),
  comercios: z.array(
    z.looseObject({
      slug: z.string().regex(/^[a-z0-9-]{1,64}$/),
      name: z.string().min(1).max(120),
      url: z.url({ protocol: /^https$/ }),
      signingDid: z.string().regex(/^did:stellar:testnet:G[A-Z2-7]{55}$/),
    }),
  ),
});

const operationsSchema = z.object({
  _embedded: z.object({
    records: z.array(
      z.looseObject({
        type: z.string(),
        transaction_hash: z.string().regex(/^[0-9a-f]{64}$/),
        transaction_successful: z.boolean().optional(),
        // `null`, not absent, on a deploy or an upload: seen on a real store account.
        parameters: z.array(z.looseObject({ value: z.string() })).nullish(),
      }),
    ),
  }),
  _links: z.looseObject({ next: z.looseObject({ href: z.string() }).optional() }).optional(),
});

type Operation = z.infer<typeof operationsSchema>["_embedded"]["records"][number];

/** Seven-decimal USDC from atomic units, without floating point. */
export function formatUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = abs / 10_000_000n;
  const fraction = (abs % 10_000_000n).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * The receipt hash of an `anchor(hash, merchant, amount, order_ref)` call on
 * `registryId` by `merchant`, or `null` for any other operation. Horizon lists
 * an `invoke_host_function`'s parameters as the contract, the function name
 * and then the arguments, each as base64 XDR.
 */
export function anchoredHash(op: Operation, registryId: string, merchant: string): string | null {
  if (op.type !== "invoke_host_function" || op.transaction_successful === false) return null;
  const params = op.parameters ?? [];
  if (params.length !== 6) return null;
  try {
    const [contract, fn, hash, who] = params.map((p) => xdr.ScVal.fromXDR(p.value, "base64"));
    if (contract === undefined || fn === undefined || hash === undefined || who === undefined) return null;
    if (Address.fromScVal(contract).toString() !== registryId) return null;
    if (scValToNative(fn) !== "anchor") return null;
    if (Address.fromScVal(who).toString() !== merchant) return null;
    const bytes: unknown = scValToNative(hash);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return null;
    return Buffer.from(bytes).toString("hex");
  } catch {
    return null;
  }
}

function withTimeout(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function readJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AgentPassError("NetworkError", `GET ${url} answered ${res.status}`, { details: { url, status: res.status } });
  return res.json();
}

/** The newest `anchor` this merchant sent to the registry, as `{ hash, txHash }`, or `null` if none in reach. */
async function findLatestAnchor(
  fetchImpl: typeof fetch,
  horizonUrl: string,
  registryId: string,
  merchant: string,
): Promise<{ hash: string; txHash: string } | null> {
  let url: string | undefined = `${horizonUrl}/accounts/${merchant}/operations?order=desc&limit=${PAGE_SIZE}`;
  for (let page = 0; page < MAX_PAGES && url !== undefined; page++) {
    const parsed = operationsSchema.parse(await readJson(fetchImpl, url));
    for (const op of parsed._embedded.records) {
      const hash = anchoredHash(op, registryId, merchant);
      if (hash !== null) return { hash, txHash: op.transaction_hash };
    }
    if (parsed._embedded.records.length < PAGE_SIZE) return null;
    url = parsed._links?.next?.href;
  }
  return null;
}

async function storeRow(
  deps: StoresDirectoryDeps,
  fetchImpl: typeof fetch,
  store: z.infer<typeof directorySchema>["comercios"][number],
): Promise<StoreRow> {
  const signing = store.signingDid.slice("did:stellar:testnet:".length);
  const base = store.url.replace(/\/+$/, "");
  const [count, latest] = await Promise.all([
    deps.registry.count(signing).catch(() => null),
    (async (): Promise<StoreRow["latest"]> => {
      try {
        const found = await findLatestAnchor(fetchImpl, deps.horizonUrl, deps.registry.contractId, signing);
        if (found === null) return { status: "none" };
        const record = await deps.registry.get(found.hash);
        // Horizon named it, but the registry must still hold it before it is shown as anchored.
        if (record === null) return { status: "unavailable" };
        return {
          status: "found",
          receipt: {
            hash: found.hash,
            tx_hash: found.txHash,
            amount_usdc: formatUsdc(record.amount),
            order_ref: record.orderRef,
            anchored_at: new Date(record.timestamp * 1000).toISOString(),
            verify_url: `${base}/receipts/${found.hash}`,
            explorer_url: `${EXPLORER_TX}${found.txHash}`,
          },
        };
      } catch {
        return { status: "unavailable" };
      }
    })(),
  ]);
  return {
    slug: store.slug,
    name: store.name,
    url: base,
    ucp_profile_url: `${base}/.well-known/ucp`,
    signing_account: signing,
    receipts_anchored: count,
    latest,
  };
}

/** Builds the page data, sharing one answer for `ttlMs` and never starting two builds at once. */
export function createStoresDirectory(deps: StoresDirectoryDeps): { list(): Promise<StoresPage> } {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = withTimeout(deps.fetchImpl);
  let cached: { at: number; page: StoresPage } | undefined;
  let inFlight: Promise<StoresPage> | undefined;

  async function build(): Promise<StoresPage> {
    let directory: z.infer<typeof directorySchema>;
    try {
      directory = directorySchema.parse(await readJson(fetchImpl, deps.directoryUrl));
    } catch (error) {
      throw new AgentPassError("NetworkError", "the store directory did not answer with a list of stores", {
        cause: error,
        details: { url: deps.directoryUrl },
      });
    }
    const stores = await Promise.all(directory.comercios.map((store) => storeRow(deps, fetchImpl, store)));
    return {
      platform_host: directory.platformHost,
      network: "stellar:testnet",
      registry: deps.registry.contractId,
      generated_at: new Date(now()).toISOString(),
      stores,
    };
  }

  return {
    async list() {
      if (cached !== undefined && now() - cached.at < ttl) return cached.page;
      inFlight ??= build()
        .then((page) => {
          cached = { at: now(), page };
          return page;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
