#!/usr/bin/env node
/**
 * `pnpm demo:buy -- "compra el hoodie talla M y envíalo a Ñuñoa"`
 *
 * Flags: --gateway <url> (default GATEWAY_URL or http://localhost:4021),
 *        --max-usdc <n> (default 100), --dry-run, --no-verify, --json.
 * Reads AGENT_SECRET_KEY from .env.local at the repo root. Saves the receipt
 * to .vitrinee/last-receipt.jws for `pnpm demo:verify`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { isVitrineeError } from "@vitrinee/core";

import { buy } from "./buy.js";
import { LAST_RECEIPT_PATH, loadRepoEnv } from "./env.js";

loadRepoEnv();

// pnpm forwards a literal "--" ahead of the arguments; parseArgs would treat
// everything after it (including our flags) as positionals. Drop it first.
const argv = process.argv.slice(2);
const args = argv[0] === "--" ? argv.slice(1) : argv;

const { values, positionals } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    gateway: { type: "string", default: process.env["GATEWAY_URL"] ?? "http://localhost:4021" },
    "max-usdc": { type: "string", default: process.env["AGENT_MAX_USDC"] ?? "100" },
    "dry-run": { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

// A stray "--" can arrive when a package manager forwards arguments; it is never part of the order.
const instruction = positionals.filter((p) => p !== "--").join(" ").trim();
if (instruction === "") {
  process.stderr.write('uso: pnpm demo:buy -- "compra el hoodie talla M y envíalo a Ñuñoa" [--dry-run] [--no-verify] [--max-usdc 100] [--gateway URL]\n');
  process.exit(2);
}

const out = (line: string): void => {
  if (!values.json) process.stdout.write(`${line}\n`);
};

out("");
out("Vitrinee · agente de compra (cliente x402 estándar)");
try {
  const result = await buy({
    gatewayUrl: values.gateway,
    instruction,
    signerSecret: process.env["AGENT_SECRET_KEY"],
    maxUsdc: values["max-usdc"],
    dryRun: values["dry-run"],
    verify: !values["no-verify"],
    log: out,
  });
  if (result.order?.receiptJws != null) {
    const path = LAST_RECEIPT_PATH();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${result.order.receiptJws}\n`, { mode: 0o600 });
    out(`  guardado     ${path} (para pnpm demo:verify)`);
  }
  out("");
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          intent: { product: result.intent.product.id, quantity: result.intent.quantity, shipping: result.intent.shipping },
          requirements: result.requirements,
          order: result.order === undefined ? null : { ...result.order, raw: undefined },
          verification: result.verification ?? null,
          elapsedMs: Math.round(result.elapsedMs),
          timings: result.timings,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (result.verification !== undefined && !result.verification.valid) process.exitCode = 1;
} catch (error) {
  out("");
  if (isVitrineeError(error)) {
    process.stderr.write(`✗ ${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
