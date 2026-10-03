/**
 * `pnpm --filter @agentpey/mcp start`: AgentPey's MCP server, for real, on
 * Stellar testnet (T128). The gateway starts it as the `mcp` app behind
 * `mcp.agentpey.com`; locally it runs on `PORT` with `.env.local` loaded.
 *
 * At startup it checks, before listening, that the credential and the
 * Mandate verify on chain and empower this agent's key. A server that could
 * not pay is better not started than started and failing on the first `pay`.
 */
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
  verifyIntent,
  type CreatePurchaseIntentResult,
} from "@agentpey/agent";
import { verifyMandate } from "@agentpey/mandate";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { ReceiptRegistryClient, verifyReceipt } from "@vitrinee/anchor";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { readMcpEnv } from "./config.js";
import { createMcpApp, MCP_PATH } from "./http.js";
import { createOAuthServer } from "./oauth/server.js";
import { QuoteBook } from "./quotes.js";
import { Shopper } from "./shopper.js";

const TESTNET = {
  network: "testnet",
  passphrase: Networks.TESTNET,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;

const deploymentSchema = z.object({ receiptRegistry: z.object({ contractId: z.string() }) });

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), app: "mcp", message, ...fields })}\n`);
}

async function main(): Promise<void> {
  const env = readMcpEnv(process.env);
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
  const shopper = new Shopper({
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

  const publicUrl = env.MCP_PUBLIC_URL.replace(/\/+$/, "");
  const resource = `${publicUrl}${MCP_PATH}`;
  const oauth = createOAuthServer({ publicUrl, resource, allowedWallet: env.MCP_ALLOWED_WALLET, secret: env.MCP_OAUTH_SECRET, log });
  const app = createMcpApp({ shopper, log, allowedHosts: [new URL(publicUrl).hostname, "localhost", "127.0.0.1"], auth: { oauth, resource, allowInsecureIssuer: publicUrl.startsWith("http://") } });
  app.listen(env.PORT, () => log("listening", { port: env.PORT, resource, agent: agentKey.publicKey(), rail: env.MCP_POLICY_RAIL_CONTRACT_ID }));
}

main().catch((error: unknown) => {
  log("could not start", isAgentPassError(error) ? { code: error.code, error: error.message } : { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
