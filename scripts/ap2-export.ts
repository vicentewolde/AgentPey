/**
 * T123: a real Mandate, exported as AP2 v0.2 open mandates and verified.
 *
 * 1. Issue the agent's credential and the principal's Mandate, anchored on
 *    testnet (fees only, from the issuer account; no USDC moves).
 * 2. The agent signs a purchase intent for one product of a real Vitrinee
 *    store, through the same tool it buys with.
 * 3. Export: the Mandate is re-verified on chain, `checkMandate` must allow
 *    the intent, and the pair is signed EdDSA with ISSUER_SECRET_KEY (`E-9`).
 * 4. Verify the pair with `@agentpey/ap2`, and show that an altered copy is
 *    rejected with a typed error.
 * 5. With `--ephemeral-p256`: export the same Mandate and intent again with a
 *    single-use P-256 issuer key and agent key, for the AP2 reference SDK
 *    (`scripts/ap2-crosscheck/`). Only public keys are written; the private
 *    ones exist in this process and nowhere else.
 *
 *   pnpm run ap2:export -- --store https://agentcommerce.vitrinee.agentpey.com --product 67624104591666 --ephemeral-p256
 *
 * Writes to .vitrinee/ap2/ (gitignored). Needs `.env.local` with
 * ISSUER_SECRET_KEY, AGENT_SECRET_KEY and AGENT_REGISTRY_CONTRACT_ID.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { AgentPassCredential, Scope } from "@agentpass/core";
import { AGENTPASS_CREDENTIAL_TYPE, AGENTPASS_STATUS_TYPE, AgentPassError, VC_CONTEXT_V2, isAgentPassError, stellarAddressToDid } from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import type { Ap2PublicJwk } from "@agentpey/ap2";
import { verifyOpenMandatePair } from "@agentpey/ap2";
import type { Ap2Issuer, CreatePurchaseIntentResult } from "@agentpey/agent";
import {
  DEFAULT_VENUE_REGISTRY,
  createAgent,
  createInMemorySpendLedger,
  createOnChainMandateVerifier,
  createX402Catalog,
  expandPlatformVenues,
  exportMandateAsAp2,
  stellarAp2Issuer,
} from "@agentpey/agent";
import { anchorMandate, createMandate } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk";

import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const OUT_DIR = resolve(REPO_ROOT, ".vitrinee/ap2");
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    store: { type: "string" },
    product: { type: "string" },
    quantity: { type: "string", default: "1" },
    "ephemeral-p256": { type: "boolean", default: false },
  },
});

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}
function line(label: string, value: string): void {
  out(`  ${label.padEnd(14)} ${value}`);
}
function step(n: number, total: number, title: string): void {
  out(`\n[${n}/${total}] ${title}`);
}

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key, fix: "pnpm run bootstrap" } });
  return value;
}

/** A single-use P-256 key pair: the private half never leaves this process (`E-9`). */
function ephemeralP256(): { privateJwk: Ap2Issuer["signer"]["privateJwk"]; publicJwk: Ap2PublicJwk } {
  const { kty, crv, x, y, d } = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  if (x === undefined || y === undefined || d === undefined) throw new AgentPassError("ConfigError", "generated P-256 key has no public point", {});
  return { privateJwk: { kty, crv, x, y, d }, publicJwk: { kty: "EC", crv: "P-256", x, y } };
}

/** Raises `payment.amount_range.max` inside the mandate's own disclosure, leaving the signature alone. */
function raiseLimit(payment: string): string {
  const parts = payment.split("~");
  const index = parts.length - 2;
  const [salt, mandate] = JSON.parse(Buffer.from(parts[index] ?? "", "base64url").toString("utf8")) as [string, { constraints: Array<Record<string, unknown>> }];
  const raised = { ...mandate, constraints: mandate.constraints.map((c) => (c.type === "payment.amount_range" ? { ...c, max: 9_000_000_000 } : c)) };
  parts[index] = Buffer.from(JSON.stringify([salt, raised])).toString("base64url");
  return parts.join("~");
}

