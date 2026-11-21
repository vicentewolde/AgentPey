#!/usr/bin/env node
/**
 * `pnpm run buyer:onboard -- --principal G... [--per-tx 3] [--per-day 5] [--index <n>] [--yes]` — gives one person
 * their own spending account (T186, `Y-4`, `R-33`):
 *
 * 1. derives their agent key from `MCP_AGENT_MNEMONIC` at index n (SEP-0005, `@agentpey/tenancy`), so a leaked key
 *    reaches this one rail and no other;
 * 2. deploys a `policy_rail` owned by that key, with their wallet as `principal` and the limits given here, which the
 *    network then enforces on every payment;
 * 3. reads the rail back from the chain and adds the person to `apps/mcp/wallets.testnet.json`.
 *
 * It never moves USDC. Funding is a separate, guarded step it prints at the end: `pnpm run rail:topup` (capped, and
 * sending nothing without `--yes`), or the person sends USDC from their own wallet. Without `--yes` this command only
 * shows what it would do; with it, it deploys on testnet, which needs the user's OK (CLAUDE.local.md).
 *
 * Secrets: the mnemonic and the deployer's key come from `.env.local` and are never printed. The derived secret only
 * reaches the Stellar CLI's environment if ever needed; this script does not need it at all, since the rail's owner is
 * just the public key.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { BAZAAR_USDC_ISSUER, fromScaledAmount, toScaledAmount } from "@agentpey/agent";
import { deriveTenantKeypair, generateMasterMnemonic } from "@agentpey/tenancy";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { EMPTY_WALLETS_FILE, WALLETS_FILE, type WalletsFile, addWallet, assertCanAdd, formatWalletsFile, nextAgentIndex, parseWalletsFile } from "../apps/mcp/src/wallets.js";
import { parseBuyerOnboardArgs } from "./lib/buyer-onboard-args.js";
import { readDeployment } from "./lib/deployment.js";
import { readEnvFile, upsertEnvValue, writeEnvFile } from "./lib/env-file.js";
import { TESTNET, fundWithFriendbot, getAccountState } from "./lib/network.js";
import { CONTRACTS_ROOT, lastLine, stellarCli } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const WALLETS_PATH = resolve(REPO_ROOT, "apps/mcp", WALLETS_FILE);
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const WASM_PATH = resolve(CONTRACTS_ROOT, "target/wasm32v1-none/release/policy_rail.wasm");
const MNEMONIC_KEY = "MCP_AGENT_MNEMONIC";
/** Same lifetime `deploy:policy-rail` gives a rail: the principal can always withdraw before and after. */
const VALID_DAYS = 365;

function requireEnv(env: ReadonlyMap<string, string>, key: string, fix: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key, fix } });
  return value;
}

