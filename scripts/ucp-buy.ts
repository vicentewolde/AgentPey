#!/usr/bin/env node
/**
 * `pnpm run ucp:buy -- --store <URL> --product <id> [--quantity <n>]` — a real
 * UCP purchase on Stellar testnet, end to end (T122, Fase 7).
 *
 * The same chain of trust as `pnpm run demo:pay-real`, through UCP instead
 * of a bare HTTP 402:
 *
 * 1. Issue the agent's credential and the principal's Mandate, anchored on
 *    testnet. The Mandate's limits are the UCP rail's: 3.00 USDC per purchase,
 *    5.00 per day.
 * 2. The agent signs a purchase intent for the product, from the store's own
 *    catalogue (its venue comes from the Vitrinee platform directory, C-141).
 * 3. `executeUcpPayment`: open the UCP checkout, check its payment
 *    requirements against the store's profile, the venue and the Mandate,
 *    sign from the UCP `policy_rail`, complete. **This moves real testnet USDC.**
 * 4. Wait for the receipt's anchor, then verify the receipt independently:
 *    signature, anchor in receipt-registry, settlement on Horizon.
 *
 * Needs `.env.local` with ISSUER_SECRET_KEY, AGENT_SECRET_KEY,
 * AGENT_REGISTRY_CONTRACT_ID and UCP_POLICY_RAIL_CONTRACT_ID (written by
 * `pnpm run deploy:policy-rail -- --profile ucp --principal G...`).
 * Prints no secret.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { AgentPassCredential, Scope } from "@agentpass/core";
import { AGENTPASS_CREDENTIAL_TYPE, AGENTPASS_STATUS_TYPE, AgentPassError, VC_CONTEXT_V2, isAgentPassError, stellarAddressToDid } from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import type { CreatePurchaseIntentResult } from "@agentpey/agent";
import {
  DEFAULT_VENUE_REGISTRY,
  createAgent,
  createInMemorySpendLedger,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  createX402Catalog,
  executeUcpPayment,
  expandPlatformVenues,
  mayHaveBeenPaid,
  verifyIntent,
} from "@agentpey/agent";
import { anchorMandate, createMandate } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk";

import { ReceiptRegistryClient, verifyReceipt } from "../packages/vitrinee-anchor/src/index.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const VITRINEE_DEPLOYMENT = resolve(REPO_ROOT, "deployments/vitrinee-testnet.json");
const RECEIPT_OUT = resolve(REPO_ROOT, ".vitrinee/last-ucp-receipt.jws");
const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const HORIZON = "https://horizon-testnet.stellar.org";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    store: { type: "string" },
    product: { type: "string" },
    quantity: { type: "string", default: "1" },
    email: { type: "string", default: "comprador@agentpey.com" },
  },
});

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}
function line(label: string, value: string): void {
  out(`  ${label.padEnd(13)} ${value}`);
}
function step(n: number, title: string): void {
  out(`\n[${n}/5] ${title}`);
}

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") {
    throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, {
      details: { key, fix: key === "UCP_POLICY_RAIL_CONTRACT_ID" ? "pnpm run deploy:policy-rail -- --profile ucp --principal G..." : "pnpm run bootstrap" },
    });
  }
  return value;
}

async function main(): Promise<void> {
  if (values.store === undefined || !URL.canParse(values.store) || values.product === undefined) {
    throw new AgentPassError("InvalidArguments", "usage: pnpm run ucp:buy -- --store <URL> --product <id> [--quantity <n>]", { details: {} });
  }
  const quantity = Number(values.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new AgentPassError("InvalidArguments", "--quantity must be a whole number from 1 to 100", { details: { quantity: values.quantity } });
  }
  const storeUrl = new URL(values.store).origin;
  const productId = values.product;

  const env = await readEnvFile(ENV_PATH);
  const issuer = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY"));
  const agentKeypair = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY"));
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");
  const railId = requireEnv(env, "UCP_POLICY_RAIL_CONTRACT_ID");

  out("\nAgentPey · compra UCP pagada sobre Stellar · Fase 7 (T122) · testnet");
  line("tienda", storeUrl);
  line("producto", `${productId} × ${quantity}`);
  line("pagador", `${railId} (policy_rail UCP: 3.00 por compra, 5.00 por día)`);

  // The store's venue, from the Vitrinee platform's public directory (C-141).
  const registry = await expandPlatformVenues(DEFAULT_VENUE_REGISTRY);
  const venue = [...registry.venues.values()].find((candidate) => candidate.baseUrl !== undefined && new URL(candidate.baseUrl).origin === storeUrl);
  if (venue === undefined) {
    throw new AgentPassError("InvalidVenueId", "the store is not in the Vitrinee platform directory", { details: { storeUrl } });
  }
  line("venue", venue.venueId);

  const scope: Scope = {
    actions: ["catalog:read", "intent:create"],
    venues: [venue.venueId],
    assets: [`USDC:${USDC_CONTRACT}`],
    limits: { perTx: "3.00", perDay: "5.00", currency: "USDC" },
  };

  step(1, "Credencial y Mandato, firmados y anclados en testnet");
  const agentpass = await createAgentPass({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network });
  const issuerDid = stellarAddressToDid(issuer.publicKey(), "testnet");
  const now = new Date();
  const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const credential: AgentPassCredential = {
    "@context": [VC_CONTEXT_V2],
    type: ["VerifiableCredential", AGENTPASS_CREDENTIAL_TYPE],
    issuer: issuerDid,
    validFrom: now.toISOString(),
    validUntil,
    credentialSubject: {
      id: stellarAddressToDid(agentKeypair.publicKey(), "testnet"),
      agent: { name: "comprador-ucp", model: "claude-opus-5-5", operator: "agentpey" },
      principal: issuerDid,
      scope,
    },
    credentialStatus: { type: AGENTPASS_STATUS_TYPE, registry: agentpass.config.contractId },
  };
  const issued = await agentpass.issue({ credential, issuer });
  line("credencial", issued.hash);
  const mandate = createMandate({ principal: issuerDid, agent: stellarAddressToDid(agentKeypair.publicKey(), "testnet"), grant: scope, registry: agentpass.config.contractId, validFrom: now.toISOString(), validUntil });
  const anchoredMandate = await anchorMandate(agentpass, { mandate, principal: issuer });
  line("mandato", anchoredMandate.hash);

  step(2, "El agente firma la intención de compra");
  const ledger = createInMemorySpendLedger();
  const agent = await createAgent({
    credential: issued.jws,
    mandate: anchoredMandate.jws,
    catalog: createX402Catalog({ venueId: venue.venueId, registry }),
    verifier: agentpass,
    mandateVerifier: createOnChainMandateVerifier(agentpass),
    signer: agentKeypair,
    ledger,
  });
  const intentResult = (await agent.tools.invoke("create_purchase_intent", { product_id: productId, quantity })) as CreatePurchaseIntentResult;
  const verified = await verifyIntent(intentResult.jws);
  line("intent", intentResult.intent_id);
  line("total", `${intentResult.total_amount} USDC`);

  step(3, "Checkout UCP, reconciliado contra el Mandato y pagado desde el policy_rail");
  const paid = await executeUcpPayment(
    { policyRail: createLocalPolicyRail({ ledger }), signerSecret: agentKeypair.secret(), payer: { contractId: railId, ownerSecret: agentKeypair.secret() } },
    {
      storeUrl,
      productId,
      quantity,
      buyer: { email: values.email, first_name: "Comprador", last_name: "AgentPey" },
      destination: { first_name: "Comprador", last_name: "AgentPey", street_address: "Av. Providencia 1234", address_locality: "Providencia", address_region: "RM", address_country: "CL" },
      intent: verified.intent,
      scope,
      mandate: anchoredMandate.mandate,
      venueId: venue.venueId,
      registry,
      idempotencyKey: `ucp-buy-${intentResult.intent_id}`,
    },
  );
  line("checkout", paid.checkoutId);
  line("orden", paid.orderId);
  line("total", `${paid.total.amount} ${paid.total.currency}`);
  line("pagado", `${(Number(paid.paid.amount) / 1e7).toFixed(7)} USDC a ${paid.paid.payTo}`);
  line("tx", paid.transaction ?? "(sin hash)");
  if (paid.transaction !== undefined) line("explorer", `https://stellar.expert/explorer/testnet/tx/${paid.transaction}`);
  line("permalink", paid.permalinkUrl);

  step(4, "Anclaje del recibo en receipt-registry");
  let anchor = paid.receipt?.anchor.status ?? "sin recibo";
  for (let attempt = 0; attempt < 30 && anchor === "pending"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 3000));
    const order = (await (await fetch(`${storeUrl}/ucp/v1/orders/${encodeURIComponent(paid.orderId)}`)).json()) as { receipt?: { anchor?: { status?: string; tx_hash?: string } } };
    anchor = order.receipt?.anchor?.status ?? anchor;
    if (order.receipt?.anchor?.tx_hash !== undefined) line("anclaje tx", order.receipt.anchor.tx_hash);
  }
  line("anclaje", anchor);

  step(5, "Verificación independiente del recibo (sin pasar por la tienda)");
  const jws = paid.receipt?.jws;
  if (jws === undefined) throw new AgentPassError("NetworkError", "the store returned no receipt", { details: { orderId: paid.orderId } });
  await mkdir(resolve(REPO_ROOT, ".vitrinee"), { recursive: true });
  await writeFile(RECEIPT_OUT, `${jws}\n`);
  const deployment = JSON.parse(await readFile(VITRINEE_DEPLOYMENT, "utf8")) as { receiptRegistry: { contractId: string } };
  const result = await verifyReceipt(jws, {
    registry: new ReceiptRegistryClient({ contractId: deployment.receiptRegistry.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
    horizonUrl: HORIZON,
    settlementAttempts: 5,
  });
  const mark = (ok: boolean) => (ok ? "✅" : "❌");
  line("hash", result.hash);
  line(`${mark(result.checks.signature.ok)} firma`, result.checks.signature.ok ? "Ed25519 del did:stellar de la tienda" : (result.checks.signature.reason ?? "inválida"));
  line(`${mark(result.checks.anchored.ok)} anclaje`, result.checks.anchored.ok ? `receipt-registry · ledger ${result.checks.anchored.record?.ledger ?? "?"}` : (result.checks.anchored.reason ?? "no anclado"));
  line(`${mark(result.checks.settlement.ok)} pago`, result.checks.settlement.ok ? `confirmado en Horizon · ledger ${result.checks.settlement.ledger ?? "?"}` : (result.checks.settlement.reason ?? "no confirmado"));
  line("recibo", RECEIPT_OUT);
  out(result.valid ? "\n✅ Compra UCP de punta a punta: pagada en Stellar, pedido creado, recibo válido.\n" : "\n❌ El recibo no pasó los tres checks.\n");
  process.exitCode = result.valid ? 0 : 1;
}

main().catch((error: unknown) => {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.stderr.write(mayHaveBeenPaid(error) ? "  (puede que el pago se haya enviado: revisa el explorer antes de reintentar)\n" : "  (no se envió ningún pago)\n");
  } else {
    process.stderr.write(`\n${String(error)}\n`);
  }
  process.exitCode = 1;
});
