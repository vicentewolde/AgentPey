/**
 * RealOps' entrypoint.
 *
 * It holds **no Stellar key**. The only credential it will ever carry is an
 * AgentPey `/v1` API key (from T81), which buys it exactly one power: asking.
 * Worth stating here because this is the file where an operator looks to see
 * what a service can do, and the honest answer is "less than you would expect".
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createAgentPeyClient } from "./agentpey.js";
import { createRealOpsServer, type MagicLinkDelivery } from "./app.js";
import { createMemoryStore, EMAIL_RETENTION_DAYS, type RealOpsStore } from "./accounts.js";
import { createPostgresStore, REALOPS_SCHEMA_SQL, sweepExpired, sweepStaleEmails, type SqlClient } from "./store-postgres.js";
import type { PilotTargets } from "./permissions.js";

const ENV_PATH = fileURLToPath(new URL("../../../.env.local", import.meta.url));
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  const first = raw[0];
  const quoted = raw.length >= 2 && (first === '"' || first === "'") && raw.at(-1) === first;
  if (!quoted) return raw;
  const inner = raw.slice(1, -1);
  return first === '"' ? inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\") : inner;
}

async function readEnv(): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  try {
    for (const line of (await readFile(ENV_PATH, "utf8")).split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const match = LINE.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      values.set(match[1], unquote(match[2]));
    }
  } catch {
    // Deployed: process.env carries everything.
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== "") values.set(key, value);
  }
  return values;
}

const env = await readEnv();
const port = Number(env.get("PORT") ?? 4040);
const baseUrl = env.get("REALOPS_PUBLIC_URL") ?? `http://localhost:${port}`;
const signalDeskUrl = env.get("SIGNALDESK_PUBLIC_URL") ?? "https://agentpey-signaldesk.onrender.com";

/**
 * The venue, asset and payout the pilot's grants name. Read from configuration
 * rather than hardcoded, but note what this does *not* buy: RealOps naming a
 * different venue would only produce a grant AgentPey refuses, because AgentPey
 * resolves the venue against its own `venues.json` and never against this.
 */
const targets: PilotTargets = {
  venueId: env.get("PILOT_VENUE_ID") ?? "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  assetId: env.get("PILOT_ASSET_ID") ?? "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: env.get("PILOT_PAY_TO") ?? "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
  products: {
    market_brief: ["signaldesk:market-brief-xlm-usdc"],
    ai_credits: ["signaldesk:ai-credits-1000"],
  },
};

async function buildStore(): Promise<{ store: RealOpsStore; client?: SqlClient }> {
  const connectionString = env.get("DATABASE_URL");
  if (connectionString === undefined || connectionString === "") {
    process.stdout.write("RealOps: no DATABASE_URL — in-memory storage, everything is lost on restart\n");
    return { store: createMemoryStore() };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => {
    process.stderr.write(`RealOps: idle Postgres client failed: ${error.message}\n`);
  });
  for (const statement of REALOPS_SCHEMA_SQL) await pool.query(statement);
  return { store: createPostgresStore(pool), client: pool };
}

const resendKey = env.get("RESEND_API_KEY");
const delivery: MagicLinkDelivery =
  resendKey === undefined || resendKey === ""
    ? { mode: "onscreen" }
    : {
        mode: "email",
        send: async (email, link) => {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              from: env.get("REALOPS_MAIL_FROM") ?? "RealOps <no-reply@agentpey.com>",
              to: [email],
              subject: "Tu enlace para entrar a RealOps",
              // Only a link. Never an artefact, never a receipt, never
              // anything worth intercepting (`PILOTO-F9.md` § 7.1).
              text: `Entrá con este enlace. Dura 15 minutos y sirve una sola vez:\n\n${link}\n`,
            }),
          });
          if (!response.ok) {
            throw new Error(`Resend rejected the message: ${response.status}`);
          }
        },
      };

const { store, client } = await buildStore();

/**
 * The only credential RealOps holds. Without it the screens still work and
 * the sign button says so — a platform that cannot reach AgentPey is a
 * platform that cannot get anything authorised, which is the correct
 * failure.
 */
const partnerKey = env.get("REALOPS_AGENTPEY_API_KEY");
const agentpeyBaseUrl = env.get("AGENTPEY_BASE_URL") ?? "https://agentpey-web.onrender.com";
const agentpey =
  partnerKey === undefined || partnerKey === ""
    ? undefined
    : createAgentPeyClient({ baseUrl: agentpeyBaseUrl, apiKey: partnerKey });

const server = createRealOpsServer({
  store,
  agentpey,
  agentpeyBaseUrl,
  targets,
  signalDeskUrl,
  baseUrl,
  delivery,
  secureCookies: baseUrl.startsWith("https://"),
});

server.listen(port, () => {
  process.stdout.write(`RealOps · ${baseUrl} · magic links: ${delivery.mode}\n`);
  process.stdout.write(
    agentpey === undefined
      ? "  (no REALOPS_AGENTPEY_API_KEY: signing is disabled)\n"
      : `  AgentPey: ${agentpeyBaseUrl}\n`,
  );
  if (delivery.mode === "onscreen") {
    process.stdout.write("  (no RESEND_API_KEY: links are shown on screen and email is NOT verified)\n");
  }
});

if (client !== undefined) {
  const sweep = setInterval(() => {
    void (async () => {
      try {
        const { links, sessions } = await sweepExpired(client, new Date());
        const emails = await sweepStaleEmails(client, new Date(), EMAIL_RETENTION_DAYS);
        if (links + sessions + emails > 0) {
          process.stdout.write(`RealOps sweep: ${links} links, ${sessions} sessions, ${emails} emails erased\n`);
        }
      } catch (error) {
        process.stderr.write(`RealOps sweep failed: ${error instanceof Error ? error.message : "unknown"}\n`);
      }
    })();
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
}
