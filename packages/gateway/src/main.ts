import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { MockStoreAdapter, type StoreAdapter } from "@vitrinee/adapters";
import { MANIFEST_PATH, isVitrineeError } from "@vitrinee/core";

import { createApp } from "./app.js";
import { loadConfig, type GatewayConfig } from "./config.js";

// Secrets live in .env.local, gitignored. Any real environment (Render) sets
// variables directly and has no file.
const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function createAdapter(config: GatewayConfig): StoreAdapter {
  switch (config.adapter) {
    case "mock":
      return new MockStoreAdapter({ ordersFile: config.mockOrdersFile });
  }
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...fields })}\n`);
}

try {
  const config = loadConfig();
  const adapter = createAdapter(config);
  const app = createApp({ config, adapter, log });
  app.listen(config.port, () => {
    log("vitrinee gateway listening", {
      port: config.port,
      adapter: adapter.name,
      merchant: config.merchant.stellarAccount,
      facilitator: config.facilitator.url,
      facilitatorKey: config.facilitator.apiKey === undefined ? "missing" : "set",
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
