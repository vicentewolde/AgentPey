/**
 * T135 · Can an MPP charge be paid from a `policy_rail`? A technical probe on
 * Stellar testnet, with the official SDK (`@stellar/mpp` 0.7.1, `mppx`
 * 0.6.31). Decision `R-4`: if the answer is no, AgentPey does not build MPP
 * payments with a classic key; this probe is the evidence.
 *
 * It runs an MPP charge server in process (the SDK's own `Mppx` server,
 * driven with `Request`/`Response` objects, no port opened) that charges
 * 0.01 USDC to agentcommerce's payTo account, and then:
 *
 *   a. pull, the rail as payer (`did:pkh:…:C…`)        expected: refused
 *   b. pull, the rail's owner as declared payer (`G…`)  expected: refused
 *   c. sponsored, the rail authorizes (owner as source) expected: refused
 *   d. sponsored, the rail as payer (`did:pkh:…:C…`)   expected: refused
 *   e. control: the SDK's own client, a classic key     expected: paid
 *
 * a–d sign the rail's authorization entry exactly as AgentPey signs an x402
 * payment from it (`authorizeAsPolicyRailOwner`), with the stellar-sdk
 * version `@stellar/mpp` asks for (15). The server refuses a–d
 * before it broadcasts anything, so no money moves. Push mode is not tried
 * (decided with the user): there the client broadcasts first and the server
 * refuses after, so money would move for a payment that does not count.
 * Only e moves money: 0.01 testnet USDC from the agent's classic key, a
 * control that shows the server pays out, not a way AgentPey pays.
 *
 *   pnpm --dir scripts/mpp-probe install
 *   pnpm --dir scripts/mpp-probe run probe
 *
 * Reads `AGENT_SECRET_KEY` and `UCP_POLICY_RAIL_CONTRACT_ID` from the repo's
 * `.env.local`. Prints no secret.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ALL_ZEROS, NETWORK_PASSPHRASE, SOROBAN_RPC_URLS, USDC_SAC_TESTNET } from "@stellar/mpp";
import { Mppx as MppxClient, stellar as stellarClient } from "@stellar/mpp/charge/client";
import { Mppx, Store, stellar } from "@stellar/mpp/charge/server";
import { Account, Address, BASE_FEE, Contract, Keypair, TransactionBuilder, authorizeEntry, hash, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Challenge, Credential } from "mppx";
import { z } from "zod";

/** agentcommerce's payTo account: where its x402 and UCP payments already go (T122–T149). */
const RECIPIENT = "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN";
const AMOUNT = "0.01";
const RESOURCE = "https://mpp-probe.local/resource";
const NETWORK = "stellar:testnet" as const;
const PASSPHRASE = NETWORK_PASSPHRASE[NETWORK];
const RPC = new rpc.Server(SOROBAN_RPC_URLS[NETWORK]);

