#!/usr/bin/env node
/**
 * `pnpm run ucp:probe-per-tx -- --store <URL> --product <id> --quantity <n> [--rail mcp]` —
 * proves that the network, not the agent, refuses a UCP purchase above the
 * rail's per-transaction limit (T122 acceptance criterion).
 *
 * In production `policyRail.authorise` refuses such a purchase first, before
 * anything is signed (`executeUcpPayment`), so the contract never gets asked.
 * This script exists to ask it anyway: it opens a real UCP checkout above
 * 3.00 USDC, takes its payment requirements, and has `PolicyRailStellarScheme`
 * sign them directly against the UCP rail. The Soroban simulation runs the
 * rail's `__check_auth`, which answers `PerTxExceeded` (#7).
 *
 * **Nothing is sent and no money moves**: the refusal happens in simulation,
 * and the checkout is canceled at the end. It is a separate script on
 * purpose: the production path gains no mode that skips the local check.
 *
 * `--rail mcp` (T128) asks the MCP server's own rail instead, signed by its
 * owner, the MCP agent's key.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { AGENTPEY_PLATFORM_PROFILE, PolicyRailStellarScheme } from "@agentpey/agent";
import { Keypair } from "@stellar/stellar-sdk";

import { readEnvFile } from "./lib/env-file.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const HANDLER = "com.agentpey.stellar_x402";
type PaymentRequirements = Parameters<PolicyRailStellarScheme["createPaymentPayload"]>[1];

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { store: { type: "string" }, product: { type: "string" }, quantity: { type: "string", default: "2" }, rail: { type: "string", default: "ucp" } },
});

const out = (line = "") => process.stdout.write(`${line}\n`);
const row = (label: string, value: string) => out(`  ${label.padEnd(12)} ${value}`);

async function ucp(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "UCP-Agent": `profile="${AGENTPEY_PLATFORM_PROFILE}"` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (values.store === undefined || !URL.canParse(values.store) || values.product === undefined) {
    throw new AgentPassError("InvalidArguments", "usage: pnpm run ucp:probe-per-tx -- --store <URL> --product <id> --quantity <n>", { details: {} });
  }
  const env = await readEnvFile(ENV_PATH);
  if (values.rail !== "ucp" && values.rail !== "mcp") throw new AgentPassError("InvalidArguments", "--rail takes ucp or mcp", { details: { rail: values.rail } });
  const [railKey, ownerKey] = values.rail === "mcp" ? ["MCP_POLICY_RAIL_CONTRACT_ID", "MCP_AGENT_SECRET_KEY"] : ["UCP_POLICY_RAIL_CONTRACT_ID", "AGENT_SECRET_KEY"];
  const railId = env.get(railKey)?.trim() ?? "";
  const ownerSecret = env.get(ownerKey)?.trim() ?? "";
  if (railId === "" || ownerSecret === "") {
    throw new AgentPassError("ConfigError", `needs ${railKey} and ${ownerKey} in .env.local`, { details: {} });
  }
  const endpoint = `${new URL(values.store).origin}/ucp/v1`;

  out("\nAgentPey · ¿quién rechaza una compra sobre per_tx? · T122 · testnet");
  row("rail", `${railId} (per_tx 3.00 USDC)`);
  row("agente", Keypair.fromSecret(ownerSecret).publicKey());

  const checkout = await ucp("POST", `${endpoint}/checkout-sessions`, {
    line_items: [{ item: { id: values.product }, quantity: Number(values.quantity) }],
    fulfillment: { methods: [{ type: "shipping", destinations: [{ street_address: "Av. Providencia 1234", address_locality: "Providencia", address_country: "CL" }] }] },
  });
  const id = String(checkout["id"]);
  const handlers = (checkout["ucp"] as { payment_handlers?: Record<string, Array<{ config?: { payment_requirements?: PaymentRequirements } }>> }).payment_handlers;
  const requirements = handlers?.[HANDLER]?.[0]?.config?.payment_requirements;
  if (requirements === undefined) throw new AgentPassError("MerchantRejectedRequest", "the checkout is not ready to pay", { details: { status: checkout["status"], messages: checkout["messages"] } });
  row("checkout", id);
  row("pide", `${(Number(requirements.amount) / 1e7).toFixed(7)} USDC a ${requirements.payTo}`);

  out("\n  Firmando directo contra el contrato, sin el chequeo local…");
  try {
    await new PolicyRailStellarScheme({ contractId: railId, ownerSecret }).createPaymentPayload(2, requirements);
    out("  ❌ el contrato aceptó firmar: per_tx no está siendo aplicado");
    process.exitCode = 1;
  } catch (error) {
    const text = JSON.stringify(isAgentPassError(error) ? { message: error.message, details: error.details, cause: String(error.cause) } : String(error));
    const perTx = /#7\b|PerTxExceeded|Error\(Contract, #7\)/.test(text);
    row("rechazo", isAgentPassError(error) ? `${error.code}: ${error.message}` : String(error));
    row("contrato", perTx ? "Error(Contract, #7) = PerTxExceeded, desde __check_auth" : "otro motivo (ver detalle)");
    if (!perTx) out(`  detalle      ${text.slice(0, 1500)}`);
    out(perTx ? "\n  ✅ La red rechazó la compra sobre per_tx. No se envió nada.\n" : "\n  ⚠️ Rechazada, pero no por per_tx.\n");
    process.exitCode = perTx ? 0 : 1;
  } finally {
    await ucp("POST", `${endpoint}/checkout-sessions/${encodeURIComponent(id)}/cancel`).catch(() => undefined);
    row("checkout", `${id} cancelado`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${isAgentPassError(error) ? `${error.code}: ${error.message}\n${JSON.stringify(error.details)}` : String(error)}\n`);
  process.exitCode = 1;
});
