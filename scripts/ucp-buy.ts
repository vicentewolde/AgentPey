#!/usr/bin/env node
/**
 * `pnpm run ucp:buy -- --store <URL> --product <id>[:<n>] [--product <id>[:<n>] …] [--quantity <n>] [--ucp-version 2026-08-25] [--ap2] [--marketing yes|no]`
 * — a real UCP purchase on Stellar testnet, end to end (T122, Fase 7). With
 * `--ucp-version 2026-08-25` the agent sends its 2026-08-25 platform profile
 * and the store answers in that version (T133); without it, 2026-04-08.
 * `--product` repeated is a cart (T148): one checkout, one intent with every
 * line, one payment of their sum; `id:n` gives that line a quantity (else
 * `--quantity`, which only a single product may use).
 * With `--ap2` (T134, R-15) the agent sends its AP2 platform profile: the
 * store signs its checkout, and the agent closes an AP2 mandate over it with
 * the platform key (`AGENTPEY_PLATFORM_AP2_SECRET`, `pnpm run ap2:platform-key`).
 * The mandate and the keys a third party needs to check it are written to
 * `.vitrinee/ap2-t134/` for `scripts/ap2-crosscheck/verify.py --closed`.
 * `--marketing yes|no` (T149) sends the buyer's marketing consent, in the
 * version's shape, in an update once the store has advertised its consent
 * options; the store passes it to its platform order.
 *
 * The same chain of trust as `pnpm run demo:pay-real`, through UCP instead
 * of a bare HTTP 402:
 *
 * 1. Issue the agent's credential and the principal's Mandate, anchored on
 *    testnet. The Mandate's limits are the UCP rail's, read from
 *    `deployments/testnet.json` (5.00 USDC per purchase, 10.00 per day since
 *    T148, `R-19`).
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
  AGENTPEY_PLATFORM_PROFILE,
  AGENTPEY_PLATFORM_PROFILE_2026_08_25,
  AGENTPEY_PLATFORM_PROFILE_AP2,
  DEFAULT_VENUE_REGISTRY,
  createAgent,
  createInMemorySpendLedger,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  createX402Catalog,
  executeUcpPayment,
  expandPlatformVenues,
  MAX_UCP_LINES,
  mayHaveBeenPaid,
  verifyIntent,
} from "@agentpey/agent";
import { anchorMandate, createMandate } from "@agentpey/mandate";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { deriveP256, p256FromScalar } from "../packages/ap2/src/keys.js";
import { PLATFORM_AP2_KID } from "./lib/ap2-platform.js";

import { ReceiptRegistryClient, verifyReceipt } from "../packages/vitrinee-anchor/src/index.js";
import { readDeployment } from "./lib/deployment.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const VITRINEE_DEPLOYMENT = resolve(REPO_ROOT, "deployments/vitrinee-testnet.json");
const AGENTPEY_DEPLOYMENT = resolve(REPO_ROOT, "deployments/testnet.json");
const RECEIPT_OUT = resolve(REPO_ROOT, ".vitrinee/last-ucp-receipt.jws");
const AP2_OUT = resolve(REPO_ROOT, ".vitrinee/ap2-t134");
/** The label the agent's AP2 key is derived under, from its Stellar seed (R-16). */
const AGENT_AP2_KEY_LABEL = "agentpey/ap2-holder/p256/v1";
/** A public P-256 key as a UCP profile publishes it (T134). */
const publishedP256Schema = z.looseObject({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1), kid: z.string().min(1) });
const profileKeysSchema = z.looseObject({ keys: z.array(z.unknown()) });

/** The P-256 key a profile publishes under `kid` (or whose kid ends with `kidSuffix`), read and validated. */
async function publishedP256(profileUrl: string, match: (kid: string) => boolean): Promise<z.infer<typeof publishedP256Schema>> {
  const response = await fetch(profileUrl, { headers: { accept: "application/json" } });
  const profile = profileKeysSchema.safeParse(response.ok ? await response.json() : null);
  if (!profile.success) throw new AgentPassError("NetworkError", "a UCP profile could not be read", { details: { profileUrl, status: response.status } });
  const key = profile.data.keys.map((k) => publishedP256Schema.safeParse(k)).find((k) => k.success && match(k.data.kid));
  if (key === undefined || !key.success) throw new AgentPassError("ConfigError", "the profile publishes no matching P-256 key", { details: { profileUrl } });
  return key.data;
}

