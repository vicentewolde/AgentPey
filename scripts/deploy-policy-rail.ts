#!/usr/bin/env node
/**
 * `pnpm run deploy:policy-rail` — deploy the `policy_rail` smart account (T22)
 * and leave it able to pay: same limits `LocalPolicyRail` enforces off-chain,
 * enforced by the network inside the transfer itself (T31).
 *
 * Re-runnable, like `deploy:registry`: a recorded contract that still answers
 * with the wasm this source builds is left alone, and only its USDC balance is
 * topped up. Any drift stops and asks for `--redeploy`, because a redeploy
 * means a **new contract id** — and the old one keeps whatever balance it had.
 *
 * `owner` is the agent's own key: the agent still authorises its purchases,
 * exactly as it does when paying from its classic account. What changes is who
 * the money moves from, and who gets to say no — `__check_auth` re-checks
 * `perTx`/`perDay` on chain, after `LocalPolicyRail` already checked them off
 * chain. Two independent gates on the same numbers, not one moved.
 *
 * `--principal <G...>` is the wallet that owns the money in the rail, and the
 * only one that can take it back out or rotate `owner` (T57, `C-61`). Required
 * and without a default on purpose: there is no wallet this script could
 * reasonably invent, and picking the wrong one is exactly the failure `G9`
 * described — funds no one but AgentPey can move.
 *
 * Secrets reach the Stellar CLI through the environment, never argv, so they
 * cannot be read out of the process list.
 *
 * `--profile ucp` (T122) deploys a second instance of the same contract for
 * UCP purchases at real stores, with limits a real product fits in: 3.00 USDC
 * per purchase and 5.00 per day, the same as a tenant's rail (C-133). It is
 * recorded apart (`policyRailUcp`, `UCP_POLICY_RAIL_CONTRACT_ID`), so the
 * shared rail and everything that pays from it are untouched.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { BAZAAR_USDC_ISSUER, fromScaledAmount, toScaledAmount } from "@agentpey/agent";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { readEnvFile, upsertEnvValue, writeEnvFile } from "./lib/env-file.js";
import { TESTNET, getLiveVersion } from "./lib/network.js";
import { readDeployment, writeDeployment } from "./lib/deployment.js";
import type { PolicyRailDeployment } from "./lib/deployment.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const WASM_PATH = resolve(CONTRACTS_DIR, "target/wasm32v1-none/release/policy_rail.wasm");

const ARGV = process.argv.slice(2);
const REDEPLOY = ARGV.includes("--redeploy");

interface RailProfile {
  readonly name: "shared" | "ucp";
  readonly perTx: string;
  readonly perDay: string;
  readonly fundThreshold: string;
  readonly fundTarget: string;
  readonly recordKey: "policyRail" | "policyRailUcp";
  readonly envKey: string;
}

/**
 * `swap-risk-quote`, the one product with a real payment path, costs
 * 0.0010000 USDC. `perTx` at twice that leaves a purchase comfortably inside
 * the limit while still refusing a challenge that asked for meaningfully more
 * than what the catalogue quoted; `perDay` allows ten of them, enough for a
 * demo session and still a number the contract can be seen enforcing.
 */
const SHARED: RailProfile = {
  name: "shared",
  perTx: "0.0020000",
  perDay: "0.0100000",
  fundThreshold: "0.0050000",
  fundTarget: "0.0500000",
  recordKey: "policyRail",
  envKey: "POLICY_RAIL_CONTRACT_ID",
};

/** Real store products cost 1.5 to 3 USDC: one fits, three of them in a day, and a 3.01 purchase is refused on chain. */
const UCP: RailProfile = {
  name: "ucp",
  perTx: "3.0000000",
  perDay: "5.0000000",
  fundThreshold: "1.0000000",
  fundTarget: "5.0000000",
  recordKey: "policyRailUcp",
  envKey: "UCP_POLICY_RAIL_CONTRACT_ID",
};

