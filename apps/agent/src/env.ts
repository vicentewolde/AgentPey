import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The repo root: the nearest ancestor holding pnpm-workspace.yaml. */
export function repoRoot(from = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

export function loadRepoEnv(): void {
  const file = resolve(repoRoot(), ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** RECEIPT_REGISTRY_ID, else the id committed in deployments/testnet.json. */
export function registryId(): string | undefined {
  const fromEnv = process.env["RECEIPT_REGISTRY_ID"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const file = resolve(repoRoot(), "deployments/testnet.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { receiptRegistry?: { contractId?: string } | null }).receiptRegistry?.contractId;
}

export const LAST_RECEIPT_PATH = (): string => resolve(repoRoot(), ".vitrinee/last-receipt.jws");
