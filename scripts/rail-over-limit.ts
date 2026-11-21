#!/usr/bin/env node
/**
 * `pnpm run rail:over-limit -- --rail C... [--yes]` — has the network itself refuse a payment above a per-person
 * rail's `per_tx` (T189), and leaves the hash of that refused transaction as evidence.
 *
 * Every earlier proof (T22, T31, T122) stopped at simulation: the refusal is real, but nothing reaches the ledger. Here
 * the transaction is sent. A payment over the limit cannot be simulated to success, so its footprint comes from the same
 * payment within the limit, signed and simulated first; the over-limit authorization keeps that one's nonce
 * (`lib/over-limit.ts`) so both touch the same entries. The rail's `__check_auth` then refuses it on chain
 * (`PerTxExceeded`, contract error #7) and the ledger records a failed transaction. No USDC moves; the agent's account
 * pays the testnet fee.
 *
 * The rail must be on `apps/mcp/wallets.testnet.json`; its owner key is derived from `MCP_AGENT_MNEMONIC` at the listed
 * index and never printed. The recipient is AgentPey's testnet reserve, which already holds USDC. Without `--yes` it only
 * shows the simulated refusal.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { BAZAAR_USDC_ISSUER, fromScaledAmount, toScaledAmount } from "@agentpey/agent";
import { deriveTenantKeypair } from "@agentpey/tenancy";
import { Account, Address, BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder, authorizeEntry, contract, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

import { WALLETS_FILE, parseWalletsFile } from "../apps/mcp/src/wallets.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";
import { PER_TX_EXCEEDED, accountRefusal, transferAmountOf, withTransferAmount } from "./lib/over-limit.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const WALLETS_PATH = resolve(REPO_ROOT, "apps/mcp", WALLETS_FILE);
/** How far past the limit to ask: clearly over it, and still within what the rail holds, so the only reason to refuse is the limit. */
const OVER_BY = toScaledAmount("0.5");

const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const row = (label: string, value: string): void => out(`  ${label.padEnd(12)} ${value}`);

