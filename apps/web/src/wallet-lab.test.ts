import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { signStellarMessage } from "@agentpass/core";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { WALLET_KIT_HEADERS, serveWalletKit } from "./wallet-kit-route.js";
import { LAB_DATA_NAME, buildLabTransaction, checkLabMessage, checkLabTransaction, isLocalHost, routeWalletLab, type LabDeps } from "./wallet-lab.js";

describe("the wallet lab (T143)", () => {
  const wallet = Keypair.random();
  const message = "AgentPey wallet challenge abc";

  it("verifies a SEP-53 signature with the same function a sign-in uses", () => {
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: signStellarMessage(wallet, message) }, message)).toMatchObject({ ok: true, verified: true });
  });

  it("names a signature over the raw message, or its plain SHA-256, as not SEP-53 (what a non-SEP-53 wallet does)", () => {
    const raw = Buffer.from(wallet.sign(Buffer.from(message, "utf8"))).toString("base64");
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: raw }, message)).toMatchObject({ ok: false, code: "NotSep53", message: expect.stringContaining("raw bytes") });
    const hashed = Buffer.from(wallet.sign(createHash("sha256").update(message, "utf8").digest())).toString("base64");
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: hashed }, message)).toMatchObject({ ok: false, code: "NotSep53", message: expect.stringContaining("SHA-256") });
  });

  it("refuses a signature over another message, or by another account", () => {
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: signStellarMessage(wallet, "other") }, message)).toMatchObject({ ok: false, code: "InvalidSignature" });
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: signStellarMessage(Keypair.random(), message) }, message)).toMatchObject({ ok: false, code: "InvalidSignature" });
  });

  it("builds a test transaction with sequence 0, valid on no network, and verifies the account's signature on it", () => {
    const { xdr } = buildLabTransaction(wallet.publicKey());
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    expect("source" in tx && tx.source).toBe(wallet.publicKey());
    expect("sequence" in tx && tx.sequence).toBe("1"); // the builder adds one to the account's 0
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr })).toMatchObject({ ok: false, code: "InvalidSignature" });
    tx.sign(wallet);
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr: tx.toXDR() })).toMatchObject({ ok: true, verified: true });
  });

  it("names a transaction signed for mainnet instead of testnet (LOBSTR cannot be told the network)", () => {
    const onMainnet = TransactionBuilder.fromXDR(buildLabTransaction(wallet.publicKey()).xdr, Networks.PUBLIC);
    onMainnet.sign(wallet);
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr: onMainnet.toXDR() })).toMatchObject({ ok: false, code: "SignedForAnotherNetwork" });
  });

  it("refuses the lab transaction signed by another key", () => {
    const tx = TransactionBuilder.fromXDR(buildLabTransaction(wallet.publicKey()).xdr, Networks.TESTNET);
    tx.sign(Keypair.random());
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr: tx.toXDR() })).toMatchObject({ ok: false, code: "InvalidSignature" });
  });

  it("refuses a transaction that is not the lab's, even signed", () => {
    const other = new TransactionBuilder(new Account(wallet.publicKey(), "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }))
      .setTimeout(300)
      .build();
    other.sign(wallet);
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr: other.toXDR() })).toMatchObject({ ok: false, code: "InvalidArguments" });
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr: "not xdr" })).toMatchObject({ ok: false, code: "InvalidArguments" });
  });

  it("names the data entry the test transaction would write", () => {
    const tx = TransactionBuilder.fromXDR(buildLabTransaction(wallet.publicKey()).xdr, Networks.TESTNET);
    expect("operations" in tx && tx.operations[0]).toMatchObject({ type: "manageData", name: LAB_DATA_NAME });
  });

  it.each([
    ["localhost:8787", true],
    ["127.0.0.1:8787", true],
    ["[::1]:8787", true],
    ["localhost", true],
    ["agentpey.com", false],
    ["localhost.agentpey.com", false],
    [undefined, false],
  ])("treats Host %s as local: %s", (host, local) => {
    expect(isLocalHost(host)).toBe(local);
  });
});

