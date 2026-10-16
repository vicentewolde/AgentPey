/**
 * AgentResolve from the command line — T124 (`E-14` to `E-19`).
 *
 *   pnpm run resolve:deposit -- --merchant <G...> --amount 3.00
 *   pnpm run resolve:open    -- --receipt .vitrinee/last-ucp-receipt.jws --reason not_delivered --description "…" [--evidence "…"]… [--amount 1.00]
 *   pnpm run resolve:decide  -- --receipt <hash> [--response <response.json>]
 *   pnpm run resolve:check-response -- --receipt <hash> --response <response.json>
 *   pnpm run resolve:execute -- --receipt <hash> --confirm <verdict hash>
 *   pnpm run resolve:verify  -- --receipt <hash>
 *
 * Roles, all on testnet:
 * - **deposit**: a sponsor funds a merchant's guarantee. The sponsor is the
 *   reserve account (`AGENT_SECRET_KEY`, same one that funded the UCP rail, E-5).
 * - **open**: the buyer signs a claim (`AGENT_SECRET_KEY`: the agent owns the
 *   UCP `policy_rail` that paid); the arbiter (`RESOLVE_ARBITER_SECRET_KEY`)
 *   verifies the receipt's three checks, that the claimant controls the payer,
 *   the window and the amount, then opens the dispute on chain.
 * - **respond** (T126, `E-20` to `E-22`): the merchant's owner answers on
 *   `agentpey.com/resolve/responder` with the `claim.jws` the arbiter sends,
 *   signs with Freighter from the receipt's payout account, and sends back the
 *   downloaded file. `check-response` verifies it without deciding anything.
 * - **decide**: with the merchant's response (`--response`, kept as
 *   `response.json`), or without one only 48 h after the dispute opened.
 *   Claude Opus 5.5 proposes, the code bounds it, the verdict is written to
 *   disk with its hash. Nothing moves.
 * - **execute**: a person confirms by passing that exact hash (`E-18`); only
 *   then does the arbiter call `resolve`, which pays from the guarantee.
 * - **verify**: reads the dispute on chain and checks it against the verdict
 *   file. Read-only.
 *
 * A receipt paid into a store's `purchase-escrow` (it names the escrow, T159)
 * is disputed in that escrow instead (T158, `X-26`): `open` is sent by the
 * payer's own key (the rail's owner signs the escrow's message, `X-18`), the
 * merchant's time to answer is the escrow's own window, and `execute` calls the
 * escrow's `resolve`, which refunds from the payment it holds. The verdict and
 * its confirmation (`E-18`) do not change.
 *
 * Files under `.vitrinee/agentresolve/<receipt hash>/` (gitignored).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

import { AgentPassError, didToStellarAddress, isAgentPassError, stellarAddressToDid } from "@agentpass/core";
import { toScaledAmount, fromScaledAmount } from "@agentpey/agent";
import type { AgentResolveVerdict, ClaimReason, ResponseContext, VerifiedResponse } from "@agentpey/resolve";
import {
  CLAIM_REASONS,
  agentResolveResponseSchema,
  agentResolveVerdictSchema,
  assertMayDecide,
  checkClaim,
  claimHash,
  createClaudeArbiterWithKey,
  decideDispute,
  formatAtomic,
  responseDeadline,
  responseHash,
  signClaim,
  signEscrowOpen,
  signedResponseFileSchema,
  verdictHash,
  verifyClaim,
  verifyMerchantResponse,
} from "@agentpey/resolve";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { EscrowClient, ReceiptRegistryClient, escrowReaders, verifyReceipt, type EscrowConfig } from "../packages/vitrinee-anchor/src/index.js";
import { checkReceiptSignature, receiptHash as hashOfReceipt } from "../packages/vitrinee-core/src/index.js";
import {
  assertMayExecute,
  assertOpenFor,
  assertResponseMatches,
  fromAgentResolve,
  fromEscrow,
  responseWindowOf,
  venueOf,
  verdictMatches,
  type DisputeVenue,
  type DisputeView,
} from "./lib/dispute-venue.js";
import { withRetry } from "./lib/network-retry.js";
import { orderRefHex } from "./lib/purchase-escrow.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";
import { lastLine, stellarCli, stellarCliTx } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const STATE_ROOT = resolve(REPO_ROOT, ".vitrinee/agentresolve");
const VITRINEE_DEPLOYMENT = resolve(REPO_ROOT, "deployments/vitrinee-testnet.json");
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const RESPONDER_URL = "https://agentpey.com/resolve/responder";

const [command = "", ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
const { values } = parseArgs({
  args: rest,
  options: {
    merchant: { type: "string" },
    amount: { type: "string" },
    receipt: { type: "string" },
    claim: { type: "string" },
    reason: { type: "string" },
    description: { type: "string" },
    evidence: { type: "string", multiple: true },
    confirm: { type: "string" },
    response: { type: "string" },
  },
});

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}
function line(label: string, value: string): void {
  out(`  ${label.padEnd(14)} ${value}`);
}
function section(title: string): void {
  out(`\n${title}`);
}

function requireEnv(env: ReadonlyMap<string, string>, key: string, fix: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key, fix } });
  return value;
}

function usage(message: string): never {
  throw new AgentPassError("InvalidArguments", message, { details: { command } });
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** The dispute as `get` returns it through the CLI. Field names are the contract's. */
const disputeSchema = z.object({
  merchant: z.string(),
  payer: z.string(),
  claim_hash: hex64,
  amount: z.coerce.bigint(),
  opened_at: z.coerce.number(),
  status: z.union([z.literal("Open"), z.literal("Resolved"), z.tuple([z.enum(["Open", "Resolved"])])]).transform((s) => (Array.isArray(s) ? s[0] : s)),
  verdict_hash: hex64.nullable(),
  refund: z.coerce.bigint(),
  resolved_at: z.coerce.number(),
});
const guaranteeSchema = z.object({ balance: z.coerce.bigint(), locked: z.coerce.bigint() });

