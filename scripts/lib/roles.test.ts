import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ROLES, resolveKeypair } from "./roles.js";

const agent = ROLES.find((r) => r.id === "agent")!;

describe("resolveKeypair", () => {
  it("reuses an existing secret and never regenerates it", () => {
    const kp = Keypair.random();
    const env = new Map([[agent.secretVar, kp.secret()]]);
    const resolved = resolveKeypair(agent, env);
    expect(resolved.origin).toBe("existing");
    expect(resolved.keypair.publicKey()).toBe(kp.publicKey());
  });

  it("generates a fresh keypair when the secret is absent or blank", () => {
    expect(resolveKeypair(agent, new Map()).origin).toBe("generated");
    expect(resolveKeypair(agent, new Map([[agent.secretVar, ""]])).origin).toBe("generated");
  });

  it("refuses a public key that does not match the secret, and a malformed secret", () => {
    const kp = Keypair.random();
    const env = new Map([
      [agent.secretVar, kp.secret()],
      [agent.publicVar, Keypair.random().publicKey()],
    ]);
    expect(() => resolveKeypair(agent, env)).toThrow(/does not match/);
    expect(() => resolveKeypair(agent, new Map([[agent.secretVar, "SNOTASEED"]]))).toThrow(/valid Stellar secret/);
  });

  it("defines the two merchant keys separately (V-8)", () => {
    const vars = ROLES.map((r) => r.secretVar);
    expect(new Set(vars).size).toBe(3);
    expect(ROLES.find((r) => r.id === "merchant-payout")!.usdcTrustline).toBe(true);
    expect(ROLES.find((r) => r.id === "merchant-signing")!.usdcTrustline).toBe(false);
  });
});
