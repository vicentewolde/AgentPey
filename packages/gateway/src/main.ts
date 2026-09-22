import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { JumpsellerStoreAdapter, MockStoreAdapter, type StoreAdapter } from "@vitrinee/adapters";
import { MANIFEST_PATH, VitrineeError, isVitrineeError } from "@vitrinee/core";

import { createApp } from "./app.js";
import { loadConfig, type GatewayConfig } from "./config.js";

/**
 * The repo root: the nearest ancestor holding pnpm-workspace.yaml. `pnpm
 * gateway` runs with the cwd set to the *package*, so resolving against
 * process.cwd() alone would miss the .env.local and the deployments file
 * that both live at the root.
 */
function repoRoot(from = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const root = repoRoot();

// Secrets live in .env.local, gitignored. Any real environment (Render) sets
// variables directly and has no file.
const envFile = resolve(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

// The registry id is public and committed in deployments/testnet.json; the
// env var only overrides it.
if (process.env["RECEIPT_REGISTRY_ID"] === undefined || process.env["RECEIPT_REGISTRY_ID"] === "") {
  const deployments = resolve(root, "deployments/testnet.json");
  if (existsSync(deployments)) {
    const id = (JSON.parse(readFileSync(deployments, "utf8")) as { receiptRegistry?: { contractId?: string } | null }).receiptRegistry?.contractId;
    if (id !== undefined) process.env["RECEIPT_REGISTRY_ID"] = id;
  }
}
process.env["ORDERS_FILE"] ??= resolve(root, ".vitrinee/orders.json");
process.env["MOCK_ORDERS_FILE"] ??= resolve(root, ".vitrinee/mock-store.json");

function createAdapter(config: GatewayConfig): StoreAdapter {
  switch (config.adapter) {
    case "mock":
      return new MockStoreAdapter({ ordersFile: config.mockOrdersFile });
    case "jumpseller": {
      if (config.jumpseller === undefined) {
        throw new VitrineeError("ConfigError", "ADAPTER=jumpseller needs JUMPSELLER_LOGIN and JUMPSELLER_AUTHTOKEN");
      }
      return new JumpsellerStoreAdapter({
        credentials: config.jumpseller,
        currency: config.merchant.currency,
        onWarning: (message, details) => log(message, details),
      });
    }
  }
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...fields })}\n`);
}

try {
  const config = loadConfig();
  const adapter = createAdapter(config);
  const app = createApp({ config, adapter, log });
  const resumed = app.anchors.resume();
  app.listen(config.port, () => {
    log("vitrinee gateway listening", {
      port: config.port,
      adapter: adapter.name,
      merchant: config.merchant.stellarAccount,
      signing: config.signing.account,
      receiptRegistry: config.receiptRegistryId,
      facilitator: config.facilitator.url,
      facilitatorKey: config.facilitator.apiKey === undefined ? "missing" : "set",
      anchorsResumed: resumed,
      manifest: MANIFEST_PATH,
    });
  });
} catch (error) {
  if (isVitrineeError(error)) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`startup failed: ${String(error)}\n`);
  }
  process.exit(1);
}
