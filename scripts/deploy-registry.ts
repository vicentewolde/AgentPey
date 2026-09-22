#!/usr/bin/env node
/**
 * `pnpm deploy:registry` — build, upload, deploy and verify receipt-registry,
 * then record it in deployments/testnet.json and .env.local.
 *
 * Re-runnable: when the recorded contract is live and runs exactly the wasm
 * the source builds to, this does nothing and says so. Any difference stops
 * the script and asks for `--redeploy`, because a redeploy is a **new
 * contract id**: every receipt anchored in the old one stays there, and
 * verifiers pointed at the new one will not find them.
 *
 * Paid for by MERCHANT_SIGNING_SECRET (it already holds XLM). The deployer
 * gets no power over the contract: there is no admin (V-3).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";

import { ReceiptRegistryClient } from "../packages/anchor/src/index.js";
import { readDeployment, writeDeployment, type ReceiptRegistryDeployment } from "./lib/deployment.js";
import { readEnvFile, upsertEnv, writeEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const WASM_PATH = resolve(CONTRACTS_DIR, "target/wasm32v1-none/release/receipt_registry.wasm");
const SCHEMA_VERSION = 1;

const REDEPLOY = process.argv.slice(2).includes("--redeploy");
const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function build(): Promise<Buffer> {
  try {
    await execFileAsync("stellar", ["contract", "build", "--package", "receipt-registry"], { cwd: CONTRACTS_DIR, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`stellar contract build failed:\n${stderr.slice(-2000)}`);
  }
  return readFile(WASM_PATH);
}

async function submit(server: rpc.Server, signer: Keypair, op: xdr.Operation): Promise<rpc.Api.GetSuccessfulTransactionResponse & { hash: string }> {
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`submission ${sent.status} (${sent.hash})`);
  }
  const final = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ended ${final.status}`);
  }
  return { ...final, hash: sent.hash };
}

async function main(): Promise<void> {
  const { content, values } = await readEnvFile(ENV_PATH);
  const secret = values.get("MERCHANT_SIGNING_SECRET");
  if (secret === undefined || secret === "") throw new Error("MERCHANT_SIGNING_SECRET is missing from .env.local — run `pnpm bootstrap` first");
  const deployer = Keypair.fromSecret(secret);
  const server = new rpc.Server(TESTNET.rpcUrl);
  const deployment = await readDeployment(DEPLOYMENT_PATH);

  out();
  out("Vitrinee · receipt-registry · Stellar testnet");
  out(`  rpc        ${TESTNET.rpcUrl}`);
  out(`  deployer   ${deployer.publicKey()}  (MERCHANT_SIGNING_ACCOUNT)`);

  const wasm = await build();
  const wasmHash = sha256(wasm);
  out(`  wasm       ${wasm.length} bytes · sha256 ${wasmHash}`);

  const recorded = deployment.receiptRegistry;
  if (recorded !== null && !REDEPLOY) {
    const live = sha256(await server.getContractWasmByContractId(recorded.contractId));
    if (live === wasmHash) {
      out(`  contract   ${recorded.contractId}  (recorded, live, same wasm — nothing to do)`);
      await writeEnvFile(ENV_PATH, upsertEnv(content, [{ key: "RECEIPT_REGISTRY_ID", value: recorded.contractId }], "written by pnpm deploy:registry"));
      out();
      return;
    }
    throw new Error(
      `the recorded contract ${recorded.contractId} runs wasm ${live}, the source builds ${wasmHash}.\n` +
        "A redeploy creates a NEW contract id; receipts anchored in the old one stay there. Re-run with --redeploy if that is what you want.",
    );
  }

  const latest = await server.getLatestLedger();
  const protocolVersion = Number(latest.protocolVersion);
  out(`  protocol   ${protocolVersion}`);

  let uploadTxHash: string | null = null;
  try {
    const uploaded = await submit(server, deployer, Operation.uploadContractWasm({ wasm }));
    uploadTxHash = uploaded.hash;
    out(`  upload     tx ${uploaded.hash}`);
  } catch (error) {
    // Uploading identical code twice is refused by simulation on some RPCs; the code is then already there.
    const message = error instanceof Error ? error.message : String(error);
    if (!/exist/i.test(message)) throw error;
    out("  upload     wasm already on chain, reusing it");
  }

  const created = await submit(
    server,
    deployer,
    Operation.createCustomContract({ address: new Address(deployer.publicKey()), wasmHash: Buffer.from(wasmHash, "hex"), salt: randomBytes(32) }),
  );
  const contractId = scValToNative(created.returnValue!) as string;
  out(`  deploy     tx ${created.hash}`);
  out(`  contract   ${contractId}`);

  // Verify with the client the gateway will use: an unknown hash reads null, the count reads 0.
  const client = new ReceiptRegistryClient({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });
  const probe = await client.get("0".repeat(64));
  const count = await client.count(deployer.publicKey());
  if (probe !== null || count !== 0) throw new Error(`fresh contract answered unexpectedly: get=${JSON.stringify(probe)} count=${count}`);
  const liveHash = sha256(await server.getContractWasmByContractId(contractId));
  if (liveHash !== wasmHash) throw new Error(`deployed contract runs ${liveHash}, expected ${wasmHash}`);
  out("  verified   get(unknown) = null · count(deployer) = 0 · live wasm matches");

  const record: ReceiptRegistryDeployment = {
    contractId,
    wasmHash,
    deployer: deployer.publicKey(),
    schemaVersion: SCHEMA_VERSION,
    uploadTxHash,
    deployTxHash: created.hash,
    deployedAt: new Date().toISOString(),
    protocolVersion,
  };
  await writeDeployment(DEPLOYMENT_PATH, { ...deployment, protocolVersion, receiptRegistry: record });
  await writeEnvFile(ENV_PATH, upsertEnv(content, [{ key: "RECEIPT_REGISTRY_ID", value: contractId, comment: "receipt-registry on testnet (deployments/testnet.json)" }], "written by pnpm deploy:registry"));
  out(`  wrote      deployments/testnet.json · .env.local RECEIPT_REGISTRY_ID`);
  out(`  explorer   https://stellar.expert/explorer/testnet/contract/${contractId}`);
  out();
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\ndeploy:registry failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