function readProfile(): RailProfile {
  // `--profile=ucp` would otherwise be ignored and fall through to the shared rail.
  if (ARGV.some((arg) => arg.startsWith("--profile="))) {
    throw new AgentPassError("ConfigError", "write --profile <shared|ucp>, with a space", { details: {} });
  }
  const at = ARGV.indexOf("--profile");
  if (at === -1) return SHARED;
  const value = (ARGV[at + 1] ?? "").trim();
  if (value === "shared") return SHARED;
  if (value === "ucp") return UCP;
  throw new AgentPassError("ConfigError", "--profile takes shared or ucp", { details: { profile: value } });
}

const PROFILE = readProfile();

/**
 * Reads `--principal <G...>`. Validated here rather than left to the CLI:
 * a malformed address only surfaces as a Soroban type error deep inside
 * `contract deploy`, long after the wasm has been uploaded and paid for.
 */
function readPrincipal(): string {
  const at = ARGV.indexOf("--principal");
  const value = at === -1 ? "" : (ARGV[at + 1] ?? "").trim();
  if (value === "") {
    throw new AgentPassError("ConfigError", "--principal <G...> is required", {
      details: {
        why: "the wallet that funds the rail and is the only one that can withdraw from it or rotate its owner key",
        usage: "pnpm run deploy:policy-rail -- --principal GXXXX…",
      },
    });
  }
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new AgentPassError("ConfigError", "--principal is not a Stellar public key", {
      details: { principal: value },
    });
  }
  return value;
}

const PER_TX = PROFILE.perTx;
const PER_DAY = PROFILE.perDay;
const VALID_DAYS = 365;

/** Top up to {@link FUND_TARGET} whenever the rail holds less than this. */
const FUND_THRESHOLD = PROFILE.fundThreshold;
const FUND_TARGET = PROFILE.fundTarget;

function cliEnv(secret: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    STELLAR_ACCOUNT: secret,
    STELLAR_NETWORK: TESTNET.network,
    STELLAR_RPC_URL: TESTNET.rpcUrl,
    STELLAR_NETWORK_PASSPHRASE: TESTNET.passphrase,
  };
}

async function stellar(args: readonly string[], secret: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("stellar", [...args], {
      cwd: CONTRACTS_DIR,
      env: cliEnv(secret),
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new AgentPassError("CommandFailed", `stellar ${args.join(" ")} failed`, {
      cause: error,
      // Never echo the environment: it carries a secret key.
      details: { command: `stellar ${args.join(" ")}`, stderr: stderr.slice(-2000) },
    });
  }
}

function lastLine(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined) {
    throw new AgentPassError("CommandFailed", "the Stellar CLI produced no output");
  }
  return last;
}

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") {
    throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, {
      details: { key, fix: "run `pnpm run bootstrap` first" },
    });
  }
  return value;
}

/** A contract's USDC balance, as a decimal string. Read-only, no fee. */
async function usdcBalance(address: string, secret: string): Promise<string> {
  const raw = lastLine(
    await stellar(["contract", "invoke", "--id", BAZAAR_USDC_ISSUER, "--", "balance", "--id", address], secret),
  );
  const scaled = BigInt(raw.replaceAll('"', ""));
  return fromScaledAmount(scaled);
}

/**
 * Moves USDC into the rail from the account that already holds it — the agent.
 * A contract address needs no trustline: a SEP-41 balance lives in the token
 * contract's own storage, whoever holds it (the same way T22 funded this
 * contract with native XLM).
 */
async function ensureFunded(contractId: string, funder: Keypair): Promise<void> {
  const balance = await usdcBalance(contractId, funder.secret());
  process.stdout.write(`  balance      ${balance} USDC\n`);
  if (toScaledAmount(balance) >= toScaledAmount(FUND_THRESHOLD)) {
    process.stdout.write("  funding      above the threshold — nothing to top up\n\n");
    return;
  }

  const top = toScaledAmount(FUND_TARGET) - toScaledAmount(balance);
  process.stdout.write(`  funding      +${fromScaledAmount(top)} USDC from ${funder.publicKey()}\n`);
  await stellar(
    [
      "contract",
      "invoke",
      "--id",
      BAZAAR_USDC_ISSUER,
      "--",
      "transfer",
      "--from",
      funder.publicKey(),
      "--to",
      contractId,
      "--amount",
      top.toString(),
    ],
    funder.secret(),
  );
  process.stdout.write(`  balance      ${await usdcBalance(contractId, funder.secret())} USDC\n\n`);
}

