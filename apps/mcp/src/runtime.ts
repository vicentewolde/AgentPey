/**
 * The MCP server's real dependencies on Stellar testnet (T128): one shopper per spending account, each wired to
 * AgentPass, its Mandate, its own rail, the Vitrinee directory and the receipt registry. Apart from `main.ts` so the
 * same wiring can be exercised without HTTP.
 *
 * Since T187 (`R-33`, `Y-4`) the server serves a closed list of wallets: the one it always served
 * (`MCP_ALLOWED_WALLET`, with its own non-derived key, T171 §7) and every person on `apps/mcp/wallets.testnet.json`,
 * each with an agent key derived for them alone from `MCP_AGENT_MNEMONIC`. Each account is checked on chain at
 * startup, as the single one always was. The original account failing stops the server, as before; a listed one
 * failing is disabled and logged, and the rest keep working.
 */
import { readFileSync } from "node:fs";

import { AgentPassError, didToStellarAddress, isAgentPassError } from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import {
  DEFAULT_VENUE_REGISTRY,
  createAgent,
  createInMemorySpendLedger,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  createX402Catalog,
  expandPlatformVenues,
  toScaledAmount,
  verifyIntent,
} from "@agentpey/agent";
import { verifyMandate } from "@agentpey/mandate";
import { deriveTenantKeypair, type TenantKeypair } from "@agentpey/tenancy";
import { Keypair, Networks, StrKey, contract } from "@stellar/stellar-sdk";
import { ReceiptRegistryClient, escrowDisputeOpeners, escrowPolicy, escrowReaders, verifyReceipt } from "@vitrinee/anchor";
import { z } from "zod";

import type { McpEnv } from "./config.js";
import { QuoteBook } from "./quotes.js";
import { Shopper } from "./shopper.js";
import { signLines } from "./sign-lines.js";
import { EMPTY_WALLETS_FILE, WALLETS_FILE, type WalletsFile, parseWalletsFile } from "./wallets.js";

