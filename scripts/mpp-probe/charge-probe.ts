/**
 * T135 · Can an MPP charge be paid from a `policy_rail`? A technical probe on
 * Stellar testnet, with the official SDK (`@stellar/mpp` 0.7.1, `mppx`
 * 0.6.31). Decision `R-4`: if the answer is no, AgentPey does not build MPP
 * payments with a classic key; this probe is the evidence.
 *
 * It runs MPP charge servers in process (the SDK's own `Mppx` server, driven
 * with `Request`/`Response` objects, no port opened) that charge 0.01 USDC to
 * agentcommerce's payTo account, and then:
 *
 *   0. the rail's signed transfer, simulated in enforcing mode: the rail does authorize it
 *   a. pull, the rail as payer (`did:pkh:…:C…`)        expected: refused, invalid public key
 *   b. pull, the rail's owner as declared payer (`G…`)  expected: refused, `from` mismatch
 *   c. sponsored, the rail authorizes (owner as source) expected: refused, `from` mismatch
 *   d. sponsored, the rail as payer (`did:pkh:…:C…`)   expected: refused, invalid public key
 *   e. control: the SDK's own client, a classic key     expected: paid (unsponsored server)
 *
 * a–d sign the rail's authorization entry exactly as AgentPey signs an x402
 * payment from it (`authorizeAsPolicyRailOwner`), with the stellar-sdk version
 * `@stellar/mpp` asks for (15). An attempt counts as refused only when the
 * SDK's own reason is the expected one, and the rail's balance must read the
 * same before and after. The script never broadcasts anything itself: with
 * 0.7.1 the refusals come before the server touches the network. If the SDK
 * accepted a or b, its server would broadcast the rail's transfer (up to 0.01
 * USDC, within the rail's caps), and the verdict says stop. The sponsored
 * server's fee payer is an unfunded random account: it cannot broadcast, and
 * there is no sponsored control; c and d stand on their recorded reason.
 *
 * Push mode is not tried (decided with the user): there the client broadcasts
 * first and the server refuses after, so money would move for a payment that
 * does not count. Only e moves money: 0.01 testnet USDC from the agent's
 * classic key, a control that shows the server pays out, not a way AgentPey
 * pays. `--skip-control` reruns 0–d without it.
 *
 *   pnpm --dir scripts/mpp-probe install
 *   pnpm --dir scripts/mpp-probe run probe
 *
 * Reads `AGENT_SECRET_KEY` and `UCP_POLICY_RAIL_CONTRACT_ID` from the repo's
 * `.env.local`. Prints no secret. Its errors are `ProbeError`, not AgentPey's
 * `AgentPassError`: this package is outside AgentPey's workspace.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ALL_ZEROS, NETWORK_PASSPHRASE, SOROBAN_RPC_URLS, USDC_SAC_TESTNET } from "@stellar/mpp";
import { Mppx as MppxClient, stellar as stellarClient } from "@stellar/mpp/charge/client";
import { Mppx, Store, stellar } from "@stellar/mpp/charge/server";
import { Account, Address, BASE_FEE, Contract, Keypair, Transaction, TransactionBuilder, authorizeEntry, hash, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Challenge, Credential } from "mppx";
import { z } from "zod";

/** agentcommerce's payTo account: where its x402 and UCP payments already go (T122–T149). */
const RECIPIENT = "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN";
const AMOUNT = "0.01";
/** The same amount in USDC's base units (7 decimals): what the challenges ask for. */
const AMOUNT_ATOMIC = "100000";
const RESOURCE = "https://mpp-probe.local/resource";
const NETWORK = "stellar:testnet" as const;
const PASSPHRASE = NETWORK_PASSPHRASE[NETWORK];
const RPC = new rpc.Server(SOROBAN_RPC_URLS[NETWORK]);
/** The control's transaction in the run that paid it (2026-10-05), cited when a rerun skips the control. */
const EARLIER_CONTROL_TX = "9e9836644e434df99a5b359a94a145bbe36cd1a3219ecebd6f32a6fb8efd9be9";

