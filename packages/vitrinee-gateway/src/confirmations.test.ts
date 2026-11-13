import { fileURLToPath } from "node:url";

import { Account, Address, Asset, BASE_FEE, Contract, Keypair, Operation, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { EscrowPurchase, EscrowReader, EscrowReaderFactory } from "@vitrinee/anchor";
import { isVitrineeError } from "@vitrinee/core";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { registerConfirmations } from "./confirmations.js";
import type { StoreEscrow } from "./config.js";
import { OrderStore, type OrderRecord } from "./orders.js";
import { listen } from "./test/listen.js";

interface ConfirmPage {
  checkConfirmXdr(xdr: string, expected: { escrow: string; orderId: string; source: string }): string | null;
  MAX_CONFIRM_FEE_STROOPS: number;
}
const page = (await import(fileURLToPath(new URL("../../../apps/web/public/resolve/confirmar.js", import.meta.url)))) as ConfirmPage;

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

/** Two calls in one transaction, as a store that tries to slip a second operation past the buyer would build it. */
const twoCalls = (source: string): string =>
  new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(ESCROW).call("confirm", nativeToScVal(Buffer.from(ORDER, "utf8"), { type: "bytes" })))
    .addOperation(Operation.payment({ destination: STORE_ESCROW.payee, asset: Asset.native(), amount: "100" }))
    .setTimeout(300)
    .build()
    .toXDR();

/** `confirm` with one auth entry of the given kind, as a simulated transaction carries it. */
function withAuth(source: string, credentials: xdr.SorobanCredentials): string {
  const args = () => new xdr.InvokeContractArgs({ contractAddress: new Contract(ESCROW).address().toScAddress(), functionName: "confirm", args: [nativeToScVal(Buffer.from(ORDER, "utf8"), { type: "bytes" })] });
  const invocation = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args()), subInvocations: [] });
  const op = Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(args()), auth: [new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation })] });
  return new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).addOperation(op).setTimeout(300).build().toXDR();
}

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
        held = { ...held, status: "released", confirmedAt: 2 };
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
      twoCalls(principal.publicKey()),
      TransactionBuilder.buildFeeBumpTransaction(agentKey, "20000", TransactionBuilder.fromXDR(callXdr(ORDER, principal.publicKey()), PASSPHRASE) as never, PASSPHRASE).toXDR(),
    ]) {
      expect((await post("submit", { signed_xdr: xdr })).status).toBe(409);
    }
    expect(sent).toHaveLength(0);
    const ok = await post("submit", { signed_xdr: callXdr(ORDER, principal.publicKey()) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("released");
    expect(sent).toHaveLength(1);
    // Sent again once the escrow says the buyer confirmed it: nothing goes out, and no transaction is claimed as the one.
    const again = await post("submit", { signed_xdr: callXdr(ORDER, principal.publicKey()) });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "released", transaction: null });
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

describe("the confirmation page reads the transaction before the wallet sees it (T185 review)", () => {
  const expected = { escrow: ESCROW, orderId: ORDER, source: principal.publicKey() };

  it("passes exactly confirm(order) on the escrow, from the account that signs, with or without its source-account auth", () => {
    expect(page.checkConfirmXdr(callXdr(ORDER, principal.publicKey()), expected)).toBeNull();
    expect(page.checkConfirmXdr(withAuth(principal.publicKey(), xdr.SorobanCredentials.sorobanCredentialsSourceAccount()), expected)).toBeNull();
  });

  it("refuses anything else the store could hand the wallet", () => {
    const addressAuth = xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(agentKey.publicKey()).toScAddress(), nonce: xdr.Int64.fromString("1"), signatureExpirationLedger: 1, signature: xdr.ScVal.scvVoid() }),
    );
    const cases: Record<string, string> = {
      "another source": callXdr(ORDER, agentKey.publicKey()),
      "another order": callXdr("ord_other", principal.publicKey()),
      "another function": callXdr(ORDER, principal.publicKey(), "release"),
      "another contract": callXdr(ORDER, principal.publicKey(), "confirm", RAIL),
      "a high fee": callXdr(ORDER, principal.publicKey(), "confirm", ESCROW, String(page.MAX_CONFIRM_FEE_STROOPS + 1)),
      "two operations": twoCalls(principal.publicKey()),
      "a fee bump": TransactionBuilder.buildFeeBumpTransaction(agentKey, "20000", TransactionBuilder.fromXDR(callXdr(ORDER, principal.publicKey()), PASSPHRASE) as never, PASSPHRASE).toXDR(),
      "an address credential": withAuth(principal.publicKey(), addressAuth),
      "garbage": "AAAA",
    };
    const reasons = Object.fromEntries(Object.entries(cases).map(([what, tx]) => [what, page.checkConfirmXdr(tx, expected)]));
    expect(reasons).toEqual({
      "another source": "another source account",
      "another order": "another order",
      "another function": "not confirm",
      "another contract": "another contract",
      "a high fee": "fee too high",
      "two operations": "not exactly one operation",
      "a fee bump": "not a plain transaction",
      "an address credential": "an authorization other than the source account",
      garbage: "unreadable transaction",
    });
  });
});
