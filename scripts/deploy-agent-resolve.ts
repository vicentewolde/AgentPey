#!/usr/bin/env node
/**
 * `pnpm run deploy:agent-resolve` — deploy AgentResolve (T124): the contract
 * that holds merchants' guarantees and pays dispute refunds from them.
 *
 * The arbiter is its own account (`E-16`): `RESOLVE_ARBITER_SECRET_KEY` in
 * `.env.local`. If it is not there yet, this script creates a testnet account,
 * funds it with Friendbot and writes the secret to `.env.local` — printing only
 * the public key.
 *
 * Re-runnable: a recorded contract built from the same wasm is left alone.
 * Different wasm stops and asks for `--redeploy`, because a redeploy is a new
 * contract id and the old one keeps its guarantees.
 *
 * The claim window is Vitrinee's refund window (`REFUND_WINDOW_SECONDS`, 10
 * days), counted from the receipt's anchoring ledger.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { readDeployment, writeDeployment } from "./lib/deployment.js";
import { readEnvFile, upsertEnvValue, writeEnvFile } from "./lib/env-file.js";
import { TESTNET, fundWithFriendbot, getLiveVersion } from "./lib/network.js";
import { CONTRACTS_ROOT, lastLine, stellarCli } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const VITRINEE_DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/vitrinee-testnet.json");
const WASM_PATH = resolve(CONTRACTS_ROOT, "target/wasm32v1-none/release/agent_resolve.wasm");
const CLAIM_WINDOW_SECONDS = 864_000;
const SCHEMA_VERSION = 1;
const REDEPLOY = process.argv.includes("--redeploy");

const configSchema = z.object({ arbiter: z.string(), token: z.string(), registry: z.string(), claim_window: z.coerce.number() });

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key, fix: "pnpm run bootstrap" } });
  return value;
}

/** The arbiter's key, created and funded on first run (`E-16`). */
async function arbiterKey(env: ReadonlyMap<string, string>): Promise<Keypair> {
  const existing = env.get("RESOLVE_ARBITER_SECRET_KEY")?.trim() ?? "";
  if (existing !== "") return Keypair.fromSecret(existing);
  const created = Keypair.random();
  await fundWithFriendbot(TESTNET.friendbotUrl, created.publicKey());
  await writeEnvFile(ENV_PATH, upsertEnvValue(await readFile(ENV_PATH, "utf8"), "RESOLVE_ARBITER_SECRET_KEY", created.secret()));
  out("  arbiter      created, funded by Friendbot, secret written to .env.local");
  return created;
}

async function main(): Promise<void> {
  const env = await readEnvFile(ENV_PATH);
  const admin = Keypair.fromSecret(requireEnv(env, "ADMIN_SECRET_KEY"));
  const vitrinee = z
    .object({ usdc: z.object({ contractId: z.string() }), receiptRegistry: z.object({ contractId: z.string() }) })
    .parse(JSON.parse(await readFile(VITRINEE_DEPLOYMENT_PATH, "utf8")));
  const [version, recorded] = await Promise.all([getLiveVersion(TESTNET.rpcUrl), readDeployment(DEPLOYMENT_PATH)]);

  out("\nAgentPey deploy:agent-resolve · Stellar testnet\n");
  out(`  protocol     ${version.protocolVersion}`);
  out(`  deployer     ${admin.publicKey()}`);
  const arbiter = await arbiterKey(env);
  out(`  arbiter      ${arbiter.publicKey()}`);
  out(`  token        ${vitrinee.usdc.contractId} (USDC)`);
  out(`  registry     ${vitrinee.receiptRegistry.contractId} (Vitrinee receipt-registry)`);
  out(`  window       ${CLAIM_WINDOW_SECONDS} s (10 days)\n`);

  await stellarCli(["contract", "build", "--package", "agent-resolve"], admin.secret());
  const wasm = await readFile(WASM_PATH);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  out(`  wasm         ${wasm.byteLength} bytes · ${wasmHash.slice(0, 16)}…`);

  const previous = recorded.agentResolve;
  if (previous !== null && !REDEPLOY) {
    if (previous.wasmHash !== wasmHash) {
      throw new AgentPassError("ConfigError", "the source builds a different wasm than the deployed contract; re-run with --redeploy", {
        details: { deployed: previous.wasmHash, built: wasmHash, warning: "a redeploy creates a NEW contract id; the old one keeps its guarantees" },
      });
    }
    out(`\n  already deployed: ${previous.contractId}`);
    await writeEnvFile(ENV_PATH, upsertEnvValue(await readFile(ENV_PATH, "utf8"), "AGENT_RESOLVE_CONTRACT_ID", previous.contractId));
    return;
  }

  const uploaded = lastLine(await stellarCli(["contract", "upload", "--wasm", WASM_PATH], admin.secret()));
  if (uploaded !== wasmHash) throw new AgentPassError("CommandFailed", "the uploaded wasm hash differs from the local one", { details: { uploaded, local: wasmHash } });

  const contractId = lastLine(
    await stellarCli(
      [
        "contract", "deploy", "--wasm-hash", wasmHash, "--",
        "--arbiter", arbiter.publicKey(),
        "--token", vitrinee.usdc.contractId,
        "--registry", vitrinee.receiptRegistry.contractId,
        "--claim_window", CLAIM_WINDOW_SECONDS.toString(),
      ],
      admin.secret(),
    ),
  );
  if (!StrKey.isValidContract(contractId)) throw new AgentPassError("CommandFailed", "the CLI did not return a contract id", { details: { output: contractId } });

  const live = configSchema.parse(JSON.parse(lastLine(await stellarCli(["contract", "invoke", "--id", contractId, "--send", "no", "--", "config"], admin.secret()))));
  if (live.arbiter !== arbiter.publicKey() || live.token !== vitrinee.usdc.contractId || live.registry !== vitrinee.receiptRegistry.contractId || live.claim_window !== CLAIM_WINDOW_SECONDS) {
    throw new AgentPassError("ConfigError", "the deployed contract does not match what was asked for", { details: { contractId, live } });
  }

  await writeDeployment(DEPLOYMENT_PATH, {
    ...recorded,
    protocolVersion: version.protocolVersion,
    agentResolve: {
      contractId,
      wasmHash,
      arbiter: arbiter.publicKey(),
      token: vitrinee.usdc.contractId,
      registry: vitrinee.receiptRegistry.contractId,
      claimWindowSeconds: CLAIM_WINDOW_SECONDS,
      schemaVersion: SCHEMA_VERSION,
      deployedAt: new Date().toISOString(),
      protocolVersion: version.protocolVersion,
    },
  });
  await writeEnvFile(ENV_PATH, upsertEnvValue(await readFile(ENV_PATH, "utf8"), "AGENT_RESOLVE_CONTRACT_ID", contractId));
  out(`\n  deployed     ${contractId}`);
  out(`  explorer     https://stellar.expert/explorer/testnet/contract/${contractId}\n`);
}

main().catch((error: unknown) => {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`\n${String(error)}\n`);
  }
  process.exitCode = 1;
});