/** The SDK's own reasons for refusing a payer, as its server logs them (`@stellar/mpp` 0.7.1). */
const INVALID_PAYER = /Credential source contains an invalid Stellar public key/;
const FROM_MISMATCH = /Transfer "from" does not match credential source/;

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
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ProbeError("ConfigError", `cannot read ${file}: it needs AGENT_SECRET_KEY and UCP_POLICY_RAIL_CONTRACT_ID`);
  }
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  const parsed = envSchema.safeParse(values);
  if (!parsed.success) throw new ProbeError("ConfigError", `.env.local: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

// ---------------------------------------------------------------- helpers

const atomicBalance = z.bigint();

/** A SEP-41 balance, read by simulating `balance` (no transaction is sent); null when it cannot be read. */
async function usdcBalance(of: string, source: string): Promise<string | null> {
  const tx = new TransactionBuilder(await RPC.getAccount(source), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(USDC_SAC_TESTNET).call("balance", new Address(of).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) return null;
  const parsed = atomicBalance.safeParse(scValToNative(sim.result.retval));
  if (!parsed.success) return null;
  return `${parsed.data / 10_000_000n}.${(parsed.data % 10_000_000n).toString().padStart(7, "0")}`;
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

/** What the probe reads from a challenge's request: the amount, in the asset's base units. */
const challengeRequestSchema = z.looseObject({ amount: z.string().regex(/^\d+$/) });

/**
 * A transfer of `amount` from the rail, its authorization entry signed as the
 * rail's owner the way AgentPey signs an x402 payment from it
 * (apps/agent/src/payment/policy-rail-payer.ts: the owner signs the entry's
 * payload and returns the `{ public_key, signature }` struct `__check_auth`
 * decodes). Sponsored: the all-zeros source the SDK's own client uses,
 * envelope unsigned. Otherwise: the owner's account as source, envelope signed
 * by it. Never sent to the network here.
 */
async function railTransaction(amount: string, rail: string, owner: Keypair, sponsored: boolean): Promise<Transaction> {
  const source = sponsored ? new Account(ALL_ZEROS, "0") : await RPC.getAccount(owner.publicKey());
  const transfer = new Contract(USDC_SAC_TESTNET).call("transfer", new Address(rail).toScVal(), new Address(RECIPIENT).toScVal(), nativeToScVal(BigInt(amount), { type: "i128" }));
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
  if (!(tx instanceof Transaction)) throw new ProbeError("UnexpectedOutcome", "the rail's transfer came back as a fee-bump transaction");
  if (!sponsored) tx.sign(owner);
  return tx;
}

const did = (address: string) => `did:pkh:${NETWORK}:${address}`;

type Outcome = { paid: boolean; refusedForThePayer: boolean };

/**
 * One attempt: a fresh challenge, a credential carrying `transaction` with
 * `source` as payer, and the server's answer. It counts as refused for the
 * payer only when the server answers 402 and the SDK's own reason is
 * `expected`: mppx turns any failure of `verify` (an RPC timeout, an expired
 * challenge, an ambiguous settlement after broadcasting) into the same 402.
 */
async function attempt(label: string, srv: Server, expected: RegExp, build: (amount: string) => Promise<{ transaction: string; source: string }>): Promise<Outcome> {
  const challenge = Challenge.fromResponse(await srv.handle(new Request(RESOURCE)));
  const { amount } = challengeRequestSchema.parse(challenge.request);
  const { transaction, source } = await build(amount);
  // `serialize` returns the whole header value, `Payment <base64url>`.
  const authorization = Credential.serialize(Credential.from({ challenge, payload: { type: "transaction", transaction }, source }));
  out(`\n${label}`);
  out(`  source      ${source}`);
  // mppx answers every failed verification with the same "Payment verification failed." and logs the SDK's own
  // reason to console.error: it is kept here, so each attempt shows why it was refused.
  const reasons: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    const error = args.find((a): a is Error => a instanceof Error);
    reasons.push(error === undefined ? args.map(String).join(" ") : `${error.name}: ${error.message}${"details" in error ? ` ${JSON.stringify(error.details)}` : ""}`);
  };
  let response: Response;
  try {
    response = await srv.handle(new Request(RESOURCE, { headers: { Authorization: authorization } }));
  } catch (error) {
    // The server threw instead of answering: whatever it was, it is not the refusal this attempt is about.
    out(`  thrown      ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return { paid: false, refusedForThePayer: false };
  } finally {
    console.error = log;
  }
  const body = await response.text();
  out(`  status      ${response.status}`);
  out(`  answer      ${body.slice(0, 700)}`);
  for (const reason of reasons) out(`  motivo      ${reason}`);
  const refusedForThePayer = response.status === 402 && reasons.some((reason) => expected.test(reason));
  out(`  esperado    ${expected.source} → ${refusedForThePayer ? "sí" : "NO"}`);
  return { paid: response.status === 200, refusedForThePayer };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------- the probe

const env = readEnv();
const owner = Keypair.fromSecret(env.AGENT_SECRET_KEY);
const rail = env.UCP_POLICY_RAIL_CONTRACT_ID;
const plain = server();
// Unfunded on purpose: it cannot broadcast anything, so no sponsored attempt can move money.
const sponsored = server(Keypair.random());
const skipControl = process.argv.includes("--skip-control");

