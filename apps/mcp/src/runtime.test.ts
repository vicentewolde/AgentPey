import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { assertRailMatches } from "./runtime.js";

describe("assertRailMatches (T128, R-7)", () => {
  const agent = Keypair.random().publicKey();
  const wallet = Keypair.random().publicKey();

  it("passes when the rail is owned by the agent and its principal is the wallet that signs in", () => {
    expect(() => assertRailMatches({ owner: agent, principal: wallet }, { agent, wallet })).not.toThrow();
  });

  it("refuses to start when another wallet would sign in, or another key owns the rail", () => {
    expect(() => assertRailMatches({ owner: agent, principal: Keypair.random().publicKey() }, { agent, wallet })).toThrow(expect.objectContaining({ code: "ConfigError", message: expect.stringMatching(/principal/) }));
    expect(() => assertRailMatches({ owner: Keypair.random().publicKey(), principal: wallet }, { agent, wallet })).toThrow(expect.objectContaining({ code: "ConfigError", message: expect.stringMatching(/owned/) }));
  });
});
