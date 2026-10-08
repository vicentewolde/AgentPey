/**
 * The MCP server's real dependencies on Stellar testnet (T128): the shopper
 * wired to AgentPass, the Mandate, the MCP's own rail, the Vitrinee directory
 * and the receipt registry. Apart from `main.ts` so the same wiring can be
 * exercised without HTTP.
 */
import { AgentPassError, didToStellarAddress } from "@agentpass/core";
import { createAgentPass } from "@agentpass/sdk";
import {
  DEFAULT_VENUE_REGISTRY,
  createAgent,
  createInMemorySpendLedger,
  createLocalPolicyRail,
  createOnChainMandateVerifier,
  createX402Catalog,
  expandPlatformVenues,
  verifyIntent,
} from "@agentpey/agent";
import { verifyMandate } from "@agentpey/mandate";
import { Keypair, Networks, StrKey, contract } from "@stellar/stellar-sdk";
import { ReceiptRegistryClient, verifyReceipt } from "@vitrinee/anchor";
import { readFileSync } from "node:fs";
import { z } from "zod";

import type { McpEnv } from "./config.js";
import { QuoteBook } from "./quotes.js";
import { Shopper } from "./shopper.js";
import { signLines } from "./sign-lines.js";

const TESTNET = {
  network: "testnet",
  passphrase: Networks.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;

const deploymentSchema = z.object({ receiptRegistry: z.object({ contractId: z.string() }) });
const intentResultSchema = z.looseObject({ jws: z.string().min(1) });

interface RailGetters {
  owner(): Promise<contract.AssembledTransaction<unknown>>;
  principal(): Promise<contract.AssembledTransaction<unknown>>;
}

/** A contract call's result, unwrapping a Soroban `Result` when the getter returns one. */
function unwrap(value: unknown): unknown {
  return typeof (value as { unwrap?: unknown } | null)?.unwrap === "function" ? (value as { unwrap: () => unknown }).unwrap() : value;
}

/**
 * Refuses to start unless the rail is owned by this agent's key and its
 * principal is the wallet allowed to sign in (`R-7`): the person who can use
 * the server must be the one whose money it spends.
 */
export function assertRailMatches(onChain: { owner: string; principal: string }, expected: { agent: string; wallet: string }): void {
  if (onChain.owner !== expected.agent) {
    throw new AgentPassError("ConfigError", "the MCP rail is not owned by MCP_AGENT_SECRET_KEY", { details: { owner: onChain.owner, agent: expected.agent } });
  }
  if (onChain.principal !== expected.wallet) {
    throw new AgentPassError("ConfigError", "MCP_ALLOWED_WALLET is not the principal of the MCP rail", { details: { principal: onChain.principal, wallet: expected.wallet } });
  }
}

/** The rail's owner key and principal, read from the network (simulation, no fee). */
async function readRail(contractId: string): Promise<{ owner: string; principal: string }> {
  const client = await contract.Client.from<RailGetters>({ contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });
  const owner = unwrap((await client.owner()).result);
  const principal = unwrap((await client.principal()).result);
  if (!(owner instanceof Uint8Array) || typeof principal !== "string") {
    throw new AgentPassError("ConfigError", "the MCP rail did not answer owner and principal as a policy_rail does", { details: { contractId } });
  }
  return { owner: StrKey.encodeEd25519PublicKey(Buffer.from(owner)), principal };
}

/**
 * The shopper with its real dependencies on testnet, checked: the credential
 * and the Mandate verify on chain and name this agent's key. Used by `main`,
 * and by anything that needs the server's exact behaviour without HTTP.
 */
export async function createShopper(env: McpEnv, log: (message: string, fields?: Record<string, unknown>) => void): Promise<Shopper> {
  const agentKey = Keypair.fromSecret(env.MCP_AGENT_SECRET_KEY);
  const agentpass = await createAgentPass({ contractId: env.AGENT_REGISTRY_CONTRACT_ID, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase, network: TESTNET.network });

  const credential = await agentpass.verify(env.MCP_CREDENTIAL_JWS);
  if (didToStellarAddress(credential.credential.credentialSubject.id) !== agentKey.publicKey()) {
    throw new AgentPassError("SignerMismatch", "MCP_AGENT_SECRET_KEY is not the subject of MCP_CREDENTIAL_JWS", {});
  }
  const mandate = await verifyMandate(env.MCP_MANDATE_JWS);
  if (didToStellarAddress(mandate.agent) !== agentKey.publicKey()) {
    throw new AgentPassError("MandateAgentMismatch", "MCP_MANDATE_JWS does not empower the MCP agent", {});
  }
  const mandateVerifier = createOnChainMandateVerifier(agentpass);
  await mandateVerifier.verify(env.MCP_MANDATE_JWS);

  assertRailMatches(await readRail(env.MCP_POLICY_RAIL_CONTRACT_ID), { agent: agentKey.publicKey(), wallet: env.MCP_ALLOWED_WALLET });

  let deployment: z.infer<typeof deploymentSchema>;
  try {
    deployment = deploymentSchema.parse(JSON.parse(readFileSync(new URL("../../../deployments/vitrinee-testnet.json", import.meta.url), "utf8")));
  } catch (error) {
    throw new AgentPassError("ConfigError", "deployments/vitrinee-testnet.json is missing or does not name the receipt registry", { cause: error, details: {} });
  }
  const receiptRegistry = new ReceiptRegistryClient({ contractId: deployment.receiptRegistry.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });

  const ledger = createInMemorySpendLedger();
  const policyRail = createLocalPolicyRail({ ledger });
  return new Shopper({
    venues: () => expandPlatformVenues(DEFAULT_VENUE_REGISTRY, { onIssue: (platform, issue) => log("directory issue", { platform, issue }) }),
    fixedVenues: DEFAULT_VENUE_REGISTRY,
    signIntent: async ({ venueId, registry, lines }) => {
      // A fresh agent per intent: it re-checks the credential and the Mandate on chain each time.
      const agent = await createAgent({
        credential: env.MCP_CREDENTIAL_JWS,
        mandate: env.MCP_MANDATE_JWS,
        catalog: createX402Catalog({ venueId, registry }),
        verifier: agentpass,
        mandateVerifier,
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
    payment: { signerSecret: env.MCP_AGENT_SECRET_KEY, payer: { contractId: env.MCP_POLICY_RAIL_CONTRACT_ID, ownerSecret: env.MCP_AGENT_SECRET_KEY } },
    agentKey,
    verifyReceipt: (jws) => verifyReceipt(jws, { registry: receiptRegistry, horizonUrl: TESTNET.horizonUrl, settlementAttempts: 3 }),
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

