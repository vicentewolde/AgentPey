import { Account, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import type { EscrowPurchase, EscrowReader, EscrowReaderFactory } from "@vitrinee/anchor";
import { isVitrineeError } from "@vitrinee/core";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { registerConfirmations } from "./confirmations.js";
import type { StoreEscrow } from "./config.js";
import { OrderStore, type OrderRecord } from "./orders.js";
import { listen } from "./test/listen.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const ESCROW = "CDSCZJEM6QR6ZZKGRTLAX36GVN6UVFRISDDW7MGMGCWKZO5JVF6E3UML";
const RAIL = "CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L";
const ORDER = "ord_confirm01";
const principal = Keypair.random();
const agentKey = Keypair.random();
const classicPayer = Keypair.random();
const STORE_ESCROW: StoreEscrow = { contract: ESCROW, payee: Keypair.random().publicKey(), arbiter: "GARBITER", releaseWindowSeconds: 600, responseWindowSeconds: 900, resolveWindowSeconds: 3600 };

const record = { orderId: ORDER, status: "paid", createdAt: "2026-11-12T10:00:00.000Z", receipt: { jws: "r.jws", hash: "7".repeat(64) }, hold: { status: "held", attempts: 1, escrow: ESCROW } } as OrderRecord;

const purchase = (payer: string, status: EscrowPurchase["status"] = "held"): EscrowPurchase => ({
  orderRef: ORDER, payer, amountAtomic: 500_000n, txHash: "e".repeat(64), receiptHash: "7".repeat(64), status,
  heldAt: 1, shippedAt: null, claimHash: null, openedAt: null, responseHash: null, verdictHash: null, refundAtomic: 0n, refundOwedAtomic: 0n, closedAt: null,
});

/** `fn(order)` on the escrow with `source`, as a wallet would hand it back. */
const callXdr = (orderRef: string, source: string, fn = "confirm", contract = ESCROW, fee: string = BASE_FEE): string =>
  new TransactionBuilder(new Account(source, "1"), { fee, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contract).call(fn, nativeToScVal(Buffer.from(orderRef, "utf8"), { type: "bytes" })))
    .setTimeout(300)
    .build()
    .toXDR();

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(payer: string, status: EscrowPurchase["status"] = "held") {
  let held = purchase(payer, status);
  const sent: string[] = [];
  const readers: EscrowReaderFactory = (contractId) => ({ contractId, get: async () => held, config: async () => { throw new Error("unused"); }, byTx: async () => null }) as EscrowReader;
  const app = express();
  app.use(express.json());
  registerConfirmations(app, {
    orders: new OrderStore(undefined, [record]),
    escrow: STORE_ESCROW,
    readers,
    writer: {
      prepareConfirm: async (input, signer) => callXdr(input.orderRef, signer),
      submitSigned: async (_name, signedXdr) => {
        sent.push(signedXdr);
        held = { ...held, status: "released" };
        return { txHash: "a".repeat(64), ledger: 1 };
      },
    },
    principalOf: async () => principal.publicKey(),
    networkPassphrase: PASSPHRASE,
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isVitrineeError(error)) res.status(error.httpStatus).json(error.toJSON());
    else res.status(500).json({ error: String(error) });
  });
  const server = await listen(app);
  servers.push(server);
  const post = (path: string, body: unknown) => fetch(`${server.url}/orders/${ORDER}/confirm/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { server, post, sent };
}

describe("the buyer's confirmation (T185, Y-1)", () => {
  it("names the rail's principal as the one who signs, never the agent key", async () => {
    const { server } = await start(RAIL);
    const body = (await (await fetch(`${server.url}/orders/${ORDER}/confirm`)).json()) as { signer: string; can_confirm: boolean };
    expect(body.signer).toBe(principal.publicKey());
    expect(body.signer).not.toBe(agentKey.publicKey());
    expect(body.can_confirm).toBe(true);
  });

  it("names a classic payer itself", async () => {
    const { server } = await start(classicPayer.publicKey());
    expect(((await (await fetch(`${server.url}/orders/${ORDER}/confirm`)).json()) as { signer: string }).signer).toBe(classicPayer.publicKey());
  });

  it("prepares the call only for that account", async () => {
    const { post } = await start(RAIL);
    expect((await post("prepare", { account: agentKey.publicKey() })).status).toBe(409);
    const ok = await post("prepare", { account: principal.publicKey() });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { xdr: string }).xdr.length).toBeGreaterThan(10);
  });

  it("sends exactly confirm for this order from that account, and refuses anything else", async () => {
    const { post, sent } = await start(RAIL);
    for (const xdr of [
      callXdr(ORDER, agentKey.publicKey()),
      callXdr("ord_other", principal.publicKey()),
      callXdr(ORDER, principal.publicKey(), "release"),
      callXdr(ORDER, principal.publicKey(), "confirm", RAIL),
      callXdr(ORDER, principal.publicKey(), "confirm", ESCROW, "999999999"),
    ]) {
      expect((await post("submit", { signed_xdr: xdr })).status).toBe(409);
    }
    expect(sent).toHaveLength(0);
    const ok = await post("submit", { signed_xdr: callXdr(ORDER, principal.publicKey()) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("released");
    expect(sent).toHaveLength(1);
  });

  it("does not confirm a purchase that is disputed or already closed", async () => {
    for (const status of ["disputed", "resolved", "expired"] as const) {
      const { post, sent } = await start(RAIL, status);
      expect((await post("prepare", { account: principal.publicKey() })).status).toBe(409);
      expect((await post("submit", { signed_xdr: callXdr(ORDER, principal.publicKey()) })).status).toBe(409);
      expect(sent).toHaveLength(0);
    }
  });
});