class ProbeError extends Error {
  constructor(
    readonly code: "ConfigError" | "UnexpectedOutcome",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- configuration

const envSchema = z.object({
  AGENT_SECRET_KEY: z.string().regex(/^S[A-Z2-7]{55}$/, "a Stellar secret seed"),
  UCP_POLICY_RAIL_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/, "a contract address"),
});

function readEnv(): z.infer<typeof envSchema> {
  const file = fileURLToPath(new URL("../../.env.local", import.meta.url));
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  const parsed = envSchema.safeParse(values);
  if (!parsed.success) throw new ProbeError("ConfigError", `.env.local: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

// ---------------------------------------------------------------- helpers

/** A SEP-41 balance, read by simulating `balance` (no transaction is sent). */
async function usdcBalance(of: string, source: string): Promise<string> {
  const tx = new TransactionBuilder(await RPC.getAccount(source), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(USDC_SAC_TESTNET).call("balance", new Address(of).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) return "(unreadable)";
  const atomic = BigInt(scValToNative(sim.result.retval) as bigint);
  return `${atomic / 10_000_000n}.${(atomic % 10_000_000n).toString().padStart(7, "0")}`;
}

type Server = { handle: (request: Request) => Promise<Response> };

function server(feePayer?: Keypair): Server {
  const mppx = Mppx.create({
    secretKey: randomBytes(32).toString("hex"),
    methods: [stellar.charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, network: NETWORK, store: Store.memory(), ...(feePayer === undefined ? {} : { feePayer: { envelopeSigner: feePayer } }) })],
  });
  return {
    async handle(request) {
      const result = await mppx.charge({ amount: AMOUNT, description: "AgentPey T135 probe" })(request);
      if (result.status === 402) return result.challenge;
      return result.withReceipt(Response.json({ paid: true }));
    },
  };
}

/**
 * A transfer of the challenge's amount from the rail, its authorization entry
 * signed as the rail's owner the way AgentPey signs an x402 payment from it
 * (apps/agent/src/payment/policy-rail-payer.ts: the owner signs the entry's
 * payload and returns the `{ public_key, signature }` struct `__check_auth`
 * decodes). Sponsored: the all-zeros source the SDK's own client uses,
 * envelope unsigned. Otherwise: the owner's account as source, envelope signed
 * by it. Never sent to the network here. Built with `sdk` (15 or 17).
 */
/** What the probe reads from a challenge's request: the amount, in the asset's base units. */
const challengeRequestSchema = z.looseObject({ amount: z.string().regex(/^\d+$/) });

async function railTransaction(challenge: { request: unknown }, rail: string, owner: Keypair, sponsored: boolean): Promise<string> {
  const { amount } = challengeRequestSchema.parse(challenge.request);
  const source = sponsored ? new Account(ALL_ZEROS, "0") : await RPC.getAccount(owner.publicKey());
  const transfer = new Contract(USDC_SAC_TESTNET).call(
    "transfer",
    new Address(rail).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(BigInt(amount), { type: "i128" }),
  );
  const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).addOperation(transfer).setTimeout(180).build();
  const prepared = await RPC.prepareTransaction(built);
  const validUntil = (await RPC.getLatestLedger()).sequence + 60;
  const envelope = prepared.toEnvelope();
  for (const op of envelope.v1().tx().operations()) {
    if (op.body().switch().value !== xdr.OperationType.invokeHostFunction().value) continue;
    const entries = op.body().invokeHostFunctionOp().auth();
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i]!.credentials().switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) continue;
      // stellar-sdk 15 hands the callback only the preimage: the payload AgentPey signs is its hash.
      entries[i] = await authorizeEntry(
        entries[i]!,
        async (preimage: xdr.HashIdPreimage) => ({ signature: owner.sign(hash(preimage.toXDR())), publicKey: owner.publicKey() }),
        validUntil,
        PASSPHRASE,
      );
    }
  }
  const tx = TransactionBuilder.fromXDR(envelope.toXDR("base64"), PASSPHRASE);
  if (!sponsored) tx.sign(owner);
  return tx.toXDR();
}

const did = (address: string) => `did:pkh:${NETWORK}:${address}`;

async function attempt(label: string, srv: Server, build: (challenge: ReturnType<typeof Challenge.fromResponse>) => Promise<{ transaction: string; source: string }>) {
  const challenge = Challenge.fromResponse(await srv.handle(new Request(RESOURCE)));
  const { transaction, source } = await build(challenge);
  // `serialize` returns the whole header value, `Payment <base64url>`.
  const authorization = Credential.serialize(Credential.from({ challenge, payload: { type: "transaction", transaction }, source }));
  let response: Response;
  // mppx answers every failed verification with the same "Payment verification failed." and logs the SDK's own
  // reason to console.error: it is kept here, so each attempt shows why it was refused.
  const reasons: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    const error = args.find((a): a is Error => a instanceof Error);
    reasons.push(error === undefined ? args.map(String).join(" ") : `${error.name}: ${error.message}${"details" in error ? ` ${JSON.stringify((error as { details: unknown }).details)}` : ""}`);
  };
  try {
    response = await srv.handle(new Request(RESOURCE, { headers: { Authorization: authorization } }));
  } catch (error) {
    // The SDK's server threw instead of answering: nothing was broadcast, and it is a refusal all the same.
    out(`\n${label}`);
    out(`  source      ${source}`);
    out(`  thrown      ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return { paid: false, refusedForThePayer: true };
  } finally {
    console.error = log;
  }
  const body = await response.text();
  out(`\n${label}`);
  out(`  source      ${source}`);
  out(`  status      ${response.status}`);
  out(`  answer      ${body.slice(0, 700)}`);
  for (const reason of reasons) out(`  motivo      ${reason}`);
  // A refusal only counts when the server read the credential: a malformed one would say nothing about the payer.
  const read = response.status === 402 && !body.includes("malformed-credential");
  return { paid: response.status === 200, refusedForThePayer: read };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------- the probe

const env = readEnv();
const owner = Keypair.fromSecret(env.AGENT_SECRET_KEY);
const rail = env.UCP_POLICY_RAIL_CONTRACT_ID;
const plain = server();
const sponsored = server(Keypair.random());

out("AgentPey · T135 · MPP charge desde un policy_rail · Stellar testnet");
out(`  SDK         @stellar/mpp 0.7.1, mppx 0.6.31, @stellar/stellar-sdk 15.1.0`);
out(`  cobra       ${AMOUNT} USDC (${USDC_SAC_TESTNET}) a ${RECIPIENT}`);
out(`  rail        ${rail}`);
out(`  dueño       ${owner.publicKey()}`);
const before = { rail: await usdcBalance(rail, owner.publicKey()), owner: await usdcBalance(owner.publicKey(), owner.publicKey()), recipient: await usdcBalance(RECIPIENT, owner.publicKey()) };
out(`  saldos      rail ${before.rail} · dueño ${before.owner} · cobro ${before.recipient}`);

const outcomes: Array<{ paid: boolean; refusedForThePayer: boolean }> = [];
outcomes.push(await attempt("a. pull, el rail como pagador", plain, async (c) => ({ transaction: await railTransaction(c, rail, owner, false), source: did(rail) })));
outcomes.push(await attempt("b. pull, el dueño del rail declarado como pagador", plain, async (c) => ({ transaction: await railTransaction(c, rail, owner, false), source: did(owner.publicKey()) })));
outcomes.push(await attempt("c. patrocinado, el rail autoriza (dueño como source)", sponsored, async (c) => ({ transaction: await railTransaction(c, rail, owner, true), source: did(owner.publicKey()) })));
outcomes.push(await attempt("d. patrocinado, el rail como pagador", sponsored, async (c) => ({ transaction: await railTransaction(c, rail, owner, true), source: did(rail) })));

// `--skip-control` reruns a–d without moving money again, once the control has paid in an earlier run.
const skipControl = process.argv.includes("--skip-control");
let controlPaid = skipControl;
if (skipControl) {
  out("\ne. control: omitido en esta corrida (--skip-control); pagó en una corrida anterior");
} else {
  out("\ne. control: el cliente oficial del SDK con una llave clásica (no es una forma de pagar de AgentPey, R-4)");
  const client = MppxClient.create({ methods: [stellarClient.charge({ keypair: owner })], fetch: (input, init) => plain.handle(new Request(input, init)), polyfill: false });
  const paid = await client.fetch(RESOURCE);
  controlPaid = paid.status === 200;
  out(`  status      ${paid.status}`);
  out(`  answer      ${(await paid.text()).slice(0, 200)}`);
  const receipt = paid.headers.get("payment-receipt");
  if (receipt !== null) out(`  recibo      ${Buffer.from(receipt, "base64url").toString("utf8")}`);
}

const after = { rail: await usdcBalance(rail, owner.publicKey()), owner: await usdcBalance(owner.publicKey(), owner.publicKey()), recipient: await usdcBalance(RECIPIENT, owner.publicKey()) };
out(`\n  saldos      rail ${after.rail} · dueño ${after.owner} · cobro ${after.recipient}`);

const verdict = outcomes.every((o) => !o.paid && o.refusedForThePayer) && controlPaid;
out(verdict ? "\nVEREDICTO: el SDK oficial no acepta un pago MPP charge desde un policy_rail (a–d rechazados, nada se movió desde el rail); con una llave clásica sí cobra (e)." : "\nVEREDICTO: resultado inesperado; parar y mostrar.");
if (!verdict) throw new ProbeError("UnexpectedOutcome", "an attempt from the rail was accepted or refused for a malformed credential, or the control did not pay");
