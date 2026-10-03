import { readFile, writeFile } from "node:fs/promises";

import { AgentPassError, stellarAddressSchema, stellarContractIdSchema } from "@agentpass/core";
import { z } from "zod";

import { TESTNET } from "./network.js";

export const agentRegistryDeploymentSchema = z.strictObject({
  contractId: stellarContractIdSchema,
  /** SHA-256 of the deployed wasm, hex — the same value Stellar keys uploads by. */
  wasmHash: z.string().regex(/^[0-9a-f]{64}$/),
  admin: stellarAddressSchema,
  schemaVersion: z.number().int().nonnegative(),
  deployedAt: z.iso.datetime(),
  /** The network's protocol version at deploy time. */
  protocolVersion: z.number().int().positive(),
});

/**
 * The `policy_rail` smart account (T22/T31). Its limits are recorded as the
 * decimal strings the rest of the project speaks, not as stroops: the contract
 * is the authority on the scaled values, this file is what a human reads.
 */
export const policyRailDeploymentSchema = z.strictObject({
  contractId: stellarContractIdSchema,
  wasmHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The Ed25519 key whose signature `__check_auth` accepts — the agent's. */
  owner: stellarAddressSchema,
  /**
   * The wallet with the last word over the rail: the only one that can
   * `withdraw` its balance or rotate `owner` (T57, `C-61`). Nullable only for
   * the one rail deployed before that constructor existed — the shared pilot
   * rail, which has no `principal` on chain to record. Every rail deployed
   * from here on writes a real address.
   */
  principal: stellarAddressSchema.nullable().default(null),
  /** The one SEP-41 token this rail can move. */
  asset: stellarContractIdSchema,
  perTx: z.string().min(1),
  perDay: z.string().min(1),
  validUntil: z.iso.datetime(),
  deployedAt: z.iso.datetime(),
  protocolVersion: z.number().int().positive(),
});

/** AgentResolve (T124, `E-14` to `E-19`): merchant guarantees and disputes over Vitrinee receipts. */
export const agentResolveDeploymentSchema = z.strictObject({
  contractId: stellarContractIdSchema,
  wasmHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The only account that opens and resolves disputes (`E-16`). */
  arbiter: stellarAddressSchema,
  /** USDC: the asset guarantees are held and refunds paid in. */
  token: stellarContractIdSchema,
  /** Vitrinee's `receipt-registry`, which this contract reads. */
  registry: stellarContractIdSchema,
  claimWindowSeconds: z.number().int().positive(),
  schemaVersion: z.number().int().nonnegative(),
  deployedAt: z.iso.datetime(),
  protocolVersion: z.number().int().positive(),
});

export const deploymentSchema = z.strictObject({
  network: z.literal("testnet"),
  networkPassphrase: z.string().min(1),
  rpcUrl: z.string().min(1),
  protocolVersion: z.number().int().positive().nullable(),
  agentRegistry: agentRegistryDeploymentSchema.nullable(),
  policyRail: policyRailDeploymentSchema.nullable().default(null),
  /** The rail that pays UCP purchases (T122): same contract, its own instance and limits. */
  policyRailUcp: policyRailDeploymentSchema.nullable().default(null),
  /** T128 (R-9): the MCP server's own rail, owned by its agent key. */
  policyRailMcp: policyRailDeploymentSchema.nullable().default(null),
  agentResolve: agentResolveDeploymentSchema.nullable().default(null),
});

export type Deployment = z.infer<typeof deploymentSchema>;
export type AgentRegistryDeployment = z.infer<typeof agentRegistryDeploymentSchema>;
export type PolicyRailDeployment = z.infer<typeof policyRailDeploymentSchema>;
export type AgentResolveDeployment = z.infer<typeof agentResolveDeploymentSchema>;

export const EMPTY_DEPLOYMENT: Deployment = {
  network: "testnet",
  networkPassphrase: TESTNET.passphrase,
  rpcUrl: TESTNET.rpcUrl,
  protocolVersion: null,
  agentRegistry: null,
  policyRail: null,
  policyRailUcp: null,
  policyRailMcp: null,
  agentResolve: null,
};

export async function readDeployment(path: string): Promise<Deployment> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_DEPLOYMENT;
    throw new AgentPassError("ConfigError", `could not read ${path}`, {
      cause: error,
      details: { path },
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AgentPassError("ConfigError", `${path} is not valid JSON`, {
      cause: error,
      details: { path },
    });
  }

  const parsed = deploymentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", `${path} does not match the deployment schema`, {
      details: { path, issues: z.treeifyError(parsed.error) },
    });
  }
  return parsed.data;
}

export async function writeDeployment(path: string, deployment: Deployment): Promise<void> {
  // Validate on the way out too: this file is the only artefact the TypeScript
  // and Rust halves of the repo share, so a malformed write is expensive.
  const parsed = deploymentSchema.safeParse(deployment);
  if (!parsed.success) {
    throw new AgentPassError("ConfigError", "refusing to write a malformed deployment record", {
      details: { issues: z.treeifyError(parsed.error) },
    });
  }

  await writeFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
}