const TESTNET = {
  network: "testnet",
  passphrase: Networks.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;

const deploymentSchema = z.object({ receiptRegistry: z.object({ contractId: z.string() }) });
/** AgentResolve's arbiter: the one arbiter the MCP accepts in a store's escrow (T160). */
const agentResolveSchema = z.object({ agentResolve: z.object({ arbiter: z.string().regex(/^G[A-Z2-7]{55}$/) }) });
const intentResultSchema = z.looseObject({ jws: z.string().min(1) });

type Log = (message: string, fields?: Record<string, unknown>) => void;

interface RailGetters {
  owner(): Promise<contract.AssembledTransaction<unknown>>;
  principal(): Promise<contract.AssembledTransaction<unknown>>;
  per_tx(): Promise<contract.AssembledTransaction<unknown>>;
  per_day(): Promise<contract.AssembledTransaction<unknown>>;
}

/** One person's spending account: whose wallet signs in, which key spends, from which rail, under which documents. */
export interface SpendingAccount {
  /** How the log names it: never a secret. */
  readonly label: string;
  /** Its SEP-0005 index; absent for the original account, whose key is not derived. */
  readonly agentIndex?: number;
  /** The wallet that signs in and owns the money: the rail's principal. */
  readonly wallet: string;
  /** The agent key that owns the rail and signs intents, payments and claims. */
  readonly agentSecret: string;
  readonly rail: string;
  readonly credentialJws: string;
  readonly mandateJws: string;
  /** The limits the list says its rail enforces; checked against the rail on chain at startup. Absent for the original. */
  readonly limits?: { readonly perTx: string; readonly perDay: string };
}

/** A listed person the server will not serve, and why. Logged at startup; no secret in it. */
export interface DisabledAccount {
  readonly wallet: string;
  readonly agentIndex: number;
  readonly reason: string;
}

/** Which person each request spends for. `wallets` is exactly who may sign in. */
export interface ShopperDirectory {
  readonly wallets: readonly string[];
  forWallet(wallet: string): Shopper | undefined;
}

/** A contract call's result, unwrapping a Soroban `Result` when the getter returns one. */
function unwrap(value: unknown): unknown {
  return typeof (value as { unwrap?: unknown } | null)?.unwrap === "function" ? (value as { unwrap: () => unknown }).unwrap() : value;
}

/**
 * Refuses an account unless its rail is owned by its agent key and its principal is the wallet that signs in (`R-7`):
 * the person who can use the server must be the one whose money it spends.
 */
export function assertRailMatches(onChain: { owner: string; principal: string }, expected: { agent: string; wallet: string; label?: string }): void {
  const label = expected.label ?? "the MCP account";
  if (onChain.owner !== expected.agent) {
    throw new AgentPassError("ConfigError", `${label}: the rail is not owned by its agent key`, { details: { owner: onChain.owner, agent: expected.agent } });
  }
  if (onChain.principal !== expected.wallet) {
    throw new AgentPassError("ConfigError", `${label}: the wallet that signs in is not the principal of its rail`, { details: { principal: onChain.principal, wallet: expected.wallet } });
  }
}

/**
 * The listed people the server can serve, and the ones it cannot, decided before anything is read on chain. Pure: the
 * key derivation is passed in. Refused: everyone when there is no mnemonic; an entry without its credential and
 * Mandate; one whose derived key is not the listed agent (a different mnemonic); and one for the original wallet,
 * which keeps its own account.
 */
export function planListedAccounts(
  file: WalletsFile,
  options: { readonly mnemonic: string | undefined; readonly originalWallet: string; readonly derive?: (mnemonic: string, index: number) => TenantKeypair },
): { readonly accounts: SpendingAccount[]; readonly disabled: DisabledAccount[] } {
  const derive = options.derive ?? ((mnemonic: string, index: number) => deriveTenantKeypair(mnemonic, index, "agent"));
  const accounts: SpendingAccount[] = [];
  const disabled: DisabledAccount[] = [];
  for (const entry of file.wallets) {
    const off = (reason: string) => disabled.push({ wallet: entry.wallet, agentIndex: entry.agentIndex, reason });
    if (entry.wallet === options.originalWallet) {
      off("this wallet already has the original account (MCP_ALLOWED_WALLET)");
      continue;
    }
    if (options.mnemonic === undefined) {
      off("MCP_AGENT_MNEMONIC is not set");
      continue;
    }
    if (entry.credential === undefined || entry.mandate === undefined) {
      off("no credential and Mandate yet: run mcp:setup with --agent-index");
      continue;
    }
    let key: TenantKeypair;
    try {
      key = derive(options.mnemonic, entry.agentIndex);
    } catch (error) {
      off(isAgentPassError(error) ? error.message : "the agent key could not be derived");
      continue;
    }
    if (key.publicKey !== entry.agent) {
      off("MCP_AGENT_MNEMONIC does not derive the listed agent key");
      continue;
    }
    accounts.push({ label: `agent index ${entry.agentIndex}`, agentIndex: entry.agentIndex, wallet: entry.wallet, agentSecret: key.secret, rail: entry.rail, credentialJws: entry.credential, mandateJws: entry.mandate, limits: { perTx: entry.perTx, perDay: entry.perDay } });
  }
  return { accounts, disabled };
}

/** The rail's owner key, principal and limits (atomic units), read from the network (simulation, no fee). */
async function readRail(contractId: string): Promise<{ owner: string; principal: string; perTx: bigint; perDay: bigint }> {
  const client = await contract.Client.from<RailGetters>({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });
  const owner = unwrap((await client.owner()).result);
  const principal = unwrap((await client.principal()).result);
  const perTx = unwrap((await client.per_tx()).result);
  const perDay = unwrap((await client.per_day()).result);
  if (!(owner instanceof Uint8Array) || typeof principal !== "string" || typeof perTx !== "bigint" || typeof perDay !== "bigint") {
    throw new AgentPassError("ConfigError", "the rail did not answer owner, principal and limits as a policy_rail does", { details: { contractId } });
  }
  return { owner: StrKey.encodeEd25519PublicKey(Buffer.from(owner)), principal, perTx, perDay };
}

/**
 * Refuses a listed account whose rail enforces other limits than the list says: the list is what people read, the rail
 * is what the network enforces, and the Mandate was issued with the list's numbers.
 */
export function assertRailLimits(onChain: { perTx: bigint; perDay: bigint }, listed: { perTx: string; perDay: string }, label: string): void {
  if (onChain.perTx !== toScaledAmount(listed.perTx) || onChain.perDay !== toScaledAmount(listed.perDay)) {
    throw new AgentPassError("ConfigError", `${label}: the rail's limits on chain are not the listed ones`, {
      details: { onChain: { perTx: onChain.perTx.toString(), perDay: onChain.perDay.toString() }, listed },
    });
  }
}

/** What every account's shopper shares: the registry, the directory's escrows and receipts, AgentResolve's arbiter. */
interface Shared {
  readonly agentpass: Awaited<ReturnType<typeof createAgentPass>>;
  readonly mandateVerifier: ReturnType<typeof createOnChainMandateVerifier>;
  readonly receiptRegistry: ReceiptRegistryClient;
  readonly arbiter: string;
  readonly escrows: ReturnType<typeof escrowReaders>;
  readonly escrowDisputes: ReturnType<typeof escrowDisputeOpeners>;
}

async function createShared(env: McpEnv): Promise<Shared> {
  const agentpass = await createAgentPass({ contractId: env.AGENT_REGISTRY_CONTRACT_ID, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network });
  let deployment: z.infer<typeof deploymentSchema>;
  try {
    deployment = deploymentSchema.parse(JSON.parse(readFileSync(new URL("../../../deployments/vitrinee-testnet.json", import.meta.url), "utf8")));
  } catch (error) {
    throw new AgentPassError("ConfigError", "deployments/vitrinee-testnet.json is missing or does not name the receipt registry", { cause: error, details: {} });
  }
  let arbiter: string;
  try {
    arbiter = agentResolveSchema.parse(JSON.parse(readFileSync(new URL("../../../deployments/testnet.json", import.meta.url), "utf8"))).agentResolve.arbiter;
  } catch (error) {
    throw new AgentPassError("ConfigError", "deployments/testnet.json is missing or does not name AgentResolve's arbiter", { cause: error, details: {} });
  }
  return {
    agentpass,
    mandateVerifier: createOnChainMandateVerifier(agentpass),
    receiptRegistry: new ReceiptRegistryClient({ contractId: deployment.receiptRegistry.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
    arbiter,
    escrows: escrowReaders({ rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
    escrowDisputes: escrowDisputeOpeners({ rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase }),
  };
}

/**
 * One account's shopper, checked: the credential and the Mandate verify on chain and name this account's agent key,
 * and the rail is that key's and that wallet's. Nothing is shared with another account's shopper but read-only clients:
 * each has its own key, rail, spend ledger and quotes.
 */
async function createAccountShopper(shared: Shared, account: SpendingAccount, log: Log): Promise<Shopper> {
  const agentKey = Keypair.fromSecret(account.agentSecret);
  const credential = await shared.agentpass.verify(account.credentialJws);
  if (didToStellarAddress(credential.credential.credentialSubject.id) !== agentKey.publicKey()) {
    throw new AgentPassError("SignerMismatch", `${account.label}: the agent key is not the subject of its credential`, {});
  }
  const mandate = await verifyMandate(account.mandateJws);
  if (didToStellarAddress(mandate.agent) !== agentKey.publicKey()) {
    throw new AgentPassError("MandateAgentMismatch", `${account.label}: the Mandate does not empower its agent key`, {});
  }
  await shared.mandateVerifier.verify(account.mandateJws);
  const rail = await readRail(account.rail);
  assertRailMatches(rail, { agent: agentKey.publicKey(), wallet: account.wallet, label: account.label });
  if (account.limits !== undefined) assertRailLimits(rail, account.limits, account.label);

  const ledger = createInMemorySpendLedger();
  const policyRail = createLocalPolicyRail({ ledger });
  return new Shopper({
    venues: () => expandPlatformVenues(DEFAULT_VENUE_REGISTRY, { onIssue: (platform, issue) => log("directory issue", { platform, issue }) }),
    fixedVenues: DEFAULT_VENUE_REGISTRY,
    signIntent: async ({ venueId, registry, lines }) => {
      // A fresh agent per intent: it re-checks the credential and the Mandate on chain each time.
      const agent = await createAgent({
        credential: account.credentialJws,
        mandate: account.mandateJws,
        catalog: createX402Catalog({ venueId, registry }),
        verifier: shared.agentpass,
        mandateVerifier: shared.mandateVerifier,
        signer: agentKey,
        ledger,
        now: new Date(),
      });
      const signed = intentResultSchema.safeParse(await signLines(agent, lines));
      if (!signed.success) throw new AgentPassError("InvalidIntent", "the agent did not return a signed intent", { details: {} });
      return (await verifyIntent(signed.data.jws)).intent;
    },
    scope: credential.credential.credentialSubject.scope,
    mandate: mandate.mandate,
    policyRail,
    payment: {
      signerSecret: account.agentSecret,
      payer: { contractId: account.rail, ownerSecret: account.agentSecret },
      // A store's escrow is paid only once it checks out on chain: known code, AgentResolve's arbiter, releasing to
      // the store's own account (T160, X-9).
      // 15 s for the hold, not the default 30: pay already includes the settlement, and a chat client that gives up
      // first shows an error for a payment that went through. get_order shows the hold either way (T161).
      escrow: { ...escrowPolicy(shared.escrows, [shared.arbiter]), heldWaitMs: 15_000 },
    },
    agentKey,
    // A receipt paid into a store's escrow is checked against that escrow too (T159).
    verifyReceipt: (jws) =>
      verifyReceipt(jws, {
        registry: shared.receiptRegistry,
        horizonUrl: TESTNET.horizonUrl,
        settlementAttempts: 3,
        escrows: shared.escrows,
      }),
    // get_order reads the escrow a signed receipt names, on chain, for where the payment stands (T161 review).
    escrows: shared.escrows,
    // open_claim opens the dispute in that escrow, sent and paid by the agent's own account (T162).
    escrowDisputes: shared.escrowDisputes,
    // Signing a quote's intent reserves the day's budget (M-15). A quote that expires or is evicted unpaid
    // signed nothing that pays, so its reservation goes back (T150 review).
    quotes: new QuoteBook({
      onDrop: (entry, reason) =>
        policyRail.release({ intentId: entry.intent.intentId, reason: reason === "expired" ? "QuoteExpired" : "QuoteEvicted" }).catch((error: unknown) => {
          log("spend not released", { intentId: entry.intent.intentId, error: error instanceof Error ? error.message : String(error) });
        }),
    }),
    log,
  });
}

/** The list next to the app (`apps/mcp/wallets.testnet.json`), from `src` or `dist` alike. No file: nobody listed. */
export function readWalletsFile(location: URL = new URL(`../${WALLETS_FILE}`, import.meta.url)): WalletsFile {
  let text: string;
  try {
    text = readFileSync(location, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_WALLETS_FILE;
    throw new AgentPassError("ConfigError", `${WALLETS_FILE} could not be read`, { cause: error, details: {} });
  }
  return parseWalletsFile(text);
}

/**
 * Every account's shopper, checked on chain. The original account (`MCP_*` variables) must check out or the server
 * does not start, as before T187. A listed account that does not check out is disabled and logged; the others serve.
 */
export async function createShoppers(env: McpEnv, log: Log, options: { readonly wallets?: WalletsFile } = {}): Promise<ShopperDirectory> {
  const shared = await createShared(env);
  const original: SpendingAccount = {
    label: "MCP_ALLOWED_WALLET",
    wallet: env.MCP_ALLOWED_WALLET,
    agentSecret: env.MCP_AGENT_SECRET_KEY,
    rail: env.MCP_POLICY_RAIL_CONTRACT_ID,
    credentialJws: env.MCP_CREDENTIAL_JWS,
    mandateJws: env.MCP_MANDATE_JWS,
  };
  const shoppers = new Map<string, Shopper>([[original.wallet, await createAccountShopper(shared, original, log)]]);

  // A list that cannot be read disables the list, never the original account (T187 review).
  let listed: WalletsFile;
  try {
    listed = options.wallets ?? readWalletsFile();
  } catch (error) {
    log("wallet list unreadable", { error: isAgentPassError(error) ? error.message : "unknown" });
    listed = EMPTY_WALLETS_FILE;
  }
  const plan = planListedAccounts(listed, { mnemonic: env.MCP_AGENT_MNEMONIC, originalWallet: original.wallet });
  const disabled = [...plan.disabled];
  for (const account of plan.accounts) {
    try {
      shoppers.set(account.wallet, await createAccountShopper(shared, account, log));
    } catch (error) {
      disabled.push({ wallet: account.wallet, agentIndex: account.agentIndex ?? 0, reason: isAgentPassError(error) ? `${error.code}: ${error.message}` : "its checks on chain failed" });
    }
  }
  for (const entry of disabled) log("listed wallet disabled", { wallet: entry.wallet, agentIndex: entry.agentIndex, reason: entry.reason });
  log("wallets served", { count: shoppers.size, disabled: disabled.length });
  return { wallets: [...shoppers.keys()], forWallet: (wallet) => shoppers.get(wallet) };
}
