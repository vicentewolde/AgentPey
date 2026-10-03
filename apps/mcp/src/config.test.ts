import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { readMcpEnv } from "./config.js";

const agent = Keypair.random();
const valid = {
  MCP_PUBLIC_URL: "https://mcp.agentpey.com",
  MCP_AGENT_SECRET_KEY: agent.secret(),
  MCP_POLICY_RAIL_CONTRACT_ID: "CBWRKZ3SL4EAXOS5XAV6CXVRRTBNPPFFC5TKSLW3FTXFTQZNBAZY6Z5U",
  MCP_CREDENTIAL_JWS: "aaa.bbb.ccc",
  MCP_MANDATE_JWS: "aaa.bbb.ccc",
  MCP_ALLOWED_WALLET: Keypair.random().publicKey(),
  MCP_OAUTH_SECRET: "x".repeat(32),
  AGENT_REGISTRY_CONTRACT_ID: "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F",
};

describe("readMcpEnv (T128)", () => {
  it("reads a complete environment", () => {
    expect(readMcpEnv(valid)).toMatchObject({ PORT: 3010, MCP_PUBLIC_URL: "https://mcp.agentpey.com" });
  });

  it("names what is wrong, never a secret's value", () => {
    const bad = { ...valid, MCP_AGENT_SECRET_KEY: "SNOTAKEY", MCP_OAUTH_SECRET: "short", MCP_PUBLIC_URL: "http://mcp.agentpey.com" };
    let thrown: unknown;
    try {
      readMcpEnv(bad);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "ConfigError" });
    const text = JSON.stringify({ message: (thrown as Error).message, details: (thrown as { details: unknown }).details });
    expect(text).toMatch(/MCP_AGENT_SECRET_KEY/);
    expect(text).toMatch(/MCP_OAUTH_SECRET/);
    expect(text).toMatch(/MCP_PUBLIC_URL/);
    expect(text).not.toContain("SNOTAKEY");
    expect(text).not.toContain(agent.secret());
  });
});
