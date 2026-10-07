import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { anchoredHash, createStoresDirectory, formatUsdc, type StoresRegistry } from "./stores-directory.js";

const REGISTRY = "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5";
const OTHER_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SIGNER = Keypair.random().publicKey();
const OTHER_SIGNER = Keypair.random().publicKey();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TX_A = "1".repeat(64);
const TX_B = "2".repeat(64);

function b64(value: xdr.ScVal): string {
  return value.toXDR("base64");
}

function anchorOp(opts: { hash: string; tx: string; contract?: string; fn?: string; merchant?: string; successful?: boolean }) {
  return {
    type: "invoke_host_function",
    transaction_hash: opts.tx,
    transaction_successful: opts.successful ?? true,
    parameters: [
      new Address(opts.contract ?? REGISTRY).toScVal(),
      xdr.ScVal.scvSymbol(opts.fn ?? "anchor"),
      xdr.ScVal.scvBytes(Buffer.from(opts.hash, "hex")),
      new Address(opts.merchant ?? SIGNER).toScVal(),
      nativeToScVal(15_684_211n, { type: "i128" }),
      xdr.ScVal.scvBytes(Buffer.from("ord_x", "utf8")),
    ].map((v) => ({ type: "Sc", value: b64(v) })),
  };
}

const directory = {
  platformHost: "vitrinee.agentpey.com",
  comercios: [
    {
      slug: "agentcommerce",
      name: "AgentCommerce",
      url: "https://agentcommerce.vitrinee.agentpey.com",
      payTo: Keypair.random().publicKey(),
      signingDid: `did:stellar:testnet:${SIGNER}`,
    },
  ],
};

function registry(overrides: Partial<StoresRegistry> = {}): StoresRegistry {
  return {
    contractId: REGISTRY,
    count: vi.fn(async () => 16),
    get: vi.fn(async (hash: string) =>
      hash === HASH_A ? { merchant: SIGNER, amount: 15_684_211n, orderRef: "ord_muws1afd200277f471", ledger: 5_000_000, timestamp: 1_791_300_000 } : null,
    ),
    ...overrides,
  };
}

function fakeFetch(routes: Record<string, unknown | (() => Response)>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    const route = routes[key];
    return typeof route === "function" ? (route as () => Response)() : Response.json(route);
  }) as unknown as typeof fetch;
}

const DIR_URL = "https://vitrinee.agentpey.com/api/comercios";
const HORIZON = "https://horizon-testnet.stellar.org";
const OPS = `${HORIZON}/accounts/${SIGNER}/operations`;

describe("formatUsdc", () => {
  it("writes atomic units with seven decimals, without floating point", () => {
    expect(formatUsdc(15_684_211n)).toBe("1.5684211");
    expect(formatUsdc(10_000_000n)).toBe("1.0000000");
    expect(formatUsdc(1n)).toBe("0.0000001");
  });
});

describe("anchoredHash", () => {
  it("reads the hash of an anchor on the registry by this merchant", () => {
    expect(anchoredHash(anchorOp({ hash: HASH_A, tx: TX_A }), REGISTRY, SIGNER)).toBe(HASH_A);
  });

  it("ignores a call to another contract, another function, another merchant, or a failed transaction", () => {
    expect(anchoredHash(anchorOp({ hash: HASH_A, tx: TX_A, contract: OTHER_CONTRACT }), REGISTRY, SIGNER)).toBeNull();
    expect(anchoredHash(anchorOp({ hash: HASH_A, tx: TX_A, fn: "transfer" }), REGISTRY, SIGNER)).toBeNull();
    expect(anchoredHash(anchorOp({ hash: HASH_A, tx: TX_A, merchant: OTHER_SIGNER }), REGISTRY, SIGNER)).toBeNull();
    expect(anchoredHash(anchorOp({ hash: HASH_A, tx: TX_A, successful: false }), REGISTRY, SIGNER)).toBeNull();
  });

  it("ignores operations that are not contract calls, or whose parameters are not XDR", () => {
    expect(anchoredHash({ type: "payment", transaction_hash: TX_A }, REGISTRY, SIGNER)).toBeNull();
    const garbled = anchorOp({ hash: HASH_A, tx: TX_A });
    garbled.parameters[0] = { type: "Sc", value: "not-xdr" };
    expect(anchoredHash(garbled, REGISTRY, SIGNER)).toBeNull();
  });
});

