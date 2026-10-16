import type { EscrowConfig, EscrowPurchase, EscrowReader, EscrowReaderFactory } from "@vitrinee/anchor";
import { describe, expect, it } from "vitest";

import { escrowMeaning, readEscrowState } from "./escrow-state.js";

const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
const RECEIPT = "7".repeat(64);
const HELD_AT = 1_790_000_000; // 2026-09-21T14:13:20Z
const WINDOWS = { releaseWindowSeconds: 600, responseWindowSeconds: 900, resolveWindowSeconds: 3600 };
const CONFIG = { operator: "G", payee: "G", arbiter: "G", token: "C", ...WINDOWS } as EscrowConfig;

const purchase = (overrides: Partial<EscrowPurchase> = {}): EscrowPurchase => ({
  orderRef: "ord_1",
  payer: "CRAIL",
  amountAtomic: 5_157_895n,
  txHash: "e".repeat(64),
  receiptHash: RECEIPT,
  status: "held",
  heldAt: HELD_AT,
  shippedAt: null,
  claimHash: null,
  openedAt: null,
  responseHash: null,
  verdictHash: null,
  refundAtomic: 0n,
  refundOwedAtomic: 0n,
  closedAt: null,
  ...overrides,
});
const at = (seconds: number) => new Date((HELD_AT + seconds) * 1000);

function readers(found: EscrowPurchase | null | (() => Promise<never>)): EscrowReaderFactory {
  return (contractId) =>
    ({
      contractId,
      config: async () => CONFIG,
      get: typeof found === "function" ? found : async () => found,
      byTx: async () => null,
    }) as EscrowReader;
}
const signed = { receiptHash: RECEIPT, contract: ESCROW };
const read = (found: EscrowPurchase | null | (() => Promise<never>), overrides: Partial<Parameters<typeof readEscrowState>[0]> = {}) =>
  readEscrowState({ orderId: "ord_1", signed, storeBlock: { contract: ESCROW, status: typeof found === "object" && found !== null ? found.status : "held" }, readers: readers(found), now: at(60), ...overrides });

describe("each escrow state in a sentence with its own amounts and dates (T161 review)", () => {
  it("says the amount, and the dates the person can act on", () => {
    expect(escrowMeaning(purchase(), WINDOWS, at(60))).toBe("The payment of 0.5157895 USDC is held in the store's escrow. It goes to the store only after the order ships and the release window closes; a claim can be opened until then.");
    const shipped = purchase({ status: "shipped", shippedAt: HELD_AT + 100 });
    expect(escrowMeaning(shipped, WINDOWS, at(200))).toContain("stays held until 2026-09-21T14:25:00.000Z");
    expect(escrowMeaning(shipped, WINDOWS, at(800))).toContain("the release window closed on 2026-09-21T14:25:00.000Z with no claim");
    expect(escrowMeaning(purchase({ status: "released" }), WINDOWS, at(60))).toBe("The release window closed with no claim: the escrow paid the store 0.5157895 USDC.");
    expect(escrowMeaning(purchase({ status: "responded", openedAt: HELD_AT }), WINDOWS, at(60))).toContain("decides before 2026-09-21T15:28:20.000Z");
  });

  it("tells a store that did not answer in time from one that still can", () => {
    const disputed = purchase({ status: "disputed", openedAt: HELD_AT });
    expect(escrowMeaning(disputed, WINDOWS, at(900))).toContain("the store has until 2026-09-21T14:28:20.000Z to answer");
    expect(escrowMeaning(disputed, WINDOWS, at(901))).toBe(
      "A claim is open and the store did not answer by 2026-09-21T14:28:20.000Z: the payment stays held, and the arbiter decides before 2026-09-21T15:28:20.000Z.",
    );
  });

  it("says who got what when the arbiter decided: nothing, all, or part", () => {
    expect(escrowMeaning(purchase({ status: "resolved" }), WINDOWS, at(60))).toBe("The arbiter decided for the store: nothing was refunded, and the escrow paid the store 0.5157895 USDC.");
    expect(escrowMeaning(purchase({ status: "resolved", refundAtomic: 5_157_895n }), WINDOWS, at(60))).toBe("The arbiter decided for the payer: the full 0.5157895 USDC went back to the payer from the held payment.");
    expect(escrowMeaning(purchase({ status: "resolved", refundAtomic: 1_000_000n }), WINDOWS, at(60))).toBe("The arbiter decided: 0.1000000 USDC went back to the payer from the held payment, and 0.4157895 USDC to the store.");
  });

  it("says when part of a refund still waits in the escrow (X-19)", () => {
    expect(escrowMeaning(purchase({ status: "expired", refundAtomic: 5_157_895n, refundOwedAtomic: 5_157_895n }), WINDOWS, at(60))).toBe(
      "The arbiter did not decide in time: the escrow refunded the payer the full 0.5157895 USDC. 0.5157895 USDC of the refund could not be delivered yet and waits in the escrow until claim_refund delivers it.",
    );
  });
});

describe("readEscrowState: the escrow the signed receipt names, read on chain (T161 review)", () => {
  it("shows the chain's state, with its dates", async () => {
    const view = await read(purchase({ status: "disputed", openedAt: HELD_AT, claimHash: "c".repeat(64) }));
    expect(view).toMatchObject({
      escrow: { contract: ESCROW, status: "disputed", amount_usdc: "0.5157895", respond_by: "2026-09-21T14:28:20.000Z", resolve_by: "2026-09-21T15:28:20.000Z", release_after: null },
      escrow_notice: null,
    });
  });

  it("never trusts the store's block: a different status is the chain's, and said", async () => {
    const view = await read(purchase({ status: "disputed", openedAt: HELD_AT }), { storeBlock: { contract: ESCROW, status: "released" } });
    expect(view.escrow?.status).toBe("disputed");
    expect(view.escrow_notice).toContain("different escrow state");
  });

  it("ignores a malformed store block instead of failing", async () => {
    const view = await read(purchase(), { storeBlock: { contract: 7, status: "paid" } });
    expect(view.escrow?.status).toBe("held");
    expect(view.escrow_notice).toContain("different escrow state");
  });

  it("shows no escrow for a receipt that names none, whatever the store's block says", async () => {
    expect(await read(purchase(), { signed: { receiptHash: RECEIPT, contract: undefined }, storeBlock: undefined })).toEqual({ escrow: null, escrow_notice: null });
    expect((await read(purchase(), { signed: { receiptHash: RECEIPT, contract: undefined } })).escrow_notice).toContain("names none");
    expect((await read(purchase(), { signed: null })).escrow).toBeNull();
  });

  it("refuses a purchase held under another receipt", async () => {
    const view = await read(purchase({ receiptHash: "0".repeat(64) }));
    expect(view.escrow).toBeNull();
    expect(view.escrow_notice).toContain("different receipt");
  });

  it("says when the purchase is not recorded yet, the read fails, or hangs", async () => {
    expect((await read(null)).escrow_notice).toContain("has not recorded the purchase");
    expect((await read(() => Promise.reject(new Error("503")))).escrow_notice).toContain("Could not read");
    expect((await read(() => new Promise<never>(() => {}), { timeoutMs: 20 })).escrow_notice).toContain("Could not read");
    expect((await read(purchase(), { readers: undefined })).escrow_notice).toContain("could not be read");
  });

  it("does not throw on dates out of range", async () => {
    const view = await read(purchase({ status: "shipped", shippedAt: 9e15 }));
    expect(view.escrow).toBeNull();
    expect(view.escrow_notice).toContain("dates");
  });
});
