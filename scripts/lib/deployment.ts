/**
 * `deployments/testnet.json` — the one artifact shared by TypeScript and
 * Rust. Written only by deploy scripts; a redeploy is always explicit.
 */
import { readFile, writeFile } from "node:fs/promises";

export interface ReceiptRegistryDeployment {
  contractId: string;
  /** SHA-256 of the deployed wasm, lowercase hex: what Stellar keys uploads by. */
  wasmHash: string;
  /** Pays for the deploy. Has no power over the contract, which has no admin (V-3). */
  deployer: string;
  schemaVersion: number;
  uploadTxHash: string | null;
  deployTxHash: string;
  deployedAt: string;
  protocolVersion: number;
}

export interface Deployment {
  network: "testnet";
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  protocolVersion: number;
  usdc: { code: string; issuer: string; contractId: string; decimals: number };
  facilitator: { name: string; url: string };
  receiptRegistry: ReceiptRegistryDeployment | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseDeployment(raw: unknown): Deployment {
  const d = raw as Deployment;
  if (d === null || typeof d !== "object" || d.network !== "testnet" || typeof d.rpcUrl !== "string") {
    throw new Error("deployments/testnet.json is not a testnet deployment file");
  }
  const r = d.receiptRegistry;
  if (r !== null && r !== undefined) {
    if (!/^C[A-Z2-7]{55}$/.test(r.contractId) || !HEX64.test(r.wasmHash) || !HEX64.test(r.deployTxHash)) {
      throw new Error("deployments/testnet.json → receiptRegistry is malformed; fix it by hand, never guess");
    }
  }
  return { ...d, receiptRegistry: r ?? null };
}

export async function readDeployment(path: string): Promise<Deployment> {
  return parseDeployment(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function writeDeployment(path: string, deployment: Deployment): Promise<void> {
  await writeFile(path, JSON.stringify(deployment, null, 2) + "\n");
}