describe("the wallet lab's routes", () => {
  const wallet = Keypair.random();

  /** A challenge store that issues one nonce and takes it once. The lab is given nothing else: no directory. */
  function store(): LabDeps & { taken: string[] } {
    const issued = new Set(["nonce-1"]);
    const taken: string[] = [];
    return {
      taken,
      takeChallenge: async (nonce) => (taken.push(nonce), issued.delete(nonce)),
      challengeMessage: (nonce) => `AgentPey wallet challenge ${nonce}`,
    };
  }
  const call = (deps: LabDeps, pathname: string, body: unknown, host = "localhost:8787", method = "POST") => routeWalletLab({ method, pathname, host, body: async () => body }, deps);

  it("verifies a message once: the same challenge is refused after", async () => {
    const deps = store();
    const body = { address: wallet.publicKey(), nonce: "nonce-1", signature: signStellarMessage(wallet, "AgentPey wallet challenge nonce-1") };
    expect(await call(deps, "/api/wallet/lab/message", body)).toMatchObject({ status: 200, body: { ok: true, verified: true } });
    expect(await call(deps, "/api/wallet/lab/message", body)).toMatchObject({ status: 400, body: { code: "InvalidArguments" } });
  });

  it("answers 400 to a malformed body, before touching the challenge store", async () => {
    const deps = store();
    expect(await call(deps, "/api/wallet/lab/message", { address: "nope" })).toMatchObject({ status: 400, body: { code: "InvalidArguments" } });
    expect(await call(deps, "/api/wallet/lab/transaction", {})).toMatchObject({ status: 400 });
    expect(await call(deps, "/api/wallet/lab/transaction/verify", { address: wallet.publicKey() })).toMatchObject({ status: 400 });
    expect(deps.taken).toEqual([]);
  });

  it("builds and checks a transaction, end to end", async () => {
    const deps = store();
    const built = await call(deps, "/api/wallet/lab/transaction", { address: wallet.publicKey() });
    expect(built).toMatchObject({ status: 200, body: { ok: true } });
    const xdr = "xdr" in built!.body && typeof built!.body.xdr === "string" ? built!.body.xdr : "";
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    tx.sign(wallet);
    expect(await call(deps, "/api/wallet/lab/transaction/verify", { address: wallet.publicKey(), xdr: tx.toXDR() })).toMatchObject({ status: 200, body: { verified: true } });
  });

  it("does not exist outside a local server, nor for a GET", async () => {
    const deps = store();
    expect(await call(deps, "/api/wallet/lab/transaction", { address: wallet.publicKey() }, "agentpey.com")).toMatchObject({ status: 404 });
    expect(await call(deps, "/api/wallet/lab/transaction", { address: wallet.publicKey() }, "localhost:8787", "GET")).toMatchObject({ status: 404 });
    expect(deps.taken).toEqual([]);
  });

  it("leaves every other path to the server", async () => {
    expect(await call(store(), "/api/wallet/verify", {})).toBeUndefined();
  });
});

describe("/wallet-kit.js", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function serve(bundle: string, onMissing?: (path: string) => void): Promise<Response> {
    const server = createServer((_req, res) => void serveWalletKit(res, { bundle, ...(onMissing === undefined ? {} : { onMissing }) }));
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/wallet-kit.js`);
  }

  it("serves the bundle as JavaScript, with nosniff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wallet-kit-"));
    const bundle = join(dir, "wallet-kit.js");
    writeFileSync(bundle, "window.AgentpeyWallet = {};");
    const res = await serve(bundle);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(WALLET_KIT_HEADERS["content-type"]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("window.AgentpeyWallet = {};");
  });

  it("answers 503, and says so, when the bundle is not built", async () => {
    const missing: string[] = [];
    const res = await serve("/nonexistent/wallet-kit.js", (path) => missing.push(path));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("run pnpm build");
    expect(missing).toEqual(["/nonexistent/wallet-kit.js"]);
  });
});
