import { describe, expect, it } from "vitest";

import { VitrineeError } from "./errors.js";
import { isStellarAccount, isStellarContractId, parseStellarDid, stellarDid } from "./did.js";
import { USDC_TESTNET } from "./manifest.js";

const ACCOUNT = USDC_TESTNET.issuer;

describe("did:stellar", () => {
  it("derives and parses a testnet DID", () => {
    const did = stellarDid(ACCOUNT);
    expect(did).toBe(`did:stellar:testnet:${ACCOUNT}`);
    expect(parseStellarDid(did)).toEqual({ network: "testnet", account: ACCOUNT });
  });

  it("rejects malformed accounts and DIDs", () => {
    expect(() => stellarDid("GABC")).toThrow(VitrineeError);
    expect(() => stellarDid(USDC_TESTNET.contractId)).toThrow(VitrineeError);
    expect(() => parseStellarDid("did:stellar:mainnet:" + ACCOUNT)).toThrow(VitrineeError);
    expect(() => parseStellarDid("did:key:z6Mk")).toThrow(VitrineeError);
    // Valid shape, broken checksum.
    expect(() => parseStellarDid("did:stellar:testnet:" + ACCOUNT.slice(0, -1) + "A")).toThrow(
      VitrineeError,
    );
  });

  it("tells accounts from contracts", () => {
    expect(isStellarAccount(ACCOUNT)).toBe(true);
    expect(isStellarAccount(USDC_TESTNET.contractId)).toBe(false);
    expect(isStellarContractId(USDC_TESTNET.contractId)).toBe(true);
    expect(isStellarContractId(ACCOUNT)).toBe(false);
  });
});
