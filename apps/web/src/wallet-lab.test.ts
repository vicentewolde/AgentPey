import { signStellarMessage } from "@agentpass/core";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { LAB_DATA_NAME, buildLabTransaction, checkLabMessage, checkLabTransaction } from "./wallet-lab.js";

describe("the wallet lab (T143)", () => {
  const wallet = Keypair.random();
  const message = "AgentPey wallet challenge abc";

  it("verifies a SEP-53 signature with the same function a sign-in uses", () => {
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: signStellarMessage(wallet, message) }, message)).toMatchObject({ ok: true, verified: true });
  });

  it("refuses a signature over another message, or by another account", () => {
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: signStellarMessage(wallet, "other") }, message)).toMatchObject({ ok: false, code: "InvalidSignature" });
    expect(checkLabMessage({ address: wallet.publicKey(), nonce: "n", signature: signStellarMessage(Keypair.random(), message) }, message)).toMatchObject({ ok: false, code: "InvalidSignature" });
  });

  it("builds a test transaction for the account and verifies the account's signature on it", () => {
    const { xdr } = buildLabTransaction(wallet.publicKey(), "123");
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    expect("source" in tx && tx.source).toBe(wallet.publicKey());
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr })).toMatchObject({ ok: false, code: "InvalidSignature" });
    tx.sign(wallet);
    expect(checkLabTransaction({ address: wallet.publicKey(), xdr: tx.toXDR() })).toMatchObject({ ok: true, verified: true });
  });

  it("refuses the lab transaction signed by another key", () => {
    const tx = TransactionBuilder.fromXDR(buildLabTransaction(wallet.publicKey(), "0").xdr, Networks.TESTNET);
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
    const tx = TransactionBuilder.fromXDR(buildLabTransaction(wallet.publicKey(), "0").xdr, Networks.TESTNET);
    expect("operations" in tx && tx.operations[0]).toMatchObject({ type: "manageData", name: LAB_DATA_NAME });
  });
});
