/**
 * The Stellar CLI, for scripts that deploy or invoke contracts. Secrets reach
 * it through the environment (`STELLAR_ACCOUNT`), never argv, so they cannot
 * be read out of the process list; and a failure never echoes the
 * environment. Same rules `deploy-policy-rail.ts` follows with its own copy.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AgentPassError } from "@agentpass/core";

import { TESTNET } from "./network.js";

const execFileAsync = promisify(execFile);
const CONTRACTS_DIR = resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts");

/** Runs `stellar <args>` against testnet as the account whose secret is `secret`; returns stdout. */
export async function stellarCli(args: readonly string[], secret: string): Promise<string> {
  return (await stellarCliFull(args, secret)).stdout;
}

/**
 * Same, also returning the hash of the transaction the CLI submitted, read
 * from its log (`--send no` and read-only calls submit nothing: `undefined`).
 */
export async function stellarCliTx(args: readonly string[], secret: string): Promise<{ result: string; txHash: string | undefined }> {
  const { stdout, stderr } = await stellarCliFull(args, secret);
  const txHash = /Signing transaction: ([0-9a-f]{64})/.exec(stderr)?.[1] ?? /transaction(?:\/| )([0-9a-f]{64})/i.exec(stderr)?.[1];
  return { result: lastLine(stdout === "" ? "null" : stdout), txHash };
}

async function stellarCliFull(args: readonly string[], secret: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("stellar", [...args], {
      cwd: CONTRACTS_DIR,
      env: {
        ...process.env,
        STELLAR_ACCOUNT: secret,
        STELLAR_NETWORK: TESTNET.network,
        STELLAR_RPC_URL: TESTNET.rpcUrl,
        STELLAR_NETWORK_PASSPHRASE: TESTNET.passphrase,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new AgentPassError("CommandFailed", `stellar ${args.slice(0, 6).join(" ")} failed`, {
      cause: error,
      details: { command: `stellar ${args.join(" ")}`, stderr: stderr.slice(-2000) },
    });
  }
}

/** The last non-empty line of CLI output: where `deploy`, `upload` and `invoke` print their result. */
export function lastLine(output: string): string {
  const last = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  if (last === undefined) throw new AgentPassError("CommandFailed", "the Stellar CLI produced no output");
  return last;
}

export const CONTRACTS_ROOT = CONTRACTS_DIR;
