/**
 * Everything the MCP server reads from its environment, checked with zod at
 * startup (T128). Every secret is named here and nowhere else; none is ever
 * logged. In production they reach this process through the gateway's
 * fixed list for the `mcp` app (`apps/gateway/src/hosts.ts`), and locally
 * from `.env.local`, written by `pnpm run mcp:setup`.
 */
import { AgentPassError } from "@agentpass/core";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { MIN_SECRET_BYTES } from "./oauth/tokens.js";

const account = z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "not a Stellar account (G...)");
const contract = z.string().refine((value) => StrKey.isValidContract(value), "not a Stellar contract id (C...)");
const secretKey = z.string().refine((value) => StrKey.isValidEd25519SecretSeed(value), "not a Stellar secret key (S...)");
const jws = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "not a compact JWS");

export const mcpEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  /** This server's public origin, e.g. https://mcp.agentpey.com. */
  MCP_PUBLIC_URL: z.url().refine((value) => value.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value), "must be https, or http on localhost"),
  /** The agent's key: the subject of its credential, and the owner of its rail (R-1). */
  MCP_AGENT_SECRET_KEY: secretKey,
  MCP_POLICY_RAIL_CONTRACT_ID: contract,
  MCP_CREDENTIAL_JWS: jws,
  MCP_MANDATE_JWS: jws,
  /** The only wallet that can sign in (R-7): the principal of the rail. */
  MCP_ALLOWED_WALLET: account,
  MCP_OAUTH_SECRET: z.string().min(MIN_SECRET_BYTES, `at least ${MIN_SECRET_BYTES} characters`),
  AGENT_REGISTRY_CONTRACT_ID: contract,
  /**
   * The phrase each listed person's agent key derives from (T187, `R-33`, SEP-0005). Optional: without it the server
   * serves only `MCP_ALLOWED_WALLET`, as before the list, and says so in its log.
   */
  MCP_AGENT_MNEMONIC: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
});

export type McpEnv = z.infer<typeof mcpEnvSchema>;

/** @throws AgentPassError `ConfigError`, naming the variables that are missing or malformed, never their values. */
export function readMcpEnv(env: NodeJS.ProcessEnv): McpEnv {
  const parsed = mcpEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new AgentPassError("ConfigError", `the MCP server's environment is incomplete: ${problems.join("; ")}`, { details: { problems } });
  }
  return parsed.data;
}
