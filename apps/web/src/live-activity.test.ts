import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { signReceipt, USDC_TESTNET } from "@vitrinee/core";
import { describe, expect, it, vi } from "vitest";

import { createLiveActivity, type DisputeEntry, type LiveDeps, type ReceiptEntry } from "./live-activity.js";

const REGISTRY = "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5";
const RESOLVE = "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F";
const signerA = Keypair.random();
const signerB = Keypair.random();
const A = signerA.publicKey();
const B = signerB.publicKey();
const tx = (c: string) => c.repeat(64);

/** A real receipt, signed by the store's key: its hash is what the registry anchors. */
function signed(signer: Keypair, orderId: string, items: Array<[string, number, string, string]>, paymentTx: string) {
  const total = items.reduce((sum, [, q, , atomic]) => sum + BigInt(atomic) * BigInt(q), 0n);
  return signReceipt(
    {
      typ: "vitrinee-receipt/0.1",
      orderId,
      platformOrderId: "1",
      platform: "shopify",
      merchantDid: `did:stellar:testnet:${signer.publicKey()}`,
      merchantAccount: Keypair.random().publicKey(),
      payerAccount: Keypair.random().publicKey(),
      network: "stellar:testnet",
      asset: USDC_TESTNET.contractId,
      amountUSDC: `${total / 10_000_000n}.${(total % 10_000_000n).toString().padStart(7, "0")}`,
      amountUSDCAtomic: total.toString(),
      settlementTxHash: paymentTx,
      items: items.map(([name, quantity, decimal, atomic], i) => ({ productId: `p${i}`, sku: `s${i}`, name, quantity, unitPriceUSDC: decimal, unitPriceUSDCAtomic: atomic })),
      issuedAt: "2026-10-08T12:00:00.000Z",
      refundWindowEndsAt: "2026-10-18T12:00:00.000Z",
    } as Parameters<typeof signReceipt>[0],
    signer.secret(),
  );
}
const RA = signed(signerA, "ord_alpha1", [["Imán", 1, "1.5684211", "15684211"], ["Stickers", 2, "1.0421053", "10421053"]], tx("7"));
const RB = signed(signerB, "ord_beta1", [["Gorro", 1, "1.0421053", "10421053"]], tx("8"));
const keys: Record<string, string> = { a: RA.hash, b: RB.hash };
const h = (c: string) => keys[c] ?? c.repeat(64);

function anchorOp(hash: string, txHash: string, merchant: string) {
  return {
    type: "invoke_host_function",
    transaction_hash: txHash,
    transaction_successful: true,
    parameters: [
      new Address(REGISTRY).toScVal(),
      xdr.ScVal.scvSymbol("anchor"),
      xdr.ScVal.scvBytes(Buffer.from(hash, "hex")),
      new Address(merchant).toScVal(),
      nativeToScVal(1n, { type: "i128" }),
      xdr.ScVal.scvBytes(Buffer.from("x", "utf8")),
    ].map((v) => ({ value: v.toXDR("base64") })),
  };
}

const DIR = "https://vitrinee.agentpey.com/api/comercios";
const HORIZON = "https://horizon-testnet.stellar.org";
const directory = {
  platformHost: "vitrinee.agentpey.com",
  comercios: [
    { slug: "alpha", name: "Alpha", url: "https://alpha.vitrinee.agentpey.com", signingDid: `did:stellar:testnet:${A}` },
    { slug: "beta", name: "Beta", url: "https://beta.vitrinee.agentpey.com", signingDid: `did:stellar:testnet:${B}` },
  ],
};

function receipt(merchant: string, orderRef: string, amount: bigint, timestamp: number): ReceiptEntry {
  return { merchant, orderRef, amount, timestamp };
}

function fetchFor(routes: Record<string, unknown | (() => Response)>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    const route = routes[key];
    return typeof route === "function" ? (route as () => Response)() : Response.json(route);
  }) as unknown as typeof fetch;
}

