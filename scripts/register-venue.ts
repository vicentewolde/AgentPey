#!/usr/bin/env node
/**
 * Adds one validated row to the x402 venue registry.
 *
 * Usage:
 *   pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/register-venue.ts \
 *     --slug reference-merchant \
 *     [--address G...|C...] \
 *     [--base-url https://merchant.example] \
 *     --asset USDC:G... [--asset EURC:C...] \
 *     [--registry /path/to/venues.json]
 *
 * `--address` is the venue's on-chain identity: the classic account it is
 * paid at (`G...`, what SignalDesk and a Vitrinee store use) or a Soroban
 * contract (`C...`, the bazaar). It is the second half of the `VenueId` a
 * Mandate names, so it has to be the address the merchant's own 402 quotes
 * as `payTo` when that is how the venue is identified.
 *
 * Omitting `--address` derives a deterministic, well-formed but undeployed
 * contract id from the slug. It follows the mock/bazaar convention: an identity
 * for configuration, never a claim that a contract has been deployed.
 *
 * The row's field was `contractId` until T79 renamed it `address` in
 * `registry.ts` (a venue paid at a `G...` account is not a contract); this
 * script kept writing the old name and every run failed the schema check.
 * Found, and fixed, when T100 first needed it for a real venue.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk/base";

import { loadVenueRegistry, registryVenueSchema } from "../apps/agent/src/catalog/registry.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_REGISTRY_PATH = resolve(REPO_ROOT, "apps/agent/src/catalog/venues.json");

interface RegisterVenueArgs {
  readonly slug: string;
  readonly address: string;
  readonly baseUrl: string | undefined;
  readonly assets: readonly { readonly code: string; readonly issuer: string }[];
  readonly registryPath: string;
}

function invalidArguments(message: string, details?: Record<string, unknown>): AgentPassError {
  return new AgentPassError("InvalidArguments", message, { details });
}

function usage(): string {
  return [
    "Usage: pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/register-venue.ts",
    "  --slug <slug> [--address <G...|C...>] [--base-url <url>]",
    "  --asset <CODE:G...|C...> [--asset <CODE:G...|C...> ...] [--registry <path>]",
  ].join("\n");
}

function flagValues(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw invalidArguments(`${flag} requires a value`, { flag });
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function oneFlag(args: readonly string[], flag: string): string | undefined {
  const values = flagValues(args, flag);
  if (values.length > 1) {
    throw invalidArguments(`${flag} may only be supplied once`, { flag });
  }
  return values[0];
}

function deriveContractId(slug: string): string {
  return StrKey.encodeContract(createHash("sha256").update(`agentpay:phase7:${slug}`, "utf8").digest());
}

function parseAsset(value: string): { readonly code: string; readonly issuer: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator !== value.lastIndexOf(":")) {
    throw invalidArguments("--asset must be CODE:G... or CODE:C...", { asset: value });
  }
  return { code: value.slice(0, separator), issuer: value.slice(separator + 1) };
}

function parseArgs(argv: readonly string[]): RegisterVenueArgs {
  const allowedFlags = new Set(["--slug", "--address", "--base-url", "--asset", "--registry"]);
  for (const value of argv) {
    if (value.startsWith("--") && !allowedFlags.has(value)) {
      throw invalidArguments(`unknown argument ${value}`, { argument: value, usage: usage() });
    }
  }

  const slug = oneFlag(argv, "--slug");
  if (slug === undefined || slug.trim() === "") {
    throw invalidArguments("--slug is required", { usage: usage() });
  }

  const assets = flagValues(argv, "--asset").map(parseAsset);
  if (assets.length === 0) {
    throw invalidArguments("at least one --asset is required", { usage: usage() });
  }

  return {
    slug,
    address: oneFlag(argv, "--address") ?? deriveContractId(slug),
    baseUrl: oneFlag(argv, "--base-url"),
    assets,
    registryPath: resolve(oneFlag(argv, "--registry") ?? DEFAULT_REGISTRY_PATH),
  };
}

async function readRegistry(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new AgentPassError("ConfigError", `could not read venue registry at ${path}`, { cause: error, details: { path } });
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new AgentPassError("InvalidVenueRegistry", `venue registry at ${path} is not valid JSON`, {
      cause: error,
      details: { path },
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const row = { slug: args.slug, address: args.address, ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }), assets: args.assets };
  const parsedRow = registryVenueSchema.safeParse(row);
  if (!parsedRow.success) {
    throw new AgentPassError("InvalidVenueRegistry", "the new venue row does not match the registry schema", {
      details: { issues: parsedRow.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }

  const existing = await readRegistry(args.registryPath);
  if (!Array.isArray(existing)) {
    throw new AgentPassError("InvalidVenueRegistry", "the venue registry must be an array", { details: { path: args.registryPath } });
  }

  // Validate the file as it stands before looking at its row identities. A
  // merchant's slug is its operator-facing name, so accepting the same slug
  // with another derived contract id would make future configuration ambiguous.
  loadVenueRegistry(existing);
  const slugAlreadyRegistered = existing.some((entry) => registryVenueSchema.parse(entry).slug === parsedRow.data.slug);
  if (slugAlreadyRegistered) {
    throw new AgentPassError("InvalidVenueRegistry", `the venue registry already names slug \"${parsedRow.data.slug}\"`, {
      details: { slug: parsedRow.data.slug, path: args.registryPath },
    });
  }

  const next = [...existing, parsedRow.data];
  // This is deliberately before writeFile: a duplicate or malformed existing
  // row leaves the file byte-for-byte untouched.
  loadVenueRegistry(next);

  try {
    await writeFile(args.registryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new AgentPassError("ConfigError", `could not write venue registry at ${args.registryPath}`, {
      cause: error,
      details: { path: args.registryPath },
    });
  }

  process.stdout.write(`Registered ${args.slug} in ${args.registryPath}\n`);
}

try {
  await main();
} catch (error) {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n`);
    if (Object.keys(error.details).length > 0) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`\nUnexpected failure: ${String(error)}\n`);
  }
  process.exitCode = 1;
}