function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from .env.local`, { details: { key } });
  return value;
}

async function balanceOf(holder: string): Promise<bigint> {
  const usdc = await contract.Client.from<{ balance(args: { readonly id: string }): Promise<contract.AssembledTransaction<bigint>> }>({
    contractId: BAZAAR_USDC_ISSUER,
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.passphrase,
  });
  return (await (usdc as unknown as { balance(args: { readonly id: string }): Promise<contract.AssembledTransaction<bigint>> }).balance({ id: holder })).result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((arg) => arg !== "--"), options: { rail: { type: "string" }, yes: { type: "boolean", default: false } } });
  const railId = values.rail ?? "";
  if (!StrKey.isValidContract(railId)) throw new AgentPassError("InvalidArguments", "usage: pnpm run rail:over-limit -- --rail C... [--yes]", { details: { rail: railId } });

  const listed = parseWalletsFile(await readFile(WALLETS_PATH, "utf8")).wallets.find((entry) => entry.rail === railId);
  if (listed === undefined) throw new AgentPassError("InvalidArguments", `that rail is not on apps/mcp/${WALLETS_FILE}`, { details: { rail: railId } });

  const env = await readEnvFile(ENV_PATH);
  const derived = deriveTenantKeypair(requireEnv(env, "MCP_AGENT_MNEMONIC"), listed.agentIndex, "agent");
  if (derived.publicKey !== listed.agent) throw new AgentPassError("ConfigError", "MCP_AGENT_MNEMONIC does not derive this rail's listed owner", { details: { agentIndex: listed.agentIndex } });
  const owner = Keypair.fromSecret(derived.secret);
  const reserve = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY")).publicKey();

  const perTx = toScaledAmount(listed.perTx);
  const within = perTx / 2n;
  const over = perTx + OVER_BY;
  const balance = await balanceOf(railId);

  out("\nAgentPey rail:over-limit · a payment above per_tx, refused by the network · Stellar testnet\n");
  row("rail", railId);
  row("owner", `${owner.publicKey()} (agent index ${listed.agentIndex})`);
  row("per_tx", `${listed.perTx} USDC`);
  row("balance", `${fromScaledAmount(balance)} USDC`);
  row("asks", `${fromScaledAmount(over)} USDC to the reserve ${reserve}`);
  if (balance < over) throw new AgentPassError("ConfigError", "the rail holds less than the over-limit amount: the refusal would be about funds, not the limit", { details: { balance: fromScaledAmount(balance) } });

  const server = new rpc.Server(TESTNET.rpcUrl);
  const source = await server.getAccount(owner.publicKey());
  const build = (amount: bigint, auth: xdr.SorobanAuthorizationEntry[] | undefined, fee: string = BASE_FEE): TransactionBuilder =>
    new TransactionBuilder(new Account(source.accountId(), source.sequenceNumber()), { fee, networkPassphrase: TESTNET.passphrase })
      .addOperation(
        Operation.invokeContractFunction({
          contract: BAZAAR_USDC_ISSUER,
          function: "transfer",
          args: [new Address(railId).toScVal(), new Address(reserve).toScVal(), nativeToScVal(amount, { type: "i128" })],
          ...(auth === undefined ? {} : { auth }),
        }),
      )
      .setTimeout(120);
  const ledger = await server.getLatestLedger();
  const sign = (entry: xdr.SorobanAuthorizationEntry): Promise<xdr.SorobanAuthorizationEntry> =>
    // eslint-disable-next-line @typescript-eslint/require-await
    authorizeEntry(entry, async (_preimage, payload) => ({ publicKey: owner.publicKey(), signature: owner.sign(Buffer.from(payload)) }), ledger.sequence + 60, TESTNET.passphrase);

  // 1. The same payment within the limit: its authorization (and nonce), signed, and the footprint the network computes.
  const recorded = await server.simulateTransaction(build(within, undefined).build());
  if (!rpc.Api.isSimulationSuccess(recorded) || recorded.result?.auth.length !== 1) throw new AgentPassError("NetworkError", "could not simulate the payment within the limit", { details: { error: rpc.Api.isSimulationError(recorded) ? recorded.error.slice(0, 500) : "no single authorization" } });
  const unsigned = recorded.result.auth[0]!;
  if (transferAmountOf(unsigned) !== within) throw new AgentPassError("NetworkError", "the simulated authorization is not for the asked amount", { details: {} });
  const enforced = await server.simulateTransaction(build(within, [await sign(unsigned)]).build());
  if (!rpc.Api.isSimulationSuccess(enforced)) throw new AgentPassError("NetworkError", "the rail refused even the payment within the limit", { details: { error: rpc.Api.isSimulationError(enforced) ? enforced.error.slice(0, 500) : "" } });
  row("within", `${fromScaledAmount(within)} USDC simulates fine: the rail and its owner key are in order`);

  // 2. Over the limit: same nonce and footprint, signed again by the owner, with the fee the footprint needs.
  const fee = (BigInt(BASE_FEE) + BigInt(enforced.minResourceFee) * 2n).toString();
  const withAmount = async (amount: bigint) => build(amount, [await sign(withTransferAmount(unsigned, amount))], fee).setSorobanData(enforced.transactionData.build()).build();

  // A control first: the same rebuilt path, still under the limit, must pass, so the refusal below is the limit's alone.
  const control = await server.simulateTransaction(await withAmount(perTx));
  if (!rpc.Api.isSimulationSuccess(control)) throw new AgentPassError("NetworkError", "the rebuilt payment of exactly per_tx did not simulate; the refusal would prove nothing", { details: { error: rpc.Api.isSimulationError(control) ? control.error.slice(0, 500) : "" } });
  row("control", `${listed.perTx} USDC, exactly per_tx, rebuilt the same way: passes`);

  const tx = await withAmount(over);
  const preview = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationError(preview)) throw new AgentPassError("ConfigError", "the over-limit payment simulated as valid; nothing was sent", { details: {} });
  const refusal = accountRefusal(preview.events, railId);
  row("simulated", refusal === undefined ? preview.error.slice(0, 200) : `${preview.error} — the rail answered Error(Contract, #${refusal})${refusal === PER_TX_EXCEEDED ? ", PerTxExceeded" : ""}`);
  if (refusal !== PER_TX_EXCEEDED) throw new AgentPassError("ConfigError", "the rail refused it, but not for exceeding per_tx; nothing was sent", { details: { refusal: refusal ?? null } });
  if (!values.yes) {
    out("\n  dry run      nothing sent. Add --yes to send it and have the network refuse it on chain.\n");
    return;
  }

  tx.sign(Keypair.fromSecret(derived.secret));
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new AgentPassError("NetworkError", "the RPC did not accept the transaction for the ledger", { details: { hash: sent.hash, status: sent.status } });
  const final = await server.pollTransaction(sent.hash, { attempts: 30 });
  const after = await balanceOf(railId);
  out("");
  row("sent", sent.hash);
  row("ledger", String(final.status));
  row("balance", `${fromScaledAmount(after)} USDC (${after === balance ? "unchanged" : "CHANGED"})`);
  row("explorer", `https://stellar.expert/explorer/testnet/tx/${sent.hash}`);
  out("");
  if (final.status !== "FAILED" || after !== balance) throw new AgentPassError("ConfigError", "the network did not refuse the over-limit payment as expected", { details: { status: String(final.status), hash: sent.hash } });
  out("  refused by the network: the rail would not pay more than its per_tx.\n");
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
