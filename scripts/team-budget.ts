#!/usr/bin/env node
/**
 * `pnpm run team:pay -- [--times N]` — T146: a team gives its agent a budget
 * on the network, and the agent spends it on a pay-per-use service.
 *
 * The "team" is the principal that signs the Mandate; its agent buys
 * `signaldesk:ai-credits-1000` (0.10 USDC) and pays from `policyRailUcp`, a
 * `policy_rail` that is already deployed (`R-25`: nothing new is deployed).
 * Two budgets apply, one inside the other, enforced in different places:
 *
 * - the **team's**, in the credential and the Mandate: 0.10 per purchase and
 *   0.30 per UTC day, checked off-chain by PolicyRail before anything is
 *   signed. The day's total lives in this script's own MandateVault, keyed by
 *   the agent, so it holds across runs that share that file; moving or
 *   deleting the file starts the day over. A lock file keeps two runs from
 *   spending against it at once.
 * - the **rail's**, in the contract: `per_tx` and `per_day` (5 and 10 on
 *   `policyRailUcp`, shared with `ucp:buy`), checked by the network inside the
 *   transfer itself. The network does not know the team's 0.30.
 *
 * Every PolicyRail decision lands in the vault (`.team-budget/vault.jsonl`,
 * hash-chained): a grant before payment, a daily-limit refusal with its code,
 * and, once a payment settles, an `anchored` entry tying it to its transaction
 * (T28) through a companion anchor in `agent_registry`. A refusal the agent
 * raises before PolicyRail (a revoked credential, a product outside the
 * Mandate) is printed, not recorded. `pnpm run team:summary` reads it back.
 *
 * Known limits: a grant whose payment failed is never released here, even
 * when the payment provably never left (`M-15` makes that the safe side); and
 * a payment that settles but fails to anchor stays without its `anchored`
 * entry.
 *
 * With `--times 4` on a fresh day, three purchases settle and the fourth is
 * refused by the team's daily budget before anything is signed.
 */
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentPassCredential, Scope } from "@agentpass/core";
import {
  AGENTPASS_CREDENTIAL_TYPE,
  AGENTPASS_STATUS_TYPE,
  AgentPassError,
  VC_CONTEXT_V2,
  isAgentPassError,
  stellarAddressToDid,
} from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";

import { anchorMandate, createMandate } from "@agentpey/mandate";
import { createFileMandateVault } from "@agentpey/vault";

import type { CreatePurchaseIntentResult, VenueId } from "@agentpey/agent";
import {
  anchorPaymentDecision,
  createAgent,
  createBazaarCatalog,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  executeBazaarPayment,
  fillRouteTemplate,
  getBazaarServiceRoute,
  verifyIntent,
  withVault,
} from "@agentpey/agent";

import { readEnvFile } from "./lib/env-file.js";
import { TEAM_LIMITS, TEAM_VAULT_PATH } from "./lib/team-summary.js";
import { TESTNET } from "./lib/network.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");

const SIGNALDESK_VENUE = "signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF";
const SIGNALDESK_PAY_TO = "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF";
const USDC = "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PRODUCT_ID = "signaldesk:ai-credits-1000";

/** The team's budget for its agent (decided by the user for T146). */
const TEAM_SCOPE: Scope = {
  actions: ["catalog:read", "intent:create"],
  venues: [SIGNALDESK_VENUE],
  assets: [USDC],
  limits: { ...TEAM_LIMITS, currency: "USDC" },
};

const MAX_TIMES = 6;

/** The refusals that are the team's budget at work; any other error stops the run. */
const BUDGET_REFUSALS: ReadonlySet<string> = new Set([
  "ScopeDailyLimitExceeded",
  "MandateDailyLimitExceeded",
  "ScopeAmountExceeded",
  "MandateAmountExceeded",
]);

function parseTimes(argv: readonly string[]): number {
  const at = argv.indexOf("--times");
  if (at === -1) return 1;
  const value = Number(argv[at + 1]);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMES) {
    throw new AgentPassError("InvalidArguments", `--times takes a whole number from 1 to ${MAX_TIMES}`, { details: { got: argv[at + 1] ?? null } });
  }
  return value;
}

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key);
  if (value === undefined || value === "") {
    throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key } });
  }
  return value;
}