const USDC_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const HORIZON = "https://horizon-testnet.stellar.org";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    store: { type: "string" },
    product: { type: "string", multiple: true },
    // No default: whether it was given at all is what a cart refuses, in either spelling (`--quantity 2`, `--quantity=2`).
    quantity: { type: "string" },
    email: { type: "string", default: "comprador@agentpey.com" },
    "ucp-version": { type: "string", default: "2026-04-08" },
    ap2: { type: "boolean", default: false },
    marketing: { type: "string" },
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
  if (values.store === undefined || !URL.canParse(values.store) || values.product === undefined || values.product.length === 0) {
    throw new AgentPassError("InvalidArguments", "usage: pnpm run ucp:buy -- --store <URL> --product <id>[:<n>] [--product <id>[:<n>] …] [--quantity <n>]", { details: {} });
  }
  const wholeQuantity = (raw: string): number => {
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 100) {
      throw new AgentPassError("InvalidArguments", "a quantity must be a whole number from 1 to 100", { details: { quantity: raw } });
    }
    return n;
  };
  if (values.product.length > 1 && values.quantity !== undefined) {
    throw new AgentPassError("InvalidArguments", "a cart gives each line its quantity as --product <id>:<n>, not --quantity", { details: {} });
  }
  if (values.product.length > MAX_UCP_LINES) {
    throw new AgentPassError("InvalidArguments", `a cart has at most ${MAX_UCP_LINES} lines`, { details: { lines: values.product.length } });
  }
  // `id:n` or `id` (then --quantity, else 1). Product ids are digits or slugs, never with a colon.
  const lines = values.product.map((spec) => {
    const parts = spec.split(":");
    const [id = "", count] = parts;
    if (id === "" || parts.length > 2) throw new AgentPassError("InvalidArguments", "--product is <id> or <id>:<n>", { details: { product: spec } });
    return { productId: id, quantity: wholeQuantity(count ?? values.quantity ?? "1") };
  });
  const ucpVersion = values["ucp-version"];
  if (ucpVersion !== "2026-04-08" && ucpVersion !== "2026-08-25") {
    throw new AgentPassError("InvalidArguments", "--ucp-version must be 2026-04-08 or 2026-08-25", { details: { ucpVersion } });
  }
  if (values.ap2 && ucpVersion !== "2026-08-25") {
    throw new AgentPassError("InvalidArguments", "--ap2 needs --ucp-version 2026-08-25: UCP's AP2 extension is offered only there (R-15)", { details: {} });
  }
  if (values.marketing !== undefined && values.marketing !== "yes" && values.marketing !== "no") {
    throw new AgentPassError("InvalidArguments", "--marketing is yes or no", { details: { marketing: values.marketing } });
  }
  // The buyer's marketing decision (T149), in the version's shape. 2026-08-25 asks a platform that submits consent to
  // include every purpose the store advertises: the other three are echoed as the store's (`source: "business"`),
  // which says the buyer stated nothing about them. AgentPey's stores advertise these four.
  const marketing = values.marketing === undefined ? undefined : values.marketing === "yes";
  const consent =
    marketing === undefined
      ? undefined
      : ucpVersion === "2026-04-08"
        ? { marketing }
        : {
            "dev.ucp.consent.marketing": { granted: marketing, source: "platform" },
            "dev.ucp.consent.analytics": { granted: false, source: "business" },
            "dev.ucp.consent.preferences": { granted: false, source: "business" },
            "dev.ucp.consent.sale_or_sharing": { granted: false, source: "business" },
          };
  const platformProfile = values.ap2 ? AGENTPEY_PLATFORM_PROFILE_AP2 : ucpVersion === "2026-08-25" ? AGENTPEY_PLATFORM_PROFILE_2026_08_25 : AGENTPEY_PLATFORM_PROFILE;
  const storeUrl = new URL(values.store).origin;

  const env = await readEnvFile(ENV_PATH);
  const issuer = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY"));
  const agentKeypair = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY"));
  const contractId = requireEnv(env, "AGENT_REGISTRY_CONTRACT_ID");
  const railId = requireEnv(env, "UCP_POLICY_RAIL_CONTRACT_ID");

  out("\nAgentPey · compra UCP pagada sobre Stellar · Fase 7 (T122) · testnet");
  line("tienda", storeUrl);
  for (const [i, l] of lines.entries()) line(lines.length === 1 ? "producto" : `línea ${i + 1}`, `${l.productId} × ${l.quantity}`);
  // The Mandate's limits are the rail's own, as recorded when it was deployed: the two gates on the same numbers (T148, R-19).
  const recorded = (await readDeployment(AGENTPEY_DEPLOYMENT)).policyRailUcp;
  if (recorded === null || recorded.contractId !== railId) {
    throw new AgentPassError("ConfigError", "UCP_POLICY_RAIL_CONTRACT_ID is not the UCP rail recorded in deployments/testnet.json", { details: { railId, recorded: recorded?.contractId ?? null } });
  }
  const limits = { perTx: recorded.perTx, perDay: recorded.perDay };
  line("pagador", `${railId} (policy_rail UCP: ${limits.perTx} por compra, ${limits.perDay} por día)`);

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
    limits: { ...limits, currency: "USDC" },
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
  // One product through the model's own tool, as before; a cart through the agent's cart signer, same checks (T148).
  const [single] = lines;
  let intentResult: CreatePurchaseIntentResult;
  if (lines.length === 1 && single !== undefined) {
    intentResult = (await agent.tools.invoke("create_purchase_intent", { product_id: single.productId, quantity: single.quantity })) as CreatePurchaseIntentResult;
  } else {
    if (agent.signCart === undefined) throw new AgentPassError("ConfigError", "the agent cannot sign intents: its credential or Mandate did not verify", { details: {} });
    intentResult = await agent.signCart(lines);
  }
  const verified = await verifyIntent(intentResult.jws);
  line("intent", intentResult.intent_id);
  line("total", `${intentResult.total_amount} USDC`);

  // AP2 (T134): the platform key signs the open mandate; the agent's own P-256 key, derived from its Stellar seed
  // (R-16), closes it. The Mandate just anchored is the open mandate's source.
  const agentDid = stellarAddressToDid(agentKeypair.publicKey(), "testnet");
  const holder = deriveP256(StrKey.decodeEd25519SecretSeed(agentKeypair.secret()), AGENT_AP2_KEY_LABEL, `${agentDid}#ap2-p256`);
  const platformKey = values.ap2 ? p256FromScalar(Buffer.from(requireEnv(env, "AGENTPEY_PLATFORM_AP2_SECRET"), "base64url"), PLATFORM_AP2_KID) : undefined;
  if (platformKey !== undefined) {
    // Before paying: the key the store will check is the one agentpey.com publishes, and it is this secret's.
    const published = await publishedP256(AGENTPEY_PLATFORM_PROFILE_AP2, (kid) => kid === PLATFORM_AP2_KID);
    if (published.x !== platformKey.publicJwk.x || published.y !== platformKey.publicJwk.y) {
      throw new AgentPassError("ConfigError", "agentpey-ap2.json publishes another key than AGENTPEY_PLATFORM_AP2_SECRET's; deploy apps/web first", { details: { profile: AGENTPEY_PLATFORM_PROFILE_AP2 } });
    }
  }
  const ap2 = platformKey !== undefined
    ? {
        issuer: new URL(AGENTPEY_PLATFORM_PROFILE_AP2).origin,
        platform: platformKey.signer,
        holder: { ...holder.signer, publicJwk: holder.publicJwk },
        source: { mandate_id: anchoredMandate.mandate.mandateId, hash: anchoredMandate.hash, registry: anchoredMandate.mandate.credentialStatus.registry },
        closed: new Set<string>(),
      }
    : undefined;
  if (ap2 !== undefined) line("ap2", `perfil ${AGENTPEY_PLATFORM_PROFILE_AP2}`);

  step(3, "Checkout UCP, reconciliado contra el Mandato y pagado desde el policy_rail");
  const paid = await executeUcpPayment(
    { policyRail: createLocalPolicyRail({ ledger }), signerSecret: agentKeypair.secret(), payer: { contractId: railId, ownerSecret: agentKeypair.secret() }, platformProfile, ...(ap2 === undefined ? {} : { ap2 }) },
    {
      storeUrl,
      ...(lines.length === 1 && single !== undefined ? { productId: single.productId, quantity: single.quantity } : { lines }),
      buyer: { email: values.email, first_name: "Comprador", last_name: "AgentPey", ...(consent === undefined ? {} : { consent }) },
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
  if (marketing !== undefined) line("marketing", marketing ? "sí, enviado a la tienda" : "no, enviado a la tienda");
  line("total", `${paid.total.amount} ${paid.total.currency}`);
  line("pagado", `${(Number(paid.paid.amount) / 1e7).toFixed(7)} USDC a ${paid.paid.payTo}`);
  line("tx", paid.transaction ?? "(sin hash)");
  if (paid.transaction !== undefined) line("explorer", `https://stellar.expert/explorer/testnet/tx/${paid.transaction}`);
  if (ap2 !== undefined) {
    // With --ap2 the agent refuses to pay without closing a mandate; a paid purchase without one is a bug.
    if (paid.ap2Mandate === undefined) throw new AgentPassError("Ap2MandateInvalid", "the purchase was paid without an AP2 mandate", { details: { orderId: paid.orderId } });
    // What a third party needs to check the mandate with AP2's own SDK: the chain, where the two keys are
    // published (verify.py fetches them from there), and the aud and nonce it is bound to.
    const storeProfile = `${storeUrl}/.well-known/ucp`;
    const storeKey = await publishedP256(storeProfile, (kid) => kid.endsWith("#ap2-p256"));
    await mkdir(AP2_OUT, { recursive: true });
    await writeFile(resolve(AP2_OUT, "chain.txt"), paid.ap2Mandate);
    await writeFile(resolve(AP2_OUT, "platform.jwk.json"), JSON.stringify(platformKey?.publicJwk));
    await writeFile(resolve(AP2_OUT, "business.jwk.json"), JSON.stringify(storeKey));
    await writeFile(
      resolve(AP2_OUT, "binding.json"),
      JSON.stringify({ aud: storeUrl, nonce: paid.checkoutId, platform_profile: AGENTPEY_PLATFORM_PROFILE_AP2, platform_kid: PLATFORM_AP2_KID, store_profile: storeProfile, store_kid: storeKey.kid }),
    );
    line("mandato ap2", `${paid.ap2Mandate.length} bytes, cadena abierto~~cierre en ${AP2_OUT}`);
  }
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
