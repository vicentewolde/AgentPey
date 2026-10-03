#!/usr/bin/env node
/**
 * `pnpm run mcp:setup -- --principal <G...> [--reissue]` — prepares AgentPey's
 * MCP server to pay on Stellar testnet (T128, `R-8`, `R-9`), writing every
 * value to `.env.local`. Prints names, never secrets.
 *
 * 1. The MCP agent's own key (`MCP_AGENT_SECRET_KEY`), created once and given
 *    testnet XLM by friendbot. It signs intents and claims, and owns the rail.
 * 2. `MCP_ALLOWED_WALLET`: the principal, the one wallet that can sign in to
 *    the MCP server (`R-7`) and withdraw from its rail. Written only after
 *    the recorded rail is checked to have this principal; the server checks
 *    it again on chain at startup.
 * 3. `MCP_OAUTH_SECRET`, created once. Changing it signs everyone out.
 * 4. The rail: deployed apart, on purpose, with
 *    `pnpm run deploy:policy-rail -- --profile mcp --principal <G...>`, a new
 *    contract on testnet. This script only checks it is recorded.
 * 5. The agent's credential and Mandate, issued and anchored on testnet with
 *    `ISSUER_SECRET_KEY`, as `ucp:buy` does (`R-8`): scope over every store in
 *    the Vitrinee directory today, 3.00 USDC per purchase and 5.00 per day
 *    (`R-9`), for 30 days. Issued when missing, or again with `--reissue`
 *    (a new store joined, or they expired).
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentPassCredential, Scope } from "@agentpass/core";
import { AGENTPASS_CREDENTIAL_TYPE, AGENTPASS_STATUS_TYPE, AgentPassError, VC_CONTEXT_V2, isAgentPassError, stellarAddressToDid } from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import { DEFAULT_VENUE_REGISTRY, expandPlatformVenues } from "@agentpey/agent";
import { anchorMandate, createMandate } from "@agentpey/mandate";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { readDeployment } from "./lib/deployment.js";
import { readEnvFile, upsertEnvValue, writeEnvFile } from "./lib/env-file.js";
import { TESTNET, fundWithFriendbot, getAccountState } from "./lib/network.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const LIMITS = { perTx: "3.00", perDay: "5.00", currency: "USDC" } as const;
const VALID_DAYS = 30;
export const RENDER_KEYS = [
  "MCP_PUBLIC_URL",
  "MCP_AGENT_SECRET_KEY",
  "MCP_POLICY_RAIL_CONTRACT_ID",
  "MCP_CREDENTIAL_JWS",
  "MCP_MANDATE_JWS",
  "MCP_ALLOWED_WALLET",
  "MCP_OAUTH_SECRET",
] as const;

const ARGV = process.argv.slice(2).filter((arg) => arg !== "--");
const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const row = (label: string, value: string): void => out(`  ${label.padEnd(13)} ${value}`);

function readPrincipal(): string {
  const at = ARGV.indexOf("--principal");
  const value = at === -1 ? "" : (ARGV[at + 1] ?? "").trim();
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new AgentPassError("ConfigError", "--principal <G...> is required: your wallet, the only one that can sign in to the MCP server and withdraw from its rail", {
      details: { usage: "pnpm run mcp:setup -- --principal G..." },
    });
  }
  return value;
}

function requireEnv(env: ReadonlyMap<string, string>, key: string, fix: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key, fix } });
  return value;
}

async function main(): Promise<void> {
  const principal = readPrincipal();
  const reissue = ARGV.includes("--reissue");
  let contents = await readFile(ENV_PATH, "utf8");
  const env = await readEnvFile(ENV_PATH);
  const set = (key: string, value: string) => {
    contents = upsertEnvValue(contents, key, value);
    env.set(key, value);
  };

  out("\nAgentPey · mcp:setup · Stellar testnet");

  // 1. The agent's key.
  let agent: Keypair;
  if ((env.get("MCP_AGENT_SECRET_KEY") ?? "") === "") {
    agent = Keypair.random();
    set("MCP_AGENT_SECRET_KEY", agent.secret());
    row("agente", `${agent.publicKey()} (llave nueva)`);
  } else {
    agent = Keypair.fromSecret(env.get("MCP_AGENT_SECRET_KEY")!);
    row("agente", agent.publicKey());
  }
  if (!(await getAccountState(TESTNET.horizonUrl, agent.publicKey())).funded) {
    await fundWithFriendbot(TESTNET.friendbotUrl, agent.publicKey());
    row("XLM", "fondeada con friendbot");
  }

  // 3. The OAuth secret. The wallet that signs in (2) is written only once the rail agrees, below.
  if ((env.get("MCP_OAUTH_SECRET") ?? "") === "") {
    set("MCP_OAUTH_SECRET", randomBytes(48).toString("base64url"));
    row("OAuth", "secreto nuevo");
  }
  if ((env.get("MCP_PUBLIC_URL") ?? "") === "") set("MCP_PUBLIC_URL", "https://mcp.agentpey.com");
  await writeEnvFile(ENV_PATH, contents);

  // 4. The rail, deployed apart.
  const deployment = await readDeployment(DEPLOYMENT_PATH);
  const rail = deployment.policyRailMcp;
  if (rail === null) {
    row("rail", "todavía no está desplegado. Siguiente paso, con permiso:");
    out(`\n  pnpm run deploy:policy-rail -- --profile mcp --principal ${principal}\n`);
  } else {
    if (rail.owner !== agent.publicKey() || rail.principal !== principal) {
      throw new AgentPassError("ConfigError", "the recorded MCP rail has another owner or principal; redeploy it with --profile mcp --redeploy", {
        details: { owner: rail.owner, expectedOwner: agent.publicKey(), principal: rail.principal, expectedPrincipal: principal },
      });
    }
    set("MCP_POLICY_RAIL_CONTRACT_ID", rail.contractId);
    row("rail", `${rail.contractId} (${rail.perTx} por compra, ${rail.perDay} por día)`);
  }
  // 2. Who signs in: the rail's principal, and nobody else. Written after the
  // check above, so a mistyped --principal never reaches .env.local, and from
  // there Render. With no rail yet it is written too: the server refuses to
  // start unless the rail on chain names this wallet as its principal.
  set("MCP_ALLOWED_WALLET", principal);
  row("wallet", `${principal} (la única que inicia sesión y retira del rail)`);
  await writeEnvFile(ENV_PATH, contents);

  // 5. Credential and Mandate.
  if (reissue || (env.get("MCP_CREDENTIAL_JWS") ?? "") === "" || (env.get("MCP_MANDATE_JWS") ?? "") === "") {
    const issuer = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY", "pnpm run bootstrap"));
    const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID", "pnpm run bootstrap");
    const registry = await expandPlatformVenues(DEFAULT_VENUE_REGISTRY);
    const stores = [...registry.venues.keys()].filter((venueId) => !DEFAULT_VENUE_REGISTRY.venues.has(venueId));
    if (stores.length === 0) throw new AgentPassError("ConfigError", "the Vitrinee directory lists no store right now", {});
    const scope: Scope = { actions: ["catalog:read", "intent:create"], venues: stores, assets: [`USDC:${USDC_CONTRACT}`], limits: LIMITS };

    const agentpass = await createAgentPass({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network });
    const issuerDid = stellarAddressToDid(issuer.publicKey(), "testnet");
    const agentDid = stellarAddressToDid(agent.publicKey(), "testnet");
    const now = new Date();
    const validUntil = new Date(now.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const credential: AgentPassCredential = {
      "@context": [VC_CONTEXT_V2],
      type: ["VerifiableCredential", AGENTPASS_CREDENTIAL_TYPE],
      issuer: issuerDid,
      validFrom: now.toISOString(),
      validUntil,
      credentialSubject: { id: agentDid, agent: { name: "agentpey-mcp", model: "claude", operator: "agentpey" }, principal: issuerDid, scope },
      credentialStatus: { type: AGENTPASS_STATUS_TYPE, registry: agentpass.config.contractId },
    };
    const issued = await agentpass.issue({ credential, issuer });
    const mandate = createMandate({ principal: issuerDid, agent: agentDid, grant: scope, registry: agentpass.config.contractId, validFrom: now.toISOString(), validUntil });
    const anchored = await anchorMandate(agentpass, { mandate, principal: issuer });
    set("MCP_CREDENTIAL_JWS", issued.jws);
    set("MCP_MANDATE_JWS", anchored.jws);
    await writeEnvFile(ENV_PATH, contents);
    row("credencial", `${issued.hash} (hasta ${validUntil})`);
    row("mandato", anchored.hash);
    row("tiendas", stores.join(", "));
  } else {
    row("credencial", "ya existe; --reissue para emitirla de nuevo");
  }

  const missing = RENDER_KEYS.filter((key) => (env.get(key) ?? "") === "");
  out("\n  En el panel de Render, servicio AgentPey, copia estas variables desde .env.local:");
  for (const key of RENDER_KEYS) out(`    ${key}${missing.includes(key) ? "   (falta)" : ""}`);
  out("  Y AGENT_REGISTRY_CONTRACT_ID, si no está.");
  if (rail !== null) out(`\n  Fondea el rail con USDC de testnet desde tu wallet: envía a ${rail.contractId}\n`);
}

main().catch((error: unknown) => {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`\n${String(error)}\n`);
  }
  process.exitCode = 1;
});