const deploymentSchema = z.object({
  policyRailUcp: z.object({ contractId: z.string().regex(/^C[A-Z2-7]{55}$/), owner: z.string(), perTx: z.string(), perDay: z.string() }),
});

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(16)} ${value}\n`);
}

async function main(): Promise<void> {
  const times = parseTimes(process.argv.slice(2));
  const env = await readEnvFile(ENV_PATH);
  const team = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY"));
  const agentKey = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY"));
  const registryId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");
  // A local SignalDesk can stand in for the live one, e.g. to try a fix before it deploys. Who gets paid does
  // not change with it: `payTo` is still pinned by venues.json and the Mandate.
  const signaldeskInput = process.env["TEAM_SIGNALDESK_URL"] ?? "https://signaldesk.agentpey.com";
  const signaldeskParsed = z.url({ protocol: /^https?$/ }).safeParse(signaldeskInput);
  if (!signaldeskParsed.success) {
    throw new AgentPassError("ConfigError", "TEAM_SIGNALDESK_URL must be an http(s) URL", { details: { got: signaldeskInput } });
  }
  const signaldeskUrl = signaldeskParsed.data.replace(/\/+$/, "");
  const rail = deploymentSchema.parse(JSON.parse(await readFile(DEPLOYMENT_PATH, "utf8"))).policyRailUcp;
  if (rail.owner !== agentKey.publicKey()) {
    throw new AgentPassError("ConfigError", "AGENT_SECRET_KEY is not the owner of policyRailUcp", {
      details: { railOwner: rail.owner, agent: agentKey.publicKey() },
    });
  }

  mkdirSync(dirname(TEAM_VAULT_PATH), { recursive: true });
  // The file vault is read once into memory: a second run at the same time would spend against a stale total
  // and fork the hash chain. One run at a time.
  const lockPath = `${TEAM_VAULT_PATH}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx");
  } catch (error) {
    throw new AgentPassError("ConfigError", "another team:pay is running (or one crashed): remove the lock file if not", {
      cause: error,
      details: { lock: relative(REPO_ROOT, lockPath) },
    });
  }
  process.on("exit", () => {
    closeSync(lock);
    unlinkSync(lockPath);
  });
  const vault = createFileMandateVault({ path: TEAM_VAULT_PATH });
  const integrity = vault.verify();
  if (!integrity.ok) {
    throw new AgentPassError("VaultCorrupted", "the team's vault does not verify; refusing to spend against it", { details: { path: relative(REPO_ROOT, TEAM_VAULT_PATH) } });
  }

  const teamDid = stellarAddressToDid(team.publicKey(), "testnet");
  const agentDid = stellarAddressToDid(agentKey.publicKey(), "testnet");

  process.stdout.write("\nAgentPey · presupuesto de equipo (T146) · Stellar testnet\n");
  line("equipo", team.publicKey());
  line("agente", agentKey.publicKey());
  line("servicio", `${PRODUCT_ID} en ${signaldeskUrl}`);
  line("tope del equipo", `${TEAM_SCOPE.limits.perTx} por compra, ${TEAM_SCOPE.limits.perDay} por día (Mandato)`);
  line("tope del rail", `${rail.perTx} por compra, ${rail.perDay} por día (red, ${rail.contractId})`);
  line("vault", `${relative(REPO_ROOT, TEAM_VAULT_PATH)} (${vault.list().length} registros, cadena válida)`);

  const agentpass = await createAgentPass({
    contractId: registryId,
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.passphrase,
    network: TESTNET.network,
  });

  process.stdout.write("\n[1] El equipo emite la credencial y el Mandato del agente\n");
  const now = new Date();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const credential: AgentPassCredential = {
    "@context": [VC_CONTEXT_V2],
    type: ["VerifiableCredential", AGENTPASS_CREDENTIAL_TYPE],
    issuer: teamDid,
    validFrom: now.toISOString(),
    validUntil,
    credentialSubject: {
      id: agentDid,
      agent: { name: "team-budget", model: "claude-opus-5", operator: "agentpey-team-demo" },
      principal: teamDid,
      scope: TEAM_SCOPE,
    },
    credentialStatus: { type: AGENTPASS_STATUS_TYPE, registry: agentpass.config.contractId },
  };
  const issued = await agentpass.issue({ credential, issuer: team });
  const mandate = createMandate({
    principal: teamDid,
    agent: agentDid,
    grant: { ...TEAM_SCOPE, payTo: [SIGNALDESK_PAY_TO], products: [PRODUCT_ID] },
    registry: agentpass.config.contractId,
    validFrom: now.toISOString(),
    validUntil,
  });
  const anchored = await anchorMandate(agentpass, { mandate, principal: team });
  line("credencial", issued.hash);
  line("mandato", anchored.hash);

  // One rail, wrapped so refusals land in the vault, for the agent's own
  // intent check and for the payment's reconciliation against the real 402.
  const policyRail = withVault(createLocalPolicyRail({ ledger: vault }), vault);
  const catalogOptions = { venueId: SIGNALDESK_VENUE as VenueId, baseUrl: signaldeskUrl };
  const catalog = createBazaarCatalog(catalogOptions);
  const route = await getBazaarServiceRoute(catalogOptions, PRODUCT_ID);
  const agent = await createAgent({
    credential: issued.jws,
    mandate: anchored.jws,
    catalog,
    verifier: agentpass,
    mandateVerifier: createOnChainMandateVerifier(agentpass),
    signer: agentKey,
    ledger: vault,
    policyRail,
  });

  for (let n = 1; n <= times; n++) {
    process.stdout.write(`\n[${n + 1}] Compra ${n} de ${times}\n`);
    let intent: CreatePurchaseIntentResult;
    try {
      intent = (await agent.tools.invoke("create_purchase_intent", { product_id: PRODUCT_ID, quantity: 1 })) as CreatePurchaseIntentResult;
    } catch (error) {
      if (isAgentPassError(error) && BUDGET_REFUSALS.has(error.code)) {
        line("rechazada", `${error.code}: ${error.message}`);
        line("firmado", "nada: el presupuesto del equipo la rechazó antes de firmar o pagar");
        continue;
      }
      // Anything else (a revoked credential, the network) is not the budget speaking: stop and say what it was.
      throw error;
    }
    line("intent", intent.intent_id);
    const verified = await verifyIntent(intent.jws);

    const receipt = await executeBazaarPayment(
      { policyRail, signerSecret: agentKey.secret(), payer: { contractId: rail.contractId, ownerSecret: agentKey.secret() } },
      {
        resourceUrl: fillRouteTemplate(signaldeskUrl, route, { account: team.publicKey() }),
        intent: verified.intent,
        scope: TEAM_SCOPE,
        mandate: anchored.mandate,
        venueId: catalog.venueId,
      },
    );
    line("pagada", receipt.settled ? "sí" : `no (${receipt.errorReason ?? "sin motivo"})`);
    line("pagador", receipt.payer ?? "(desconocido)");
    if (receipt.transaction === undefined) continue;
    line("transacción", `https://stellar.expert/explorer/testnet/tx/${receipt.transaction}`);
    const body = z.looseObject({ receipt_url: z.string().optional(), receipt_hash: z.string().optional() }).safeParse(receipt.resourceBody);
    if (body.success && body.data.receipt_url !== undefined) line("recibo", body.data.receipt_url);

    const record = vault.list(agentDid).find((r) => r.entry.kind === "granted" && r.entry.intentId === intent.intent_id);
    if (record === undefined) {
      line("vault", "sin registro de autorización para este intent (no debería pasar)");
      continue;
    }
    const link = await anchorPaymentDecision(agentpass, {
      record,
      paymentTx: receipt.transaction,
      subject: agentKey.publicKey(),
      expiresAt: new Date(validUntil),
      issuer: team,
    });
    await vault.recordAnchor({ subject: agentDid, intentId: intent.intent_id, paymentTx: receipt.transaction, linkHash: link.linkHash, anchorTx: link.transactionHash });
    line("ancla", `https://stellar.expert/explorer/testnet/tx/${link.transactionHash}`);
  }

  process.stdout.write("\nResumen del mes: pnpm run team:summary\n\n");
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
