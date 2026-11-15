import { deriveTenantKeypair, generateMasterMnemonic } from "@agentpey/tenancy";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { assertRailMatches, planListedAccounts } from "./runtime.js";
import type { WalletEntry } from "./wallets.js";

describe("assertRailMatches (T128, R-7)", () => {
  const agent = Keypair.random().publicKey();
  const wallet = Keypair.random().publicKey();

  it("passes when the rail is owned by the agent and its principal is the wallet that signs in", () => {
    expect(() => assertRailMatches({ owner: agent, principal: wallet }, { agent, wallet })).not.toThrow();
  });

  it("refuses to start when another wallet would sign in, or another key owns the rail", () => {
    expect(() => assertRailMatches({ owner: agent, principal: Keypair.random().publicKey() }, { agent, wallet })).toThrow(expect.objectContaining({ code: "ConfigError", message: expect.stringMatching(/principal/) }));
    expect(() => assertRailMatches({ owner: Keypair.random().publicKey(), principal: wallet }, { agent, wallet })).toThrow(expect.objectContaining({ code: "ConfigError", message: expect.stringMatching(/owned/) }));
  });
});

describe("planListedAccounts (T187, R-33)", () => {
  const mnemonic = generateMasterMnemonic();
  const original = Keypair.random().publicKey();
  const CRED = "a.b.c";
  const MAND = "d.e.f";
  const entry = (agentIndex: number, overrides: Partial<WalletEntry> = {}): WalletEntry => ({
    wallet: Keypair.random().publicKey(),
    agentIndex,
    agent: deriveTenantKeypair(mnemonic, agentIndex, "agent").publicKey,
    rail: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    perTx: "1",
    perDay: "2",
    addedAt: "2026-11-15T18:16:47.127Z",
    credential: CRED,
    mandate: MAND,
    ...overrides,
  });

  it("serves each listed person with the key derived for their index, their rail and their documents", () => {
    const [a, b] = [entry(1), entry(2)];
    const plan = planListedAccounts({ network: "testnet", wallets: [a, b] }, { mnemonic, originalWallet: original });
    expect(plan.disabled).toEqual([]);
    expect(plan.accounts.map((account) => [account.wallet, account.rail, account.agentIndex])).toEqual([
      [a.wallet, a.rail, 1],
      [b.wallet, b.rail, 2],
    ]);
    expect(Keypair.fromSecret(plan.accounts[0]!.agentSecret).publicKey()).toBe(a.agent);
    expect(plan.accounts[1]!.agentSecret).not.toBe(plan.accounts[0]!.agentSecret);
    expect(plan.accounts[0]).toMatchObject({ credentialJws: CRED, mandateJws: MAND });
  });

  it("disables, and says why: no mnemonic, no documents yet, a key the mnemonic does not derive, the original wallet again", () => {
    const missingDocs = entry(1, { credential: undefined });
    const wrongKey = entry(2, { agent: Keypair.random().publicKey() });
    const again = entry(3, { wallet: original });
    const fine = entry(4);
    const plan = planListedAccounts({ network: "testnet", wallets: [missingDocs, wrongKey, again, fine] }, { mnemonic, originalWallet: original });
    expect(plan.accounts.map((account) => account.wallet)).toEqual([fine.wallet]);
    expect(plan.disabled.map((d) => [d.agentIndex, d.reason])).toEqual([
      [1, expect.stringMatching(/credential and Mandate/)],
      [2, expect.stringMatching(/does not derive/)],
      [3, expect.stringMatching(/original account/)],
    ]);
    const noMnemonic = planListedAccounts({ network: "testnet", wallets: [fine] }, { mnemonic: undefined, originalWallet: original });
    expect(noMnemonic).toEqual({ accounts: [], disabled: [{ wallet: fine.wallet, agentIndex: 4, reason: "MCP_AGENT_MNEMONIC is not set" }] });
  });

  it("never puts a secret in what it disables", () => {
    const plan = planListedAccounts({ network: "testnet", wallets: [entry(1, { agent: Keypair.random().publicKey() })] }, { mnemonic, originalWallet: original });
    expect(JSON.stringify(plan.disabled)).not.toMatch(/"S[A-Z2-7]{55}"/);
    expect(JSON.stringify(plan.disabled)).not.toContain(mnemonic.split(" ")[0]! + " " + mnemonic.split(" ")[1]!);
  });
});
