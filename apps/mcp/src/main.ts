/**
 * `pnpm --filter @agentpey/mcp start`: AgentPey's MCP server, for real, on
 * Stellar testnet (T128). The gateway starts it as the `mcp` app behind
 * `mcp.agentpey.com`; locally it runs on `PORT` with `.env.local` loaded.
 *
 * Before listening, `createShoppers` checks each spending account on chain:
 * its credential and Mandate verify and empower its agent key, and its rail is
 * that key's and that wallet's (T187). A server whose original account could
 * not pay is better not started; a listed account that fails is disabled.
 */
import { isAgentPassError } from "@agentpass/core";

import { readMcpEnv } from "./config.js";
import { createMcpApp, MCP_PATH } from "./http.js";
import { createOAuthServer } from "./oauth/server.js";
import { createShoppers } from "./runtime.js";

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), app: "mcp", message, ...fields })}\n`);
}

async function main(): Promise<void> {
  const env = readMcpEnv(process.env);
  const shoppers = await createShoppers(env, log);
  const publicUrl = env.MCP_PUBLIC_URL.replace(/\/+$/, "");
  const resource = `${publicUrl}${MCP_PATH}`;
  const oauth = createOAuthServer({ publicUrl, resource, allowedWallets: shoppers.wallets, secret: env.MCP_OAUTH_SECRET, log });
  const app = createMcpApp({ shopper: shoppers, log, allowedHosts: [new URL(publicUrl).hostname, "localhost", "127.0.0.1"], auth: { oauth, resource, allowInsecureIssuer: publicUrl.startsWith("http://") } });
  app.listen(env.PORT, () => log("listening", { port: env.PORT, resource, wallets: shoppers.wallets.length }));
}

main().catch((error: unknown) => {
  log("could not start", isAgentPassError(error) ? { code: error.code, error: error.message } : { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
