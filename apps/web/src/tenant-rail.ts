/**
 * Each wallet-connected tenant's own `policy_rail` (F6/T58) — deployed
 * lazily, the first time that tenant actually pays via the rail, not when
 * the tenant is created. Same cost reasoning `tenant-agent.ts` already
 * applies to the classic account (`C-21`): most tenants in this pilot never
 * spend enough to justify one.
 *
 * **Why this cannot reuse `scripts/deploy-policy-rail.ts`.** That script
 * shells out to the `stellar` CLI (`execFile`) — fine for a human running it
 * once against `.env.local`, but this code runs inside the live web server
 * (Render has no `stellar` CLI installed, and depending on one there would
 * be a new, unnecessary attack surface). `@stellar/stellar-sdk`'s
 * `contract.Client.deploy` does the same job — create a new instance from a
 * wasm hash **already uploaded** to the network — without shelling out to
 * anything: it fetches the contract's spec straight from RPC by wasm hash,
 * so this module never needs the compiled `.wasm` file, only its hash
 * (`POLICY_RAIL_WASM_HASH`, the same hash `deployments/testnet.json` already
 * records for the shared pilot rail — one wasm, many instances).
 *
 * **Who is `owner` and who is `principal`, here.** `owner` is this tenant's
 * own derived agent key (`ensureTenantAgent` — the same key that already
 * signs the tenant's Mandato); it authorises day-to-day spend, same role
 * `AGENT_SECRET_KEY` plays for the shared rail today. `principal` is the
 * wallet this tenant already proved control of before a Mandato could even
 * exist (`directory.bindPrincipal`, called from both `/api/wallet/verify`
 * and the hosted-consent flow) — the only address that can withdraw or
 * rotate `owner` (T57, `C-61`). Both are always real and already resolved by
 * the time a wallet-connected session reaches `buy()`; this module never
 * invents either.
 *
 * **What this does not cover.** The classic, no-wallet demo path (`C-34`)
 * has no tenant identity to own a rail with — it keeps paying from the
 * shared account/rail, exactly as it does today. Balance monitoring is a
 * separate ticket (T59) — this module funds a rail once, at deploy time, and
 * never checks back.
 */
import { AgentPassError } from "@agentpass/core";
import { MAX_SPONSORED_RAILS, SPONSORED_FUNDING_PER_TENANT } from "@agentpey/activity";
import { BAZAAR_USDC_ISSUER, fromScaledAmount, toScaledAmount } from "@agentpey/agent";
import type { Directory } from "@agentpey/directory";
import { Keypair, Networks, StrKey, contract } from "@stellar/stellar-sdk";

import type { TenantAgent } from "./tenant-agent.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * The on-chain backstop of every tenant rail: `3.00` per transfer and `3.00`
 * per day since 2026-09-23 (`C-133`), the same as the sponsored credit
 * (`C-131`). They were `0.30`/`0.60` (`C-80`), under which no real product of
 * a Vitrinee store (the cheapest is 1.0421053 USDC) could ever be paid, however
 * much the rail held.
 *
 * **The Mandate is the limit that decides, not these.** `LocalPolicyRail`
 * refuses against the principal's signed `grant.limits` before anything is
 * signed, and RealOps proposes `0.30`/`0.60` there by default. That is also
 * what acceptance case 4 of the F9 brief exercises: a second report exceeding
 * the daily cap is refused by the Mandate, so it holds with these numbers too.
 * What these add is the guarantee that, whatever happens off-chain, the
 * network itself never lets a rail move more than its day's credit.
 *
 * These are written into the contract at construction, so a rail already
 * deployed keeps whatever it was built with: `0.30`/`0.60` for rails from
 * T77 to 2026-09-23, `0.002`/`0.01` for the handful from T58. None is
 * migrated; a tenant that must buy something dearer needs a new rail.
 */
const PER_TX = "3.0000000";
const PER_DAY = "3.0000000";
const VALID_DAYS = 365;

/**
 * How much USDC a freshly deployed tenant rail starts with, and how many
 * tenants the pilot will sponsor at all (`C-80`) — imported from
 * `@agentpey/activity`, not declared here. The check that refuses to sponsor
 * and the panel that shows the credit running out read the same two numbers,
 * for the same reason every spending figure in this codebase comes from one
 * place.
 */
