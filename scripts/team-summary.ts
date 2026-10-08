#!/usr/bin/env node
/**
 * `pnpm run team:summary -- [--month YYYY-MM]` — T146: what the team's agent
 * spent in a month, read back from the vault `team:pay` writes, next to the
 * limits the network enforces on the rail that paid.
 *
 * The vault is verified first: a chain that does not recompute is reported,
 * and no total is printed from it. The rail's limits and today's spend are
 * read from the contract itself (`per_tx`, `per_day`, `spent_on`), not from
 * anything this repository wrote down.
 *
 * With `--html` (T153) it also writes the same month as a page next to the
 * vault and opens it in the browser.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { Networks, contract } from "@stellar/stellar-sdk";
import { z } from "zod";

import { createFileMandateVault } from "@agentpey/vault";

import { renderSummaryHtml, type RailReading } from "./lib/team-summary-html.js";
import { currentMonth, fromUnits, summarizeMonth, TEAM_LIMITS, TEAM_VAULT_PATH, toUnits } from "./lib/team-summary.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOYMENT_PATH = resolve(REPO_ROOT, "deployments/testnet.json");
const RPC_URL = "https://soroban-testnet.stellar.org";
const SECONDS_PER_DAY = 86_400;

interface RailReads {
  per_tx(): Promise<contract.AssembledTransaction<unknown>>;
  per_day(): Promise<contract.AssembledTransaction<unknown>>;
  spent_on(args: { readonly day: bigint }): Promise<contract.AssembledTransaction<unknown>>;
}

/** `per_tx`/`per_day` return a Soroban `Result`, `spent_on` a bare `i128`: both end up a bigint, or a typed error. */
function asUnits(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "object" && value !== null && "unwrap" in value && typeof value.unwrap === "function") {
    const inner: unknown = (value as { unwrap(): unknown }).unwrap();
    if (typeof inner === "bigint") return inner;
  }
  throw new AgentPassError("NetworkError", `the rail's ${what} did not read back as an amount`, { details: { what } });
}

function parseMonth(argv: readonly string[]): string {
  const at = argv.indexOf("--month");
  return at === -1 ? currentMonth(new Date()) : (argv[at + 1] ?? "");
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(18)} ${value}\n`);
}

async function readRail(contractId: string): Promise<{ perTx: string; perDay: string; spentToday: string }> {
  const client = await contract.Client.from<RailReads>({ contractId, rpcUrl: RPC_URL, networkPassphrase: Networks.TESTNET });
  const day = BigInt(Math.floor(Date.now() / 1000 / SECONDS_PER_DAY));
  const [perTx, perDay, spent] = await Promise.all([client.per_tx(), client.per_day(), client.spent_on({ day })]);
  return {
    perTx: fromUnits(asUnits(perTx.result, "per_tx")),
    perDay: fromUnits(asUnits(perDay.result, "per_day")),
    spentToday: fromUnits(asUnits(spent.result, "spent_on")),
  };
}

async function main(): Promise<void> {
  const month = parseMonth(process.argv.slice(2));
  if (!existsSync(TEAM_VAULT_PATH)) {
    throw new AgentPassError("ConfigError", "no team vault yet: run pnpm run team:pay first", { details: { path: relative(REPO_ROOT, TEAM_VAULT_PATH) } });
  }
  const vault = createFileMandateVault({ path: TEAM_VAULT_PATH });
  const integrity = vault.verify();

  process.stdout.write(`\nAgentPey · gastos del equipo · ${month}\n\n`);
  line("vault", relative(REPO_ROOT, TEAM_VAULT_PATH));
  if (!integrity.ok) {
    line("cadena", "NO verifica: el archivo se editó después de escrito. No se muestra ningún total.");
    process.exitCode = 1;
    return;
  }
  line("cadena", `verifica (${vault.list().length} registros)`);

  const summary = summarizeMonth(vault.list(), month);
  const settled = summary.payments.filter((p) => !p.released);
  process.stdout.write("\nPagos\n");
  if (settled.length === 0) line("", "ninguno este mes");
  for (const p of settled) {
    const tx = p.paymentTx === null ? "sin transacción anclada" : `https://stellar.expert/explorer/testnet/tx/${p.paymentTx}`;
    line(p.at.slice(0, 16).replace("T", " "), `${p.amount} ${p.currency}  ${tx}`);
  }
  if (summary.payments.some((p) => p.released)) {
    line("liberados", `${summary.payments.filter((p) => p.released).length} (nunca llegaron a la red, no cuentan)`);
  }

  process.stdout.write("\nRechazos\n");
  if (summary.refusals.length === 0) line("", "ninguno este mes");
  for (const r of summary.refusals) line(r.at.slice(0, 16).replace("T", " "), `${r.code}: ${r.reason}`);

  process.stdout.write("\nTotales\n");
  line("gastado", `${summary.spent} ${summary.currency ?? "USDC"} en ${settled.length} ${settled.length === 1 ? "pago" : "pagos"}, ${summary.activeDays} ${summary.activeDays === 1 ? "día" : "días"} con gasto`);
  const ceiling = toUnits(TEAM_LIMITS.perDay) * BigInt(summary.activeDays);
  line("tope del equipo", `${TEAM_LIMITS.perDay} por día (credencial y Mandato, fuera de la red): ${fromUnits(ceiling)} como máximo en esos días`);

  const deployment = z
    .object({ policyRailUcp: z.object({ contractId: z.string() }) })
    .parse(JSON.parse(await readFile(DEPLOYMENT_PATH, "utf8")));
  let railReading: RailReading | null = null;
  try {
    const rail = await readRail(deployment.policyRailUcp.contractId);
    railReading = { contractId: deployment.policyRailUcp.contractId, ...rail };
    line("tope del rail", `${rail.perTx} por compra, ${rail.perDay} por día (leído de la red)`);
    line("rail hoy", `${rail.spentToday} gastado hoy por el rail (incluye otras compras que paga el mismo rail)`);
  } catch (error) {
    line("tope del rail", `no se pudo leer de la red ahora (${error instanceof Error ? error.message.slice(0, 80) : String(error)})`);
  }

  if (process.argv.slice(2).includes("--html")) {
    const html = renderSummaryHtml({
      month,
      summary,
      teamPerTx: TEAM_LIMITS.perTx,
      teamPerDay: TEAM_LIMITS.perDay,
      records: vault.list().length,
      rail: railReading,
      generatedAt: new Date(),
    });
    const out = resolve(dirname(TEAM_VAULT_PATH), `resumen-${month}.html`);
    await writeFile(out, html);
    line("página", relative(REPO_ROOT, out));
    // Opened in the default browser on macOS; elsewhere the path above is enough.
    if (process.platform === "darwin") spawn("open", [out], { stdio: "ignore", detached: true }).unref();
  }
  process.stdout.write("\n");
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
