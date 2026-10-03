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
  type CreatePurchaseIntentResult,
} from "@agentpey/agent";
import { verifyMandate } from "@agentpey/mandate";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { ReceiptRegistryClient, verifyReceipt } from "@vitrinee/anchor";
import { readFileSync } from "node:fs";
import { z } from "zod";

import type { McpEnv } from "./config.js";
import { QuoteBook } from "./quotes.js";
import { Shopper } from "./shopper.js";

const TESTNET = {
  network: "testnet",
  passphrase: Networks.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;

const deploymentSchema = z.object({ receiptRegistry: z.object({ contractId: z.string() }) });

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

  const deployment = deploymentSchema.parse(JSON.parse(readFileSync(new URL("../../../deployments/vitrinee-testnet.json", import.meta.url), "utf8")));
  const receiptRegistry = new ReceiptRegistryClient({ contractId: deployment.receiptRegistry.contractId, rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.passphrase });

  const ledger = createInMemorySpendLedger();
  return new Shopper({
    venues: () => expandPlatformVenues(DEFAULT_VENUE_REGISTRY, { onIssue: (platform, issue) => log("directory issue", { platform, issue }) }),
    fixedVenues: DEFAULT_VENUE_REGISTRY,
    signIntent: async ({ venueId, registry, productId, quantity }) => {
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
      const signed = (await agent.tools.invoke("create_purchase_intent", { product_id: productId, quantity })) as CreatePurchaseIntentResult;
      return (await verifyIntent(signed.jws)).intent;
    },
    scope: credential.credential.credentialSubject.scope,
    mandate: mandate.mandate,
    policyRail: createLocalPolicyRail({ ledger }),
    payment: { signerSecret: env.MCP_AGENT_SECRET_KEY, payer: { contractId: env.MCP_POLICY_RAIL_CONTRACT_ID, ownerSecret: env.MCP_AGENT_SECRET_KEY } },
    agentKey,
    verifyReceipt: (jws) => verifyReceipt(jws, { registry: receiptRegistry, horizonUrl: TESTNET.horizonUrl, settlementAttempts: 3 }),
    quotes: new QuoteBook(),
    log,
  });
}

