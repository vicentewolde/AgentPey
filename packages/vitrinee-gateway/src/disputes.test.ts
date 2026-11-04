import { createHash } from "node:crypto";

import { Account, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { EscrowPurchase, EscrowReader, EscrowReaderFactory } from "@vitrinee/anchor";
import { isVitrineeError } from "@vitrinee/core";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import type { StoreEscrow } from "./config.js";
import { disputeResponseHash, registerDisputes, type DisputeDeps } from "./disputes.js";
import { OrderStore, type OrderRecord } from "./orders.js";
import { listen } from "./test/listen.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
const payee = Keypair.random();
const ORDER = "ord_mv9s83yb0022b6a353";
const RECEIPT = "7".repeat(64);
const CLAIM_JWS = "eyJhbGciOiJFZERTQSJ9.eyJ0eXBlIjoiQWdlbnRSZXNvbHZlQ2xhaW0ifQ.c2ln";
const CLAIM = createHash("sha256").update(CLAIM_JWS, "utf8").digest("hex");
const OPENED_AT = 1_793_000_000; // 2026-10-26T…Z
const STORE_ESCROW: StoreEscrow = { contract: ESCROW, payee: payee.publicKey(), arbiter: "GARBITER", releaseWindowSeconds: 600, responseWindowSeconds: 900, resolveWindowSeconds: 3600 };

const record = (overrides: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    orderId: ORDER,
    status: "paid",
    createdAt: "2026-10-15T16:57:00.000Z",
    receipt: { jws: "receipt.jws", hash: RECEIPT },
    hold: { status: "held", attempts: 1, escrow: ESCROW },
    ...overrides,
  }) as OrderRecord;

const disputed = (overrides: Partial<EscrowPurchase> = {}): EscrowPurchase => ({
  orderRef: ORDER,
  payer: "CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L",
  amountAtomic: 5_157_895n,
  txHash: "e".repeat(64),
  receiptHash: RECEIPT,
  status: "disputed",
  heldAt: OPENED_AT - 100,
  shippedAt: null,
  claimHash: CLAIM,
  openedAt: OPENED_AT,
  responseHash: null,
  verdictHash: null,
  refundAtomic: 0n,
  refundOwedAtomic: 0n,
  closedAt: null,
  ...overrides,
});

const response = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "AgentResolveResponse",
  responseId: "6f1b3d0e-5a2c-4c55-9f4e-2a7f3c1d9b10",
  respondent: `did:stellar:testnet:${payee.publicKey()}`,
  receiptHash: RECEIPT,
  claimHash: CLAIM,
  claimId: "0b9b2f3a-7c4d-4e1f-8a6b-5d3c2e1f0a9b",
  position: "contest",
  acceptedAtomic: null,
  statement: "Shipped on time; tracking attached.",
  evidence: [],
  createdAt: "2026-10-26T12:05:00.000Z",
  ...overrides,
});

