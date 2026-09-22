#!/usr/bin/env node
/**
 * `pnpm run partner:key` — look at the `/v1` key in use, issue a new one for
 * the **same partner**, and revoke an old one once the new one is deployed.
 *
 * **Why this exists, and why `partner:create` is not the answer.** T93, T94 and
 * T95 added three permissions to the frozen list (`payments:preview`,
 * `webhooks:read`, `webhooks:write`). The list is flat on purpose —
 * `payments:authorize` does not imply `payments:preview` — so a key issued
 * before them cannot call those routes at all, and gets `403`. The obvious
 * move, running `partner:create` again, is a trap: it mints a **new partner**,
 * and tenants are partner-scoped (`newTenantId(partnerId)`). Pointing RealOps
 * at a new partner's key would leave every existing account without its tenant,
 * its agents or its signed Mandates — they would still exist on chain and in
 * the vault, under the old partner, invisible to the app. This script issues a
 * key for the partner that is already there, which is what rotating a
 * credential is supposed to mean.
 *
 * **It never prints the key it reads.** The current secret is used only to find
 * out which partner it belongs to, through the same constant-time
 * `authenticate` that `/v1` uses. It is read from `.env.local` rather than
 * taken as an argument, so it does not end up in shell history.
 *
 * **It does not rotate for you, in one step, on purpose.** Issuing and revoking
 * are two commands because between them something has to be deployed and
 * checked. A script that revoked the old key as it minted the new one would
 * take production down for as long as the deploy takes, every time.
 *
 * An operator script, not an HTTP route, for the same reason
 * `create-partner.ts` is one: there is no admin authentication in front of
 * `/v1` to put partner administration behind (`PLATAFORMA-PARTNERS.md` § F5).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { createDirectory, type ApiKey, type Directory } from "@agentpey/directory";
import { API_SCOPES } from "@agentpey/partner-api";

import { readEnvFile } from "./lib/env-file.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");

/** The key RealOps authenticates to `/v1` with. Read, never printed. */
const CURRENT_KEY_VAR = "REALOPS_AGENTPEY_API_KEY";

const USAGE = `
Usage:
  pnpm run partner:key                          Show the key in use and what it is missing
  pnpm run partner:key -- --issue               Issue a new key for that same partner
  pnpm run partner:key -- --issue --partner ptn_…   …for a partner named explicitly
  pnpm run partner:key -- --revoke apk_… --yes  Revoke an old key, after the new one is live

Options:
  --name "<label>"    A name for the new key. Defaults to "<partner> — rotated <date>".
  --scopes a,b,c      Permissions for the new key. Defaults to every permission.
`.trimStart();

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function readEnv(): Promise<ReadonlyMap<string, string>> {
  return readEnvFile(ENV_PATH);
}

function requireDatabaseUrl(env: ReadonlyMap<string, string>): string {
  const databaseUrl = env.get("DATABASE_URL") ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new AgentPassError("ConfigError", "DATABASE_URL is missing — set it in .env.local or the environment", {
      details: { envPath: ENV_PATH },
    });
  }
  return databaseUrl;
}

/**
 * Which partner to act on.
 *
 * Either named outright, or discovered from the key already in `.env.local`.
 * The second path is the one worth having: an operator knows what is deployed,
 * not what a partner id is, and the deployed key is the authoritative answer to
 * "which partner is this installation".
 */
async function resolvePartnerId(directory: Directory, env: ReadonlyMap<string, string>): Promise<{
  readonly partnerId: string;
  readonly currentKey?: ApiKey;
}> {
  const explicit = readArg("partner");
  if (explicit !== undefined && explicit !== "") {
    const partner = await directory.findPartner(explicit);
    if (partner === undefined) {
      throw new AgentPassError("PartnerNotFound", `no partner with id "${explicit}"`, {
        details: { partnerId: explicit },
      });
    }
    return { partnerId: partner.id };
  }

  const secret = env.get(CURRENT_KEY_VAR);
  if (secret === undefined || secret === "") {
    throw new AgentPassError(
      "ConfigError",
      `${CURRENT_KEY_VAR} is missing from .env.local, so there is no key to read the partner from — pass --partner ptn_… instead`,
      { details: { envPath: ENV_PATH, variable: CURRENT_KEY_VAR } },
    );
  }

  // The same constant-time lookup `/v1` performs. A revoked key answers
  // `undefined` here, which is the honest answer: it cannot tell us anything
  // any more either.
  const currentKey = await directory.authenticate(secret);
  if (currentKey === undefined) {
    throw new AgentPassError(
      "ConfigError",
      `the ${CURRENT_KEY_VAR} in .env.local is not a key this database knows, or it is revoked — pass --partner ptn_… instead`,
      { details: { envPath: ENV_PATH, variable: CURRENT_KEY_VAR } },
    );
  }
  return { partnerId: currentKey.partnerId, currentKey };
}

