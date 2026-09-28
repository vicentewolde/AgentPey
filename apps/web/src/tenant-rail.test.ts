import { stellarAddressToDid } from "@agentpass/core";
import type { AgentInstance } from "@agentpey/directory";
import { deriveTenantKeypair, generateMasterMnemonic } from "@agentpey/tenancy";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ensureTenantPolicyRail, type TenantRailDirectory } from "./tenant-rail.js";

const TENANT_A = "ptn_00000000000000000000000001:00000000000000000000000001";
const RAIL_CONTRACT_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

function fakeAgent(overrides: Partial<AgentInstance> = {}): AgentInstance {
  const address = Keypair.random().publicKey();
  return {
    id: "agt_00000000000000000000000001",
    tenantId: TENANT_A,
    keyIndex: 0,
    address,
    did: stellarAddressToDid(address, "testnet"),
    label: null,
    status: "active",
    onchainState: "derived",
    policyRailContractId: null,
    policyRailFundedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface FakeState {
  readonly funded?: number;
  readonly reserveUsdc?: string;
  readonly claimable?: boolean;
}

function fakeDirectory(state: FakeState = {}) {
  const calls = { set: 0, claim: 0, release: 0, count: 0 };
  let claimable = state.claimable ?? true;
  const directory: TenantRailDirectory = {
    async setAgentPolicyRail() {
      calls.set += 1;
      throw new Error("must not be called in this test");
    },
    async claimRailFunding() {
      calls.claim += 1;
      const answer = claimable;
      claimable = false;
      return answer;
    },
    async releaseRailFunding() {
      calls.release += 1;
      claimable = true;
    },
    async countFundedRails() {
      calls.count += 1;
      return state.funded ?? 0;
    },
  };
  return { directory, calls };
}

function agentFor(instance: AgentInstance) {
  const { secret } = deriveTenantKeypair(mnemonic, instance.keyIndex, "agent");
  return { instance, keypair: Keypair.fromSecret(secret) };
}

const mnemonic = generateMasterMnemonic();

describe("a rail that already exists", () => {
  it("is returned as is, with nothing deployed and nothing funded", async () => {
    const instance = fakeAgent({ policyRailContractId: RAIL_CONTRACT_ID, policyRailFundedAt: new Date() });
    const { directory, calls } = fakeDirectory();

    const contractId = await ensureTenantPolicyRail(
      directory,
      agentFor(instance),
      Keypair.random().publicKey(),
      Keypair.random(),
      "0".repeat(64),
      async () => "100.0000000",
    );

    expect(contractId).toBe(RAIL_CONTRACT_ID);
    expect(calls).toMatchObject({ set: 0, claim: 0 });
  });

  it("is funded on this call when it was deployed but never funded — not redeployed", async () => {
    // The state a crash between persisting and funding leaves behind. Before
    // T77 this was invisible: the rail existed, the row pointed at it, and
    // the first purchase failed on an empty balance with no explanation.
    const instance = fakeAgent({ policyRailContractId: RAIL_CONTRACT_ID, policyRailFundedAt: null });
    const { directory, calls } = fakeDirectory();

    await expect(
      ensureTenantPolicyRail(
        directory,
        agentFor(instance),
        Keypair.random().publicKey(),
        Keypair.random(),
        "0".repeat(64),
        async () => "100.0000000",
      ),
    ).rejects.toBeDefined();

    // It claimed the funding and tried to transfer — the transfer itself
    // needs a network, which is where this test stops. What matters here is
    // that it went down the funding path and never the deploy path.
    expect(calls.claim).toBe(1);
    expect(calls.set).toBe(0);
    expect(calls.release).toBe(1);
  });

  it("does not fund twice when another process already claimed it", async () => {
    const instance = fakeAgent({ policyRailContractId: RAIL_CONTRACT_ID, policyRailFundedAt: null });
    const { directory, calls } = fakeDirectory({ claimable: false });

    const contractId = await ensureTenantPolicyRail(
      directory,
      agentFor(instance),
      Keypair.random().publicKey(),
      Keypair.random(),
      "0".repeat(64),
      async () => "100.0000000",
    );

    expect(contractId).toBe(RAIL_CONTRACT_ID);
    expect(calls.claim).toBe(1);
    expect(calls.release).toBe(0);
  });
});

describe("the sponsored-credit pre-flight, before anything is deployed", () => {
  const freshAgent = () => agentFor(fakeAgent({ policyRailContractId: null }));

  it("refuses once the pilot has sponsored as many tenants as it allows", async () => {
    const { directory, calls } = fakeDirectory({ funded: 40 });
    await expect(
      ensureTenantPolicyRail(directory, freshAgent(), Keypair.random().publicKey(), Keypair.random(), "0".repeat(64), async () => "100.0000000"),
    ).rejects.toMatchObject({ code: "SponsoredCreditExhausted", details: { remedy: "raise the cap" } });
    // Nothing was deployed and nothing was claimed: the refusal happens
    // before a single fee is spent.
    expect(calls).toMatchObject({ set: 0, claim: 0 });
  });

  it("refuses when the reserve cannot cover another tenant, and says so differently", async () => {
    const { directory } = fakeDirectory({ funded: 3 });
    await expect(
      ensureTenantPolicyRail(directory, freshAgent(), Keypair.random().publicKey(), Keypair.random(), "0".repeat(64), async () => "0.5000000"),
    ).rejects.toMatchObject({ code: "SponsoredCreditExhausted", details: { remedy: "fund the reserve" } });
  });

  it("separates the two refusals on purpose — the remedies are opposite", async () => {
    const capped = fakeDirectory({ funded: 40 });
    const broke = fakeDirectory({ funded: 0 });
    const cappedError = await ensureTenantPolicyRail(capped.directory, freshAgent(), Keypair.random().publicKey(), Keypair.random(), "0".repeat(64), async () => "100").catch((e: unknown) => e);
    const brokeError = await ensureTenantPolicyRail(broke.directory, freshAgent(), Keypair.random().publicKey(), Keypair.random(), "0".repeat(64), async () => "0").catch((e: unknown) => e);
    expect((cappedError as { details: { remedy: string } }).details.remedy).not.toBe(
      (brokeError as { details: { remedy: string } }).details.remedy,
    );
  });
});
