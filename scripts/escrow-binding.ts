#!/usr/bin/env node
/**
 * `pnpm run escrow:binding` — one payment, one receipt, on testnet (T159).
 *
 * In the `rehearsal` escrow:
 *   1. pays `--amount` USDC (default 0.05) from the UCP rail, through the facilitator;
 *   2. prepares a second `hold` on that same payment, for another order and
 *      another receipt, while it is still valid (simulated, signed, not sent);
 *   3. holds the purchase with `EscrowClient.hold`, the call the store makes;
 *   4. sends the prepared duplicate: the network rejects it (`PaymentAlreadyHeld`)
 *      and the failed transaction has a hash;
 *   5. runs check 4 (`checkHeld`) against the real escrow: the true receipt
 *      passes; a receipt citing another payment, or another receipt on this
 *      payment, fails with its reason;
 *   6. ships and, after the release window, releases the purchase to the
 *      payee (ISSUER), so the escrow is left with nothing unallocated.
 *
 * Moves real testnet USDC from the UCP rail: ask before running.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentPassError, isAgentPassError } from "@agentpass/core";
import { Account, Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { STELLAR_DECIMALS, toAtomic } from "../packages/ucp-stellar/src/index.js";
import { EscrowClient, checkHeld } from "../packages/vitrinee-anchor/src/index.js";
import { readDeployment } from "./lib/deployment.js";
import { payIntoEscrow } from "./lib/escrow-pay.js";
import { readEnvFile } from "./lib/env-file.js";
import { TESTNET } from "./lib/network.js";
import { orderRefHex } from "./lib/purchase-escrow.js";
import { stellarCliTx } from "./lib/stellar-cli.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPLORER = "https://stellar.expert/explorer/testnet/tx";
const ARGV = process.argv.slice(2);

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}
function step(name: string, value: string): void {
  out(`  ${name.padEnd(14)} ${value}`);
}
function requireEnv(env: ReadonlyMap<string, string>, key: string, file: string): string {
  const value = env.get(key)?.trim() ?? "";
  if (value === "") throw new AgentPassError("ConfigError", `${key} is missing from ${file}`, { details: { key } });
  return value;
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

async function main(): Promise<void> {
  const at = ARGV.indexOf("--amount");
  const amount = at === -1 ? "0.05" : (ARGV[at + 1] ?? "");
  const env = await readEnvFile(resolve(REPO_ROOT, ".env.local"));
  const vitrineeEnv = await readEnvFile(resolve(REPO_ROOT, ".env.vitrinee.local"));
  const deployment = await readDeployment(resolve(REPO_ROOT, "deployments/testnet.json"));
  const escrow = deployment.purchaseEscrows["rehearsal"];
  const rail = deployment.policyRailUcp;
  if (escrow === undefined || rail === null) throw new AgentPassError("ConfigError", "needs the rehearsal escrow and the UCP rail in deployments/testnet.json", { details: {} });

  const operator = Keypair.fromSecret(requireEnv(env, "ADMIN_SECRET_KEY", ".env.local"));
  const payee = Keypair.fromSecret(requireEnv(env, "ISSUER_SECRET_KEY", ".env.local")).publicKey();
  const railOwner = Keypair.fromSecret(requireEnv(env, "AGENT_SECRET_KEY", ".env.local"));
  if (escrow.operator !== operator.publicKey() || escrow.payee !== payee) throw new AgentPassError("ConfigError", "the rehearsal escrow's accounts are not this repo's keys", { details: { escrow } });
  if (rail.owner !== railOwner.publicKey()) throw new AgentPassError("ConfigError", "AGENT_SECRET_KEY does not own the UCP rail", { details: { owner: rail.owner } });
  const apiKey = vitrineeEnv.get("FACILITATOR_API_KEY")?.trim();
  const facilitator = new HTTPFacilitatorClient({
    url: vitrineeEnv.get("FACILITATOR_URL")?.trim() || "https://channels.openzeppelin.com/x402/testnet",
    createAuthHeaders: apiKey ? async () => { const h = { Authorization: `Bearer ${apiKey}` }; return { verify: h, settle: h, supported: h }; } : undefined,
  });
  const client = new EscrowClient({ contractId: escrow.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });
  const server = new rpc.Server(TESTNET.rpcUrl);
  const amountAtomic = toAtomic(amount, STELLAR_DECIMALS);
  const stamp = Date.now().toString(36);
  const orderA = `t159-${stamp}-a`;
  const orderB = `t159-${stamp}-b`;

  out(`\nAgentPey escrow:binding · ${escrow.contractId} · ${amount} USDC from ${rail.contractId}\n`);

  // 1. The payment.
  const paymentTx = await payIntoEscrow({ facilitator, rail: rail.contractId, railOwner, token: escrow.token, escrow: escrow.contractId, amountAtomic, label: orderA });
  step("payment", `${paymentTx}  ${EXPLORER}/${paymentTx}`);
  const receiptA = sha256(`t159 rehearsal receipt for ${orderA} paid by ${paymentTx}`);
  const receiptB = sha256(`t159 second receipt on the same payment, for ${orderB}`);

  // 2. The duplicate, prepared while it is still valid: the operator's next-but-one sequence number.
  const source = await server.getAccount(operator.publicKey());
  const later = new Account(operator.publicKey(), (BigInt(source.sequenceNumber()) + 1n).toString());
  const duplicate = new TransactionBuilder(later, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
    .addOperation(
      new Contract(escrow.contractId).call(
        "hold",
        nativeToScVal(Buffer.from(orderB, "utf8"), { type: "bytes" }),
        new Address(rail.contractId).toScVal(),
        nativeToScVal(amountAtomic, { type: "i128" }),
        xdr.ScVal.scvBytes(Buffer.from(paymentTx, "hex")),
        xdr.ScVal.scvBytes(Buffer.from(receiptB, "hex")),
      ),
    )
    .setTimeout(300)
    .build();
  const prepared = await server.prepareTransaction(duplicate);
  prepared.sign(operator);
  step("duplicate", `prepared for ${orderB}, same payment, another receipt; not sent yet`);

  // 3. The real hold, through the store's own client.
  const held = await client.hold({ orderRef: orderA, payer: rail.contractId, amount: amountAtomic, txHash: paymentTx, receiptHash: receiptA }, operator.secret());
  step("hold", `${held.txHash ?? "(already held)"}  ${held.txHash === undefined ? "" : `${EXPLORER}/${held.txHash}`}`);

  // 4. The duplicate reaches the network, which refuses it.
  const sent = await server.sendTransaction(prepared);
  const final = sent.status === "PENDING" ? await server.pollTransaction(sent.hash, { attempts: 30 }) : null;
  const finalStatus = final?.status ?? sent.status;
  step("duplicate sent", `${sent.hash}  ${EXPLORER}/${sent.hash}`);
  step("network says", String(finalStatus));
  if (finalStatus === rpc.Api.GetTransactionStatus.SUCCESS) throw new AgentPassError("CommandFailed", "the duplicate hold was accepted: one payment backs two receipts", { details: { hash: sent.hash } });
  const after = await client.byTx(paymentTx);
  step("by_tx", `${after?.orderRef ?? "none"} · receipt ${after?.receiptHash.slice(0, 16) ?? "-"}… (the duplicate left nothing)`);

  // 5. Check 4 against the real escrow.
  const claims = {
    escrow: { contract: escrow.contractId },
    settlementTxHash: paymentTx,
    orderId: orderA,
    payerAccount: rail.contractId,
    amountUSDCAtomic: amountAtomic.toString(),
    merchantDid: `did:stellar:testnet:${operator.publicKey()}`,
    merchantAccount: payee,
  };
  const readers = () => client;
  out("\ncheck 4, held");
  step("true receipt", show(await checkHeld(claims, receiptA, readers)));
  step("other payment", show(await checkHeld({ ...claims, settlementTxHash: sha256("a payment this escrow never saw") }, receiptA, readers)));
  step("other receipt", show(await checkHeld({ ...claims, orderId: orderB }, receiptB, readers)));

  // 6. Close it out: ship, wait the release window, release to the payee.
  out("");
  const ship = await stellarCliTx(["contract", "invoke", "--id", escrow.contractId, "--", "mark_shipped", "--order_ref", orderRefHex(orderA)], operator.secret());
  step("mark_shipped", `${ship.txHash ?? "?"}  ${EXPLORER}/${ship.txHash ?? ""}`);
  out(`  waiting        ${escrow.releaseWindowSeconds} s release window`);
  await sleep((escrow.releaseWindowSeconds + 10) * 1000);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const release = await stellarCliTx(["contract", "invoke", "--id", escrow.contractId, "--", "release", "--order_ref", orderRefHex(orderA)], operator.secret());
      step("release", `${release.txHash ?? "?"}  ${EXPLORER}/${release.txHash ?? ""}`);
      break;
    } catch (error) {
      // The ledger's clock trails the wall clock by a few seconds: ReleaseTooEarly is the contract's error #9.
      if (attempt >= 5 || !(isAgentPassError(error) && JSON.stringify(error.details).includes("Error(Contract, #9)"))) throw error;
      await sleep(10_000);
    }
  }
  const closed = await client.get(orderA);
  step("status", `${closed?.status ?? "?"} · ${closed?.amountAtomic ?? "?"} to ${payee}`);
  out("");
}

main().catch((error: unknown) => {
  if (isAgentPassError(error)) {
    process.stderr.write(`\n${error.code}: ${error.message}\n${JSON.stringify(error.details, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  } else {
    process.stderr.write(`\n${String(error)}\n`);
  }
  process.exitCode = 1;
});