function requestedScopes(): readonly string[] {
  const raw = readArg("scopes");
  if (raw === undefined) return [...API_SCOPES];

  const scopes = raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  const unknown = scopes.filter((scope) => !(API_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    throw new AgentPassError("ConfigError", `unknown permission(s): ${unknown.join(", ")}`, {
      details: { unknown, known: [...API_SCOPES] },
    });
  }
  if (scopes.length === 0) {
    throw new AgentPassError("ConfigError", "--scopes was given with no permissions in it", { details: { raw } });
  }
  return scopes;
}

/** What the key in use can and cannot do. The diagnosis, which is most of the value. */
function report(key: ApiKey, partnerName: string): void {
  const missing = (API_SCOPES as readonly string[]).filter((scope) => !key.scopes.includes(scope));

  console.log(`Partner:     ${key.partnerId} (${partnerName})`);
  console.log(`Key in use:  ${key.id} (${key.name})`);
  console.log(`Issued:      ${key.createdAt.toISOString()}`);
  console.log(`Permissions: ${key.scopes.join(", ")}`);
  console.log("");
  if (missing.length === 0) {
    console.log("This key already holds every permission. Nothing to issue.");
    return;
  }
  console.log(`Missing (${missing.length}): ${missing.join(", ")}`);
  console.log("");
  console.log("Routes those permissions unlock:");
  if (missing.includes("payments:preview")) console.log("  payments:preview  POST /v1/purchases/preview  (T93)");
  if (missing.includes("webhooks:read")) console.log("  webhooks:read     GET  /v1/webhooks            (T94)");
  if (missing.includes("webhooks:write")) console.log("  webhooks:write    POST /v1/webhooks            (T94)");
  console.log("");
  console.log("To issue a key for this same partner, with every permission:");
  console.log("  pnpm run partner:key -- --issue");
}

async function issue(directory: Directory, partnerId: string, partnerName: string): Promise<void> {
  const scopes = requestedScopes();
  const today = new Date().toISOString().slice(0, 10);
  const name = readArg("name") ?? `${partnerName} — rotated ${today}`;

  const { apiKey, secret } = await directory.issueApiKey({ partnerId, name, scopes });

  console.log(`Partner:     ${partnerId} (${partnerName})`);
  console.log(`New key:     ${apiKey.id} (${apiKey.name})`);
  console.log(`Permissions: ${apiKey.scopes.join(", ")}`);
  console.log("");
  console.log("Secret (shown once — store it now, it cannot be retrieved again):");
  console.log(secret);
  console.log("");
  console.log("Next, in order:");
  console.log(`  1. Put it in Render as ${CURRENT_KEY_VAR}, and in .env.local, and redeploy.`);
  console.log("  2. Check the deploy works before touching the old key.");
  console.log("  3. Only then revoke the old one:");
  console.log("       pnpm run partner:key -- --revoke <old apk_…> --yes");
  console.log("");
  console.log("The old key keeps working until you revoke it. That overlap is the point:");
  console.log("nothing is down while the new one is being deployed.");
}

/**
 * Revoking is the one destructive thing here, so it says what it is about to
 * break and refuses to do it on its own. `--yes` is required, the key must be
 * named by id, and the key currently in `.env.local` is refused outright —
 * revoking the credential this installation is using is never the intent, and
 * a typo that did it would take production down.
 */
async function revoke(directory: Directory, currentKey: ApiKey | undefined): Promise<void> {
  const id = readArg("revoke");
  if (id === undefined || id === "") {
    throw new AgentPassError("ConfigError", "--revoke needs the id of the key to revoke (apk_…)", {});
  }
  if (currentKey !== undefined && currentKey.id === id) {
    throw new AgentPassError(
      "ConfigError",
      `${id} is the key in .env.local right now — revoking it would break this installation. Deploy the new key first, then revoke the old one.`,
      { details: { apiKeyId: id } },
    );
  }
  if (!hasFlag("yes")) {
    console.log(`Would revoke ${id}. This cannot be undone and takes effect immediately.`);
    console.log("Re-run with --yes once the replacement key is deployed and verified.");
    return;
  }

  await directory.revokeApiKey(id);
  console.log(`Revoked ${id}.`);
}

async function main(): Promise<void> {
  if (hasFlag("help")) {
    console.log(USAGE);
    return;
  }

  const env = await readEnv();
  const directory = await createDirectory({ connectionString: requireDatabaseUrl(env) });
  try {
    const { partnerId, currentKey } = await resolvePartnerId(directory, env);
    const partner = await directory.findPartner(partnerId);
    const partnerName = partner?.name ?? "unknown";

    if (hasFlag("revoke")) {
      await revoke(directory, currentKey);
      return;
    }
    if (hasFlag("issue")) {
      await issue(directory, partnerId, partnerName);
      return;
    }
    if (currentKey === undefined) {
      console.log(`Partner: ${partnerId} (${partnerName})`);
      console.log("No key was read from .env.local, so there is nothing to diagnose.");
      console.log("");
      console.log(USAGE);
      return;
    }
    report(currentKey, partnerName);
  } finally {
    await directory.close();
  }
}

try {
  await main();
} catch (error) {
  if (isAgentPassError(error)) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