async function readWallets(): Promise<WalletsFile> {
  try {
    return parseWalletsFile(await readFile(WALLETS_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_WALLETS_FILE;
    throw error;
  }
}

/** The mnemonic every person's agent key derives from; created here only when asked and only when there is none. */
async function agentMnemonic(init: boolean): Promise<string> {
  const env = await readEnvFile(ENV_PATH);
  const existing = env.get(MNEMONIC_KEY)?.trim() ?? "";
  if (existing !== "") return existing;
  if (!init) {
    throw new AgentPassError("ConfigError", `${MNEMONIC_KEY} is missing from .env.local`, {
      details: { fix: "run once with --init-mnemonic, then copy it to Render's mcp service; never regenerate it, or every derived key changes" },
    });
  }
  const created = generateMasterMnemonic();
  await writeEnvFile(ENV_PATH, upsertEnvValue(await readFile(ENV_PATH, "utf8"), MNEMONIC_KEY, created));
  process.stdout.write(`  mnemonic     created ${MNEMONIC_KEY} in .env.local (not shown). Copy it to Render's mcp service.\n`);
  return created;
}

interface LiveRail {
  readonly owner: string;
  readonly principal: string;
  readonly asset: string;
  readonly perTx: string;
  readonly perDay: string;
}

/** Reads the deployed rail back from the chain instead of trusting the arguments it was deployed with. */
async function probe(contractId: string, secret: string): Promise<LiveRail> {
  const read = async (method: string): Promise<string> => lastLine(await stellarCli(["contract", "invoke", "--id", contractId, "--", method], secret)).replaceAll('"', "");
  const [owner, principal, asset, perTx, perDay] = await Promise.all([read("owner"), read("principal"), read("asset"), read("per_tx"), read("per_day")]);
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new AgentPassError("NetworkError", "the rail returned an unreadable owner key", { details: { contractId, owner } });
  return {
    owner: StrKey.encodeEd25519PublicKey(Buffer.from(owner, "hex")),
    principal,
    asset,
    perTx: fromScaledAmount(BigInt(perTx)),
    perDay: fromScaledAmount(BigInt(perDay)),
  };
}

async function main(): Promise<void> {
  const args = parseBuyerOnboardArgs(process.argv.slice(2));
  const wallets = await readWallets();
  const agentIndex = args.agentIndex ?? nextAgentIndex(wallets);
  // Refused before anything is derived or deployed: one account per wallet, one key per index.
  assertCanAdd(wallets, args.principal, agentIndex);

  process.stdout.write("\nAgentPey buyer:onboard · one spending account per person · Stellar testnet\n\n");
  const agent = deriveTenantKeypair(await agentMnemonic(args.initMnemonic), agentIndex, "agent");
  if (agent.publicKey === args.principal) {
    throw new AgentPassError("ConfigError", "the derived agent key is the person's own wallet", { details: { agentIndex } });
  }

  process.stdout.write(`  principal    ${args.principal} (their wallet: withdraws, signs in)\n`);
  process.stdout.write(`  agent index  ${agentIndex}\n`);
  process.stdout.write(`  owner        ${agent.publicKey} (their agent key, derived: spends within the limits)\n`);
  process.stdout.write(`  limits       ${args.perTx} USDC per payment · ${args.perDay} USDC per day, enforced by the network\n`);
  process.stdout.write(`  asset        ${BAZAAR_USDC_ISSUER} (USDC)\n\n`);

  // Every onboarding creates the agent's account (below), so an index whose key already has one was used before: by
  // someone since removed from the list, or by a run that deployed and then failed to write. Reusing it would hand
  // this person a key that may still own another rail and still be named by an anchored credential (T187 review).
  if ((await getAccountState(TESTNET.horizonUrl, agent.publicKey)).funded) {
    throw new AgentPassError("AgentIndexTaken", "this index's agent key already has an account on testnet: it was used before", {
      details: { agentIndex, agent: agent.publicKey, fix: "pass --index with a number never used, e.g. one above every index ever listed" },
    });
  }

  if (!args.confirmed) {
    process.stdout.write("  dry run      nothing deployed. Add --yes to deploy this rail on testnet.\n\n");
    return;
  }

  const env = await readEnvFile(ENV_PATH);
  const admin = Keypair.fromSecret(requireEnv(env, "ADMIN_SECRET_KEY", "run `pnpm run bootstrap` first"));

  // The agent signs its own transactions later (credential, purchases): it needs an account, which costs only testnet
  // XLM. Created first, so the index is marked as used on chain even if anything below fails.
  await fundWithFriendbot(TESTNET.friendbotUrl, agent.publicKey);
  process.stdout.write("  agent        account created with Friendbot (testnet XLM for fees)\n");

  process.stdout.write("  building     …\n");
  await stellarCli(["contract", "build"], admin.secret());
  const wasm = await readFile(WASM_PATH);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  const mcpRail = (await readDeployment(DEPLOYMENT_PATH)).policyRailMcp;
  const same = mcpRail === null ? "no MCP rail recorded to compare" : mcpRail.wasmHash === wasmHash ? "same wasm as the MCP's rail" : "DIFFERENT wasm from the MCP's rail";
  process.stdout.write(`  wasm         ${wasmHash.slice(0, 16)}… (${same})\n`);

  const uploaded = lastLine(await stellarCli(["contract", "upload", "--wasm", WASM_PATH], admin.secret()));
  if (uploaded !== wasmHash) throw new AgentPassError("CommandFailed", "the uploaded wasm hash differs from the local one", { details: { uploaded, local: wasmHash } });

  const validUntil = Math.floor(Date.now() / 1000) + VALID_DAYS * 24 * 60 * 60;
  process.stdout.write("  deploying    …\n");
  const contractId = lastLine(
    await stellarCli(
      [
        "contract",
        "deploy",
        "--wasm-hash",
        wasmHash,
        "--",
        "--owner",
        Buffer.from(StrKey.decodeEd25519PublicKey(agent.publicKey)).toString("hex"),
        "--principal",
        args.principal,
        "--asset",
        BAZAAR_USDC_ISSUER,
        "--per_tx",
        toScaledAmount(args.perTx).toString(),
        "--per_day",
        toScaledAmount(args.perDay).toString(),
        "--valid_until",
        String(validUntil),
      ],
      admin.secret(),
    ),
  );
  if (!StrKey.isValidContract(contractId)) throw new AgentPassError("CommandFailed", "the CLI did not return a contract id", { details: { output: contractId } });

  const live = await probe(contractId, admin.secret());
  const expected = { owner: agent.publicKey, principal: args.principal, asset: BAZAAR_USDC_ISSUER, perTx: fromScaledAmount(toScaledAmount(args.perTx)), perDay: fromScaledAmount(toScaledAmount(args.perDay)) };
  if (live.owner !== expected.owner || live.principal !== expected.principal || live.asset !== expected.asset || live.perTx !== expected.perTx || live.perDay !== expected.perDay) {
    throw new AgentPassError("ConfigError", "the deployed rail does not match what was asked for; it was not added to the list", { details: { contractId, expected, actual: live } });
  }

  // Re-read just before writing, so a list changed meanwhile is never overwritten with a stale copy.
  const updated = addWallet(await readWallets(), {
    wallet: args.principal,
    agentIndex,
    agent: agent.publicKey,
    rail: contractId,
    perTx: live.perTx,
    perDay: live.perDay,
    addedAt: new Date().toISOString(),
  });
  await writeFile(WALLETS_PATH, formatWalletsFile(updated), "utf8");

  process.stdout.write(`\n  rail         ${contractId}\n`);
  process.stdout.write(`  verified     owner, principal, asset and limits read back from the chain\n`);
  process.stdout.write(`  wrote        apps/mcp/${WALLETS_FILE} (${updated.wallets.length} people)\n\n`);
  process.stdout.write("  funding      nothing moved. To fund it from AgentPey's testnet reserve, with the user's OK:\n");
  process.stdout.write(`               pnpm run rail:topup -- ${contractId} ${live.perDay}\n`);
  process.stdout.write("               or the person sends USDC to the rail from their own wallet.\n\n");
}

try {
  await main();
} catch (error) {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`\nUnexpected failure: ${String(error)}\n`);
  }
  process.exitCode = 1;
}
