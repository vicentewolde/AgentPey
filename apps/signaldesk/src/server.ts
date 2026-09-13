/**
 * SignalDesk's entrypoint: reads its own configuration and starts the merchant.
 *
 * Its keys are its own and never AgentPey's. `SIGNALDESK_SECRET_KEY` signs
 * receipts and is the account it is paid at; `SIGNALDESK_FACILITATOR_SECRET`
 * submits settlement to the network. Neither is ever an AgentPey key, and this
 * process reads no AgentPey variable other than the database URL it is pointed
 * at — which the pilot shares only because Render gives one instance.
 */
import { fileURLToPath } from "node:url";

import { AgentPassError } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";

import { readEnv } from "./env.js";
import { startSignalDesk } from "./merchant.js";
import { createMemoryStore, createPostgresStore, SIGNALDESK_SCHEMA_SQL, type SignalDeskStore } from "./store.js";

const ENV_PATH = fileURLToPath(new URL("../../../.env.local", import.meta.url));

function require(env: Map<string, string>, key: string): string {
  const value = env.get(key);
  if (value === undefined || value === "") {
    throw new AgentPassError("ConfigError", `${key} is required to run SignalDesk`, { details: { key } });
  }
  return value;
}

async function buildStore(env: Map<string, string>): Promise<SignalDeskStore> {
  const connectionString = env.get("DATABASE_URL");
  if (connectionString === undefined || connectionString === "") {
    process.stdout.write("SignalDesk: no DATABASE_URL — running with in-memory storage (deliveries are lost on restart)\n");
    return createMemoryStore();
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => {
    process.stderr.write(`SignalDesk: idle Postgres client failed: ${error.message}\n`);
  });
  for (const statement of SIGNALDESK_SCHEMA_SQL) await pool.query(statement);
  return createPostgresStore(pool);
}

const env = await readEnv(ENV_PATH);
const merchantSecret = require(env, "SIGNALDESK_SECRET_KEY");
const merchantPayTo = Keypair.fromSecret(merchantSecret).publicKey();

const { port } = await startSignalDesk(
  {
    merchantPayTo,
    merchantSecret,
    facilitatorSecret: require(env, "SIGNALDESK_FACILITATOR_SECRET"),
    port: Number(env.get("PORT") ?? 4030),
    publicUrl: env.get("SIGNALDESK_PUBLIC_URL"),
  },
  { store: await buildStore(env) },
);

process.stdout.write(`SignalDesk · paid at ${merchantPayTo} · http://localhost:${port}\n`);
