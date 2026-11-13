import { hasErrorCode } from "@agentpass/core";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { EMPTY_WALLETS_FILE, type WalletEntry, addWallet, assertCanAdd, formatWalletsFile, nextAgentIndex, parseWalletsFile } from "./wallets.js";

const railId = (): string => StrKey.encodeContract(Keypair.random().rawPublicKey());

function entry(agentIndex: number, overrides: Partial<WalletEntry> = {}): WalletEntry {
  return {
    wallet: Keypair.random().publicKey(),
    agentIndex,
    agent: Keypair.random().publicKey(),
    rail: railId(),
    perTx: "3",
    perDay: "5",
    addedAt: "2026-11-13T15:00:00.000Z",
    ...overrides,
  };
}

describe("the MCP wallet list", () => {
  it("hands out indices from 1, one past the highest in use", () => {
    expect(nextAgentIndex(EMPTY_WALLETS_FILE)).toBe(1);
    const file = addWallet(addWallet(EMPTY_WALLETS_FILE, entry(1)), entry(4));
    expect(nextAgentIndex(file)).toBe(5);
  });

  it("round-trips through its file format", () => {
    const file = addWallet(EMPTY_WALLETS_FILE, entry(1));
    expect(parseWalletsFile(formatWalletsFile(file))).toEqual(file);
  });

  it("refuses a wallet that already has a spending account", () => {
    const first = entry(1);
    const file = addWallet(EMPTY_WALLETS_FILE, first);
    expect(() => assertCanAdd(file, first.wallet, 2)).toThrow(expect.objectContaining({ code: "WalletAlreadyListed" }));
  });

  it("refuses an index that is already another person's key", () => {
    const file = addWallet(EMPTY_WALLETS_FILE, entry(1));
    let caught: unknown;
    try {
      addWallet(file, entry(1));
    } catch (error) {
      caught = error;
    }
    expect(hasErrorCode(caught, "AgentIndexTaken")).toBe(true);
  });

  it("refuses two people sharing an agent key or a rail, even with different indices", () => {
    const first = entry(1);
    const file = addWallet(EMPTY_WALLETS_FILE, first);
    expect(() => addWallet(file, entry(2, { agent: first.agent }))).toThrow(expect.objectContaining({ code: "ConfigError" }));
    expect(() => addWallet(file, entry(2, { rail: first.rail }))).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });

  it("refuses index 0, kept for the wallet the MCP served before the list", () => {
    expect(() => addWallet(EMPTY_WALLETS_FILE, entry(0))).toThrow();
  });

  it("refuses a file edited by hand into a list with a repeated wallet", () => {
    const first = entry(1);
    const text = JSON.stringify({ network: "testnet", wallets: [first, { ...entry(2), wallet: first.wallet }] });
    expect(() => parseWalletsFile(text)).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });

  it("refuses a list for another network, and text that is not JSON", () => {
    expect(() => parseWalletsFile(JSON.stringify({ network: "mainnet", wallets: [] }))).toThrow(expect.objectContaining({ code: "ConfigError" }));
    expect(() => parseWalletsFile("{")).toThrow(expect.objectContaining({ code: "ConfigError" }));
  });
});
