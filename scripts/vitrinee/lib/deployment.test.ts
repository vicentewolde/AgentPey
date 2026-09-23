import { describe, expect, it } from "vitest";

import { parseDeployment } from "./deployment.js";

const base = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  protocolVersion: 28,
  usdc: { code: "USDC", issuer: "G", contractId: "C", decimals: 7 },
  facilitator: { name: "x", url: "https://x" },
  receiptRegistry: null,
};

describe("parseDeployment", () => {
  it("accepts an empty registry slot and a well-formed one", () => {
    expect(parseDeployment(base).receiptRegistry).toBeNull();
    const withRegistry = {
      ...base,
      receiptRegistry: {
        contractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        wasmHash: "e".repeat(64),
        deployer: "G",
        schemaVersion: 1,
        uploadTxHash: null,
        deployTxHash: "a".repeat(64),
        deployedAt: "2026-09-22T15:00:00.000Z",
        protocolVersion: 28,
      },
    };
    expect(parseDeployment(withRegistry).receiptRegistry?.schemaVersion).toBe(1);
  });

  it("refuses a malformed registry entry or another network", () => {
    expect(() => parseDeployment({ ...base, receiptRegistry: { contractId: "nope" } })).toThrow(/malformed/);
    expect(() => parseDeployment({ ...base, network: "pubnet" })).toThrow(/testnet/);
  });
});
