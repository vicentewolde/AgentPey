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
 *
 * `--agent-index <n>` (T187, `R-33`) does step 5 for one person on
 * `apps/mcp/wallets.testnet.json` instead: their agent key, derived from
 * `MCP_AGENT_MNEMONIC`, gets its own credential and Mandate, with the limits
 * their rail was deployed with, written to their entry in the list (signed
 * documents, not secrets). It touches nothing in `.env.local`.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentPassCredential, Scope } from "@agentpass/core";
import { AGENTPASS_CREDENTIAL_TYPE, AGENTPASS_STATUS_TYPE, AgentPassError, VC_CONTEXT_V2, isAgentPassError, stellarAddressToDid } from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import { DEFAULT_VENUE_REGISTRY, expandPlatformVenues } from "@agentpey/agent";
import { anchorMandate, createMandate } from "@agentpey/mandate";
import { deriveTenantKeypair } from "@agentpey/tenancy";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { WALLETS_FILE, formatWalletsFile, parseWalletsFile, withAgentDocuments } from "../apps/mcp/src/wallets.js";
import { readDeployment } from "./lib/deployment.js";
import { readEnvFile, upsertEnvValue, writeEnvFile } from "./lib/env-file.js";
import { TESTNET, fundWithFriendbot, getAccountState } from "./lib/network.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const WALLETS_PATH = resolve(REPO_ROOT, "apps/mcp", WALLETS_FILE);
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const LIMITS = { perTx: "3.00", perDay: "5.00" } as const;
const VALID_DAYS = 30;
export const RENDER_KEYS = [
  "MCP_PUBLIC_URL",
  "MCP_AGENT_SECRET_KEY",
  "MCP_POLICY_RAIL_CONTRACT_ID",
  "MCP_CREDENTIAL_JWS",
  "MCP_MANDATE_JWS",
  "MCP_ALLOWED_WALLET",
  "MCP_OAUTH_SECRET",
  "MCP_AGENT_MNEMONIC",
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

interface Limits {
  readonly perTx: string;
  readonly perDay: string;
}

/**
 * Issues the agent's credential and Mandate over every store in the Vitrinee directory today, with these limits, for
 * 30 days, and anchors both on testnet. Shared by the original account and each listed person (T187).
 */
async function issueDocuments(env: ReadonlyMap<string, string>, agentPublicKey: string, limits: Limits): Promise<{ credential: string; mandate: string }> {
  const issuer = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY", "pnpm run bootstrap"));
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID", "pnpm run bootstrap");
  const registry = await expandPlatformVenues(DEFAULT_VENUE_REGISTRY);
  const stores = [...registry.venues.keys()].filter((venueId) => !DEFAULT_VENUE_REGISTRY.venues.has(venueId));
  if (stores.length === 0) throw new AgentPassError("ConfigError", "the Vitrinee directory lists no store right now", {});
  const scope: Scope = { actions: ["catalog:read", "intent:create"], venues: stores, assets: [`USDC:${USDC_CONTRACT}`], limits: { perTx: limits.perTx, perDay: limits.perDay, currency: "USDC" } };

  const agentpass = await createAgentPass({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network });
  const issuerDid = stellarAddressToDid(issuer.publicKey(), "testnet");
  const agentDid = stellarAddressToDid(agentPublicKey, "testnet");
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
  row("credencial", `${issued.hash} (hasta ${validUntil})`);
  row("mandato", anchored.hash);
  row("tiendas", stores.join(", "));
  row("topes", `${limits.perTx} por compra, ${limits.perDay} por día`);
  return { credential: issued.jws, mandate: anchored.jws };
}

function readAgentIndex(): number | undefined {
  const at = ARGV.indexOf("--agent-index");
  if (at === -1) return undefined;
  const value = (ARGV[at + 1] ?? "").trim();
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new AgentPassError("ConfigError", "--agent-index takes the person's index on the wallet list, from 1", { details: { value } });
  return Number(value);
}

/** Step 5 for one listed person (T187): their own credential and Mandate, written to their entry. */
async function setupListed(principal: string, agentIndex: number): Promise<void> {
  out(`\nAgentPey · mcp:setup · persona ${agentIndex} de la lista · Stellar testnet`);
  const env = await readEnvFile(ENV_PATH);
  const file = parseWalletsFile(await readFile(WALLETS_PATH, "utf8"));
  const entry = file.wallets.find((listed) => listed.wallet === principal && listed.agentIndex === agentIndex);
  if (entry === undefined) throw new AgentPassError("ConfigError", "this wallet is not on the list with that agent index; run buyer:onboard first", { details: { principal, agentIndex } });
  const agent = deriveTenantKeypair(requireEnv(env, "MCP_AGENT_MNEMONIC", "pnpm run buyer:onboard -- --init-mnemonic"), agentIndex, "agent");
  if (agent.publicKey !== entry.agent) throw new AgentPassError("ConfigError", "MCP_AGENT_MNEMONIC does not derive the listed agent key", { details: { agentIndex } });
  row("wallet", principal);
  row("agente", `${agent.publicKey} (derivada, índice ${agentIndex})`);
  row("rail", entry.rail);
  if (!(await getAccountState(TESTNET.horizonUrl, agent.publicKey)).funded) {
    await fundWithFriendbot(TESTNET.friendbotUrl, agent.publicKey);
    row("XLM", "fondeada con friendbot");
  }
  if (entry.credential !== undefined && entry.mandate !== undefined && !ARGV.includes("--reissue")) {
    row("credencial", "ya existe; --reissue para emitirla de nuevo");
    return;
  }
  // The Mandate carries the rail's own limits, so the agent's local check and the network's agree.
  const documents = await issueDocuments(env, agent.publicKey, { perTx: entry.perTx, perDay: entry.perDay });
  // Re-read before writing, so an entry added meanwhile is kept.
  const updated = withAgentDocuments(parseWalletsFile(await readFile(WALLETS_PATH, "utf8")), principal, agentIndex, documents);
  await writeFile(WALLETS_PATH, formatWalletsFile(updated), "utf8");
  out(`\n  Escrito en apps/mcp/${WALLETS_FILE}. El servidor la atiende al reiniciar, si MCP_AGENT_MNEMONIC está en Render.\n`);
}

async function main(): Promise<void> {
  const principal = readPrincipal();
  const agentIndex = readAgentIndex();
  if (agentIndex !== undefined) return setupListed(principal, agentIndex);
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
    const documents = await issueDocuments(env, agent.publicKey(), LIMITS);
    set("MCP_CREDENTIAL_JWS", documents.credential);
    set("MCP_MANDATE_JWS", documents.mandate);
    await writeEnvFile(ENV_PATH, contents);
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
