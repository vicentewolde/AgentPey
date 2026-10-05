import { Address, Keypair, inspectAuthEntry, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { UcpStellarError } from "./errors.js";
import {
  assertSimulationUsable,
  authorizeAsRailOwner,
  classicPayer,
  describeShortfall,
  keypairSigner,
  policyRailPayer,
  railOwnerSigner,
  type InsufficientFundsProbe,
} from "./payers.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const RAIL = "CBDWMXZEE44NJ3RA6RS7K4EK36KDFW5S7KHP276HCMM4I52MIUUHEF5B";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** An unsigned entry shaped like the one simulating a SEP-41 `transfer` from the rail produces. */
function unsignedTransferEntry(authorizer: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: new Address(authorizer).toScAddress(), nonce: 1234n, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVec([]) }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(ASSET).toScAddress(),
          functionName: "transfer",
          args: [nativeToScVal(authorizer, { type: "address" }), nativeToScVal(Keypair.random().publicKey(), { type: "address" }), nativeToScVal("10000", { type: "i128" })],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function signaturesOf(entry: xdr.SorobanAuthorizationEntry): readonly { readonly publicKey: string; readonly signature: Uint8Array }[] {
  const signatures = inspectAuthEntry(entry).signers[0]?.signatures;
  expect(signatures).not.toBeNull();
  return signatures ?? [];
}

async function rejection(promise: Promise<unknown>): Promise<UcpStellarError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UcpStellarError);
  return error as UcpStellarError;
}

describe("authorizeAsRailOwner", () => {
  it("signs the rail's entry with the owner's key, in the shape __check_auth decodes, through a callback", async () => {
    const owner = Keypair.random();
    const seen: Uint8Array[] = [];
    const sign = railOwnerSigner(owner.secret());
    const signed = await authorizeAsRailOwner(async (payload) => {
      seen.push(payload);
      return sign(payload);
    })(unsignedTransferEntry(RAIL), undefined, 4_242, PASSPHRASE);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(32);
    expect(inspectAuthEntry(signed).address).toBe(RAIL);
    expect(inspectAuthEntry(signed).signatureExpirationLedger).toBe(4_242);
    const signatures = signaturesOf(signed);
    expect(signatures).toHaveLength(1);
    expect(signatures[0]?.publicKey).toBe(owner.publicKey());
    expect(owner.verify(Buffer.from(seen[0]!), Buffer.from(signatures[0]!.signature))).toBe(true);
  });

  it("signs another payload for another network", async () => {
    const sign = railOwnerSigner(Keypair.random().secret());
    const entry = unsignedTransferEntry(RAIL);
    const testnet = await authorizeAsRailOwner(sign)(entry, undefined, 1_000, PASSPHRASE);
    const pubnet = await authorizeAsRailOwner(sign)(entry, undefined, 1_000, "Public Global Stellar Network ; September 2015");
    expect(signaturesOf(testnet)[0]?.signature).not.toEqual(signaturesOf(pubnet)[0]?.signature);
  });
});

describe("signers from a secret", () => {
  it("refuses something that is not a secret key", () => {
    expect(() => railOwnerSigner("SNOTAKEY")).toThrow(UcpStellarError);
    expect(() => keypairSigner("SNOTAKEY")).toThrow(UcpStellarError);
  });

  it("gives a SEP-43 signer for the account the secret opens", () => {
    const account = Keypair.random();
    expect(keypairSigner(account.secret()).address).toBe(account.publicKey());
  });
});

describe("policyRailPayer", () => {
  it("refuses a rail that is not a contract address", () => {
    expect(() => policyRailPayer({ contractId: Keypair.random().publicKey(), signAuthPayload: railOwnerSigner(Keypair.random().secret()) })).toThrow(UcpStellarError);
  });
});

describe("classicPayer", () => {
  it("names a payment it could not build as PaymentNotCreated, never untyped", async () => {
    const payer = classicPayer(keypairSigner(Keypair.random().secret()));
    const requirements = { scheme: "exact", network: "stellar:nowhere", asset: ASSET, amount: "1", payTo: Keypair.random().publicKey(), maxTimeoutSeconds: 60, extra: {} } as never;
    const error = await rejection(payer.createPaymentPayload(2, requirements));
    expect(error).toMatchObject({ code: "PaymentNotCreated", paymentSent: false });
  });
});

describe("describeShortfall", () => {
  const probe = (balance: bigint, amount: string): InsufficientFundsProbe => ({ contractId: "CRAIL", asset: "CUSDC", amount, readBalance: async () => balance });

  it("reports the gap, in decimals, when the rail holds less than the transfer needs", async () => {
    expect(await describeShortfall(probe(2_000_000n, "3500000"))).toEqual({ balance: "0.2000000", required: "0.3500000" });
  });

  it("reports nothing at exactly enough, or more", async () => {
    expect(await describeShortfall(probe(3_500_000n, "3500000"))).toBeUndefined();
    expect(await describeShortfall(probe(100_000_000n, "3500000"))).toBeUndefined();
  });

  it("reports nothing when the balance or the amount cannot be read, rather than throwing", async () => {
    expect(await describeShortfall({ ...probe(0n, "3500000"), readBalance: () => Promise.reject(new Error("rpc unreachable")) })).toBeUndefined();
    expect(await describeShortfall(probe(0n, "not a number"))).toBeUndefined();
  });

  it("reads the balance of the asset the requirement named", async () => {
    const seen: string[] = [];
    await describeShortfall({ ...probe(0n, "1"), asset: "CSOMEOTHERASSET", readBalance: async (_address, asset) => (seen.push(asset), 0n) });
    expect(seen).toEqual(["CSOMEOTHERASSET"]);
  });
});

describe("assertSimulationUsable", () => {
  const details = { contractId: "CRAIL", asset: "CUSDC", payTo: "GPAYEE", amount: "3500000" };
  const enough: InsufficientFundsProbe = { contractId: "CRAIL", asset: "CUSDC", amount: "3500000", readBalance: async () => 100_000_000n };
  const empty: InsufficientFundsProbe = { ...enough, readBalance: async () => 0n };
  const failedSimulation = { error: "HostError: Error(Contract, #10)" } as never;

  it("raises RailInsufficientFunds when the simulation failed and the rail is short", async () => {
    expect((await rejection(assertSimulationUsable(failedSimulation, details, empty))).code).toBe("RailInsufficientFunds");
  });

  it("raises NetworkError when the simulation failed for another reason, such as the rail's own limits", async () => {
    expect((await rejection(assertSimulationUsable(failedSimulation, details, enough))).code).toBe("NetworkError");
  });

  it("raises NetworkError when there was no simulation at all", async () => {
    expect((await rejection(assertSimulationUsable(undefined, details, empty))).code).toBe("NetworkError");
  });
});
