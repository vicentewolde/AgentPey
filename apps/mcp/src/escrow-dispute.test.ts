import { hasErrorCode } from "@agentpass/core";
import { escrowOpenMessage } from "@agentpey/resolve";
import { VitrineeError } from "@vitrinee/core";
import { PURCHASE_ESCROW_WASM_HASHES, type EscrowConfig, type EscrowDisputeOpenerFactory, type EscrowPurchase, type EscrowReader, type EscrowReaderFactory, type OpenInput } from "@vitrinee/anchor";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { checkClaimableEscrow, openEscrowDispute } from "./escrow-dispute.js";

const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
const RAIL = "CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L";
const RECEIPT = "7".repeat(64);
const TX = "e".repeat(64);
const CLAIM = "c".repeat(64);
const HELD_AT = 1_790_000_000; // 2026-09-21T14:13:20Z
const CONFIG: EscrowConfig = {
  operator: "GOPERATOR",
  payee: "GPAYEE",
  arbiter: "GARBITER",
  token: "CTOKEN",
  releaseWindowSeconds: 600,
  responseWindowSeconds: 900,
  resolveWindowSeconds: 3600,
  wasmHash: PURCHASE_ESCROW_WASM_HASHES[0] ?? null,
};
const owner = Keypair.random();

const purchase = (overrides: Partial<EscrowPurchase> = {}): EscrowPurchase => ({
  orderRef: "ord_1",
  payer: RAIL,
  amountAtomic: 5_157_895n,
  txHash: TX,
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

/**
 * One escrow in memory that answers `open` the way the contract does: the purchase must be open to a claim, and a
 * rail payer's signature must verify against its owner over `open_message`, or the host aborts (`Error(Crypto, …)`).
 */
function escrow(start: EscrowPurchase | null, config: EscrowConfig = CONFIG, railOwner: Keypair = owner) {
  let current = start;
  const sent: OpenInput[] = [];
  const readers: EscrowReaderFactory = (contractId) => ({ contractId, config: async () => config, get: async () => current, byTx: async () => null }) as EscrowReader;
  const openers: EscrowDisputeOpenerFactory = (contractId) => ({
    async open(input, _sourceSecret) {
      sent.push(input);
      if (current === null) throw new Error("HostError: Error(Contract, #7)");
      if (current.status !== "held" && current.status !== "shipped") throw new Error("HostError: Error(Contract, #8)");
      if (current.payer.startsWith("C")) {
        if (input.sig === null) throw new Error("HostError: Error(Contract, #11)");
        if (!railOwner.verify(Buffer.from(escrowOpenMessage(contractId, input.orderRef, input.claimHash)), Buffer.from(input.sig))) throw new Error("HostError: Error(Crypto, InvalidInput)");
      }
      current = { ...current, status: "disputed", claimHash: input.claimHash, openedAt: HELD_AT + 120 };
      return { txHash: "a".repeat(64), ledger: 77 };
    },
  });
  return { readers, openers, sent, current: () => current };
}

const check = (e: ReturnType<typeof escrow>, overrides: Partial<Parameters<typeof checkClaimableEscrow>[0]> = {}) =>
  checkClaimableEscrow({
    contract: ESCROW,
    orderId: "ord_1",
    receipt: { hash: RECEIPT, txHash: TX, amountAtomic: 5_157_895n },
    payer: RAIL,
    arbiters: ["GARBITER"],
    readers: e.readers,
    openers: e.openers,
    now: at(60),
    ...overrides,
  });

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  for (const code of ["ConfigError", "NetworkError", "EscrowUnverified", "ResolveReceiptInvalid", "ResolveClaimantNotPayer", "ResolveDisputeExists", "ResolveClaimWindowClosed"] as const) {
    if (hasErrorCode(error, code)) return code;
  }
  return `untyped: ${String(error)}`;
}

describe("a claim from the chat opens the dispute in the escrow (T162)", () => {
  it("signs the escrow's message with the rail owner's key, sends open, and says until when the store may answer", async () => {
    const e = escrow(purchase());
    const opened = await openEscrowDispute({ target: await check(e), claimHash: CLAIM, agentKey: owner });
    expect(opened).toEqual({
      escrow: ESCROW,
      status: "disputed",
      transaction: "a".repeat(64),
      explorer_url: `https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`,
      respond_by: "2026-09-21T14:30:20.000Z",
      resolve_by: "2026-09-21T15:30:20.000Z",
    });
    expect(e.sent).toHaveLength(1);
    expect(e.current()).toMatchObject({ status: "disputed", claimHash: CLAIM });
  });

  it("is refused by the escrow when another key signed the claim, and says the dispute was not opened", async () => {
    const e = escrow(purchase(), CONFIG, Keypair.random());
    const target = await check(e);
    const error = await openEscrowDispute({ target, claimHash: CLAIM, agentKey: owner }).catch((caught: unknown) => caught);
    expect(hasErrorCode(error, "ResolveClaimantNotPayer")).toBe(true);
    expect((error as Error).message).toContain("The dispute was not opened");
    expect(e.current()?.status).toBe("held");
  });

  it("sends no signature for a classic payer, whose transaction is the consent (X-16)", async () => {
    const e = escrow(purchase({ payer: owner.publicKey() }));
    await openEscrowDispute({ target: await check(e, { payer: owner.publicKey() }), claimHash: CLAIM, agentKey: owner });
    expect(e.sent[0]?.sig).toBeNull();
  });

  it("opens a shipped purchase before its release window closes", async () => {
    const e = escrow(purchase({ status: "shipped", shippedAt: HELD_AT }));
    await expect(check(e, { now: at(599) })).resolves.toMatchObject({ contract: ESCROW });
  });

  it("still reports the dispute open when the read after it fails, without dates", async () => {
    const e = escrow(purchase());
    const target = await check(e);
    const opened = await openEscrowDispute({ target: { ...target, readers: () => ({ get: () => Promise.reject(new Error("rpc down")) }) as unknown as EscrowReader }, claimHash: CLAIM, agentKey: owner });
    expect(opened).toMatchObject({ status: "disputed", respond_by: null, resolve_by: null });
  });

  it("tells a send that certainly did not take effect from one that may still land", async () => {
    const e = escrow(purchase());
    const target = await check(e);
    const failing = (stage: string): EscrowDisputeOpenerFactory => () => ({ open: () => Promise.reject(new VitrineeError("EscrowError", "open failed", { details: { stage } })) });
    for (const stage of ["prepare", "simulate", "rejected", "failed"]) {
      const error = await openEscrowDispute({ target: { ...target, openers: failing(stage) }, claimHash: CLAIM, agentKey: owner }).catch((caught: unknown) => caught);
      expect((error as Error).message, stage).toContain("nothing changed");
      expect((error as { details: Record<string, unknown> }).details["uncertain"], stage).toBeUndefined();
    }
    const unconfirmed = await openEscrowDispute({ target: { ...target, openers: failing("unconfirmed") }, claimHash: CLAIM, agentKey: owner }).catch((caught: unknown) => caught);
    expect((unconfirmed as Error).message).toContain("read the order with get_order");
    expect((unconfirmed as { details: Record<string, unknown> }).details["uncertain"]).toBe(true);
  });

  it.each([
    ["the contract's own window closed meanwhile", "HostError: Error(Contract, #10)", "ResolveClaimWindowClosed"],
    ["the purchase changed meanwhile", "HostError: Error(Contract, #8)", "ResolveDisputeExists"],
    ["a submission that may still land", "open transaction NOT_FOUND", "NetworkError"],
  ])("maps a refusal from the network when %s", async (_name, message, code) => {
    const e = escrow(purchase());
    const target = await check(e);
    const failing: EscrowDisputeOpenerFactory = () => ({ open: () => Promise.reject(new Error(message)) });
    expect(await codeOf(openEscrowDispute({ target: { ...target, openers: failing }, claimHash: CLAIM, agentKey: owner }))).toBe(code);
  });
});

describe("nothing is sent when the escrow does not hold this purchase, open to a claim (T162)", () => {
  it.each([
    ["the store recorded no purchase", null, {}, "ResolveReceiptInvalid"],
    ["the purchase for another order", purchase({ orderRef: "ord_2" }), {}, "ResolveReceiptInvalid"],
    ["another receipt", purchase({ receiptHash: "8".repeat(64) }), {}, "ResolveReceiptInvalid"],
    ["another payment", purchase({ txHash: "f".repeat(64) }), {}, "ResolveReceiptInvalid"],
    ["another amount", purchase({ amountAtomic: 1n }), {}, "ResolveReceiptInvalid"],
    ["another payer than this agent's rail", purchase({ payer: "CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U" }), {}, "ResolveClaimantNotPayer"],
    ["a dispute already open", purchase({ status: "disputed", openedAt: HELD_AT + 10 }), {}, "ResolveDisputeExists"],
    ["a dispute already resolved", purchase({ status: "resolved" }), {}, "ResolveDisputeExists"],
    ["the payment already released", purchase({ status: "released" }), {}, "ResolveClaimWindowClosed"],
    ["a shipped purchase past its release window", purchase({ status: "shipped", shippedAt: HELD_AT }), { now: at(600) }, "ResolveClaimWindowClosed"],
  ])("refuses when %s", async (_name, found, overrides, code) => {
    const e = escrow(found);
    expect(await codeOf(check(e, overrides))).toBe(code);
    expect(e.sent).toEqual([]);
  });

  it("refuses an escrow whose arbiter the agent does not accept", async () => {
    const e = escrow(purchase(), { ...CONFIG, arbiter: "GSTORESOWNARBITER" });
    expect(await codeOf(check(e))).toBe("EscrowUnverified");
    expect(await codeOf(check(escrow(purchase()), { arbiters: undefined }))).toBe("ConfigError");
  });

  it("refuses an escrow that does not run the known purchase-escrow code", async () => {
    for (const wasmHash of ["0".repeat(64), null]) {
      const e = escrow(purchase(), { ...CONFIG, wasmHash });
      expect(await codeOf(check(e))).toBe("EscrowUnverified");
    }
  });

  it("refuses without a way to read or open escrows, or when the escrow cannot be read", async () => {
    const e = escrow(purchase());
    expect(await codeOf(check(e, { openers: undefined }))).toBe("ConfigError");
    expect(await codeOf(check(e, { readers: undefined }))).toBe("ConfigError");
    const down: EscrowReaderFactory = () => ({ config: () => Promise.reject(new Error("rpc down")), get: async () => null }) as unknown as EscrowReader;
    expect(await codeOf(check(e, { readers: down }))).toBe("NetworkError");
    const silent: EscrowReaderFactory = () => ({ config: () => new Promise(() => undefined), get: async () => null }) as unknown as EscrowReader;
    expect(await codeOf(check(e, { readers: silent, timeoutMs: 20 }))).toBe("NetworkError");
  });
});
