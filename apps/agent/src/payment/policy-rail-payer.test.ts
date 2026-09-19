import { Address, Keypair, inspectAuthEntry, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { hasErrorCode } from "@agentpass/core";

import {
  assertSimulationUsable,
  authorizeAsPolicyRailOwner,
  describeShortfall,
  type InsufficientFundsProbe,
} from "./policy-rail-payer.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const RAIL = "CBDWMXZEE44NJ3RA6RS7K4EK36KDFW5S7KHP276HCMM4I52MIUUHEF5B";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * An unsigned authorization entry shaped like the one simulating a SEP-41
 * `transfer` produces: the rail's contract address as the authorizer, one
 * `transfer(from, to, amount)` invocation as what it is being asked to allow.
 */
function unsignedTransferEntry(authorizer: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(authorizer).toScAddress(),
        nonce: 1234n,
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ASSET).toScAddress(),
          functionName: "transfer",
          args: [
            nativeToScVal(authorizer, { type: "address" }),
            nativeToScVal(Keypair.random().publicKey(), { type: "address" }),
            nativeToScVal("10000", { type: "i128" }),
          ],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/**
 * Reads back the `Vec<Signature>` the entry now carries, through the SDK's own
 * parser: `inspectAuthEntry` returns `signatures` only when the ScVal is a vec
 * of `{ public_key: bytes32, signature: bytes64 }` maps — the very struct
 * `policy_rail`'s `__check_auth` decodes. A `null` here means the shape drifted.
 */
function signaturesOf(entry: xdr.SorobanAuthorizationEntry): readonly {
  readonly publicKey: string;
  readonly signature: Uint8Array;
}[] {
  const info = inspectAuthEntry(entry);
  const signatures = info.signers[0]?.signatures;
  expect(signatures).not.toBeNull();
  return signatures ?? [];
}

describe("authorizeAsPolicyRailOwner", () => {
  it("signs a contract account's entry in the shape __check_auth decodes", async () => {
    const owner = Keypair.random();

    const signed = await authorizeAsPolicyRailOwner(owner)(
      unsignedTransferEntry(RAIL),
      undefined,
      1_000,
      PASSPHRASE,
    );

    // Exactly one `Signature { public_key: BytesN<32>, signature: BytesN<64> }`
    // — the contract refuses any other count outright (`UnknownSigner`).
    const signatures = signaturesOf(signed);
    expect(signatures).toHaveLength(1);
    expect(signatures[0]?.publicKey).toBe(owner.publicKey());
    expect(signatures[0]?.signature).toHaveLength(64);
  });

  it("signs with the owner's key, not with whatever address the entry names", async () => {
    // The whole reason this function exists: the SDK's default path derives the
    // signing key from the entry's own address, which for a `C…` account is a
    // contract id and not an Ed25519 key at all.
    const owner = Keypair.random();

    const signed = await authorizeAsPolicyRailOwner(owner)(
      unsignedTransferEntry(RAIL),
      undefined,
      1_000,
      PASSPHRASE,
    );

    expect(inspectAuthEntry(signed).address).toBe(RAIL);
    expect(signaturesOf(signed)[0]?.publicKey).toBe(owner.publicKey());
  });

  it("carries the expiration the caller asked for into the entry", async () => {
    const signed = await authorizeAsPolicyRailOwner(Keypair.random())(
      unsignedTransferEntry(RAIL),
      undefined,
      4_242,
      PASSPHRASE,
    );

    expect(inspectAuthEntry(signed).signatureExpirationLedger).toBe(4_242);
    expect(inspectAuthEntry(signed).signed).toBe(true);
  });

  it("signs the payload the host will check, expiration and all", async () => {
    const owner = Keypair.random();
    const entry = unsignedTransferEntry(RAIL);

    // Ed25519 is deterministic: the same payload signed twice gives the same
    // 64 bytes, and a different payload cannot. Signing the same entry at two
    // expirations is therefore a direct check that the expiration is inside
    // what was signed — not merely written next to it.
    const at1000 = await authorizeAsPolicyRailOwner(owner)(entry, undefined, 1_000, PASSPHRASE);
    const againAt1000 = await authorizeAsPolicyRailOwner(owner)(entry, undefined, 1_000, PASSPHRASE);
    const at1001 = await authorizeAsPolicyRailOwner(owner)(entry, undefined, 1_001, PASSPHRASE);

    const bytes = (e: xdr.SorobanAuthorizationEntry): string =>
      Buffer.from(signaturesOf(e)[0]?.signature ?? new Uint8Array()).toString("hex");

    expect(bytes(at1000)).toBe(bytes(againAt1000));
    expect(bytes(at1000)).not.toBe(bytes(at1001));
  });

  it("signs a different payload for a different network", async () => {
    const owner = Keypair.random();
    const entry = unsignedTransferEntry(RAIL);

    const testnet = await authorizeAsPolicyRailOwner(owner)(entry, undefined, 1_000, PASSPHRASE);
    const pubnet = await authorizeAsPolicyRailOwner(owner)(
      entry,
      undefined,
      1_000,
      "Public Global Stellar Network ; September 2015",
    );

    // The network id is hashed into the preimage; a signature made for testnet
    // is not replayable on pubnet.
    expect(signaturesOf(testnet)[0]?.signature).not.toEqual(signaturesOf(pubnet)[0]?.signature);
  });
});

/**
 * T92 (`C-113`): an empty rail used to reach a person as "we could not reach
 * the merchant, it may be down", which was neither true nor actionable. These
 * cover the seam that decides which of the two errors they get.
 */
describe("describeShortfall", () => {
  function probe(balance: string, amount: string): InsufficientFundsProbe {
    return {
      contractId: "CRAIL",
      asset: "CUSDC",
      amount,
      readBalance: async () => balance,
    };
  }

  it("reports the gap when the rail holds less than the transfer needs", async () => {
    // 0.20 USDC held, 0.35 required — scaled to seven decimals, as the
    // transfer itself moves it.
    expect(await describeShortfall(probe("0.2000000", "3500000"))).toEqual({
      balance: "0.2000000",
      required: "0.3500000",
    });
  });

  it("reports nothing when the rail holds exactly enough — the boundary is not a shortfall", async () => {
    expect(await describeShortfall(probe("0.3500000", "3500000"))).toBeUndefined();
  });

  it("reports nothing when the rail holds more than enough", async () => {
    expect(await describeShortfall(probe("10.0000000", "3500000"))).toBeUndefined();
  });

  it("reports nothing when the balance cannot be read at all", async () => {
    // This runs while another failure is already being reported. A diagnostic
    // that threw would replace a real error with a worse one.
    const unreadable: InsufficientFundsProbe = {
      contractId: "CRAIL",
      asset: "CUSDC",
      amount: "3500000",
      readBalance: async () => {
        throw new Error("rpc unreachable");
      },
    };
    expect(await describeShortfall(unreadable)).toBeUndefined();
  });

  it("reports nothing when either amount is malformed, rather than throwing", async () => {
    expect(await describeShortfall(probe("not a number", "3500000"))).toBeUndefined();
    expect(await describeShortfall(probe("0.2000000", "not a number"))).toBeUndefined();
  });

  it("reads the balance of the asset the challenge named, not a hardcoded default", async () => {
    const seen: string[] = [];
    await describeShortfall({
      contractId: "CRAIL",
      asset: "CSOMEOTHERASSET",
      amount: "3500000",
      readBalance: async (_address, assetContractId) => {
        seen.push(assetContractId);
        return "0.0000000";
      },
    });
    expect(seen).toEqual(["CSOMEOTHERASSET"]);
  });
});

describe("assertSimulationUsable", () => {
  const details = { contractId: "CRAIL", asset: "CUSDC", payTo: "GPAYEE", amount: "3500000" };
  const enough: InsufficientFundsProbe = {
    contractId: "CRAIL",
    asset: "CUSDC",
    amount: "3500000",
    readBalance: async () => "10.0000000",
  };
  const empty: InsufficientFundsProbe = { ...enough, readBalance: async () => "0.0000000" };
  // `rpc.Api.isSimulationError` narrows on the presence of `error`.
  const failedSimulation = { error: "HostError: Error(Contract, #10)" } as never;

  it("raises RailInsufficientFunds when the simulation failed and the rail is short", async () => {
    await expect(assertSimulationUsable(failedSimulation, details, empty)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "RailInsufficientFunds"),
    );
  });

  it("raises the generic NetworkError when the simulation failed for some other reason", async () => {
    // A `__check_auth` refusal by the contract's own limits lands here too,
    // and must not be reported to a person as "your account is empty".
    await expect(assertSimulationUsable(failedSimulation, details, enough)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "NetworkError"),
    );
  });

  it("raises NetworkError when there was no simulation at all", async () => {
    await expect(assertSimulationUsable(undefined, details, empty)).rejects.toSatisfy((error: unknown) =>
      hasErrorCode(error, "NetworkError"),
    );
  });
});
