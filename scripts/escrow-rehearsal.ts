#!/usr/bin/env node
/**
 * `pnpm run escrow:rehearsal` — prove a PurchaseEscrow on testnet (T157):
 * two real payments into the `rehearsal` escrow, each recorded with a manual
 * `hold`, one released to the payee and one refunded to the rail that paid.
 *
 * Each payment goes the way a checkout's does: a `transfer` from the UCP
 * `policy_rail`, signed by its owner (`AGENT_SECRET_KEY`), settled by the x402
 * facilitator (`X-14`). Then:
 *
 *   released   hold → mark_shipped → (release window) → release
 *   refunded   hold → open, signed by the rail's owner → respond → resolve, full refund
 *
 * The claim, response, receipt and verdict here are rehearsal documents: what
 * the contract stores is their SHA-256. The real ones arrive with T159–T163.
 * Moves `--amount` USDC (default 0.05) per scenario out of the UCP rail; the
 * refund brings one of them back. Needs the user's OK each time it runs.
 *
 *   --scenario released|refunded|both   default both
 *   --amount <usdc>                     default 0.05
 *   --resume <order_ref>                finish a `refunded` run that stopped after `hold`
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { z } from "zod";

import { STELLAR_DECIMALS, toAtomic } from "../packages/ucp-stellar/src/index.js";
import { signEscrowOpen } from "../packages/resolve/src/escrow-open.js";
import { readDeployment } from "./lib/deployment.js";
import { payIntoEscrow } from "./lib/escrow-pay.js";
import { readEnvFile } from "./lib/env-file.js";
import { escrowPurchaseSchema, orderRefHex, type EscrowPurchase } from "./lib/purchase-escrow.js";
import { lastLine, stellarCli, stellarCliTx } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPLORER = "https://stellar.expert/explorer/testnet/tx";
const ARGV = process.argv.slice(2);

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function flag(name: string, fallback: string): string {
  const at = ARGV.indexOf(name);
  return at === -1 ? fallback : (ARGV[at + 1] ?? "");
}

function requireEnv(env: ReadonlyMap<string, string>, key: string, file: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from ${file}`, { details: { key } });
  return value;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Rehearsal {
  readonly escrow: string;
  readonly rail: string;
  readonly token: string;
  readonly releaseWindowSeconds: number;
  readonly operator: Keypair;
  readonly payee: Keypair;
  readonly arbiter: Keypair;
  readonly railOwner: Keypair;
  readonly facilitator: HTTPFacilitatorClient;
  readonly amountAtomic: bigint;
}

/** One x402 payment from the UCP rail into the escrow, settled by the facilitator. Returns the transaction hash. */
function pay(r: Rehearsal, orderRef: string): Promise<string> {
  return payIntoEscrow({ facilitator: r.facilitator, rail: r.rail, railOwner: r.railOwner, token: r.token, escrow: r.escrow, amountAtomic: r.amountAtomic, label: orderRef });
}

async function invoke(r: Rehearsal, signer: Keypair, args: readonly string[]): Promise<string> {
  const { txHash } = await stellarCliTx(["contract", "invoke", "--id", r.escrow, "--", ...args], signer.secret());
  if (txHash === undefined) throw new AgentPassError("CommandFailed", `${args[0]} submitted no transaction`, { details: { args } });
  return txHash;
}

async function get(r: Rehearsal, orderRef: string): Promise<EscrowPurchase> {
  const raw = lastLine(await stellarCli(["contract", "invoke", "--id", r.escrow, "--send", "no", "--", "get", "--order_ref", orderRefHex(orderRef)], r.operator.secret()));
  return escrowPurchaseSchema.parse(JSON.parse(raw));
}

function step(name: string, hash: string): void {
  out(`  ${name.padEnd(13)} ${hash}  ${EXPLORER}/${hash}`);
}

async function hold(r: Rehearsal, orderRef: string, paymentTx: string): Promise<void> {
  step("hold", await invoke(r, r.operator, [
    "hold", "--order_ref", orderRefHex(orderRef), "--payer", r.rail, "--amount", r.amountAtomic.toString(),
    "--tx_hash", paymentTx, "--receipt_hash", sha256(`rehearsal receipt for ${orderRef} paid by ${paymentTx}`),
  ]));
}

async function released(r: Rehearsal, orderRef: string): Promise<void> {
  out(`\nreleased · ${orderRef}`);
  const paymentTx = await pay(r, orderRef);
  step("payment", paymentTx);
  await hold(r, orderRef, paymentTx);
  step("mark_shipped", await invoke(r, r.operator, ["mark_shipped", "--order_ref", orderRefHex(orderRef)]));
  out(`  waiting      ${r.releaseWindowSeconds} s release window`);
  await sleep((r.releaseWindowSeconds + 10) * 1000);
  for (let attempt = 0; ; attempt += 1) {
    try {
      step("release", await invoke(r, r.operator, ["release", "--order_ref", orderRefHex(orderRef)]));
      break;
    } catch (error) {
      // The ledger's clock trails the wall clock by a few seconds: ReleaseTooEarly is the contract's error #9.
      if (attempt >= 5 || !(isAgentPassError(error) && JSON.stringify(error.details).includes("Error(Contract, #9)"))) throw error;
      await sleep(10_000);
    }
  }
  const purchase = await get(r, orderRef);
  out(`  status       ${purchase.status} · refund ${purchase.refund} · ${purchase.amount} to the payee`);
}

