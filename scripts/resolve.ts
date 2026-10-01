/**
 * AgentResolve from the command line — T124 (`E-14` to `E-19`).
 *
 *   pnpm run resolve:deposit -- --merchant <G...> --amount 3.00
 *   pnpm run resolve:open    -- --receipt .vitrinee/last-ucp-receipt.jws --reason not_delivered --description "…" [--evidence "…"]… [--amount 1.00]
 *   pnpm run resolve:decide  -- --receipt <hash>
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
 * - **decide**: Claude Opus 5.5 proposes, the code bounds it, the verdict is
 *   written to disk with its hash. Nothing moves.
 * - **execute**: a person confirms by passing that exact hash (`E-18`); only
 *   then does the arbiter call `resolve`, which pays from the guarantee.
 * - **verify**: reads the dispute on chain and checks it against the verdict
 *   file. Read-only.
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
import type { AgentResolveVerdict, ClaimReason } from "@agentpey/resolve";
import {
  CLAIM_REASONS,
  agentResolveVerdictSchema,
  checkClaim,
  claimHash,
  createClaudeArbiterWithKey,
  decideDispute,
  signClaim,
  verdictHash,
  verifyClaim,
} from "@agentpey/resolve";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { ReceiptRegistryClient, verifyReceipt } from "../packages/vitrinee-anchor/src/index.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";
import { lastLine, stellarCli, stellarCliTx } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const STATE_ROOT = resolve(REPO_ROOT, ".vitrinee/agentresolve");
const VITRINEE_DEPLOYMENT = resolve(REPO_ROOT, "deployments/vitrinee-testnet.json");
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet";

const [command = "", ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
const { values } = parseArgs({
  args: rest,
  options: {
    merchant: { type: "string" },
    amount: { type: "string" },
    receipt: { type: "string" },
    reason: { type: "string" },
    description: { type: "string" },
    evidence: { type: "string", multiple: true },
    confirm: { type: "string" },
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

/** `policy_rail.owner()`: the key that may speak for a rail payer. */
async function railOwner(rail: string, secret: string): Promise<string> {
  const answer = lastLine(await stellarCli(["contract", "invoke", "--id", rail, "--send", "no", "--", "owner"], secret)).replaceAll('"', "");
  const hex = hex64.safeParse(answer);
  if (!hex.success) {
    throw new AgentPassError("ResolveClaimantNotPayer", "the payer contract did not answer owner() with an Ed25519 key, so no one can speak for it", { details: { payer: rail, answer: answer.slice(0, 80) } });
  }
  return StrKey.encodeEd25519PublicKey(Buffer.from(hex.data, "hex"));
}

