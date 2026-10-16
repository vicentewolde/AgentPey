import { describe, expect, it } from "vitest";

import type { EscrowPurchase } from "../../packages/vitrinee-anchor/src/index.js";
import { assertMayExecute, assertOpenFor, assertResponseMatches, fromAgentResolve, fromEscrow, responseWindowOf, venueOf, verdictMatches } from "./dispute-venue.js";

const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
const AGENT_RESOLVE = "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F";
const RAIL = "CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA";
const RECEIPT = "7".repeat(64);
const CLAIM = "c".repeat(64);
const OPENED = 1_792_000_000;
const WINDOWS = { responseWindowSeconds: 900, resolveWindowSeconds: 3600 };

const purchase = (overrides: Partial<EscrowPurchase> = {}): EscrowPurchase => ({
  orderRef: "ord_mv9qzvka21f025d46d",
  payer: RAIL,
  amountAtomic: 5_157_895n,
  txHash: "e".repeat(64),
  receiptHash: RECEIPT,
  status: "disputed",
  heldAt: OPENED - 600,
  shippedAt: null,
  claimHash: CLAIM,
  openedAt: OPENED,
  responseHash: null,
  verdictHash: null,
  refundAtomic: 0n,
  refundOwedAtomic: 0n,
  closedAt: null,
  ...overrides,
});
const at = (seconds: number) => new Date((OPENED + seconds) * 1000);
const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe("venueOf (T158): a receipt that names an escrow is disputed there, by its order", () => {
  it("routes by the receipt's own escrow field", () => {
    expect(venueOf({ orderId: "ord_1", escrow: { contract: ESCROW } }, RECEIPT, AGENT_RESOLVE)).toEqual({ kind: "escrow", contractId: ESCROW, key: "ord_1" });
    expect(venueOf({ orderId: "ord_1" }, RECEIPT, AGENT_RESOLVE)).toEqual({ kind: "agent-resolve", contractId: AGENT_RESOLVE, key: RECEIPT });
  });
});

describe("one view of either contract's dispute", () => {
  it("reads an escrow purchase: disputed and responded are open, resolved is resolved, held is no dispute yet", () => {
    expect(fromEscrow(purchase()).status).toBe("open");
    expect(fromEscrow(purchase({ status: "responded", responseHash: "d".repeat(64) }))).toMatchObject({ status: "open", responseHash: "d".repeat(64) });
    expect(fromEscrow(purchase({ status: "resolved", verdictHash: "f".repeat(64), refundAtomic: 5_157_895n }))).toMatchObject({ status: "resolved", refund: 5_157_895n });
    expect(fromEscrow(purchase({ status: "held", claimHash: null, openedAt: null })).status).toBe("none");
    expect(fromEscrow(purchase({ status: "released" })).status).toBe("closed");
    expect(fromEscrow(purchase({ status: "expired" })).status).toBe("closed");
  });

  it("reads an agent-resolve dispute as before, with no response on chain", () => {
    expect(fromAgentResolve({ payer: RAIL, claim_hash: CLAIM, amount: 1n, opened_at: OPENED, status: "Open", verdict_hash: null, refund: 0n })).toMatchObject({ status: "open", responseHash: null, openedAt: OPENED });
  });

  it("gives the merchant 48 h in agent-resolve and the escrow's own window in an escrow (X-26)", () => {
    expect(responseWindowOf({ kind: "agent-resolve", contractId: AGENT_RESOLVE, key: RECEIPT }, undefined)).toBe(48 * 3600);
    expect(responseWindowOf({ kind: "escrow", contractId: ESCROW, key: "ord_1" }, WINDOWS)).toBe(900);
    expect(codeOf(() => responseWindowOf({ kind: "escrow", contractId: ESCROW, key: "ord_1" }, undefined))).toBe("ConfigError");
  });
});

describe("the arbiter's gates on an escrow dispute", () => {
  const venue = { kind: "escrow", contractId: ESCROW, key: "ord_mv9qzvka21f025d46d" } as const;

  it("acts only on an open dispute for this exact claim", () => {
    expect(() => assertOpenFor(fromEscrow(purchase()), CLAIM)).not.toThrow();
    expect(codeOf(() => assertOpenFor(fromEscrow(purchase()), "0".repeat(64)))).toBe("ResolveReceiptInvalid");
    expect(codeOf(() => assertOpenFor(fromEscrow(purchase({ status: "held", claimHash: null, openedAt: null })), CLAIM))).toBe("ResolveReceiptInvalid");
    expect(codeOf(() => assertOpenFor(fromEscrow(purchase({ status: "resolved" })), CLAIM))).toBe("ResolveReceiptInvalid");
    expect(codeOf(() => assertOpenFor(null, CLAIM))).toBe("ResolveReceiptInvalid");
  });

  it("hears the response the merchant gave on chain, and only that one", () => {
    const answered = fromEscrow(purchase({ status: "responded", responseHash: "d".repeat(64) }));
    expect(() => assertResponseMatches(answered, "d".repeat(64))).not.toThrow();
    expect(codeOf(() => assertResponseMatches(answered, null))).toBe("ResolveResponseInvalid");
    expect(codeOf(() => assertResponseMatches(answered, "e".repeat(64)))).toBe("ResolveResponseInvalid");
    // Nothing on chain: a response file, or none, as before.
    expect(() => assertResponseMatches(fromEscrow(purchase()), null)).not.toThrow();
  });

  it("executes after the merchant's window and before the arbiter's closes, as the escrow allows", () => {
    const open = fromEscrow(purchase()) as ReturnType<typeof fromEscrow> & { openedAt: number };
    expect(codeOf(() => assertMayExecute(venue, open, WINDOWS, at(899)))).toBe("ResolveResponsePending");
    expect(() => assertMayExecute(venue, open, WINDOWS, at(900))).not.toThrow();
    expect(() => assertMayExecute(venue, open, WINDOWS, at(900 + 3599))).not.toThrow();
    expect(codeOf(() => assertMayExecute(venue, open, WINDOWS, at(900 + 3600)))).toBe("ResolveWindowClosed");
    // With the merchant's answer on chain, the arbiter need not wait for its window.
    const answered = fromEscrow(purchase({ status: "responded", responseHash: "d".repeat(64) })) as typeof open;
    expect(() => assertMayExecute(venue, answered, WINDOWS, at(60))).not.toThrow();
    // agent-resolve has no window at all.
    expect(() => assertMayExecute({ kind: "agent-resolve", contractId: AGENT_RESOLVE, key: RECEIPT }, open, undefined, at(10_000_000))).not.toThrow();
  });

  it("matches a resolved dispute to the archived verdict: hash, refund and claim", () => {
    const resolved = fromEscrow(purchase({ status: "resolved", verdictHash: "f".repeat(64), refundAtomic: 5_157_895n }));
    expect(verdictMatches(resolved, { refundAtomic: "5157895", claimHash: CLAIM }, "f".repeat(64))).toBe(true);
    expect(verdictMatches(resolved, { refundAtomic: "1", claimHash: CLAIM }, "f".repeat(64))).toBe(false);
    expect(verdictMatches(resolved, { refundAtomic: "5157895", claimHash: CLAIM }, "a".repeat(64))).toBe(false);
    expect(verdictMatches(resolved, { refundAtomic: "5157895", claimHash: "0".repeat(64) }, "f".repeat(64))).toBe(false);
  });
});
