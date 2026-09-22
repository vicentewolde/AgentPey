#!/usr/bin/env node
/**
 * `pnpm demo:verify [receipt.jws] [--tamper] [--via-gateway URL]`
 *
 * Verifies a Vitrinee receipt **without trusting the gateway that issued
 * it**: the signature against the key in the merchant's did:stellar, the
 * hash against receipt-registry on Soroban, the payment against Horizon.
 * Defaults to the last receipt `pnpm demo:buy` saved. `--tamper` lowers the
 * amount first, keeping the original signature — it must come back red.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ReceiptRegistryClient, verifyReceipt, type ReceiptVerification } from "@vitrinee/anchor";

import { LAST_RECEIPT_PATH, loadRepoEnv, registryId } from "./env.js";
import { reportVerification } from "./report.js";
import { tamperAmount } from "./tamper.js";

loadRepoEnv();
const argv = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  allowPositionals: true,
  options: {
    tamper: { type: "boolean", default: false },
    "via-gateway": { type: "string" },
  },
});

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const path = positionals.find((p) => p !== "--") ?? LAST_RECEIPT_PATH();
let jws: string;
try {
  jws = readFileSync(path, "utf8").trim();
} catch {
  process.stderr.write(`✗ no encuentro el recibo en ${path}. Corre primero pnpm demo:buy.\n`);
  process.exit(2);
}

out();
out("Vitrinee · verificación de recibo");
out(`  recibo       ${path}`);
if (values.tamper) {
  const t = tamperAmount(jws);
  jws = t.jws;
  out(`  manipulado   amountUSDC ${t.from} → ${t.to}, misma firma (sin volver a firmar)`);
}

let result: ReceiptVerification;
if (values["via-gateway"] !== undefined) {
  out(`  verificador  ${values["via-gateway"]}/receipts/verify`);
  const res = await fetch(`${values["via-gateway"].replace(/\/+$/, "")}/receipts/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiptJws: jws }),
  });
  result = (await res.json()) as ReceiptVerification;
} else {
  const contractId = registryId();
  if (contractId === undefined) {
    process.stderr.write("✗ no hay RECEIPT_REGISTRY_ID ni deployments/testnet.json con receiptRegistry\n");
    process.exit(2);
  }
  out("  verificador  local: firma, Soroban RPC y Horizon, sin pasar por el gateway");
  result = await verifyReceipt(jws, {
    registry: new ReceiptRegistryClient({
      contractId,
      rpcUrl: process.env["STELLAR_RPC_URL"] ?? "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    }),
    horizonUrl: process.env["STELLAR_HORIZON_URL"] ?? "https://horizon-testnet.stellar.org",
    settlementAttempts: 3,
  });
}
if (result.receipt !== null) {
  out(`  pedido       ${result.receipt.orderId} · ${result.receipt.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")} · ${result.receipt.amountUSDC} USDC`);
}
reportVerification(result, out);
out();
process.exitCode = result.valid ? 0 : 1;