describe("createStoresDirectory", () => {
  it("lists each store with its count and its newest anchored receipt, taken from the registry record", async () => {
    const fetchImpl = fakeFetch({
      [DIR_URL]: directory,
      // Horizon writes `parameters: null` for a deploy, and `[]` for an upload.
      [OPS]: {
        _embedded: {
          records: [
            { type: "payment", transaction_hash: TX_B },
            { type: "invoke_host_function", transaction_hash: TX_B, parameters: null },
            { type: "invoke_host_function", transaction_hash: TX_B, parameters: [] },
            anchorOp({ hash: HASH_A, tx: TX_A }),
          ],
        },
      },
    });
    const page = await createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list();

    expect(page.platform_host).toBe("vitrinee.agentpey.com");
    expect(page.registry).toBe(REGISTRY);
    const [store] = page.stores;
    expect(store).toMatchObject({
      slug: "agentcommerce",
      ucp_profile_url: "https://agentcommerce.vitrinee.agentpey.com/.well-known/ucp",
      signing_account: SIGNER,
      receipts_anchored: 16,
      latest: {
        status: "found",
        receipt: {
          hash: HASH_A,
          tx_hash: TX_A,
          amount_usdc: "1.5684211",
          order_ref: "ord_muws1afd200277f471",
          anchored_at: new Date(1_791_300_000 * 1000).toISOString(),
          verify_url: `https://agentcommerce.vitrinee.agentpey.com/receipts/${HASH_A}`,
          explorer_url: `https://stellar.expert/explorer/testnet/tx/${TX_A}`,
        },
      },
    });
  });

  it("does not show a hash the registry does not hold, even if Horizon names it", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: { _embedded: { records: [anchorOp({ hash: HASH_B, tx: TX_B })] } } });
    const page = await createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list();
    expect(page.stores[0]?.latest).toEqual({ status: "unavailable" });
  });

  it("says a store has no receipt when its history holds no anchor", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: { _embedded: { records: [] } } });
    const page = await createStoresDirectory({
      fetchImpl,
      directoryUrl: DIR_URL,
      horizonUrl: HORIZON,
      registry: registry({ count: async () => 0 }),
    }).list();
    expect(page.stores[0]).toMatchObject({ receipts_anchored: 0, latest: { status: "none" } });
  });

  it("keeps the store on the page when Horizon or the registry does not answer", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: () => new Response("down", { status: 503 }) });
    const page = await createStoresDirectory({
      fetchImpl,
      directoryUrl: DIR_URL,
      horizonUrl: HORIZON,
      registry: registry({ count: async () => Promise.reject(new Error("rpc down")) }),
    }).list();
    expect(page.stores[0]).toMatchObject({ slug: "agentcommerce", receipts_anchored: null, latest: { status: "unavailable" } });
  });

  it("fails with a typed error when the directory does not answer with a list", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: { comercios: "nope" } });
    await expect(
      createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list(),
    ).rejects.toMatchObject({ code: "NetworkError" });
  });

  it("leaves out an entry whose URL is not https, counts it, and keeps the other stores", async () => {
    const bad = { ...directory, comercios: [{ ...directory.comercios[0], slug: "bad", url: "javascript:alert(1)" }, ...directory.comercios] };
    const fetchImpl = fakeFetch({ [DIR_URL]: bad, [OPS]: { _embedded: { records: [] } } });
    const page = await createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list();
    expect(page.skipped).toBe(1);
    expect(page.stores.map((s) => s.slug)).toEqual(["agentcommerce"]);
  });

  it("refuses a platform host that is not a host name", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: { ...directory, platformHost: "evil.com/x?" } });
    await expect(
      createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list(),
    ).rejects.toMatchObject({ code: "NetworkError" });
  });

  it("does not wait forever on a registry read that never answers", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: { _embedded: { records: [anchorOp({ hash: HASH_A, tx: TX_A })] } } });
    const never = () => new Promise<never>(() => undefined);
    const page = await createStoresDirectory({
      fetchImpl,
      directoryUrl: DIR_URL,
      horizonUrl: HORIZON,
      registry: registry({ count: never, get: never }),
      timeoutMs: 20,
    }).list();
    expect(page.stores[0]).toMatchObject({ receipts_anchored: null, latest: { status: "unavailable" } });
  });

  it("calls a signing account Horizon does not know a store with no receipt yet", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: () => new Response("not found", { status: 404 }) });
    const page = await createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry({ count: async () => 0 }) }).list();
    expect(page.stores[0]?.latest).toEqual({ status: "none" });
  });

  it("does not show a receipt the registry holds for another merchant", async () => {
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: { _embedded: { records: [anchorOp({ hash: HASH_A, tx: TX_A })] } } });
    const other = registry({ get: async () => ({ merchant: OTHER_SIGNER, amount: 1n, orderRef: "x", ledger: 1, timestamp: 1 }) });
    const page = await createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: other }).list();
    expect(page.stores[0]?.latest).toEqual({ status: "unavailable" });
  });

  it("follows Horizon's next page to find an older anchor, but never a next link on another host", async () => {
    const filler = Array.from({ length: 50 }, () => ({ type: "payment", transaction_hash: TX_B }));
    const page2 = `${HORIZON}/accounts/${SIGNER}/next-page`;
    const ok = fakeFetch({
      [DIR_URL]: directory,
      [page2]: { _embedded: { records: [anchorOp({ hash: HASH_A, tx: TX_A })] } },
      [OPS]: { _embedded: { records: filler }, _links: { next: { href: page2 } } },
    });
    const found = await createStoresDirectory({ fetchImpl: ok, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list();
    expect(found.stores[0]?.latest.status).toBe("found");

    const elsewhere = fakeFetch({
      [DIR_URL]: directory,
      [OPS]: { _embedded: { records: filler }, _links: { next: { href: "https://evil.example/ops" } } },
    });
    const notFollowed = await createStoresDirectory({ fetchImpl: elsewhere, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry() }).list();
    expect(notFollowed.stores[0]?.latest).toEqual({ status: "none" });
    expect(vi.mocked(elsewhere).mock.calls.some(([u]) => String(u).startsWith("https://evil.example"))).toBe(false);
  });

  it("keeps serving the last answer when a rebuild fails", async () => {
    let t = 0;
    let up = true;
    const fetchImpl = fakeFetch({
      [DIR_URL]: () => (up ? Response.json(directory) : new Response("down", { status: 503 })),
      [OPS]: { _embedded: { records: [] } },
    });
    const stores = createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry(), now: () => t, ttlMs: 1000 });
    const first = await stores.list();
    up = false;
    t = 1001;
    await expect(stores.list()).resolves.toBe(first);
  });

  it("shares one answer for the cache window and builds again after it", async () => {
    let t = 0;
    const fetchImpl = fakeFetch({ [DIR_URL]: directory, [OPS]: { _embedded: { records: [] } } });
    const stores = createStoresDirectory({ fetchImpl, directoryUrl: DIR_URL, horizonUrl: HORIZON, registry: registry(), now: () => t, ttlMs: 1000 });
    await Promise.all([stores.list(), stores.list()]);
    await stores.list();
    const directoryCalls = () => vi.mocked(fetchImpl).mock.calls.filter(([u]) => String(u) === DIR_URL).length;
    expect(directoryCalls()).toBe(1);
    t = 1001;
    await stores.list();
    expect(directoryCalls()).toBe(2);
  });
});