const INITIAL_FUNDING = SPONSORED_FUNDING_PER_TENANT;

/** The slice of {@link Directory} this depends on. */
export type TenantRailDirectory = Pick<
  Directory,
  "setAgentPolicyRail" | "claimRailFunding" | "releaseRailFunding" | "countFundedRails"
>;

interface UsdcContract {
  transfer(
    args: { readonly from: string; readonly to: string; readonly amount: bigint },
    options?: contract.MethodOptions,
  ): Promise<contract.AssembledTransaction<null>>;
}

function railError(message: string, details: Record<string, unknown>, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details });
}

/** Funds a classic account through Friendbot. "Already exists" counts as success — testnet only. */
async function fundWithFriendbot(address: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  if (response.status === 400 && body.includes("op_already_exists")) return;
  throw railError("Friendbot could not fund the tenant's rail owner account", {
    address,
    status: response.status,
    body: body.slice(0, 500),
  });
}

/** Deploys a fresh `policy_rail` instance from an already-uploaded wasm, owned and paid for by `owner`. */
async function deployRailContract(params: {
  readonly owner: Keypair;
  readonly principalAddress: string;
  readonly wasmHash: string;
}): Promise<string> {
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + VALID_DAYS * 24 * 60 * 60);

  let assembled: contract.AssembledTransaction<contract.Client>;
  try {
    assembled = await contract.Client.deploy(
      {
        owner: Buffer.from(StrKey.decodeEd25519PublicKey(params.owner.publicKey())),
        principal: params.principalAddress,
        asset: BAZAAR_USDC_ISSUER,
        per_tx: toScaledAmount(PER_TX),
        per_day: toScaledAmount(PER_DAY),
        valid_until: validUntil,
      },
      {
        wasmHash: params.wasmHash,
        format: "hex",
        address: params.owner.publicKey(),
        publicKey: params.owner.publicKey(),
        signTransaction: params.owner,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
      },
    );
  } catch (error) {
    throw railError("could not build this tenant's policy_rail deployment", {
      owner: params.owner.publicKey(),
      principal: params.principalAddress,
    }, error);
  }

  const sent = await assembled.signAndSend().catch((error: unknown) => {
    throw railError("deploying this tenant's policy_rail failed", {
      owner: params.owner.publicKey(),
      principal: params.principalAddress,
    }, error);
  });

  const contractId = sent.result.options.contractId;
  if (!StrKey.isValidContract(contractId)) {
    throw railError("the deployed rail did not return a usable contract id", { contractId });
  }
  return contractId;
}

/** Moves the initial USDC balance into a freshly deployed rail, from the account that already holds it. */
async function fundRailBalance(rail: { readonly contractId: string; readonly funder: Keypair }): Promise<void> {
  const usdc = await contract.Client.from<UsdcContract>({
    contractId: BAZAAR_USDC_ISSUER,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    publicKey: rail.funder.publicKey(),
    signTransaction: rail.funder,
  });

  const transfer = await usdc.transfer({
    from: rail.funder.publicKey(),
    to: rail.contractId,
    amount: toScaledAmount(INITIAL_FUNDING),
  });
  await transfer.signAndSend().catch((error: unknown) => {
    throw railError("funding the newly deployed policy_rail with USDC failed", {
      contractId: rail.contractId,
      funder: rail.funder.publicKey(),
      amount: fromScaledAmount(toScaledAmount(INITIAL_FUNDING)),
    }, error);
  });
}

/**
 * Refuses, typed, before anything is deployed, when the pilot cannot afford
 * to sponsor another tenant.
 *
 * Two separate conditions, deliberately not collapsed into one: the **cap**
 * is a decision (`C-80` — twenty testers is a pilot, an uncapped faucet is a
 * way to wake up with an empty reserve), and the **balance** is a fact. An
 * operator reading the refusal needs to know which of the two stopped it,
 * because the remedies are opposite: raise the cap, or add funds.
 *
 * @throws AgentPassError `SponsoredCreditExhausted`
 */
