import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { MANIFEST_PATH, isVitrineeError } from "@vitrinee/core";

import { createAdapter } from "./adapters.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { seedComercioFromEnv } from "./platform/comercios.js";
import { loadPlatformSettings, type PlatformSettings } from "./platform/config.js";
import { createPlatformApp } from "./platform/platform-app.js";
import { PostgresComercioStore, PostgresOrderPersistence, createVitrineePool, migrate } from "./platform/postgres.js";
import { createSecretBox } from "./platform/secret-box.js";
import { StorefrontPool } from "./platform/storefronts.js";

/**
 * The repo root: the nearest ancestor holding pnpm-workspace.yaml. `pnpm
 * gateway` runs with the cwd set to the *package*, so resolving against
 * process.cwd() alone would miss the .env.vitrinee.local and the deployments file
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

// Secrets live in .env.vitrinee.local, gitignored. Any real environment (Render) sets
// variables directly and has no file.
const envFile = resolve(root, ".env.vitrinee.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

// The registry id is public and committed in deployments/vitrinee-testnet.json; the
// env var only overrides it.
if (process.env["RECEIPT_REGISTRY_ID"] === undefined || process.env["RECEIPT_REGISTRY_ID"] === "") {
  const deployments = resolve(root, "deployments/vitrinee-testnet.json");
  if (existsSync(deployments)) {
    const id = (JSON.parse(readFileSync(deployments, "utf8")) as { receiptRegistry?: { contractId?: string } | null }).receiptRegistry?.contractId;
    if (id !== undefined) process.env["RECEIPT_REGISTRY_ID"] = id;
  }
}

function useLocalFiles(): void {
  process.env["ORDERS_FILE"] ??= resolve(root, ".vitrinee/orders.json");
  process.env["MOCK_ORDERS_FILE"] ??= resolve(root, ".vitrinee/mock-store.json");
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...fields })}\n`);
}

/** The single-store gateway, exactly as before T103: one merchant, from the environment. */
function runSingleStore(): void {
  useLocalFiles();
  const config = loadConfig();
  const adapter = createAdapter(config, log);
  const app = createApp({ config, adapter, log });
  const resumed = app.anchors.resume();
  app.listen(config.port, () => {
    log("vitrinee gateway listening", {
      mode: "single-store",
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
}

/**
 * The multi-merchant platform (T103): comercios and orders in Vitrinee's own
 * schema (C-143), secrets sealed with the master key (VT-27), one store per
 * subdomain (C-142). The store the single-store gateway ran is registered as
 * the first comercio from the same variables, once.
 */
async function runPlatform(settings: PlatformSettings): Promise<void> {
  const pool = createVitrineePool(settings.databaseUrl);
  await migrate(pool);
  const comercios = new PostgresComercioStore(pool);
  const box = createSecretBox(settings.masterKey);
  const seeded = await seedComercioFromEnv(process.env, comercios, box, new Date());
  if (seeded !== undefined) log(seeded.created ? "seed comercio registered" : "seed comercio already registered", { slug: seeded.comercio.slug });

  const storefronts = new StorefrontPool({
    comercios,
    box,
    env: process.env,
    ordersFor: (comercio) => new PostgresOrderPersistence(pool, comercio.id),
    log,
  });
  const app = createPlatformApp({ platformHost: settings.platformHost, pool: storefronts, comercios, rootComercio: settings.rootComercio, log });
  const listed = await comercios.list();
  app.listen(settings.port, () => {
    log("vitrinee platform listening", {
      mode: "platform",
      port: settings.port,
      platformHost: settings.platformHost,
      rootComercio: settings.rootComercio ?? null,
      comercios: listed.map((c) => c.slug),
      manifest: MANIFEST_PATH,
    });
  });
}

function fail(error: unknown): never {
  if (isVitrineeError(error)) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`startup failed: ${String(error)}\n`);
  }
  process.exit(1);
}

try {
  const settings = loadPlatformSettings(process.env);
  if (settings === undefined) runSingleStore();
  else runPlatform(settings).catch(fail);
} catch (error) {
  fail(error);
}
