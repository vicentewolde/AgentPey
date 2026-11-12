import { createHash } from "node:crypto";

import { evidenceFileHash, fileEvidenceFor, signEvidenceRead } from "@agentpey/resolve/evidence";
import { Keypair } from "@stellar/stellar-sdk";
import type { EscrowPurchase, EscrowReader, EscrowReaderFactory } from "@vitrinee/anchor";
import { isVitrineeError } from "@vitrinee/core";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import type { StoreEscrow } from "./config.js";
import { registerDisputes } from "./disputes.js";
import { MemoryEvidenceStore } from "./evidence-store.js";
import { OrderStore, type OrderRecord } from "./orders.js";
import { listen } from "./test/listen.js";

const ESCROW = "CDSCZJEM6QR6ZZKGRTLAX36GVN6UVFRISDDW7MGMGCWKZO5JVF6E3UML";
const ORDER = "ord_evidence01";
const RECEIPT = "7".repeat(64);
const payee = Keypair.random();
const arbiter = Keypair.random();
const claimant = Keypair.random();
const stranger = Keypair.random();
const NOW = 1_793_000_060;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a wet parcel")]);
const OTHER_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("another parcel")]);
const FILE = fileEvidenceFor(PNG, "caja.png")!;
const CLAIM_JWS = `eyJhbGciOiJFZERTQSJ9.${Buffer.from(
  JSON.stringify({ type: "AgentResolveClaim", claimId: "0b9b2f3a-7c4d-4e1f-8a6b-5d3c2e1f0a9b", claimant: `did:stellar:testnet:${claimant.publicKey()}`, amountAtomic: "500000", evidence: [{ kind: "text", content: "llegó mojada" }, FILE] }),
).toString("base64url")}.c2ln`;
const CLAIM = createHash("sha256").update(CLAIM_JWS, "utf8").digest("hex");
const STORE_ESCROW: StoreEscrow = { contract: ESCROW, payee: payee.publicKey(), arbiter: arbiter.publicKey(), releaseWindowSeconds: 600, responseWindowSeconds: 900, resolveWindowSeconds: 3600 };

const purchase = (claimHash: string | null = CLAIM): EscrowPurchase => ({
  orderRef: ORDER,
  payer: "CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L",
  amountAtomic: 500_000n,
  txHash: "e".repeat(64),
  receiptHash: RECEIPT,
  status: "disputed",
  heldAt: NOW - 200,
  shippedAt: null,
  claimHash,
  openedAt: NOW - 60,
  responseHash: null,
  verdictHash: null,
  refundAtomic: 0n,
  refundOwedAtomic: 0n,
  closedAt: null,
});

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(options: { claimKept?: boolean; claimHash?: string | null } = {}) {
  const order = { orderId: ORDER, status: "paid", createdAt: "2026-11-11T16:57:00.000Z", receipt: { jws: "receipt.jws", hash: RECEIPT }, hold: { status: "held", attempts: 1, escrow: ESCROW }, ...(options.claimKept === false ? {} : { dispute: { claimJws: CLAIM_JWS } }) } as OrderRecord;
  const orders = new OrderStore(undefined, [order]);
  const evidence = new MemoryEvidenceStore();
  const held = purchase(options.claimHash === undefined ? CLAIM : options.claimHash);
  const readers: EscrowReaderFactory = (contractId) => ({ contractId, get: async () => held, config: async () => { throw new Error("unused"); }, byTx: async () => null }) as EscrowReader;
  const app = express();
  app.use(express.json());
  registerDisputes(app, {
    orders,
    escrow: STORE_ESCROW,
    readers,
    writer: { prepareRespond: async () => "", submitSigned: async () => ({ txHash: "", ledger: 0 }) },
    networkPassphrase: "Test SDF Network ; September 2015",
    evidence,
    now: () => new Date(NOW * 1000),
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isVitrineeError(error)) res.status(error.httpStatus).json(error.toJSON());
    else res.status(500).json({ error: String(error) });
  });
  const server = await listen(app);
  servers.push(server);
  const upload = (bytes: Buffer, type = "image/png") => fetch(`${server.url}/orders/${ORDER}/dispute/evidence`, { method: "POST", headers: { "content-type": type }, body: bytes });
  const read = (signer: Keypair, sha256: string = FILE.sha256, expiresAt = NOW + 300) =>
    fetch(`${server.url}/orders/${ORDER}/dispute/evidence/${sha256}?${signEvidenceRead(signer, { escrow: ESCROW, orderId: ORDER, sha256, expiresAt }).toString()}`);
  return { server, orders, evidence, upload, read };
}

describe("a claim's file at the store (T184, Y-3)", () => {
  it("is kept when the sealed claim names it, and the dispute view says so", async () => {
    const { server, upload, evidence } = await start();
    const before = (await (await fetch(`${server.url}/orders/${ORDER}/dispute`)).json()) as { evidence: unknown[] };
    expect(before.evidence).toEqual([{ sha256: FILE.sha256, media_type: "image/png", bytes: PNG.byteLength, name: "caja.png", kept: false }]);
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { evidence: Array<{ kept: boolean }> }).evidence[0]!.kept).toBe(true);
    expect((await evidence.get(ORDER, FILE.sha256))?.bytes.equals(PNG)).toBe(true);
    // Sent again: the same file, nothing changes.
    expect((await upload(PNG)).status).toBe(200);
  });

  it("is refused when the claim names no such file, or the bytes are not the type the claim names", async () => {
    const { upload } = await start();
    expect((await upload(OTHER_PNG)).status).toBe(409);
    expect((await upload(PNG, "application/pdf")).status).toBe(409);
  });

  it("is refused before the claim reaches the store, and when the escrow holds another claim", async () => {
    expect((await (await start({ claimKept: false })).upload(PNG)).status).toBe(409);
    expect((await (await start({ claimHash: "0".repeat(64) })).upload(PNG)).status).toBe(409);
  });

  it("opens for the arbiter, the payout account and the claimant, each on a link they signed", async () => {
    const { upload, read } = await start();
    await upload(PNG);
    for (const party of [arbiter, payee, claimant]) {
      const res = await read(party);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(evidenceFileHash(bytes)).toBe(FILE.sha256);
    }
  });

  it("stays closed to anyone else, without a link, on an expired or too-long link, or a link for another file", async () => {
    const { server, upload, read } = await start();
    await upload(PNG);
    expect((await read(stranger)).status).toBe(401);
    expect((await fetch(`${server.url}/orders/${ORDER}/dispute/evidence/${FILE.sha256}`)).status).toBe(401);
    expect((await read(arbiter, FILE.sha256, NOW - 1)).status).toBe(401);
    expect((await read(arbiter, FILE.sha256, NOW + 3600)).status).toBe(401);
    const forOther = signEvidenceRead(arbiter, { escrow: ESCROW, orderId: ORDER, sha256: evidenceFileHash(OTHER_PNG), expiresAt: NOW + 300 });
    expect((await fetch(`${server.url}/orders/${ORDER}/dispute/evidence/${FILE.sha256}?${forOther.toString()}`)).status).toBe(401);
  });

  it("answers 404 for a file the claim names that the store does not have yet", async () => {
    const { read } = await start();
    expect((await read(arbiter)).status).toBe(404);
  });
});