async function verifiedReceipt(jws: string) {
  const deployment = z.object({ receiptRegistry: z.object({ contractId: z.string() }) }).parse(JSON.parse(await readFile(VITRINEE_DEPLOYMENT, "utf8")));
  const result = await verifyReceipt(jws, {
    registry: new ReceiptRegistryClient({ contractId: deployment.receiptRegistry.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
    horizonUrl: HORIZON,
    settlementAttempts: 5,
  });
  if (!result.valid || result.receipt === null) {
    throw new AgentPassError("ResolveReceiptInvalid", "the receipt did not pass its three checks", { details: { hash: result.hash, checks: result.checks } });
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
  if (values.receipt === undefined || values.reason === undefined || values.description === undefined) {
    usage(`usage: resolve:open -- --receipt <file.jws> --reason <${CLAIM_REASONS.join("|")}> --description <text> [--evidence <text>]… [--amount <USDC>]`);
  }
  if (!(CLAIM_REASONS as readonly string[]).includes(values.reason)) usage(`--reason must be one of ${CLAIM_REASONS.join(", ")}`);
  const buyer = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY", "pnpm run bootstrap"));
  const arbiter = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve"));
  const receiptJws = (await readFile(resolve(values.receipt), "utf8")).trim();

  out("\nAgentResolve · abrir un reclamo · testnet");
  section("[comprador] firma el reclamo");
  const verified = await verifiedReceipt(receiptJws);
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
  line("recibo", verified.hash);
  line("pedido", `${verified.receipt.platform} ${verified.receipt.platformOrderId ?? verified.receipt.orderId}`);
  line("reclamo", `${signed.document.claimId} (${signed.document.reason})`);
  line("pide", usdc(BigInt(amountAtomic)));
  line("firmante", signed.document.claimant);

  section("[árbitro] verifica y abre la disputa en el contrato");
  const claim = await verifyClaim(signed.jws);
  const checked = await checkClaim(claim.document, verified, { controllerOf: (payer) => railOwner(payer, arbiter.secret()) });
  line("✅ recibo", "firma del comercio, anclado en receipt-registry, pago confirmado en Horizon");
  line("✅ firmante", `controla al pagador ${checked.payer}`);
  line("✅ plazo", `hasta ${checked.receipt.refundWindowEndsAt}`);
  const hash = claimHash(signed.jws);
  // Written before `open` is sent: if the transaction lands but the CLI fails
  // waiting for it, the claim behind the on-chain `claim_hash` must still exist.
  const dir = stateDir(verified.hash);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "claim.jws"), `${signed.jws}\n`);
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
  out(`\nSiguiente: pnpm run resolve:decide -- --receipt ${verified.hash}\n`);
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
  const dispute = await readDispute(contractId, verified.hash, arbiterKey.secret());
  if (dispute === null || dispute.status !== "Open" || dispute.claim_hash !== claimHash(claimJws)) {
    throw new AgentPassError("ResolveReceiptInvalid", "there is no open dispute on chain for this claim", { details: { receipt: verified.hash, dispute } });
  }
  // The claim is re-checked as of the moment the dispute opened, not now: the
  // window and the claimant were validated then, by `open` and by the
  // contract. Re-reading them today would strand an open dispute whose window
  // closed since, or whose rail rotated its owner, with its amount locked.
  // The claimant is the one `open` accepted, bound by `claim_hash` on chain.
  const checked = await checkClaim(claim.document, verified, {
    controllerOf: () => Promise.resolve(didToStellarAddress(claim.document.claimant)),
    now: new Date(dispute.opened_at * 1000),
  });

  const { verdict, hash } = await decideDispute({ checked, receiptHash: verified.hash, claimHash: claimHash(claimJws), arbiter: createClaudeArbiterWithKey(apiKey) });
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
  const dispute = await readDispute(contractId, values.receipt, arbiter.secret());
  if (dispute === null || dispute.status !== "Open" || dispute.claim_hash !== verdict.claimHash) {
    throw new AgentPassError("ResolveConfirmationMismatch", "the dispute on chain is not open for this verdict's claim; nothing was paid", { details: { dispute } });
  }

  out("\nAgentResolve · ejecutar el veredicto confirmado · testnet");
  line("veredicto", `${verdict.outcome}, ${hash}`);
  line("reembolso", `${usdc(BigInt(verdict.refundAtomic))} a ${dispute.payer}`);
  const { txHash } = await stellarCliTx(
    ["contract", "invoke", "--id", contractId, "--", "resolve", "--receipt", values.receipt, "--verdict_hash", hash, "--refund", verdict.refundAtomic],
    arbiter.secret(),
  );
  await writeFile(resolve(dir, "resolved.json"), `${JSON.stringify({ verdictHash: hash, txHash: txHash ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  if (txHash !== undefined) line("tx", `${EXPLORER}/tx/${txHash}`);
  const after = await readDispute(contractId, values.receipt, arbiter.secret());
  line("disputa", `${after?.status ?? "?"}, reembolsado ${usdc(after?.refund ?? 0n)}`);
  out(`\nVerificar: pnpm run resolve:verify -- --receipt ${values.receipt}\n`);
}

async function verify(): Promise<void> {
  const { env, contractId } = await context();
  if (values.receipt === undefined) usage("usage: resolve:verify -- --receipt <hash>");
  const reader = Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", "pnpm run deploy:agent-resolve")); // read-only calls still name a source account
  const dispute = await readDispute(contractId, values.receipt, reader.secret());

  out("\nAgentResolve · verificar una disputa · testnet");
  line("contrato", `${EXPLORER}/contract/${contractId}`);
  line("recibo", values.receipt);
  if (dispute === null) {
    line("❌ disputa", "no hay disputa para este recibo");
    process.exitCode = 1;
    return;
  }
  line("estado", dispute.status);
  line("comercio", dispute.merchant);
  line("pagador", dispute.payer);
  line("en disputa", usdc(dispute.amount));
  line("reembolso", usdc(dispute.refund));
  // A resolved dispute must match a valid verdict on file; an open one has none yet.
  let ok = dispute.status === "Open";
  const parsed = await readVerdictFile(stateDir(values.receipt));
  if (parsed === null) {
    if (dispute.status === "Resolved") {
      line("❌ veredicto", `en la red ${dispute.verdict_hash ?? "—"}, pero no hay un veredicto válido archivado con qué compararlo`);
    } else {
      line("veredicto", "sin veredicto todavía");
    }
  } else {
    const local = verdictHash(parsed);
    const matches = dispute.verdict_hash === local && BigInt(parsed.refundAtomic) === dispute.refund && parsed.claimHash === dispute.claim_hash;
    if (dispute.status === "Resolved") {
      line(`${matches ? "✅" : "❌"} veredicto`, matches ? `el hash en la red es el del veredicto archivado (${local.slice(0, 16)}…)` : `no coincide: red ${dispute.verdict_hash ?? "—"}, archivo ${local}`);
      ok = matches;
    } else {
      line("veredicto", `archivado ${local.slice(0, 16)}…, todavía sin ejecutar`);
    }
  }
  const produced = (await readdir(resolve(stateDir(values.receipt), "verdicts")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;
  if (produced > 0) line("historial", `${produced} veredicto${produced === 1 ? "" : "s"} producido${produced === 1 ? "" : "s"} para este reclamo (verdicts/)`);
  const guarantee = await readGuarantee(contractId, dispute.merchant, reader.secret());
  line("garantía", `${usdc(guarantee.balance)} (bloqueado ${usdc(guarantee.locked)})`);
  process.exitCode = ok ? 0 : 1;
}

const COMMANDS: Record<string, () => Promise<void>> = { deposit, open, decide, execute, verify };

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