async function refunded(r: Rehearsal, orderRef: string, resume: boolean): Promise<void> {
  out(`\nrefunded · ${orderRef}`);
  if (resume) {
    // A run that stopped after `hold`: the payment is already held, so it is not paid twice.
    const held = await get(r, orderRef);
    if (held.status !== "Held" || held.payer !== r.rail || held.amount !== r.amountAtomic) {
      throw new AgentPassError("ConfigError", "--resume takes a purchase held from the UCP rail for --amount", { details: { orderRef, status: held.status, payer: held.payer, amount: held.amount.toString() } });
    }
    out(`  resumed      held since ${new Date(held.held_at * 1000).toISOString()}, payment ${held.tx_hash}`);
  } else {
    const paymentTx = await pay(r, orderRef);
    step("payment", paymentTx);
    await hold(r, orderRef, paymentTx);
  }
  const claimHash = sha256(`rehearsal claim: ${orderRef} not delivered`);
  const sig = Buffer.from(signEscrowOpen(r.escrow, orderRef, claimHash, r.railOwner)).toString("hex");
  // Anyone may submit `open`: the rail owner's signature is the consent. The operator pays the fee here.
  // An `Option` argument reaches the CLI as JSON: a quoted hex string for `Some(BytesN<64>)`.
  step("open", await invoke(r, r.operator, ["open", "--order_ref", orderRefHex(orderRef), "--claim_hash", claimHash, "--sig", JSON.stringify(sig)]));
  step("respond", await invoke(r, r.payee, ["respond", "--order_ref", orderRefHex(orderRef), "--response_hash", sha256(`rehearsal response: ${orderRef}`)]));
  step("resolve", await invoke(r, r.arbiter, [
    "resolve", "--order_ref", orderRefHex(orderRef), "--verdict_hash", sha256(`rehearsal verdict: refund_full ${orderRef}`), "--refund", r.amountAtomic.toString(),
  ]));
  const purchase = await get(r, orderRef);
  out(`  status       ${purchase.status} · refund ${purchase.refund} back to ${r.rail} · owed ${purchase.refund_owed}`);
}

async function main(): Promise<void> {
  const scenario = z.enum(["released", "refunded", "both"]).parse(flag("--scenario", "both"));
  const amount = flag("--amount", "0.05");
  const env = await readEnvFile(resolve(REPO_ROOT, ".env.local"));
  const vitrineeEnv = await readEnvFile(resolve(REPO_ROOT, ".env.vitrinee.local"));
  const deployment = await readDeployment(resolve(REPO_ROOT, "deployments/testnet.json"));
  const escrow = deployment.purchaseEscrows["rehearsal"];
  const rail = deployment.policyRailUcp;
  if (escrow === undefined) throw new AgentPassError("ConfigError", "no rehearsal escrow recorded; run deploy:purchase-escrow --rehearsal first", { details: {} });
  if (rail === null) throw new AgentPassError("ConfigError", "no UCP rail recorded in deployments/testnet.json", { details: {} });

  const apiKey = vitrineeEnv.get("FACILITATOR_API_KEY")?.trim();
  const r: Rehearsal = {
    escrow: escrow.contractId,
    rail: rail.contractId,
    token: escrow.token,
    releaseWindowSeconds: escrow.releaseWindowSeconds,
    operator: Keypair.fromSecret(requireEnv(env, "ADMIN_SECRET_KEY", ".env.local")),
    payee: Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY", ".env.local")),
    arbiter: Keypair.fromSecret(requireEnv(env, "RESOLVE_ARBITER_SECRET_KEY", ".env.local")),
    railOwner: Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY", ".env.local")),
    facilitator: new HTTPFacilitatorClient({
      url: vitrineeEnv.get("FACILITATOR_URL")?.trim() || "https://channels.openzeppelin.com/x402/testnet",
      createAuthHeaders: apiKey ? async () => { const h = { Authorization: `Bearer ${apiKey}` }; return { verify: h, settle: h, supported: h }; } : undefined,
    }),
    amountAtomic: toAtomic(amount, STELLAR_DECIMALS),
  };
  for (const [name, expected] of [["operator", r.operator], ["payee", r.payee], ["arbiter", r.arbiter]] as const) {
    if (escrow[name] !== expected.publicKey()) throw new AgentPassError("ConfigError", `the rehearsal escrow's ${name} is not this repo's key`, { details: { recorded: escrow[name] } });
  }
  if (rail.owner !== r.railOwner.publicKey()) throw new AgentPassError("ConfigError", "AGENT_SECRET_KEY does not own the UCP rail", { details: { owner: rail.owner } });

  const resume = ARGV.includes("--resume") ? flag("--resume", "") : undefined;
  if (resume !== undefined && scenario !== "refunded") throw new AgentPassError("InvalidArguments", "--resume goes with --scenario refunded", { details: {} });
  const stamp = Date.now().toString(36);
  out(`\nAgentPey escrow:rehearsal · ${r.escrow} · ${amount} USDC per scenario from ${r.rail}`);
  if (scenario !== "refunded") await released(r, `rehearsal-${stamp}-r`);
  if (scenario !== "released") await refunded(r, resume ?? `rehearsal-${stamp}-f`, resume !== undefined);
  out("");
}

main().catch((error: unknown) => {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`\n${String(error)}\n`);
  }
  process.exitCode = 1;
});