function usdc(atomic: bigint): string {
  return `${fromScaledAmount(atomic)} USDC`;
}

async function context() {
  const env = await readEnvFile(ENV_PATH);
  const contractId = requireEnv(env, "AGENT_RESOLVE_CONTRACT_ID", "pnpm run deploy:agent-resolve");
  return { env, contractId };
}

async function readDispute(contractId: string, receipt: string, secret: string): Promise<z.infer<typeof disputeSchema> | null> {
  const raw = lastLine(await stellarCli(["contract", "invoke", "--id", contractId, "--send", "no", "--", "get", "--receipt", receipt], secret));
  return raw === "null" ? null : disputeSchema.parse(JSON.parse(raw));
}

async function readGuarantee(contractId: string, merchant: string, secret: string): Promise<z.infer<typeof guaranteeSchema>> {
  return guaranteeSchema.parse(JSON.parse(lastLine(await stellarCli(["contract", "invoke", "--id", contractId, "--send", "no", "--", "guarantee", "--merchant", merchant], secret))));
}

function escrowClient(venue: DisputeVenue): EscrowClient {
  return new EscrowClient({ contractId: venue.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });
}

/** Told when a read failed on the network and is tried again, so a wait is never silent. */
function retrying(label: string) {
  return { onRetry: (attempt: number, error: unknown) => process.stderr.write(`  (${label}: la red falló en el intento ${attempt}, reintento: ${error instanceof Error ? error.message : String(error)})\n`) };
}

/** The dispute, read from whichever contract holds it (T158), with a deadline and retries (`network-retry.ts`). */
async function readView(venue: DisputeVenue, secret: string): Promise<DisputeView | null> {
  return withRetry(
    "dispute read",
    async () => {
      if (venue.kind === "agent-resolve") {
        const dispute = await readDispute(venue.contractId, venue.key, secret);
        return dispute === null ? null : fromAgentResolve(dispute);
      }
      const purchase = await escrowClient(venue).get(venue.key);
      return purchase === null ? null : fromEscrow(purchase);
    },
    retrying("disputa"),
  );
}

async function escrowConfigOf(venue: DisputeVenue): Promise<EscrowConfig | undefined> {
  return venue.kind === "escrow" ? withRetry("escrow config", () => escrowClient(venue).config(), retrying("escrow")) : undefined;
}

/**
 * Where the dispute over the receipt kept in `dir` lives, read from that receipt (saved by `open`). A directory with
 * no receipt is a dispute from before T158: `agent-resolve`.
 */
async function venueFromDir(dir: string, receipt: string, agentResolveId: string): Promise<DisputeVenue> {
  const jws = (await readFile(resolve(dir, "receipt.jws"), "utf8").catch(() => "")).trim();
  if (jws === "") return { kind: "agent-resolve", contractId: agentResolveId, key: receipt };
  const claims = checkReceiptSignature(jws).claims;
  if (claims === null || hashOfReceipt(jws) !== receipt) {
    throw new AgentPassError("ResolveReceiptInvalid", "the receipt kept for this dispute is not the one named", { details: { receipt } });
  }
  return venueOf(claims, receipt, agentResolveId);
}

/** The key whose public half is `account`, among the ones this machine holds for buyers: the UCP and MCP agents. */
function buyerKey(env: ReadonlyMap<string, string>, account: string): Keypair {
  for (const name of ["AGENT_SECRET_KEY", "MCP_AGENT_SECRET_KEY"]) {
    const secret = env.get(name)?.trim() ?? "";
    if (secret !== "" && Keypair.fromSecret(secret).publicKey() === account) return Keypair.fromSecret(secret);
  }
  throw new AgentPassError("ResolveClaimantNotPayer", "an escrow dispute opens with the payer's own key, and this machine does not hold it", { details: { claimant: account } });
}