async function requireSponsoredCredit(
  directory: TenantRailDirectory,
  reserve: Keypair,
  readUsdcBalance: (address: string) => Promise<string>,
): Promise<void> {
  const funded = await directory.countFundedRails();
  if (funded >= MAX_SPONSORED_RAILS) {
    throw new AgentPassError("SponsoredCreditExhausted", "the pilot has already sponsored as many tenants as it allows", {
      details: { funded, cap: MAX_SPONSORED_RAILS, remedy: "raise the cap" },
    });
  }

  const reserveUsdc = await readUsdcBalance(reserve.publicKey());
  if (Number(reserveUsdc) < Number(INITIAL_FUNDING)) {
    throw new AgentPassError("SponsoredCreditExhausted", "the pilot's reserve cannot cover another sponsored tenant", {
      details: { reserveUsdc, needed: INITIAL_FUNDING, reserve: reserve.publicKey(), remedy: "fund the reserve" },
    });
  }
}

/**
 * Funds a deployed rail exactly once, ever.
 *
 * **This is the fix for a real defect** (`PILOTO-F9.md` §13.2). The original
 * order was deploy → fund → persist, so a crash between funding and
 * persisting left the reserve's money in a contract no row pointed at, and
 * the next purchase deployed and funded a second one. Two concurrent first
 * purchases did the same thing with no crash at all: `setAgentPolicyRail`
 * resolves the race for the *row*, but both had already funded a rail by
 * then.
 *
 * The order is now deploy → persist → claim → fund. `claimRailFunding` is a
 * conditional update, so exactly one caller is told to fund; a failed
 * transfer releases the claim so the next attempt retries rather than
 * leaving a rail deployed and empty forever.
 *
 * Note what it does *not* do: decide by reading the rail's balance. A rail
 * that legitimately spent down to zero looks identical to one never funded,
 * and topping that one up would sponsor the same tenant twice.
 */
async function fundRailOnce(
  directory: TenantRailDirectory,
  agentId: string,
  contractId: string,
  reserve: Keypair,
): Promise<void> {
  if (!(await directory.claimRailFunding(agentId))) return;
  try {
    await fundRailBalance({ contractId, funder: reserve });
  } catch (error) {
    await directory.releaseRailFunding(agentId).catch(() => undefined);
    throw error;
  }
}

/**
 * Finds this tenant's own `policy_rail`, deploying and funding it on the
 * first call. Idempotent in both halves: a rail already deployed is returned
 * as is, and a rail deployed but not yet funded is funded on this call
 * rather than redeployed.
 *
 * @param reserve The account that funds a freshly deployed rail's sponsored
 * balance — `AGENT_SECRET_KEY`, the same account that funds the shared rail.
 * @param readUsdcBalance Reads an account's USDC, for the pre-flight check.
 * Injected, so this module stays testable without a network.
 */
export async function ensureTenantPolicyRail(
  directory: TenantRailDirectory,
  tenantAgent: TenantAgent,
  principalAddress: string,
  reserve: Keypair,
  wasmHash: string,
  readUsdcBalance: (address: string) => Promise<string>,
): Promise<string> {
  const agentId = tenantAgent.instance.id;
  const existing = tenantAgent.instance.policyRailContractId;
  if (existing !== null) {
    // Deployed already. It may still be unfunded — a transfer that failed, or
    // a process that died between persisting and funding — and this is where
    // that is finished rather than discovered later as an empty balance.
    if (tenantAgent.instance.policyRailFundedAt === null) {
      await fundRailOnce(directory, agentId, existing, reserve);
    }
    return existing;
  }

  // Before anything is deployed or any fee is spent: can the pilot afford to
  // sponsor one more tenant at all?
  await requireSponsoredCredit(directory, reserve, readUsdcBalance);

  await fundWithFriendbot(tenantAgent.keypair.publicKey());
  const contractId = await deployRailContract({ owner: tenantAgent.keypair, principalAddress, wasmHash });

  // Persist **before** funding. If this process dies here, the next attempt
  // finds the rail and funds it; the worst case is an orphaned, *empty*
  // contract costing a few stroops of fee, instead of an orphaned contract
  // holding the reserve's USDC.
  const persisted = await directory.setAgentPolicyRail(agentId, contractId);
  const actual = persisted.policyRailContractId ?? contractId;

  // `actual` may be a *different* rail than the one just deployed: a
  // concurrent first purchase can win the row. Funding follows the row, never
  // the local variable, so the money goes to the rail the tenant will
  // actually pay from.
  await fundRailOnce(directory, agentId, actual, reserve);
  return actual;
}
