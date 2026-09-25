#!/usr/bin/env node
/**
 * `pnpm run rail:topup -- <rail C...> <amount> [--yes]` — moves testnet USDC
 * from the pilot's reserve into one tenant's `policy_rail`.
 *
 * Why it exists. A new tenant's rail is born with 3 USDC (`C-131`) and nothing
 * refills it: a purchase dearer than what is left is refused with
 * `RailInsufficientFunds`, before any money moves. The demo cannot afford that
 * refusal, so this tops one rail up from the reserve that already holds the
 * pilot's testnet USDC. Nothing in the app can do this; it is an operator
 * command, run by a person, like `create-partner`.
 *
 * Safety, in order: it shows what it would do and sends nothing without
 * `--yes`; the amount is capped (`MAX_TOPUP_USDC`); the destination must be a
 * contract address; it needs the reserve to hold the amount. It reads
 * `AGENT_SECRET_KEY` from `.env.local` and never prints it. The reserve is the
 * account whose public key is `RESERVE_ADDRESS` (`.env.example`), so if that is
 * set and does not match the key, it stops.
 *
 * Testnet only, and it moves the pilot's own test tokens. Nothing here touches
 * a customer's funds: a customer's wallet can always withdraw from its rail
 * (`C-61`).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { BAZAAR_USDC_ISSUER, fromScaledAmount, toScaledAmount } from "@agentpey/agent";
import { Keypair, Networks, contract } from "@stellar/stellar-sdk";

import { readEnvFile } from "./lib/env-file.js";
import { parseTopupArgs } from "./lib/topup-args.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

interface UsdcContract {
  balance(args: { readonly id: string }): Promise<contract.AssembledTransaction<bigint>>;
  transfer(
    args: { readonly from: string; readonly to: string; readonly amount: bigint },
    options?: contract.MethodOptions,
  ): Promise<contract.AssembledTransaction<null>>;
}

async function usdcClient(signer?: Keypair): Promise<contract.Client & UsdcContract> {
  return contract.Client.from<UsdcContract>({
    contractId: BAZAAR_USDC_ISSUER,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    ...(signer === undefined ? {} : { publicKey: signer.publicKey(), signTransaction: signer }),
  }) as Promise<contract.Client & UsdcContract>;
}

async function balanceOf(holder: string): Promise<bigint> {
  const client = await usdcClient();
  return (await client.balance({ id: holder })).result;
}

async function main(): Promise<void> {
  const args = parseTopupArgs(process.argv.slice(2));

  const env = await readEnvFile(ENV_PATH);
  const secret = env.get("AGENT_SECRET_KEY");
  if (secret === undefined || secret === "") {
    throw new AgentPassError("ConfigError", "AGENT_SECRET_KEY is missing from .env.local", {
      details: { fix: "it is the reserve's key; see .env.example" },
    });
  }
  const reserve = Keypair.fromSecret(secret);
  const expected = env.get("RESERVE_ADDRESS");
  if (expected !== undefined && expected !== "" && expected !== reserve.publicKey()) {
    throw new AgentPassError("ConfigError", "AGENT_SECRET_KEY is not the reserve: its public key differs from RESERVE_ADDRESS", {
      details: { reserve: expected, key: reserve.publicKey() },
    });
  }

  const amount = toScaledAmount(args.amount);
  const [reserveBefore, railBefore] = await Promise.all([balanceOf(reserve.publicKey()), balanceOf(args.rail)]);
  console.log(`reserve   ${reserve.publicKey()}  ${fromScaledAmount(reserveBefore)} USDC`);
  console.log(`rail      ${args.rail}  ${fromScaledAmount(railBefore)} USDC`);
  console.log(`amount    ${args.amount} USDC`);

  if (reserveBefore < amount) {
    throw new AgentPassError("ConfigError", "the reserve does not hold that much USDC", {
      details: { reserve: fromScaledAmount(reserveBefore), amount: args.amount },
    });
  }
  if (!args.confirmed) {
    console.log("\nNothing was sent. Add --yes to send it.");
    return;
  }

  const client = await usdcClient(reserve);
  const transfer = await client.transfer({ from: reserve.publicKey(), to: args.rail, amount });
  const sent = await transfer.signAndSend();
  const hash = (sent as unknown as { sendTransactionResponse?: { hash?: string } }).sendTransactionResponse?.hash;

  const railAfter = await balanceOf(args.rail);
  console.log(`\nsent. rail now ${fromScaledAmount(railAfter)} USDC${hash === undefined ? "" : `  tx ${hash}`}`);
}

main().catch((error: unknown) => {
  console.error(isAgentPassError(error) ? `${error.code}: ${error.message}` : error);
  if (isAgentPassError(error)) console.error(JSON.stringify(error.details));
  process.exitCode = 1;
});
