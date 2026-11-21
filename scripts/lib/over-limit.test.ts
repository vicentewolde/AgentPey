import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { PER_TX_EXCEEDED, accountRefusal, transferAmountOf, withTransferAmount } from "./over-limit.js";

const contractId = (): string => StrKey.encodeContract(Keypair.random().rawPublicKey());

function entry(fn: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(contractId()).toScAddress(),
        nonce: xdr.Int64.fromString("424242"),
        signatureExpirationLedger: 99,
        signature: nativeToScVal("a previous signature"),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contractId()).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: [],
    }),
  });
}

const rail = Address.fromString(contractId()).toScVal();
const to = Address.fromString(Keypair.random().publicKey()).toScVal();

describe("the over-limit authorization", () => {
  it("moves the new amount and keeps the nonce, the addresses and the expiry", () => {
    const within = entry("transfer", [rail, to, nativeToScVal(5_000_000n, { type: "i128" })]);
    const over = withTransferAmount(within, 15_000_000n);

    expect(transferAmountOf(over)).toBe(15_000_000n);
    expect(transferAmountOf(within)).toBe(5_000_000n);
    const address = (e: xdr.SorobanAuthorizationEntry) => (e.credentials.type === "sorobanCredentialsAddress" ? e.credentials.address : undefined);
    const [a, b] = [address(within)!, address(over)!];
    expect(b.nonce).toBe(a.nonce);
    expect(String(b.address)).toBe(String(a.address));
    expect(b.signatureExpirationLedger).toBe(99);
    const args = (e: xdr.SorobanAuthorizationEntry) => (e.rootInvocation.function.type === "sorobanAuthorizedFunctionTypeContractFn" ? e.rootInvocation.function.contractFn.args : []);
    expect(args(over).slice(0, 2)).toEqual(args(within).slice(0, 2));
    expect(transferAmountOf(within)).toBe(5_000_000n); // the input is not mutated
  });

  it("clears the old signature, so the new amount must be signed again", () => {
    const over = withTransferAmount(entry("transfer", [rail, to, nativeToScVal(1n, { type: "i128" })]), 2n);
    expect(over.credentials.type === "sorobanCredentialsAddress" && over.credentials.address.signature).toEqual(xdr.ScVal.scvVoid());
  });

  it("refuses anything that is not a transfer, and a non-positive amount", () => {
    expect(() => withTransferAmount(entry("approve", [rail, to, nativeToScVal(1n, { type: "i128" })]), 2n)).toThrow(expect.objectContaining({ code: "InvalidArguments" }));
    expect(() => withTransferAmount(entry("transfer", [rail, to]), 2n)).toThrow(expect.objectContaining({ code: "InvalidArguments" }));
    expect(() => withTransferAmount(entry("transfer", [rail, to, nativeToScVal(1n, { type: "i128" })]), 0n)).toThrow(expect.objectContaining({ code: "InvalidArguments" }));
  });
});

describe("reading which account refused, and why", () => {
  const railA = "CBWBQVI5DK2KAVALSWTQO7A3WWBX7FFLCN2F5V46AG2VO3VNAEUGI374";
  // The diagnostic event the testnet host emitted on 15-nov for a 1.5 USDC payment from a rail with per_tx 1.
  const failed = (account: string, code: number) => ({
    event: { type: "diagnostic", body: { v0: { topics: [{ symbol: "error" }, { error: { auth: "invalid_action" } }], data: { vec: [{ string: "failed account authentication with error" }, { address: account }, { error: { contract: code } }] } } } },
  });

  it("finds the rail's own contract error", () => {
    expect(accountRefusal([{ event: { type: "diagnostic" } }, failed(railA, 7)], railA)).toBe(PER_TX_EXCEEDED);
  });

  it("ignores another account's refusal, and events with none", () => {
    expect(accountRefusal([failed(contractId(), 7)], railA)).toBeUndefined();
    expect(accountRefusal([], railA)).toBeUndefined();
    expect(accountRefusal(undefined, railA)).toBeUndefined();
  });
});