/** `policy_rail.owner()`: the key that may speak for a rail payer. */
async function railOwner(rail: string, secret: string): Promise<string> {
  const answer = lastLine(await withRetry("rail owner", () => stellarCli(["contract", "invoke", "--id", rail, "--send", "no", "--", "owner"], secret), retrying("rail"))).replaceAll('"', "");
  const hex = hex64.safeParse(answer);
  if (!hex.success) {
    throw new AgentPassError("ResolveClaimantNotPayer", "the payer contract did not answer owner() with an Ed25519 key, so no one can speak for it", { details: { payer: rail, answer: answer.slice(0, 80) } });
  }
  return StrKey.encodeEd25519PublicKey(Buffer.from(hex.data, "hex"));
}

/** A check that failed because the network did, not because the receipt is wrong: worth another try. */
const UNREACHABLE = /could not (read|reach)|status code 5\d\d|fetch failed|timed out|ECONNRESET/i;

async function verifiedReceipt(jws: string) {
  const deployment = z.object({ receiptRegistry: z.object({ contractId: z.string() }) }).parse(JSON.parse(await readFile(VITRINEE_DEPLOYMENT, "utf8")));
  const result = await withRetry(
    "receipt check",
    async () => {
      const checked = await verifyReceipt(jws, {
        registry: new ReceiptRegistryClient({ contractId: deployment.receiptRegistry.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
        horizonUrl: HORIZON,
        settlementAttempts: 5,
        escrows: escrowReaders({ rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
      });
      // A check that could not reach the chain says nothing about the receipt: try again rather than call it invalid.
      const unreachable = Object.values(checked.checks).some((check) => check !== null && !check.ok && UNREACHABLE.test(check.reason ?? ""));
      if (unreachable) throw new AgentPassError("NetworkError", "a receipt check could not reach the network", { details: { checks: checked.checks } });
      return checked;
    },
    retrying("recibo"),
  );
  if (!result.valid || result.receipt === null) {
    throw new AgentPassError("ResolveReceiptInvalid", "the receipt did not pass its checks", { details: { hash: result.hash, checks: result.checks } });
  }
  return { valid: true as const, hash: result.hash, receipt: result.receipt };
}

/** The verdict on file, or `null` when it is missing, not JSON, or off its schema. */
async function readVerdictFile(dir: string): Promise<AgentResolveVerdict | null> {
  const raw = await readFile(resolve(dir, "verdict.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = agentResolveVerdictSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function stateDir(receipt: string): string {
  return resolve(STATE_ROOT, hex64.parse(receipt));
}

async function deposit(): Promise<void> {
  const { env, contractId } = await context();
  if (values.merchant === undefined || !StrKey.isValidEd25519PublicKey(values.merchant) || values.amount === undefined) usage("usage: resolve:deposit -- --merchant <G...> --amount <USDC>");
  const sponsor = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY", "pnpm run bootstrap"));
  const amount = toScaledAmount(values.amount);

  out("\nAgentResolve · fondear la garantía de un comercio · testnet");
  line("comercio", values.merchant);
  line("monto", usdc(amount));
  line("desde", `${sponsor.publicKey()} (reserva de cuentas patrocinadas)`);
  const { txHash } = await stellarCliTx(["contract", "invoke", "--id", contractId, "--", "deposit", "--from", sponsor.publicKey(), "--merchant", values.merchant, "--amount", amount.toString()], sponsor.secret());
  const guarantee = await readGuarantee(contractId, values.merchant, sponsor.secret());
  if (txHash !== undefined) line("tx", `${EXPLORER}/tx/${txHash}`);
  line("garantía", `${usdc(guarantee.balance)} (bloqueado ${usdc(guarantee.locked)})`);
}

async function open(): Promise<void> {
  const { env, contractId } = await context();
  const arbiter = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve"));
  out("\nAgentResolve · abrir un reclamo · testnet");

  // A claim the buyer already signed elsewhere (T128: AgentPey's MCP server
  // signs it with the key of the rail that paid). The arbiter checks it exactly
  // like one signed here: the same verifyClaim and checkClaim below.
  let claimJws: string;
  let receiptJws: string;
  let verified: Awaited<ReturnType<typeof verifiedReceipt>>;
  if (values.claim !== undefined) {
    claimJws = (await readFile(resolve(values.claim), "utf8")).trim();
    const presented = await verifyClaim(claimJws);
    receiptJws = presented.document.receipt.jws;
    section("[comprador] reclamo ya firmado");
    verified = await verifiedReceipt(receiptJws);
    line("recibo", verified.hash);
    line("reclamo", `${presented.document.claimId} (${presented.document.reason})`);
    line("pide", usdc(BigInt(presented.document.amountAtomic)));
    line("firmante", presented.document.claimant);
  } else {
    if (values.receipt === undefined || values.reason === undefined || values.description === undefined) {
      usage(`usage: resolve:open -- --receipt <file.jws> --reason <${CLAIM_REASONS.join("|")}> --description <text> [--evidence <text>]… [--amount <USDC>], or resolve:open -- --claim <claim.jws>`);
    }
    if (!(CLAIM_REASONS as readonly string[]).includes(values.reason)) usage(`--reason must be one of ${CLAIM_REASONS.join(", ")}`);
    const buyer = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY", "pnpm run bootstrap"));
    receiptJws = (await readFile(resolve(values.receipt), "utf8")).trim();
    section("[comprador] firma el reclamo");
    verified = await verifiedReceipt(receiptJws);
    const amountAtomic = values.amount === undefined ? verified.receipt.amountUSDCAtomic : toScaledAmount(values.amount).toString();
    const signed = await signClaim(
      {
        type: "AgentResolveClaim",
        claimId: randomUUID(),
        claimant: stellarAddressToDid(buyer.publicKey(), "testnet"),
        receipt: { hash: verified.hash, jws: receiptJws },
        reason: values.reason as ClaimReason,
        description: values.description,
        evidence: (values.evidence ?? []).map((content) => ({ kind: /^https?:\/\//.test(content) ? ("url" as const) : ("text" as const), content })),
        amountAtomic,
        createdAt: new Date().toISOString(),
      },
      buyer,
    );
    claimJws = signed.jws;
    line("recibo", verified.hash);
    line("pedido", `${verified.receipt.platform} ${verified.receipt.platformOrderId ?? verified.receipt.orderId}`);
    line("reclamo", `${signed.document.claimId} (${signed.document.reason})`);
    line("pide", usdc(BigInt(amountAtomic)));
    line("firmante", signed.document.claimant);
  }

  const venue = venueOf(verified.receipt, verified.hash, contractId);
  if (venue.kind === "escrow") {
    await openInEscrow(env, venue, claimJws, receiptJws, verified, arbiter);
    return;
  }

  section("[árbitro] verifica y abre la disputa en el contrato");
  const claim = await verifyClaim(claimJws);
  const checked = await checkClaim(claim.document, verified, { controllerOf: (payer) => railOwner(payer, arbiter.secret()) });
  line("✅ recibo", "firma del comercio, anclado en receipt-registry, pago confirmado en Horizon");
  line("✅ firmante", `controla al pagador ${checked.payer}`);
  line("✅ plazo", `hasta ${checked.receipt.refundWindowEndsAt}`);
  const hash = claimHash(claimJws);
  // Written before `open` is sent: if the transaction lands but the CLI fails
  // waiting for it, the claim behind the on-chain `claim_hash` must still exist.
  const dir = stateDir(verified.hash);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "claim.jws"), `${claimJws}\n`);
  await writeFile(resolve(dir, "receipt.jws"), `${receiptJws}\n`);
  const { txHash } = await stellarCliTx(
    ["contract", "invoke", "--id", contractId, "--", "open", "--receipt", verified.hash, "--payer", checked.payer, "--claim_hash", hash, "--amount", checked.disputedAtomic.toString()],
    arbiter.secret(),
  );
  const dispute = await readDispute(contractId, verified.hash, arbiter.secret());
  const guarantee = await readGuarantee(contractId, dispute?.merchant ?? "", arbiter.secret());
  if (txHash !== undefined) line("tx", `${EXPLORER}/tx/${txHash}`);
  line("disputa", `${dispute?.status ?? "?"}, ${usdc(dispute?.amount ?? 0n)} bloqueados en la garantía de ${dispute?.merchant ?? "?"}`);
  line("garantía", `${usdc(guarantee.balance)} (bloqueado ${usdc(guarantee.locked)})`);
  section("[comercio] tiene 48 h para responder (E-22)");
  line("enviarle", resolve(dir, "claim.jws"));
  line("responde en", RESPONDER_URL);
  line("firma", `con Freighter, desde la cuenta de cobro del recibo ${checked.receipt.merchantAccount}`);
  if (dispute !== null) line("plazo", responseDeadline(dispute.opened_at).toISOString());
  out(`\nCon su respuesta: pnpm run resolve:decide -- --receipt ${verified.hash} --response <archivo>`);
  out(`Sin respuesta, después del plazo: pnpm run resolve:decide -- --receipt ${verified.hash}\n`);
}

/**
 * A dispute over a purchase the store's escrow holds (T158): the same claim and checks, then `open` in the escrow,
 * sent by the payer's own key. No arbiter is needed: the rail owner's signature over the escrow's message (`X-18`)
 * is the consent, and the escrow checks it against the payer it recorded with `hold`.
 */
async function openInEscrow(
  env: ReadonlyMap<string, string>,
  venue: DisputeVenue,
  claimJws: string,
  receiptJws: string,
  verified: Awaited<ReturnType<typeof verifiedReceipt>>,
  reader: Keypair,
): Promise<void> {
  section("[comprador] abre la disputa en el escrow de la tienda");
  const claim = await verifyClaim(claimJws);
  const checked = await checkClaim(claim.document, verified, { controllerOf: (payer) => railOwner(payer, reader.secret()) });
  const purchase = await escrowClient(venue).get(venue.key);
  if (purchase === null || fromEscrow(purchase).status !== "none" || purchase.payer !== checked.payer || purchase.receiptHash !== verified.hash) {
    throw new AgentPassError("ResolveReceiptInvalid", "the escrow does not hold this purchase, for this receipt and payer, without a dispute", {
      details: { escrow: venue.contractId, order: venue.key, status: purchase?.status ?? null },
    });
  }
  if (!checked.payer.startsWith("C")) {
    throw new AgentPassError("ResolveClaimantNotPayer", "a purchase paid from a classic account is disputed with that account's own transaction, not supported here", { details: { payer: checked.payer } });
  }
  const owner = buyerKey(env, didToStellarAddress(claim.document.claimant));
  line("✅ recibo", "firma del comercio, anclado en receipt-registry, pago confirmado en Horizon, retenido en el escrow");
  line("✅ firmante", `dueño del rail ${checked.payer} que pagó`);
  line("escrow", `${EXPLORER}/contract/${venue.contractId}`);
  line("orden", venue.key);
  const hash = claimHash(claimJws);
  const dir = stateDir(verified.hash);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "claim.jws"), `${claimJws}\n`);
  await writeFile(resolve(dir, "receipt.jws"), `${receiptJws}\n`);
  // An `Option<BytesN<64>>` reaches the CLI as JSON: a quoted hex string (T157).
  const sig = Buffer.from(signEscrowOpen(venue.contractId, venue.key, hash, owner)).toString("hex");
  const { txHash } = await stellarCliTx(
    ["contract", "invoke", "--id", venue.contractId, "--", "open", "--order_ref", orderRefHex(venue.key), "--claim_hash", hash, "--sig", JSON.stringify(sig)],
    owner.secret(),
  );
  const view = await readView(venue, reader.secret());
  const config = await escrowClient(venue).config();
  if (txHash !== undefined) line("tx", `${EXPLORER}/tx/${txHash}`);
  line("disputa", `${view?.detail ?? "?"}, ${usdc(view?.amount ?? 0n)} retenidos; la liberación queda congelada`);
  if (view?.openedAt != null) {
    section(`[comercio] tiene ${Math.round(config.responseWindowSeconds / 60)} min para responder, en la red (X-26)`);
    line("plazo", responseDeadline(view.openedAt, config.responseWindowSeconds).toISOString());
    line("árbitro hasta", new Date((view.openedAt + config.responseWindowSeconds + config.resolveWindowSeconds) * 1000).toISOString());
  }
  out(`\nDespués del plazo: pnpm run resolve:decide -- --receipt ${verified.hash}\n`);
}

async function decide(): Promise<void> {
  const { env, contractId } = await context();
  if (values.receipt === undefined) usage("usage: resolve:decide -- --receipt <hash>");
  const arbiterKey = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve"));
  const apiKey = requireEnv(env, "ANTHROPIC_API_KEY", "add an Anthropic API key to .env.local");
  const dir = stateDir(values.receipt);
  const claimJws = (await readFile(resolve(dir, "claim.jws"), "utf8")).trim();

  out("\nAgentResolve · veredicto · testnet");
  const claim = await verifyClaim(claimJws);
  const verified = await verifiedReceipt(claim.document.receipt.jws);
  const venue = venueOf(verified.receipt, verified.hash, contractId);
  const dispute = await readView(venue, arbiterKey.secret());
  assertOpenFor(dispute, claimHash(claimJws));
  const escrowConfig = await escrowConfigOf(venue);
  line("contrato", `${venue.kind === "escrow" ? "escrow de la tienda" : "agent-resolve"} ${venue.contractId}`);
  // The claim is re-checked as of the moment the dispute opened, not now: the
  // window and the claimant were validated then, by `open` and by the
  // contract. Re-reading them today would strand an open dispute whose window
  // closed since, or whose rail rotated its owner, with its amount locked.
  // The claimant is the one `open` accepted, bound by `claim_hash` on chain.
  const checked = await checkClaim(claim.document, verified, {
    controllerOf: () => Promise.resolve(didToStellarAddress(claim.document.claimant)),
    now: new Date(dispute.openedAt * 1000),
  });

  // The merchant's side (T126): a new file passed now, or the one an earlier
  // `decide` kept. Verified against the dispute on chain either way, and
  // without one, no decision before the 48 h (E-22).
  const windowSeconds = responseWindowOf(venue, escrowConfig);
  const response = await merchantResponse(dir, values.response, {
    receipt: checked.receipt,
    receiptHash: verified.hash,
    claimHash: dispute.claimHash!,
    claimId: claim.document.claimId,
    // What the contract locked (agent-resolve), or what the claim asks of the held purchase (escrow).
    disputedAtomic: disputedOf(venue, dispute, checked.disputedAtomic),
  });
  // An answer the merchant gave on chain must be the one heard (T158).
  assertResponseMatches(dispute, response?.hash ?? null);
  assertMayDecide({ openedAt: dispute.openedAt, hasResponse: response !== null, windowSeconds });
  if (response === null) {
    line("respuesta", `ninguna; el plazo venció el ${responseDeadline(dispute.openedAt, windowSeconds).toISOString()}`);
  } else {
    line("✅ respuesta", `${describePosition(response)}, firmada por ${didToStellarAddress(response.response.respondent)} (cuenta de cobro del recibo)`);
  }

  const { verdict, hash } = await decideDispute({ checked, receiptHash: verified.hash, claimHash: claimHash(claimJws), arbiter: createClaudeArbiterWithKey(apiKey), response, responseWindowSeconds: windowSeconds });
  // Every verdict is kept, in order: asking again until one comes out
  // convenient must leave a trail. `verdict.json` is the latest, the only one
  // `execute` will pay.
  const history = resolve(dir, "verdicts");
  await mkdir(history, { recursive: true });
  const earlier = (await readdir(history)).filter((name) => name.endsWith(".json")).length;
  const json = `${JSON.stringify(verdict, null, 2)}\n`;
  await writeFile(resolve(history, `${String(earlier + 1).padStart(3, "0")}-${hash}.json`), json);
  await writeFile(resolve(dir, "verdict.json"), json);

  line("árbitro", `${verdict.arbiter.model} (esfuerzo ${verdict.arbiter.effort})`);
  line("veredicto n.º", earlier === 0 ? "1" : `${earlier + 1} (hay ${earlier} anterior${earlier === 1 ? "" : "es"} archivado${earlier === 1 ? "" : "s"} en verdicts/; solo este se puede ejecutar)`);
  line("resultado", verdict.outcome);
  line("reembolso", `${usdc(BigInt(verdict.refundAtomic))} de ${usdc(BigInt(verdict.disputedAtomic))} en disputa`);
  if (verdict.adjusted) line("ajustado", `el modelo propuso ${usdc(BigInt(verdict.proposedRefundAtomic))}; el código lo acotó`);
  section("Razonamiento");
  out(verdict.reasoning.split("\n").map((l) => `  ${l}`).join("\n"));
  section("Hechos");
  for (const finding of verdict.findings) out(`  - ${finding}`);
  section("Hash del veredicto");
  line("sha256", hash);
  out(`\nNada se pagó. Para confirmar y pagar (E-18), una persona corre:\n  pnpm run resolve:execute -- --receipt ${verified.hash} --confirm ${hash}\n`);
}

/** The amount a verdict is bounded by: the lock in agent-resolve; in an escrow, the claim, never above the purchase. */
function disputedOf(venue: DisputeVenue, view: DisputeView, claimed: bigint): bigint {
  if (venue.kind === "agent-resolve") return view.amount;
  return claimed < view.amount ? claimed : view.amount;
}

function describePosition(verified: VerifiedResponse): string {
  const { position, acceptedAtomic } = verified.response;
  return acceptedAtomic === null ? position : `${position} (${formatAtomic(acceptedAtomic)} USDC)`;
}

async function readResponseFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AgentPassError("ResolveResponseInvalid", "the response file is not JSON", { details: { path }, cause: error });
  }
}

/**
 * The merchant's response for a dispute: the file passed with `--response`
 * (verified, then kept), or the one kept earlier (verified again), or `null`
 * when there is none. Every response is kept under `responses/<hash>.json`
 * and never overwritten, so each archived verdict's `responseHash` still
 * points at a file; `response.json` is the latest, the one `decide` reuses.
 */
async function merchantResponse(dir: string, path: string | undefined, context: ResponseContext): Promise<VerifiedResponse | null> {
  const latest = resolve(dir, "response.json");
  if (path !== undefined) {
    const verified = verifyMerchantResponse(await readResponseFile(resolve(path)), context);
    const json = `${JSON.stringify({ response: verified.response, signature: verified.signature }, null, 2)}\n`;
    await mkdir(resolve(dir, "responses"), { recursive: true });
    await writeFile(resolve(dir, "responses", `${verified.hash}.json`), json);
    await writeFile(latest, json);
    return verified;
  }
  const exists = await readFile(latest, "utf8").then(() => true, () => false);
  return exists ? verifyMerchantResponse(await readResponseFile(latest), context) : null;
}

/** Verifies a merchant's response against the dispute on chain, open or resolved. Decides nothing, writes nothing. */
async function checkResponse(): Promise<void> {
  const { env, contractId } = await context();
  if (values.receipt === undefined || values.response === undefined) usage("usage: resolve:check-response -- --receipt <hash> --response <file>");
  const reader = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve"));
  const claimJws = (await readFile(resolve(stateDir(values.receipt), "claim.jws"), "utf8")).trim();

  out("\nAgentResolve · verificar la respuesta de un comercio · testnet");
  const claim = await verifyClaim(claimJws);
  const verified = await verifiedReceipt(claim.document.receipt.jws);
  const venue = venueOf(verified.receipt, verified.hash, contractId);
  const dispute = await readView(venue, reader.secret());
  if (dispute === null || dispute.claimHash !== claimHash(claimJws)) {
    throw new AgentPassError("ResolveReceiptInvalid", "there is no dispute on chain for this claim", { details: { receipt: verified.hash, status: dispute?.status ?? null } });
  }
  const response = verifyMerchantResponse(await readResponseFile(resolve(values.response)), {
    receipt: verified.receipt,
    receiptHash: verified.hash,
    claimHash: dispute.claimHash,
    claimId: claim.document.claimId,
    disputedAtomic: disputedOf(venue, dispute, BigInt(claim.document.amountAtomic)),
  });
  line("✅ firma", `SEP-53 de ${didToStellarAddress(response.response.respondent)}, la cuenta de cobro del recibo`);
  line("✅ disputa", `responde al reclamo ${dispute.claimHash.slice(0, 16)}… que está en la red (${dispute.detail})`);
  line("posición", describePosition(response));
  line("descargos", response.response.statement);
  for (const item of response.response.evidence) line("evidencia", item.content);
  line("hash", response.hash);
}

/**
 * The response a verdict names, read back from `responses/` and hashed again:
 * whoever confirms (E-18) or audits sees that the anchored verdict covers the
 * response on file. `true` when there is nothing to check (no response, or a
 * verdict from before T126).
 */
async function checkArchivedResponse(dir: string, hash: string | null | undefined): Promise<boolean> {
  if (hash === undefined) return true;
  if (hash === null) {
    line("respuesta", "el comercio no respondió en su plazo");
    return true;
  }
  const json = await readResponseFile(resolve(dir, "responses", `${hex64.parse(hash)}.json`)).catch(() => null);
  const file = json === null ? null : signedResponseFileSchema.safeParse(json);
  const parsed = file?.success === true ? agentResolveResponseSchema.safeParse(file.data.response) : null;
  const matches = parsed?.success === true && responseHash(parsed.data) === hash;
  line(`${matches ? "✅" : "❌"} respuesta`, matches ? `la del comercio archivada en responses/ es la que cubre el veredicto (${hash.slice(0, 16)}…)` : `el veredicto nombra ${hash}, pero no hay una respuesta archivada con ese hash`);
  return matches;
}

async function execute(): Promise<void> {
  const { env, contractId } = await context();
  if (values.receipt === undefined || values.confirm === undefined) usage("usage: resolve:execute -- --receipt <hash> --confirm <verdict hash>");
  const arbiter = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve"));
  const dir = stateDir(values.receipt);
  const verdict: AgentResolveVerdict = agentResolveVerdictSchema.parse(JSON.parse(await readFile(resolve(dir, "verdict.json"), "utf8")));
  const hash = verdictHash(verdict);
  if (verdict.receiptHash !== values.receipt) {
    throw new AgentPassError("ResolveConfirmationMismatch", "the verdict on file is about another receipt; nothing was paid", { details: { receipt: values.receipt, verdict: verdict.receiptHash } });
  }
  if (values.confirm !== hash) {
    throw new AgentPassError("ResolveConfirmationMismatch", "the confirmed hash is not the verdict on file; nothing was paid", { details: { confirmed: values.confirm, onFile: hash } });
  }
  const latest = (await readdir(resolve(dir, "verdicts")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort().at(-1);
  if (latest !== undefined && !latest.endsWith(`-${hash}.json`)) {
    throw new AgentPassError("ResolveConfirmationMismatch", "the verdict on file is not the latest one the arbiter produced; nothing was paid", { details: { latest, onFile: hash } });
  }
  const venue = await venueFromDir(dir, values.receipt, contractId);
  const dispute = await readView(venue, arbiter.secret());
  if (dispute === null || dispute.status !== "open" || dispute.claimHash !== verdict.claimHash || dispute.openedAt === null) {
    throw new AgentPassError("ResolveConfirmationMismatch", "the dispute on chain is not open for this verdict's claim; nothing was paid", { details: { status: dispute?.status ?? null } });
  }
  // The escrow only takes a verdict inside its windows (X-7): checked here, so a late confirmation says so plainly.
  assertMayExecute(venue, { ...dispute, openedAt: dispute.openedAt }, await escrowConfigOf(venue), new Date());

  out("\nAgentResolve · ejecutar el veredicto confirmado · testnet");
  line("contrato", `${venue.kind === "escrow" ? "escrow de la tienda" : "agent-resolve"} ${venue.contractId}`);
  line("veredicto", `${verdict.outcome}, ${hash}`);
  line("reembolso", `${usdc(BigInt(verdict.refundAtomic))} a ${dispute.payer}${venue.kind === "escrow" ? ", desde el pago retenido" : ", desde la garantía"}`);
  const call =
    venue.kind === "escrow"
      ? ["resolve", "--order_ref", orderRefHex(venue.key), "--verdict_hash", hash, "--refund", verdict.refundAtomic]
      : ["resolve", "--receipt", values.receipt, "--verdict_hash", hash, "--refund", verdict.refundAtomic];
  const { txHash } = await stellarCliTx(["contract", "invoke", "--id", venue.contractId, "--", ...call], arbiter.secret());
  await writeFile(resolve(dir, "resolved.json"), `${JSON.stringify({ verdictHash: hash, txHash: txHash ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  if (txHash !== undefined) line("tx", `${EXPLORER}/tx/${txHash}`);
  const after = await readView(venue, arbiter.secret());
  line("disputa", `${after?.detail ?? "?"}, reembolsado ${usdc(after?.refund ?? 0n)}`);
  out(`\nVerificar: pnpm run resolve:verify -- --receipt ${values.receipt}\n`);
}

async function verify(): Promise<void> {
  const { env, contractId } = await context();
  if (values.receipt === undefined) usage("usage: resolve:verify -- --receipt <hash>");
  const reader = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve")); // read-only calls still name a source account
  const venue = await venueFromDir(stateDir(values.receipt), values.receipt, contractId);
  const dispute = await readView(venue, reader.secret());

  out("\nAgentResolve · verificar una disputa · testnet");
  line("contrato", `${venue.kind === "escrow" ? "escrow de la tienda" : "agent-resolve"} ${EXPLORER}/contract/${venue.contractId}`);
  line("recibo", values.receipt);
  if (dispute === null || dispute.status === "none") {
    line("❌ disputa", "no hay disputa para este recibo");
    process.exitCode = 1;
    return;
  }
  line("estado", dispute.detail);
  line("pagador", dispute.payer);
  line(venue.kind === "escrow" ? "retenido" : "en disputa", usdc(dispute.amount));
  line("reembolso", usdc(dispute.refund));
  if (dispute.responseHash !== null) line("respuesta", `en la red ${dispute.responseHash.slice(0, 16)}…`);
  // A resolved dispute must match a valid verdict on file; an open one has none yet.
  let ok = dispute.status === "open";
  const parsed = await readVerdictFile(stateDir(values.receipt));
  if (parsed === null) {
    if (dispute.status === "resolved") {
      line("❌ veredicto", `en la red ${dispute.verdictHash ?? "—"}, pero no hay un veredicto válido archivado con qué compararlo`);
    } else {
      line("veredicto", "sin veredicto todavía");
    }
  } else {
    const local = verdictHash(parsed);
    const responseOk = await checkArchivedResponse(stateDir(values.receipt), parsed.responseHash);
    const matches = verdictMatches(dispute, parsed, local);
    if (dispute.status === "resolved") {
      line(`${matches ? "✅" : "❌"} veredicto`, matches ? `el hash en la red es el del veredicto archivado (${local.slice(0, 16)}…)` : `no coincide: red ${dispute.verdictHash ?? "—"}, archivo ${local}`);
      ok = matches && responseOk;
    } else {
      line("veredicto", `archivado ${local.slice(0, 16)}…, todavía sin ejecutar`);
    }
  }
  const produced = (await readdir(resolve(stateDir(values.receipt), "verdicts")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;
  if (produced > 0) line("historial", `${produced} veredicto${produced === 1 ? "" : "s"} producido${produced === 1 ? "" : "s"} para este reclamo (verdicts/)`);
  if (venue.kind === "agent-resolve") {
    const merchant = await readDispute(contractId, values.receipt, reader.secret());
    if (merchant !== null) {
      const guarantee = await readGuarantee(contractId, merchant.merchant, reader.secret());
      line("garantía", `${usdc(guarantee.balance)} (bloqueado ${usdc(guarantee.locked)})`);
    }
  }
  process.exitCode = ok ? 0 : 1;
}

const COMMANDS: Record<string, () => Promise<void>> = { deposit, open, decide, execute, verify, "check-response": checkResponse };

const run = COMMANDS[command];
(run ?? (() => Promise.reject(new AgentPassError("InvalidArguments", `unknown command "${command}": ${Object.keys(COMMANDS).join(", ")}`, { details: {} }))))().catch((error: unknown) => {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) process.stderr.write(`${JSON.stringify(error.details, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  } else {
    process.stderr.write(`\n${String(error)}\n`);
  }
  process.exitCode = 1;
});
