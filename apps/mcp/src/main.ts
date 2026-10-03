/**
 * `pnpm --filter @agentpey/mcp start`: AgentPey's MCP server, for real, on
 * Stellar testnet (T128). The gateway starts it as the `mcp` app behind
 * `mcp.agentpey.com`; locally it runs on `PORT` with `.env.local` loaded.
 *
 * Before listening, `createShopper` checks that the credential and the
 * Mandate verify on chain and empower this agent's key. A server that could
 * not pay is better not started than started and failing on the first `pay`.
 */
import { isAgentPassError } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";

import { readMcpEnv } from "./config.js";
import { createMcpApp, MCP_PATH } from "./http.js";
import { createOAuthServer } from "./oauth/server.js";
import { createShopper } from "./runtime.js";

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), app: "mcp", message, ...fields })}\n`);
}

async function main(): Promise<void> {
  const env = readMcpEnv(process.env);
  const shopper = await createShopper(env, log);
  const publicUrl = env.MCP_PUBLIC_URL.replace(/\/+$/, "");
  const resource = `${publicUrl}${MCP_PATH}`;
  const oauth = createOAuthServer({ publicUrl, resource, allowedWallet: env.MCP_ALLOWED_WALLET, secret: env.MCP_OAUTH_SECRET, log });
  const app = createMcpApp({ shopper, log, allowedHosts: [new URL(publicUrl).hostname, "localhost", "127.0.0.1"], auth: { oauth, resource, allowInsecureIssuer: publicUrl.startsWith("http://") } });
  app.listen(env.PORT, () => log("listening", { port: env.PORT, resource, agent: Keypair.fromSecret(env.MCP_AGENT_SECRET_KEY).publicKey(), rail: env.MCP_POLICY_RAIL_CONTRACT_ID }));
}

main().catch((error: unknown) => {
  log("could not start", isAgentPassError(error) ? { code: error.code, error: error.message } : { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