interface LiveRail {
  readonly owner: string;
  readonly principal: string;
  readonly asset: string;
  readonly perTx: string;
  readonly perDay: string;
  readonly validUntil: string;
}

/**
 * Reads the deployed contract back through the CLI rather than trusting what
 * was passed in — an independent confirmation that the rail on chain is the
 * rail we meant to put there, and the one whose `owner` the agent can sign for.
 */
async function probe(contractId: string, secret: string): Promise<LiveRail> {
  const read = async (method: string): Promise<string> =>
    lastLine(await stellar(["contract", "invoke", "--id", contractId, "--", method], secret)).replaceAll('"', "");

  const [owner, principal, asset, perTx, perDay, validUntil] = await Promise.all([
    read("owner"),
    read("principal"),
    read("asset"),
    read("per_tx"),
    read("per_day"),
    read("valid_until"),
  ]);

  if (!/^[0-9a-f]{64}$/.test(owner)) {
    throw new AgentPassError("NetworkError", "the rail returned an unreadable owner key", {
      details: { contractId, owner },
    });
  }
  return {
    owner: StrKey.encodeEd25519PublicKey(Buffer.from(owner, "hex")),
    principal,
    asset,
    perTx: fromScaledAmount(BigInt(perTx)),
    perDay: fromScaledAmount(BigInt(perDay)),
    validUntil: new Date(Number(BigInt(validUntil)) * 1000).toISOString(),
  };
}

