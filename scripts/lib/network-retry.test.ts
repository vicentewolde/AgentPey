import { AgentPassError } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { isTransient, withRetry } from "./network-retry.js";

const noWait = { sleep: async () => {}, delayMs: 0 };

describe("withRetry (T158): a read that gives up on time and tries again", () => {
  it("tries a network failure again and returns the first answer", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls < 3) throw new Error("Request failed with status code 503");
      return "ledger 5213340";
    };
    await expect(withRetry("escrow get", read, noWait)).resolves.toBe("ledger 5213340");
    expect(calls).toBe(3);
  });

  it("stops waiting for a read that hangs, and tries again", async () => {
    let calls = 0;
    const read = () => {
      calls += 1;
      return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("answered");
    };
    await expect(withRetry("escrow get", read, { ...noWait, timeoutMs: 20 })).resolves.toBe("answered");
    expect(calls).toBe(2);
  });

  it("gives up with a NetworkError after the last attempt", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    await expect(withRetry("escrow get", read, { ...noWait, attempts: 3 })).rejects.toMatchObject({ code: "NetworkError" });
    expect(calls).toBe(3);
  });

  it("does not retry what is not the network's: a refusal fails at once", async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      throw new AgentPassError("ResolveReceiptInvalid", "the receipt did not pass its checks", { details: {} });
    };
    await expect(withRetry("receipt", read, noWait)).rejects.toMatchObject({ code: "ResolveReceiptInvalid" });
    expect(calls).toBe(1);
  });

  it("tells a network failure from anything else", () => {
    for (const transient of [new Error("Request failed with status code 502"), new Error("Request failed with status code 429"), new TypeError("fetch failed"), Object.assign(new Error("x"), { code: "ECONNRESET" }), new AgentPassError("NetworkError", "x", { details: {} })]) {
      expect(isTransient(transient), String(transient)).toBe(true);
    }
    // The Stellar CLI wraps the RPC's 503 as CommandFailed, with the answer in its stderr (T158 review).
    expect(isTransient(new AgentPassError("CommandFailed", "stellar contract invoke failed", { details: { stderr: "error: Networking or low-level protocol error: HTTP error: 503 Service Unavailable (status code 503)" } }))).toBe(true);
    expect(isTransient(new AgentPassError("CommandFailed", "stellar contract invoke failed", { details: { stderr: "error: HostError: Error(Contract, #3)" } }))).toBe(false);
    for (const lasting of [new Error("Request failed with status code 404"), new AgentPassError("ResolveReceiptInvalid", "x", { details: {} }), new Error("invalid argument")]) {
      expect(isTransient(lasting), String(lasting)).toBe(false);
    }
  });
});