async function main(): Promise<void> {
  if (values.store === undefined || !URL.canParse(values.store) || values.product === undefined) {
    throw new AgentPassError("InvalidArguments", "usage: pnpm run ap2:export -- --store <URL> --product <id> [--quantity <n>] [--ephemeral-p256]", { details: {} });
  }
  const quantity = Number(values.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new AgentPassError("InvalidArguments", "--quantity must be a whole number from 1 to 100", { details: { quantity: values.quantity } });
  }
  const crossCheck = values["ephemeral-p256"];
  const total = crossCheck ? 5 : 4;
  const store = new URL(values.store);
  const productId = values.product;

  const env = await readEnvFile(ENV_PATH);
  const issuer = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY"));
  const agentKeypair = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY"));
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");

  out("\nAgentPey · Mandato exportado como mandatos AP2 v0.2 · Fase 7 (T123) · testnet");
  line("tienda", store.origin);
  line("producto", `${productId} × ${quantity}`);

  const registry = await expandPlatformVenues(DEFAULT_VENUE_REGISTRY);
  const venue = [...registry.venues.values()].find((candidate) => candidate.baseUrl !== undefined && new URL(candidate.baseUrl).origin === store.origin);
  if (venue === undefined) throw new AgentPassError("InvalidVenueId", "the store is not in the Vitrinee platform directory", { details: { store: store.origin } });
  line("venue", venue.venueId);

  const scope: Scope = {
    actions: ["catalog:read", "intent:create"],
    venues: [venue.venueId],
    assets: [`USDC:${USDC_CONTRACT}`],
    limits: { perTx: "3.00", perDay: "5.00", currency: "USDC" },
  };

  step(1, total, "Credencial y Mandato, firmados y anclados en testnet (solo comisión, sin mover USDC)");
  const agentpass = await createAgentPass({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network });
  const issuerDid = stellarAddressToDid(issuer.publicKey(), "testnet");
  const agentDid = stellarAddressToDid(agentKeypair.publicKey(), "testnet");
  const now = new Date();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const credential: AgentPassCredential = {
    "@context": [VC_CONTEXT_V2],
    type: ["VerifiableCredential", AGENTPASS_CREDENTIAL_TYPE],
    issuer: issuerDid,
    validFrom: now.toISOString(),
    validUntil,
    credentialSubject: { id: agentDid, agent: { name: "comprador-ap2", model: "claude-opus-5-5", operator: "agentpey" }, principal: issuerDid, scope },
    credentialStatus: { type: AGENTPASS_STATUS_TYPE, registry: agentpass.config.contractId },
  };
  const issued = await agentpass.issue({ credential, issuer });
  line("credencial", issued.hash);
  const mandate = createMandate({ principal: issuerDid, agent: agentDid, grant: scope, registry: agentpass.config.contractId, validFrom: now.toISOString(), validUntil });
  const anchored = await anchorMandate(agentpass, { mandate, principal: issuer });
  line("mandato", anchored.hash);
  line("límites", `${scope.limits.perTx} por compra, ${scope.limits.perDay} por día, ${scope.limits.currency}`);

  step(2, total, "El agente firma la intención de compra");
  const catalog = createX402Catalog({ venueId: venue.venueId, registry });
  const product = await catalog.getProduct(productId);
  const mandateVerifier = createOnChainMandateVerifier(agentpass);
  const agent = await createAgent({ credential: issued.jws, mandate: anchored.jws, catalog, verifier: agentpass, mandateVerifier, signer: agentKeypair, ledger: createInMemorySpendLedger() });
  const intent = (await agent.tools.invoke("create_purchase_intent", { product_id: productId, quantity })) as CreatePurchaseIntentResult;
  line("intent", intent.intent_id);
  line("producto", product.name);
  line("total", `${intent.total_amount} USDC`);

  step(3, total, "Exportación: Mandato verificado en la red, checkMandate, y el par AP2 firmado (EdDSA)");
  const provider = stellarAp2Issuer(issuer, "testnet");
  const merchant = { name: store.hostname, website: store.origin };
  const exported = await exportMandateAsAp2(mandateVerifier, { mandate: anchored.jws, intentJws: intent.jws, merchant, itemTitle: product.name, issuer: provider });
  line("emisor", `${provider.did} (Trusted Agent Provider)`);
  line("vence", `${exported.expiresAt.toISOString()} (≤ 1 h, E-10)`);
  line("checkout", `${exported.checkout.length} bytes, mandate.checkout.open.1`);
  line("pago", `${exported.payment.length} bytes, mandate.payment.open.1`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, "checkout.sd-jwt"), `${exported.checkout}\n`);
  await writeFile(resolve(OUT_DIR, "payment.sd-jwt"), `${exported.payment}\n`);
  await writeFile(resolve(OUT_DIR, "issuer.jwk.json"), `${JSON.stringify(provider.publicJwk, null, 2)}\n`);
  await writeFile(resolve(OUT_DIR, "mandate.jws"), `${anchored.jws}\n`);

  step(4, total, "Verificación con @agentpey/ap2, solo con la llave pública del emisor");
  const verified = await verifyOpenMandatePair(exported, { issuerKey: provider.publicJwk });
  const amount = verified.payment.constraints.find((c) => c.type === "payment.amount_range");
  const items = verified.checkout.constraints.find((c) => c.type === "checkout.line_items");
  line("✅ firma", "EdDSA del did:stellar del emisor, en los dos mandatos");
  line("✅ referencia", "payment.reference = sd_hash del mandato de checkout");
  line("✅ origen", `Mandato ${verified.source.hash.slice(0, 16)}… en ${verified.source.registry}`);
  line("producto", JSON.stringify(items?.type === "checkout.line_items" ? items.items[0]?.acceptable_items : []));
  line("tope", amount?.type === "payment.amount_range" ? `${amount.max} unidades de ${amount.currency} (perTx; perDay queda en el policy_rail, E-10)` : "?");
  try {
    await verifyOpenMandatePair({ checkout: exported.checkout, payment: raiseLimit(exported.payment) }, { issuerKey: provider.publicJwk });
    line("❌ alterado", "un mandato con el tope subido pasó la verificación");
    process.exitCode = 1;
  } catch (error) {
    line("✅ alterado", isAgentPassError(error) ? `tope subido a 900 USDC → rechazado con ${error.code}` : String(error));
  }

  if (crossCheck) {
    step(5, total, "Mismo Mandato e intención, con llaves P-256 de un solo uso, para la librería oficial de AP2");
    const issuerKey = ephemeralP256();
    const agentKey = ephemeralP256();
    const p256Issuer: Ap2Issuer = { did: provider.did, signer: { alg: "ES256", privateJwk: issuerKey.privateJwk, kid: "ephemeral-p256" }, publicJwk: issuerKey.publicJwk };
    const p256 = await exportMandateAsAp2(mandateVerifier, { mandate: anchored.jws, intentJws: intent.jws, merchant, itemTitle: product.name, issuer: p256Issuer, agentKey: agentKey.publicJwk });
    await verifyOpenMandatePair(p256, { issuerKey: issuerKey.publicJwk });
    const dir = resolve(OUT_DIR, "p256");
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "checkout.sd-jwt"), `${p256.checkout}\n`);
    await writeFile(resolve(dir, "payment.sd-jwt"), `${p256.payment}\n`);
    await writeFile(resolve(dir, "issuer.jwk.json"), `${JSON.stringify(issuerKey.publicJwk, null, 2)}\n`);
    line("✅ ES256", "exportado y verificado con @agentpey/ap2");
    line("llaves", "privadas descartadas al terminar el proceso; solo se escribieron las públicas");
  }

  line("archivos", OUT_DIR);
  out(process.exitCode === 1 ? "\n❌ Algo no calzó.\n" : "\n✅ Mandato real exportado como mandatos AP2 abiertos y verificado.\n");
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
