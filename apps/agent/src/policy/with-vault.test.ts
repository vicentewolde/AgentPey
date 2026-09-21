import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileMandateVault } from "@agentpey/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuthorisationDecision, AuthorisationRequest, PolicyRail } from "./policy-rail.js";
import { withVault } from "./with-vault.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "with-vault-"));
  path = join(dir, "vault.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function requestFor(agent: string, intentId: string): AuthorisationRequest {
  return { intent: { agent, intentId } } as unknown as AuthorisationRequest;
}

function fakeRail(decision: AuthorisationDecision, release?: PolicyRail["release"]): PolicyRail {
  return {
    authorise: async () => decision,
    preview: async () => decision,
    release:
      release ??
      (() => {
        throw new Error("release was not expected in this test");
      }),
  };
}

describe("withVault", () => {
  it("passes a grant through untouched, and records nothing (the ledger already will, if it is the vault)", async () => {
    const vault = createFileMandateVault({ path });
    const granted: AuthorisationDecision = {
      authorised: true,
      intentId: "i1",
      total: "1.00",
      currency: "USDC",
      spentToday: "1.00",
      reconciled: false,
    };
    const rail = withVault(fakeRail(granted), vault);

    const decision = await rail.authorise(requestFor("agent-1", "i1"));

    expect(decision).toEqual(granted);
    expect(vault.list()).toHaveLength(0);
  });

  it("records a refusal in the vault, and still returns it unchanged", async () => {
    const vault = createFileMandateVault({ path });
    const refused: AuthorisationDecision = {
      authorised: false,
      code: "ScopeAmountExceeded",
      reason: "over perTx",
      details: { limit: "10.00", total: "20.00" },
    };
    const rail = withVault(fakeRail(refused), vault);

    const decision = await rail.authorise(requestFor("agent-1", "i2"));

    expect(decision).toEqual(refused);
    const [record] = vault.list("agent-1");
    expect(record?.entry).toMatchObject({
      kind: "refused",
      subject: "agent-1",
      intentId: "i2",
      code: "ScopeAmountExceeded",
      reason: "over perTx",
      details: { limit: "10.00", total: "20.00" },
    });
  });
});
