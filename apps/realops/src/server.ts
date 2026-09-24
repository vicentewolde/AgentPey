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
import { createBazaarCatalog } from "./bazaar-catalog.js";
import { createStorefrontDirectory } from "./storefronts.js";

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
const signalDeskUrl = env.get("SIGNALDESK_PUBLIC_URL") ?? "https://signaldesk.agentpey.com";

/**
 * The USDC every venue in the pilot quotes: the Stellar Asset Contract, not a
 * classic `G…` issuer.
 *
 * **Checked against the live 402, not copied from `venues.json` (T96).** The
 * bazaar's own `bazaar.ts` warns that its asset id is a different object from
 * the mock's, and the warning is right — but it contrasts the bazaar with the
 * *mock*, whose USDC is a classic issuer. Against SignalDesk there is no
 * divergence: the bazaar's `GET /api/x402/swap-risk` answered `402` naming this
 * exact contract. `ids.ts` compares byte for byte, so this was verified rather
 * than assumed before it went into a grant anybody signs.
 */
const PILOT_ASSET_ID = env.get("PILOT_ASSET_ID") ?? "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * What each kind of agent is pointed at. Read from configuration rather than
 * hardcoded, but note what this does *not* buy: RealOps naming a different
 * venue would only produce a grant AgentPey refuses, because AgentPey resolves
 * the venue against its own `venues.json` and never against this.
 *
 * Two merchants now, not one (T96). Each kind is one venue, and a grant names
 * one venue, so the SignalDesk agents and the bazaar agent hold genuinely
 * different powers — which is the thing the catalogue screen is there to show.
 */
const targets: PilotTargets = {
  market_brief: {
    venueId: env.get("PILOT_VENUE_ID") ?? "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
    assetId: PILOT_ASSET_ID,
    payTo: [env.get("PILOT_PAY_TO") ?? "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
    products: ["signaldesk:market-brief-xlm-usdc"],
  },
  ai_credits: {
    venueId: env.get("PILOT_VENUE_ID") ?? "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
    assetId: PILOT_ASSET_ID,
    payTo: [env.get("PILOT_PAY_TO") ?? "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF"],
    products: ["signaldesk:ai-credits-1000"],
  },
  /**
   * The ambassador's bazaar. Its venue id is the `stellar-bazaar` row of
   * `venues.json`; its two payout accounts are neither that address nor each
   * other, because each resource there collects to its own account. Both are
   * listed, so `reconcileTerms` has something real to compare the invoice
   * against.
   */
  bazaar_shopper: {
    venueId: env.get("BAZAAR_VENUE_ID") ?? "stellar-bazaar:CBDWMXZEE44NJ3RA6RS7K4EK36KDFW5S7KHP276HCMM4I52MIUUHEF5B",
    assetId: PILOT_ASSET_ID,
    payTo: [
      // `swap-risk-quote`
      "GDVR2KDK5DSMNYZJKNISUIOBDC6FZK3XZOIQWSS7KL4BRMD5BMW6RMCQ",
      // `ai-video-scriptwriter`
      "GBYXQUSY7WA3DUXZSANGQ3HMER2EBMOK5IYPUJV4YY2UH7QS736J62LB",
    ],
    products: ["swap-risk-quote", "ai-video-scriptwriter"],
  },
  /**
   * Since T104 a store shopper's target is built from its own store, read from
   * the Vitrinee directory (`storeTarget`, `C-141`). This static one is left
   * only for store shoppers hired before T104, whose grant names the old
   * single-store venue (`vitrinee:GC5ZY…`): their pages still render, and
   * AgentPey refuses their purchases (`VenueNotRegistered`). Its `assetId` is
   * the one every store target reuses.
   */
  vitrinee_shopper: {
    venueId: env.get("VITRINEE_VENUE_ID") ?? "vitrinee:GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII",
    assetId: PILOT_ASSET_ID,
    payTo: [env.get("VITRINEE_PAY_TO") ?? "GC5ZY7UJ7CKD7O7YURRSDIDVYEETYP2JXPKUL5E6GIWHUPAH5DCIVCII"],
    products: ["37282902", "37282997", "37282998", "37282999", "37283000", "37283001"],
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
const agentpeyBaseUrl = env.get("AGENTPEY_BASE_URL") ?? "https://agentpey.com";
const agentpey =
  partnerKey === undefined || partnerKey === ""
    ? undefined
    : createAgentPeyClient({ baseUrl: agentpeyBaseUrl, apiKey: partnerKey });

/**
 * The bazaar's own catalogue, read live (T96).
 *
 * A third party RealOps talks to directly, which is exactly what makes it worth
 * showing: it is not ours, it can change what it sells without telling us, and
 * a signed Mandate does not widen when it does. Nothing it answers can cause a
 * payment — the venue is resolved by AgentPey against `venues.json`, the price
 * comes from the merchant's own 402, and the payout account is checked against
 * the Mandate. The worst a hostile answer here can do is draw a wrong card.
 */
const bazaarCatalog = createBazaarCatalog({
  baseUrl: env.get("BAZAAR_BASE_URL") ?? "https://stellar-bazaar-x402.vercel.app",
});

/**
 * The Vitrinee platform's stores (T104, `C-141`), read from the same public
 * directory AgentPey reads. Each store's catalogue is its own `ServiceCard`
 * feed at `https://<slug>.vitrinee.agentpey.com`, read with the bazaar's
 * reader (`VT-24`), and its venue id is the one AgentPey builds from the same
 * directory, so a card RealOps draws is a venue AgentPey can resolve.
 */
const storefronts = createStorefrontDirectory({
  directoryUrl: env.get("VITRINEE_DIRECTORY_URL") ?? "https://vitrinee.agentpey.com/api/comercios",
  platformHost: env.get("VITRINEE_PLATFORM_HOST") ?? "vitrinee.agentpey.com",
});

const server = createRealOpsServer({
  store,
  agentpey,
  agentpeyBaseUrl,
  targets,
  bazaarCatalog,
  storefronts,
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