out("AgentPey · T135 · MPP charge desde un policy_rail · Stellar testnet");
out(`  SDK         @stellar/mpp 0.7.1, mppx 0.6.31, @stellar/stellar-sdk 15.1.0`);
out(`  cobra       ${AMOUNT} USDC (${USDC_SAC_TESTNET}) a ${RECIPIENT}`);
out(`  rail        ${rail}`);
out(`  dueño       ${owner.publicKey()}`);
const balances = async () => ({ rail: await usdcBalance(rail, owner.publicKey()), owner: await usdcBalance(owner.publicKey(), owner.publicKey()), recipient: await usdcBalance(RECIPIENT, owner.publicKey()) });
const before = await balances();
out(`  saldos      rail ${before.rail ?? "(ilegible)"} · dueño ${before.owner ?? "(ilegible)"} · cobro ${before.recipient ?? "(ilegible)"}`);

// 0. The signature stands: the network, simulating in enforcing mode, runs the rail's `__check_auth` on it.
out("\n0. la firma del rail, simulada en modo enforce (no se envía)");
const signed = await railTransaction(AMOUNT_ATOMIC, rail, owner, false);
const enforced = await RPC.simulateTransaction(signed, undefined, "enforce");
const railAuthorizes = rpc.Api.isSimulationSuccess(enforced);
out(`  resultado   ${railAuthorizes ? "éxito: __check_auth del rail acepta esta transferencia exacta, firmada así" : `falla: ${"error" in enforced ? enforced.error : "sin resultado"}`}`);

const outcomes: Outcome[] = [];
outcomes.push(await attempt("a. pull, el rail como pagador", plain, INVALID_PAYER, async (amount) => ({ transaction: (await railTransaction(amount, rail, owner, false)).toXDR(), source: did(rail) })));
outcomes.push(await attempt("b. pull, el dueño del rail declarado como pagador", plain, FROM_MISMATCH, async (amount) => ({ transaction: (await railTransaction(amount, rail, owner, false)).toXDR(), source: did(owner.publicKey()) })));
outcomes.push(await attempt("c. patrocinado, el rail autoriza (dueño como source)", sponsored, FROM_MISMATCH, async (amount) => ({ transaction: (await railTransaction(amount, rail, owner, true)).toXDR(), source: did(owner.publicKey()) })));
outcomes.push(await attempt("d. patrocinado, el rail como pagador", sponsored, INVALID_PAYER, async (amount) => ({ transaction: (await railTransaction(amount, rail, owner, true)).toXDR(), source: did(rail) })));

let controlPaid = false;
if (skipControl) {
  out(`\ne. control: no corre en esta corrida (--skip-control); pagó en la corrida del 2026-10-05, tx ${EARLIER_CONTROL_TX}`);
} else {
  out("\ne. control: el cliente oficial del SDK con una llave clásica, servidor sin patrocinio (no es una forma de pagar de AgentPey, R-4)");
  const client = MppxClient.create({ methods: [stellarClient.charge({ keypair: owner })], fetch: (input, init) => plain.handle(new Request(input, init)), polyfill: false });
  const paid = await client.fetch(RESOURCE);
  controlPaid = paid.status === 200;
  out(`  status      ${paid.status}`);
  out(`  answer      ${(await paid.text()).slice(0, 200)}`);
  const receipt = paid.headers.get("payment-receipt");
  if (receipt !== null) out(`  recibo      ${Buffer.from(receipt, "base64url").toString("utf8")}`);
}

const after = await balances();
out(`\n  saldos      rail ${after.rail ?? "(ilegible)"} · dueño ${after.owner ?? "(ilegible)"} · cobro ${after.recipient ?? "(ilegible)"}`);
const railUntouched = before.rail !== null && before.rail === after.rail;
out(`  rail        ${railUntouched ? "sin cambios" : "CAMBIÓ o no se pudo leer"}`);

const refused = outcomes.every((o) => !o.paid && o.refusedForThePayer);
const verdict = railAuthorizes && refused && railUntouched && (skipControl || controlPaid);
if (verdict) {
  out("\nVEREDICTO: el rail autoriza la transferencia (0), pero el SDK oficial rechaza el pago MPP charge desde él, por el pagador, en los cuatro intentos (a–d), y el rail no se movió.");
  out(skipControl ? `  El control con una llave clásica no corrió aquí: ver la tx ${EARLIER_CONTROL_TX}.` : "  Con una llave clásica, el mismo servidor sin patrocinio cobra (e).");
} else {
  out("\nVEREDICTO: resultado inesperado; parar y mostrar.");
  throw new ProbeError("UnexpectedOutcome", "the rail did not authorize the transfer, an attempt was not refused for its payer, the rail's balance changed or could not be read, or the control did not pay");
}