/** `respond(order, hash)` on `contract`, as the store's writer would prepare it, with `source` as its source. */
function respondXdr(orderRef: string, hash: string, source: string = payee.publicKey(), contract: string = ESCROW, fn = "respond"): string {
  return new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contract).call(fn, nativeToScVal(Buffer.from(orderRef, "utf8"), { type: "bytes" }), xdr.ScVal.scvBytes(Buffer.from(hash, "hex"))))
    .setTimeout(300)
    .build()
    .toXDR();
}

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(options: { purchase?: EscrowPurchase | null; order?: OrderRecord; now?: Date } = {}) {
  let purchase = options.purchase === undefined ? disputed() : options.purchase;
  const orders = new OrderStore(undefined, [options.order ?? record()]);
  const readers: EscrowReaderFactory = (contractId) => ({ contractId, get: async () => purchase, config: async () => { throw new Error("unused"); }, byTx: async () => null }) as EscrowReader;
  const submitted: string[] = [];
  const writer: DisputeDeps["writer"] = {
    prepareRespond: async (input, source) => respondXdr(input.orderRef, input.responseHash, source),
    submitSigned: async (_name, signedXdr) => {
      submitted.push(signedXdr);
      const tx = TransactionBuilder.fromXDR(signedXdr, PASSPHRASE);
      // The network checks the payout account signed: so does this fake.
      // Ed25519 is deterministic: the payout account's own signature over this hash is the one that must be there.
      const expected = payee.signDecorated(tx.hash()).toXDR("base64");
      if (!tx.signatures.some((sig) => sig.toXDR("base64") === expected)) throw new Error("tx_bad_auth");
      const call = (tx as unknown as { operations: Array<{ func: { invokeContract: { args: xdr.ScVal[] } } }> }).operations[0]!.func.invokeContract;
      purchase = { ...purchase!, status: "responded", responseHash: Buffer.from(scValToNative(call.args[1]!) as Uint8Array).toString("hex") };
      return { txHash: "a".repeat(64), ledger: 10 };
    },
  };
  const app = express();
  app.use(express.json());
  registerDisputes(app, { orders, escrow: STORE_ESCROW, readers, writer, networkPassphrase: PASSPHRASE, now: () => options.now ?? new Date((OPENED_AT + 60) * 1000) });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isVitrineeError(error)) res.status(error.httpStatus).json(error.toJSON());
    else res.status(500).json({ error: String(error) });
  });
  const server = await listen(app);
  servers.push(server);
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as Record<string, any> };
  };
  return { call, orders, submitted, purchase: () => purchase };
}

/** The wallet's part: sign the prepared transaction with the payout account. */
function sign(unsignedXdr: string, key: Keypair = payee): string {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, PASSPHRASE);
  tx.sign(key);
  return tx.toXDR();
}