async function main(): Promise<void> {
  const principal = readPrincipal();
  const env = await readEnvFile(ENV_PATH);
  const admin = Keypair.fromSecret(requireEnv(env, "ADMIN_SECRET_KEY"));
  const agent = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY"));

  const [version, recorded] = await Promise.all([
    getLiveVersion(TESTNET.rpcUrl),
    readDeployment(DEPLOYMENT_PATH),
  ]);

  process.stdout.write(`\nAgentPey deploy:policy-rail · ${PROFILE.name} rail · Stellar testnet\n\n`);
  process.stdout.write(`  protocol     ${version.protocolVersion}\n`);
  process.stdout.write(`  deployer     ${admin.publicKey()}\n`);
  process.stdout.write(`  owner        ${agent.publicKey()} (the agent — spends)\n`);
  process.stdout.write(`  principal    ${principal} (the wallet — withdraws, rotates the owner)\n`);
  process.stdout.write(`  asset        ${BAZAAR_USDC_ISSUER} (USDC)\n\n`);

  process.stdout.write("  building     …\n");
  await stellar(["contract", "build"], admin.secret());
  const wasm = await readFile(WASM_PATH);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  process.stdout.write(`  wasm         ${wasm.byteLength} bytes · ${wasmHash.slice(0, 16)}…\n\n`);

  const previous = recorded[PROFILE.recordKey];
  if (previous !== null && !REDEPLOY) {
    // The wasm comparison comes before the probe, not after: a rail deployed
    // from older source may not even have the methods `probe` reads (T57 added
    // `principal`), and "the source builds different wasm" is the accurate
    // reason for that, not "the rail does not answer".
    if (previous.wasmHash !== wasmHash) {
      throw new AgentPassError(
        "ConfigError",
        "the source builds to a different wasm than the deployed rail; re-run with --redeploy",
        {
          details: {
            deployed: previous.wasmHash,
            built: wasmHash,
            warning: "a redeploy creates a NEW contract id, and the old one keeps its balance",
          },
        },
      );
    }

    let live: LiveRail;
    try {
      live = await probe(previous.contractId, admin.secret());
    } catch (error) {
      throw new AgentPassError(
        "ConfigError",
        "a rail is recorded but does not answer; re-run with --redeploy to replace it",
        { cause: error, details: { contractId: previous.contractId } },
      );
    }
    if (live.principal !== principal) {
      throw new AgentPassError(
        "ConfigError",
        "the deployed rail answers to a different principal — its balance is not this wallet's to withdraw",
        {
          details: {
            contractId: previous.contractId,
            deployed: live.principal,
            asked: principal,
            fix: "pass the principal this rail was deployed with, or --redeploy to create a new one",
          },
        },
      );
    }
    if (live.owner !== agent.publicKey()) {
      throw new AgentPassError(
        "ConfigError",
        "the deployed rail's owner is not this agent — it cannot authorise payments from it",
        { details: { contractId: previous.contractId, owner: live.owner, agent: agent.publicKey() } },
      );
    }

    process.stdout.write(`  contract     ${previous.contractId}\n`);
    process.stdout.write(`  verified     perTx ${live.perTx} · perDay ${live.perDay} · until ${live.validUntil}\n`);
    process.stdout.write(`  verified     principal ${live.principal}\n\n`);
    process.stdout.write("  already deployed and matching the built wasm — nothing to redeploy\n\n");

    await writeEnvFile(
      ENV_PATH,
      upsertEnvValue(await readFile(ENV_PATH, "utf8"), PROFILE.envKey, previous.contractId),
    );
    await writeDeployment(DEPLOYMENT_PATH, { ...recorded, protocolVersion: version.protocolVersion });
    await ensureFunded(previous.contractId, agent);
    return;
  }

  process.stdout.write("  uploading    …\n");
  const uploaded = lastLine(await stellar(["contract", "upload", "--wasm", WASM_PATH], admin.secret()));
  if (uploaded !== wasmHash) {
    throw new AgentPassError("CommandFailed", "the uploaded wasm hash differs from the local one", {
      details: { uploaded, local: wasmHash },
    });
  }

  const validUntil = new Date(Date.now() + VALID_DAYS * 24 * 60 * 60 * 1000);
  process.stdout.write("  deploying    …\n");
  const contractId = lastLine(
    await stellar(
      [
        "contract",
        "deploy",
        "--wasm-hash",
        wasmHash,
        "--",
        "--owner",
        Buffer.from(StrKey.decodeEd25519PublicKey(agent.publicKey())).toString("hex"),
        "--principal",
        principal,
        "--asset",
        BAZAAR_USDC_ISSUER,
        "--per_tx",
        toScaledAmount(PER_TX).toString(),
        "--per_day",
        toScaledAmount(PER_DAY).toString(),
        "--valid_until",
        Math.floor(validUntil.getTime() / 1000).toString(),
      ],
      admin.secret(),
    ),
  );
  if (!StrKey.isValidContract(contractId)) {
    throw new AgentPassError("CommandFailed", "the CLI did not return a contract id", {
      details: { output: contractId },
    });
  }

  const live = await probe(contractId, admin.secret());
  if (
    live.owner !== agent.publicKey() ||
    live.principal !== principal ||
    live.asset !== BAZAAR_USDC_ISSUER
  ) {
    throw new AgentPassError("ConfigError", "the deployed rail does not match what was asked for", {
      details: {
        expected: { owner: agent.publicKey(), principal, asset: BAZAAR_USDC_ISSUER },
        actual: live,
      },
    });
  }

  const record: PolicyRailDeployment = {
    contractId,
    wasmHash,
    owner: agent.publicKey(),
    principal,
    asset: BAZAAR_USDC_ISSUER,
    perTx: live.perTx,
    perDay: live.perDay,
    validUntil: live.validUntil,
    deployedAt: new Date().toISOString(),
    protocolVersion: version.protocolVersion,
  };
  await writeDeployment(DEPLOYMENT_PATH, {
    ...recorded,
    protocolVersion: version.protocolVersion,
    [PROFILE.recordKey]: record,
  });
  await writeEnvFile(
    ENV_PATH,
    upsertEnvValue(await readFile(ENV_PATH, "utf8"), PROFILE.envKey, contractId),
  );

  process.stdout.write(`\n  contract     ${contractId}\n`);
  process.stdout.write(`  verified     perTx ${live.perTx} · perDay ${live.perDay} · until ${live.validUntil}\n`);
  process.stdout.write(`  verified     principal ${live.principal}\n\n`);
  process.stdout.write("  wrote deployments/testnet.json and .env.local\n\n");

  await ensureFunded(contractId, agent);
}

try {
  await main();
} catch (error) {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
  } else {
    process.stderr.write(`\nUnexpected failure: ${String(error)}\n`);
  }
  process.exitCode = 1;
}