function deps(over: Partial<LiveDeps> & { receipts?: Map<string, ReceiptEntry>; disputes?: Map<string, DisputeEntry> } = {}): LiveDeps {
  const receipts =
    over.receipts ??
    new Map([
      [h("a"), receipt(A, "ord_alpha1", 15_684_211n, 1_791_400_000)],
      [h("b"), receipt(B, "ord_beta1", 10_421_053n, 1_791_500_000)],
    ]);
  const disputes = over.disputes ?? new Map<string, DisputeEntry>();
  return {
    fetchImpl: fetchFor({
      [DIR]: directory,
      [`${HORIZON}/accounts/${A}/operations`]: { _embedded: { records: [anchorOp(h("a"), tx("1"), A)] } },
      [`${HORIZON}/accounts/${B}/operations`]: { _embedded: { records: [anchorOp(h("b"), tx("2"), B)] } },
      "https://alpha.vitrinee.agentpey.com/ucp/v1/orders/ord_alpha1": { id: "ord_alpha1", receipt: { jws: RA.jws } },
      "https://beta.vitrinee.agentpey.com/ucp/v1/orders/ord_beta1": () => new Response("down", { status: 503 }),
    }),
    directoryUrl: DIR,
    horizonUrl: HORIZON,
    registryId: REGISTRY,
    resolveId: RESOLVE,
    readLedger: vi.fn(async () => ({ receipts, disputes })),
    ...over,
  };
}