describe("a dispute's claim, kept with the order (T163)", () => {
  it("keeps the claim whose hash the escrow holds, and serves it", async () => {
    const store = await start();
    expect((await store.call(`/orders/${ORDER}/dispute`)).json).toMatchObject({ order_id: ORDER, escrow: ESCROW, claim_jws: null, response: null });
    const kept = await store.call(`/orders/${ORDER}/dispute/claim`, { claim_jws: CLAIM_JWS });
    expect(kept.status).toBe(200);
    expect(kept.json["claim_jws"]).toBe(CLAIM_JWS);
    expect(store.orders.get(ORDER)?.dispute?.claimJws).toBe(CLAIM_JWS);
  });

  it("refuses a claim the escrow does not hold, and an order with no claim", async () => {
    const store = await start();
    const forged = await store.call(`/orders/${ORDER}/dispute/claim`, { claim_jws: `${CLAIM_JWS}x` });
    expect(forged).toMatchObject({ status: 409, json: { error: "DisputeRefused" } });
    expect(store.orders.get(ORDER)?.dispute).toBeUndefined();
    const held = await start({ purchase: disputed({ status: "held", claimHash: null, openedAt: null }) });
    expect((await held.call(`/orders/${ORDER}/dispute/claim`, { claim_jws: CLAIM_JWS })).status).toBe(409);
  });

  it("knows only orders paid into this store's escrow", async () => {
    const store = await start({ order: record({ hold: { status: "held", attempts: 1, escrow: "COTHERESCROW" } }) });
    expect((await store.call(`/orders/${ORDER}/dispute`)).json).toMatchObject({ error: "OrderNotFound" });
  });

  it("opens to AgentPey's responder page only", async () => {
    const store = await start();
    const page = await store.call(`/orders/${ORDER}/dispute`, undefined, { origin: "https://agentpey.com" });
    expect(page.headers.get("access-control-allow-origin")).toBe("https://agentpey.com");
    const other = await store.call(`/orders/${ORDER}/dispute`, undefined, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the merchant answers with its wallet (T163)", () => {
  it("prepares respond for the payout account, sends it once signed, and keeps the document", async () => {
    const store = await start();
    const doc = response();
    const prepared = await store.call(`/orders/${ORDER}/dispute/response/prepare`, { response: doc });
    expect(prepared.status).toBe(200);
    expect(prepared.json).toMatchObject({ response_hash: disputeResponseHash(doc), payee: payee.publicKey(), respond_by: "2026-10-26T07:48:20.000Z" });
    const sent = await store.call(`/orders/${ORDER}/dispute/response/submit`, { response: doc, signed_xdr: sign(prepared.json["xdr"]) });
    expect(sent.status).toBe(200);
    expect(sent.json["response"]).toMatchObject({ document: doc, hash: disputeResponseHash(doc), transaction: "a".repeat(64), explorer_url: expect.stringContaining("a".repeat(64)) });
    expect(store.purchase()?.responseHash).toBe(disputeResponseHash(doc));
    // Answered once: a second answer is refused before anything is sent.
    const again = await store.call(`/orders/${ORDER}/dispute/response/prepare`, { response: response({ statement: "Changed my mind" }) });
    expect(again).toMatchObject({ status: 409, json: { message: "the store already answered this dispute" } });
  });

  it.each([
    ["another respondent", response({ respondent: `did:stellar:testnet:${Keypair.random().publicKey()}` }), "only the store's payout account"],
    ["another receipt", response({ receiptHash: "8".repeat(64) }), "another receipt"],
    ["another claim", response({ claimHash: "9".repeat(64) }), "another claim"],
    ["not a response", { type: "Something" }, "expected shape"],
  ])("refuses a response from %s before preparing anything", async (_name, doc, message) => {
    const store = await start();
    const prepared = await store.call(`/orders/${ORDER}/dispute/response/prepare`, { response: doc });
    expect(prepared.status).toBeGreaterThanOrEqual(400);
    expect(prepared.json["message"]).toContain(message);
  });

  it("refuses an answer after the escrow's response window, as the contract does", async () => {
    const onTime = await start({ now: new Date((OPENED_AT + 900) * 1000) });
    expect((await onTime.call(`/orders/${ORDER}/dispute/response/prepare`, { response: response() })).status).toBe(200);
    const late = await start({ now: new Date((OPENED_AT + 901) * 1000) });
    const refused = await late.call(`/orders/${ORDER}/dispute/response/prepare`, { response: response() });
    expect(refused).toMatchObject({ status: 409, json: { message: expect.stringContaining("the time to answer ended on") } });
  });

  it("refuses an order with no open dispute", async () => {
    const store = await start({ purchase: disputed({ status: "held", claimHash: null, openedAt: null }) });
    expect((await store.call(`/orders/${ORDER}/dispute/response/prepare`, { response: response() })).json["message"]).toContain("no open dispute");
  });

  it.each([
    ["for another document", () => respondXdr(ORDER, "b".repeat(64))],
    ["for another order", () => respondXdr("ord_other", disputeResponseHash(response()))],
    ["on another contract", () => respondXdr(ORDER, disputeResponseHash(response()), payee.publicKey(), "CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U")],
    ["calling another function", () => respondXdr(ORDER, disputeResponseHash(response()), payee.publicKey(), ESCROW, "release")],
    ["from another account", () => respondXdr(ORDER, disputeResponseHash(response()), Keypair.random().publicKey())],
    ["that is not a transaction", () => "AAAA"],
  ])("never sends a signed transaction %s", async (_name, build) => {
    const store = await start();
    const unsigned = build();
    const signedXdr = unsigned === "AAAA" ? unsigned : sign(unsigned);
    const sent = await store.call(`/orders/${ORDER}/dispute/response/submit`, { response: response(), signed_xdr: signedXdr });
    expect(sent).toMatchObject({ status: 409, json: { error: "DisputeRefused" } });
    expect(store.submitted).toEqual([]);
  });
});
