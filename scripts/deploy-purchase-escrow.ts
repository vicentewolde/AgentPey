#!/usr/bin/env node
/**
 * `pnpm run deploy:purchase-escrow` — deploy a store's PurchaseEscrow (T157):
 * the contract that holds an agent purchase until it ships, and releases or
 * refunds it by its own deadlines. One per store (`X-11`).
 *
 *   --store <slug>   the store's escrow. Its signing account (operator) and
 *                    payout account (payee) are read from the store's live UCP
 *                    profile, never typed by hand (`X-4`).
 *   --rehearsal      an escrow whose operator and payee are this repo's ADMIN
 *                    and ISSUER keys: it proves the contract on testnet without
 *                    the store's own signing key. Opens ISSUER's USDC trustline
 *                    if it is missing, so a release can reach it.
 *   --release, --response, --resolve <seconds>   the three windows, required:
 *                    they are fixed for the contract's life (`X-6`).
 *
 * The arbiter is AgentResolve's (`RESOLVE_ARBITER_SECRET_KEY`, `E-16`). The
 * deployer pays fees from `ADMIN_SECRET_KEY`. Re-runnable: a recorded escrow
 * built from the same wasm is left alone; different wasm stops and asks for
 * `--redeploy`, because that is a new contract id and the old one keeps
 * whatever it holds.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { escrowSlugSchema, readDeployment, writeDeployment } from "./lib/deployment.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET, getLiveVersion, getTrustline, openTrustline } from "./lib/network.js";
import { escrowConfigSchema, parseWindows, storeAccountsFromProfile, type StoreAccounts } from "./lib/purchase-escrow.js";
import { CONTRACTS_ROOT, lastLine, stellarCli } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const VITRINEE_DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/vitrinee-testnet.json");
const WASM_PATH = resolve(CONTRACTS_ROOT, "target/wasm32v1-none/release/purchase_escrow.wasm");
const SCHEMA_VERSION = 1;
const REHEARSAL_SLUG = "rehearsal";
const ARGV = process.argv.slice(2);
const REDEPLOY = ARGV.includes("--redeploy");

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key } });
  return value;
}

function target(): { slug: string; rehearsal: boolean } {
  const rehearsal = ARGV.includes("--rehearsal");
  const at = ARGV.indexOf("--store");
  const store = at === -1 ? undefined : ARGV[at + 1];
  if (rehearsal === (store !== undefined)) {
    throw new AgentPassError("InvalidArguments", "pass exactly one of --store <slug> or --rehearsal", { details: { argv: ARGV } });
  }
  if (rehearsal) return { slug: REHEARSAL_SLUG, rehearsal };
  const slug = escrowSlugSchema.safeParse(store);
  if (!slug.success || slug.data === REHEARSAL_SLUG) throw new AgentPassError("InvalidArguments", "--store takes a store slug", { details: { store: store ?? null } });
  return { slug: slug.data, rehearsal };
}

/** The store's accounts, as its live profile declares them. */
async function storeAccounts(slug: string): Promise<StoreAccounts> {
  const url = `https://${slug}.vitrinee.agentpey.com/.well-known/ucp`;
  const response = await fetch(url).catch((error: unknown) => {
    throw new AgentPassError("NetworkError", `could not read ${url}`, { cause: error, details: { url } });
  });
  if (!response.ok) throw new AgentPassError("NetworkError", `${url} answered ${response.status}`, { details: { url, status: response.status } });
  return storeAccountsFromProfile(await response.json());
}