describe("createLiveActivity (T151)", () => {
  it("lists every store's purchases newest first, with the registry's amount, order and time", async () => {
    const page = await createLiveActivity(deps()).read();
    expect(page.purchases.map((p) => [p.store, p.order_ref, p.amount_usdc, p.at])).toEqual([
      ["beta.vitrinee.agentpey.com", "ord_beta1", "1.0421053", new Date(1_791_500_000 * 1000).toISOString()],
      ["alpha.vitrinee.agentpey.com", "ord_alpha1", "1.5684211", new Date(1_791_400_000 * 1000).toISOString()],
    ]);
    expect(page.purchases[1]).toMatchObject({
      verify_url: `https://alpha.vitrinee.agentpey.com/receipts/${h("a")}`,
      anchor_url: `https://stellar.expert/explorer/testnet/tx/${tx("1")}`,
      // From the anchored, signed receipt.
      items: [
        { title: "Imán", quantity: 1 },
        { title: "Stickers", quantity: 2 },
      ],
      payment_tx: tx("7"),
      payment_url: `https://stellar.expert/explorer/testnet/tx/${tx("7")}`,
      dispute: null,
    });
    expect(page.totals).toMatchObject({ purchases: 2, usdc: "2.6105264", disputes_open: 0, disputes_resolved: 0 });
  });

  it("reads every receipt and dispute in one ledger read", async () => {
    const d = deps();
    await createLiveActivity(d).read();
    expect(d.readLedger).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.readLedger).mock.calls[0]?.[0]).toEqual([h("a"), h("b")]);
  });

  it("shows a dispute's state from the contract, and counts what was refunded", async () => {
    const disputes = new Map<string, DisputeEntry>([
      [h("a"), { status: "resolved", amountAtomic: 15_684_211n, refundAtomic: 15_684_211n, openedAt: 1_791_410_000, resolvedAt: 1_791_420_000, verdictHash: "9".repeat(64) }],
      [h("b"), { status: "open", amountAtomic: 10_421_053n, refundAtomic: 0n, openedAt: 1_791_510_000, resolvedAt: null, verdictHash: null }],
    ]);
    const page = await createLiveActivity(deps({ disputes })).read();
    expect(page.purchases.find((p) => p.order_ref === "ord_alpha1")?.dispute).toMatchObject({ status: "resolved", refund_usdc: "1.5684211", verdict_hash: "9".repeat(64) });
    expect(page.purchases.find((p) => p.order_ref === "ord_beta1")?.dispute).toMatchObject({ status: "open", resolved_at: null });
    expect(page.totals).toMatchObject({ disputes_open: 1, disputes_resolved: 1, refunded_usdc: "1.5684211" });
  });

  it("leaves out a purchase the registry does not hold for that store", async () => {
    const receipts = new Map([
      [h("a"), receipt(B, "ord_alpha1", 1n, 1)],
      [h("b"), receipt(B, "ord_beta1", 10_421_053n, 1_791_500_000)],
    ]);
    const page = await createLiveActivity(deps({ receipts })).read();
    expect(page.purchases.map((p) => p.order_ref)).toEqual(["ord_beta1"]);
  });

  it("keeps a purchase whose store did not answer for its receipt, without inventing products or payment", async () => {
    const page = await createLiveActivity(deps()).read();
    expect(page.purchases.find((p) => p.order_ref === "ord_beta1")).toMatchObject({ items: null, payment_tx: null, payment_url: null });
  });

  it("reads the receipt from the store's own order route for a sale made before UCP", async () => {
    const d = deps();
    const base = d.fetchImpl;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "https://beta.vitrinee.agentpey.com/orders/ord_beta1" ? Response.json({ orderId: "ord_beta1", receipt: { jws: RB.jws } }) : base(input, init),
    ) as unknown as typeof fetch;
    const page = await createLiveActivity({ ...d, fetchImpl }).read();
    expect(page.purchases.find((p) => p.order_ref === "ord_beta1")).toMatchObject({ items: [{ title: "Gorro", quantity: 1 }], payment_tx: tx("8") });
  });

  it("ignores a receipt the store shows that is not the anchored one, or not signed by that store", async () => {
    const other = signed(signerA, "ord_alpha1", [["Otra cosa", 1, "1.5684211", "15684211"]], tx("9"));
    const stranger = signed(Keypair.random(), "ord_alpha1", [["Imán", 1, "1.5684211", "15684211"]], tx("9"));
    for (const jws of [other.jws, stranger.jws, "not.a.jws"]) {
      const d = deps();
      const base = d.fetchImpl;
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        /\/orders\/ord_alpha1$/.test(String(input)) ? Response.json({ receipt: { jws } }) : base(input, init),
      ) as unknown as typeof fetch;
      const page = await createLiveActivity({ ...d, fetchImpl }).read();
      expect(page.purchases.find((p) => p.order_ref === "ord_alpha1")).toMatchObject({ items: null, payment_tx: null });
    }
  });

  it("reads an order's products once, then serves them from memory", async () => {
    let t = 0;
    const d = deps({ now: () => t, ttlMs: 1000 });
    const live = createLiveActivity(d);
    await live.read();
    t = 2000;
    await live.read();
    const orderReads = vi.mocked(d.fetchImpl).mock.calls.filter(([u]) => String(u).includes("/ucp/v1/orders/ord_alpha1"));
    expect(orderReads).toHaveLength(1);
  });

  it("marks a store whose Horizon history could not be read, and still shows the others", async () => {
    const d = deps();
    const base = d.fetchImpl;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes(`/accounts/${B}/`) ? new Response("down", { status: 503 }) : base(input, init),
    ) as unknown as typeof fetch;
    const page = await createLiveActivity({ ...d, fetchImpl }).read();
    expect(page.stores).toEqual([
      expect.objectContaining({ slug: "alpha", ok: true }),
      expect.objectContaining({ slug: "beta", ok: false }),
    ]);
    expect(page.purchases.map((p) => p.order_ref)).toEqual(["ord_alpha1"]);
  });

  it("keeps serving the last answer when a rebuild fails, and fails typed with no answer yet", async () => {
    let t = 0;
    let up = true;
    const d = deps({ now: () => t, ttlMs: 1000 });
    const readLedger = vi.fn(async (hashes: readonly string[]) => {
      if (!up) throw new Error("rpc down");
      return d.readLedger(hashes);
    });
    const live = createLiveActivity({ ...d, readLedger });
    const first = await live.read();
    up = false;
    t = 2000;
    await expect(live.read()).resolves.toBe(first);

    const cold = createLiveActivity({ ...d, readLedger: async () => Promise.reject(new Error("rpc down")) });
    await expect(cold.read()).rejects.toMatchObject({ code: "NetworkError" });
  });
});
