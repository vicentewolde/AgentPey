#!/usr/bin/env node
/**
 * `pnpm run ucp:stellar:conformance -- <store-url> [options]`
 *
 * The Stellar x402 payment handler's conformance kit (T137): one line per
 * check against any UCP store that declares `com.agentpey.stellar_x402`.
 *
 *   --profile-only        only the profile checks (GETs only)
 *   --product <id>        the product to open a checkout for (default: the first the catalog search returns)
 *   --pay                 run the charge and receipt checks: pays one checkout, on testnet
 *   --rail <C...>         pay from this policy_rail, signing as its owner (default: a classic account)
 *   --max-amount <n>      the most the charge may cost, in the asset (default 2.00)
 *   --registry <C...>     the receipt registry to trust (default: AgentPey's)
 *   --platform-profile <url>  sent in UCP-Agent (default: AgentPey's public profile)
 *   --email <address>     the buyer's email on the checkout (default conformance@agentpey.com)
 *   --json                the report as JSON
 *
 * With `--pay`, the key comes from the environment, `UCP_STELLAR_CONFORMANCE_SECRET`: a testnet secret (`S...`) of
 * a classic account holding the asset, or of the rail's owner with `--rail`. It is never printed or stored.
 *
 * Exit code: 0 when no check fails, 1 when one does, 2 for a usage error.
 */
import { parseArgs } from "node:util";

import { Networks } from "@stellar/stellar-sdk";

import { classicPayer, keypairSigner, policyRailPayer, railOwnerSigner, readTokenBalance, type UcpStellarPayer } from "../../packages/ucp-stellar/src/index.js";
import { ReceiptRegistryClient, verifyReceipt } from "../../packages/vitrinee-anchor/src/index.js";
import { AGENTPEY_RECEIPT_REGISTRY, DEFAULT_PLATFORM_PROFILE, formatReport, runConformance, type KitDeps } from "./checks.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const SECRET_ENV = "UCP_STELLAR_CONFORMANCE_SECRET";
const DESTINATION = { first_name: "Conformance", last_name: "Kit", street_address: "Av. Providencia 1234", address_locality: "Providencia", address_region: "RM", address_country: "CL" };

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: pnpm run ucp:stellar:conformance -- <store-url> [--profile-only] [--product <id>] [--pay [--rail <C...>] [--max-amount 2.00]] [--registry <C...>] [--json]\n`);
  process.exit(2);
}

function liveDeps(): KitDeps {
  return {
    fetch,
    readBalance: readTokenBalance,
    registry: (contractId) => new ReceiptRegistryClient({ contractId, rpcUrl: RPC_URL, networkPassphrase: Networks.TESTNET }),
    verifyReceipt: (jws, registry) => verifyReceipt(jws, { registry, horizonUrl: HORIZON_URL }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function main(): Promise<void> {
  // `pnpm run x -- <args>` passes the `--` through; parseArgs would read everything after it as positionals.
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    allowPositionals: true,
    options: {
      "profile-only": { type: "boolean", default: false },
      product: { type: "string" },
      pay: { type: "boolean", default: false },
      rail: { type: "string" },
      "max-amount": { type: "string", default: "2.00" },
      registry: { type: "string", default: AGENTPEY_RECEIPT_REGISTRY },
      "platform-profile": { type: "string", default: DEFAULT_PLATFORM_PROFILE },
      email: { type: "string", default: "conformance@agentpey.com" },
      json: { type: "boolean", default: false },
    },
  });
  const storeUrl = positionals[0];
  if (storeUrl === undefined || !URL.canParse(storeUrl)) usage("give the store's URL");
  if (values.rail !== undefined && !/^C[A-Z2-7]{55}$/.test(values.rail)) usage("--rail is a contract address (C...)");

  let charge: { payer: UcpStellarPayer; maxAmount: string } | undefined;
  if (values.pay) {
    const secret = process.env[SECRET_ENV]?.trim();
    if (secret === undefined || secret === "") usage(`--pay needs ${SECRET_ENV}: a testnet secret of the paying account, or of the rail's owner with --rail`);
    try {
      const payer = values.rail === undefined ? classicPayer(keypairSigner(secret)) : policyRailPayer({ contractId: values.rail, signAuthPayload: railOwnerSigner(secret) });
      charge = { payer, maxAmount: values["max-amount"] };
    } catch {
      usage(`${SECRET_ENV} is not a Stellar secret key`);
    }
  }

  const results = await runConformance(
    {
      storeUrl,
      profileOnly: values["profile-only"],
      ...(values.product === undefined ? {} : { productId: values.product }),
      destination: DESTINATION,
      email: values.email,
      platformProfile: values["platform-profile"],
      registry: values.registry,
      ...(charge === undefined ? {} : { charge }),
    },
    liveDeps(),
  );
  process.stdout.write(values.json ? `${JSON.stringify({ store: new URL(storeUrl).origin, results }, null, 2)}\n` : `${new URL(storeUrl).origin}\n\n${formatReport(results)}\n`);
  process.exitCode = results.some((r) => r.outcome === "fail") ? 1 : 0;
}

await main();