async function main(): Promise<void> {
  const { slug, rehearsal } = target();
  const windows = parseWindows(ARGV);
  const env = await readEnvFile(ENV_PATH);
  const admin = Keypair.fromSecret(requireEnv(env, "ADMIN_SECRET_KEY"));
  const arbiter = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY")).publicKey();
  const vitrinee = z
    .object({ usdc: z.object({ code: z.string(), issuer: z.string(), contractId: z.string() }) })
    .parse(JSON.parse(await readFile(VITRINEE_DEPLOYMENT_PATH, "utf8")));
  const token = vitrinee.usdc.contractId;
  const accounts: StoreAccounts = rehearsal
    ? { operator: admin.publicKey(), payee: Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY")).publicKey() }
    : await storeAccounts(slug);
  const [version, recorded] = await Promise.all([getLiveVersion(TESTNET.rpcUrl), readDeployment(DEPLOYMENT_PATH)]);

  out(`\nAgentPey deploy:purchase-escrow · ${slug} · Stellar testnet\n`);
  out(`  protocol     ${version.protocolVersion}`);
  out(`  deployer     ${admin.publicKey()}`);
  out(`  operator     ${accounts.operator} (signing account: hold, mark_shipped)`);
  out(`  payee        ${accounts.payee} (payout account: respond, releases)`);
  out(`  arbiter      ${arbiter}`);
  out(`  token        ${token} (USDC)`);
  out(`  windows      release ${windows.releaseWindowSeconds} s · response ${windows.responseWindowSeconds} s · resolve ${windows.resolveWindowSeconds} s\n`);

  if (rehearsal) {
    const line = await getTrustline(TESTNET.horizonUrl, accounts.payee, vitrinee.usdc.code, vitrinee.usdc.issuer);
    if (!line.exists) {
      const hash = await openTrustline({
        horizonUrl: TESTNET.horizonUrl,
        networkPassphrase: TESTNET.passphrase,
        source: Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY")),
        code: vitrinee.usdc.code,
        issuer: vitrinee.usdc.issuer,
      });
      out(`  trustline    USDC opened on the payee · ${hash}`);
    }
  }

  await stellarCli(["contract", "build", "--package", "purchase-escrow"], admin.secret());
  const wasm = await readFile(WASM_PATH);
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  out(`  wasm         ${wasm.byteLength} bytes · ${wasmHash.slice(0, 16)}…`);

  const previous = recorded.purchaseEscrows[slug];
  if (previous !== undefined && !REDEPLOY) {
    if (previous.wasmHash !== wasmHash) {
      throw new AgentPassError("ConfigError", "the source builds a different wasm than the deployed escrow; re-run with --redeploy", {
        details: { deployed: previous.wasmHash, built: wasmHash, warning: "a redeploy creates a NEW contract id; the old one keeps what it holds" },
      });
    }
    out(`\n  already deployed: ${previous.contractId}`);
    return;
  }

  const uploaded = lastLine(await stellarCli(["contract", "upload", "--wasm", WASM_PATH], admin.secret()));
  if (uploaded !== wasmHash) throw new AgentPassError("CommandFailed", "the uploaded wasm hash differs from the local one", { details: { uploaded, local: wasmHash } });

  const contractId = lastLine(
    await stellarCli(
      [
        "contract", "deploy", "--wasm-hash", wasmHash, "--",
        "--operator", accounts.operator,
        "--payee", accounts.payee,
        "--arbiter", arbiter,
        "--token", token,
        "--release_window", windows.releaseWindowSeconds.toString(),
        "--response_window", windows.responseWindowSeconds.toString(),
        "--resolve_window", windows.resolveWindowSeconds.toString(),
      ],
      admin.secret(),
    ),
  );
  if (!StrKey.isValidContract(contractId)) throw new AgentPassError("CommandFailed", "the CLI did not return a contract id", { details: { output: contractId } });

  const live = escrowConfigSchema.parse(JSON.parse(lastLine(await stellarCli(["contract", "invoke", "--id", contractId, "--send", "no", "--", "config"], admin.secret()))));
  const asked = { ...accounts, arbiter, token, release_window: windows.releaseWindowSeconds, response_window: windows.responseWindowSeconds, resolve_window: windows.resolveWindowSeconds };
  if (JSON.stringify(live) !== JSON.stringify({ ...live, ...asked })) {
    throw new AgentPassError("ConfigError", "the deployed escrow does not match what was asked for", { details: { contractId, live, asked } });
  }

  await writeDeployment(DEPLOYMENT_PATH, {
    ...recorded,
    protocolVersion: version.protocolVersion,
    purchaseEscrows: {
      ...recorded.purchaseEscrows,
      [slug]: {
        contractId,
        wasmHash,
        operator: accounts.operator,
        payee: accounts.payee,
        arbiter,
        token,
        ...windows,
        schemaVersion: SCHEMA_VERSION,
        deployedAt: new Date().toISOString(),
        protocolVersion: version.protocolVersion,
      },
    },
  });
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
