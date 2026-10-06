/**
 * The wallet lab (T143): what `/wallet-lab.html` asks the server, to fill the wallet-by-wallet table. Each wallet
 * signs a SEP-53 message and a test transaction; the server checks both with the code the real screens use, and
 * **sends nothing**.
 *
 * - The message check is `verifyStellarMessage` of `@agentpass/core` (`sep53.ts`), the one every sign-in uses, over
 *   a challenge from the same store; unlike `/api/wallet/verify` it is given no directory, so it cannot create a
 *   tenant: a test leaves no trace.
 * - The test transaction has sequence 0 and asks Horizon nothing: a wallet signs it all the same, and no network
 *   would accept it, so "never sent" is a property of the transaction, not a promise.
 * - The lab answers only on a local server (`localhost`, `127.0.0.1`, `[::1]`): on agentpey.com it is a 404.
 */
import { verifyStellarMessage } from "@agentpass/core";
import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { z } from "zod";

const accountSchema = z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "a Stellar account (G...)");

export const labMessageSchema = z.object({ address: accountSchema, nonce: z.string().min(1).max(200), signature: z.string().min(1).max(200) });
export const labTransactionSchema = z.object({ address: accountSchema });
export const labTransactionCheckSchema = z.object({ address: accountSchema, xdr: z.string().min(1).max(10_000) });

/** The manage-data entry the test transaction would write, if any network ever took it. None does. */
export const LAB_DATA_NAME = "agentpey-wallet-lab";
/** The sequence the test transaction carries: no account's next one, so it is valid nowhere. */
export const LAB_SEQUENCE = "0";

export type LabResult = { readonly ok: true; readonly [key: string]: unknown } | { readonly ok: false; readonly code: string; readonly message: string };

/** Whether a request's `Host` is this machine: the lab exists only there. */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** Checks a wallet's SEP-53 signature over the challenge `nonce` was issued for. The caller has already taken the nonce. */
export function checkLabMessage(input: z.infer<typeof labMessageSchema>, message: string): LabResult {
  return verifyStellarMessage(input.address, message, input.signature)
    ? { ok: true, verified: true, address: input.address }
    : { ok: false, code: "InvalidSignature", message: "the signature does not verify as SEP-53 for that account" };
}

/** An unsigned testnet transaction with `address` as its source: one manage-data operation, sequence 0, five minutes. */
export function buildLabTransaction(address: string, now: Date = new Date()): { xdr: string; hash: string } {
  const tx = new TransactionBuilder(new Account(address, LAB_SEQUENCE), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageData({ name: LAB_DATA_NAME, value: "1" }))
    .setTimebounds(Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000) + 300)
    .build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}

/** Whether `xdr` is the lab transaction for `address`, signed by `address`'s key on testnet. Never submitted. */
export function checkLabTransaction(input: z.infer<typeof labTransactionCheckSchema>): LabResult {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(input.xdr, Networks.TESTNET);
    if (!("source" in parsed) || "innerTransaction" in parsed) throw new TypeError("not a plain transaction");
    tx = parsed;
  } catch {
    return { ok: false, code: "InvalidArguments", message: "that is not a testnet transaction envelope" };
  }
  const [operation] = tx.operations;
  const isLab = tx.source === input.address && tx.operations.length === 1 && operation?.type === "manageData" && operation.name === LAB_DATA_NAME;
  if (!isLab) return { ok: false, code: "InvalidArguments", message: "that is not the lab's test transaction for this account" };
  const key = Keypair.fromPublicKey(input.address);
  const hint = Buffer.from(key.signatureHint());
  const signedOver = (hash: Buffer) =>
    tx.signatures.some((decorated) => {
      const wire = decorated.toXdrObject();
      return Buffer.from(wire.hint).equals(hint) && key.verify(hash, Buffer.from(wire.signature));
    });
  const hash = Buffer.from(tx.hash());
  if (signedOver(hash)) return { ok: true, verified: true, hash: hash.toString("hex") };
  // A wallet that cannot be told the network (LOBSTR) signs the same envelope for mainnet: its signature is good,
  // but over another network's hash, so it would be refused on testnet. Said as such, not as a bad signature.
  const mainnet = TransactionBuilder.fromXDR(tx.toXDR(), Networks.PUBLIC);
  if (signedOver(Buffer.from(mainnet.hash()))) {
    return { ok: false, code: "SignedForAnotherNetwork", message: "the wallet signed this transaction for Stellar mainnet, not testnet" };
  }
  return { ok: false, code: "InvalidSignature", message: "the transaction carries no valid signature by that account" };
}

/** What the lab's routes use of the server: the sign-in challenge store, and nothing that writes. */
export interface LabDeps {
  readonly takeChallenge: (nonce: string) => Promise<boolean>;
  readonly challengeMessage: (nonce: string) => string;
}

export const LAB_PATHS = ["/api/wallet/lab/message", "/api/wallet/lab/transaction", "/api/wallet/lab/transaction/verify"] as const;

export type LabResponse = { readonly status: number; readonly body: LabResult | { readonly code: string; readonly message: string } };

/**
 * Answers the lab's three routes, or `undefined` for any other path. A request that is not local, or not a POST,
 * is a 404: the lab does not exist on agentpey.com.
 */
export async function routeWalletLab(
  request: { readonly method: string; readonly pathname: string; readonly host: string | undefined; readonly body: () => Promise<unknown> },
  deps: LabDeps,
): Promise<LabResponse | undefined> {
  if (!(LAB_PATHS as readonly string[]).includes(request.pathname)) return undefined;
  if (request.method !== "POST" || !isLocalHost(request.host)) return { status: 404, body: { code: "NotFound", message: `no route for ${request.pathname}` } };
  const body = await request.body();
  if (request.pathname === "/api/wallet/lab/message") {
    const parsed = labMessageSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { ok: false, code: "InvalidArguments", message: "address, nonce and signature are required" } };
    if (!(await deps.takeChallenge(parsed.data.nonce))) {
      return { status: 400, body: { ok: false, code: "InvalidArguments", message: "that challenge does not exist, was already used, or expired" } };
    }
    const result = checkLabMessage(parsed.data, deps.challengeMessage(parsed.data.nonce));
    return { status: result.ok ? 200 : 400, body: result };
  }
  if (request.pathname === "/api/wallet/lab/transaction") {
    const parsed = labTransactionSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { ok: false, code: "InvalidArguments", message: "address must be a Stellar account (G...)" } };
    return { status: 200, body: { ok: true, ...buildLabTransaction(parsed.data.address) } };
  }
  const parsed = labTransactionCheckSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { ok: false, code: "InvalidArguments", message: "address and xdr are required" } };
  const result = checkLabTransaction(parsed.data);
  return { status: result.ok ? 200 : 400, body: result };
}
