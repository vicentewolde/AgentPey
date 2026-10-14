import { isAgentPassError } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ESCROW_OPEN_DOMAIN, escrowOpenMessage, signEscrowOpen } from "./escrow-open.js";

/** Same vector as `contracts/purchase-escrow/src/test.rs` (`VECTOR_CONTRACT`, `VECTOR_MESSAGE`). */
const VECTOR_CONTRACT = "CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F";
const VECTOR_MESSAGE =
  "6167656e747065792f70757263686173652d657363726f772f6f70656e2f7631b0c35fbe2a7dd256f4c699c0cea1109c1b866061a42b37b7e4e0b84c42200e3111111111111111111111111111111111111111111111111111111111111111116f72645f74657374313233";
const CLAIM = "11".repeat(32);

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isAgentPassError(error) ? error.code : "untyped";
  }
  return undefined;
}

describe("escrowOpenMessage", () => {
  it("builds byte for byte what the contract builds", () => {
    const message = escrowOpenMessage(VECTOR_CONTRACT, "ord_test123", CLAIM);
    expect(Buffer.from(message).toString("hex")).toBe(VECTOR_MESSAGE);
    expect(ESCROW_OPEN_DOMAIN).toHaveLength(32);
  });

  it("changes with the escrow, the order and the claim", () => {
    const base = Buffer.from(escrowOpenMessage(VECTOR_CONTRACT, "ord_test123", CLAIM)).toString("hex");
    const otherEscrow = "CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA";
    expect(Buffer.from(escrowOpenMessage(otherEscrow, "ord_test123", CLAIM)).toString("hex")).not.toBe(base);
    expect(Buffer.from(escrowOpenMessage(VECTOR_CONTRACT, "ord_test124", CLAIM)).toString("hex")).not.toBe(base);
    expect(Buffer.from(escrowOpenMessage(VECTOR_CONTRACT, "ord_test123", "22".repeat(32))).toString("hex")).not.toBe(base);
  });

  it("refuses an account as the escrow, a malformed claim hash and an order reference out of bounds", () => {
    expect(codeOf(() => escrowOpenMessage("GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K", "ord_1", CLAIM))).toBe("InvalidArguments");
    expect(codeOf(() => escrowOpenMessage(VECTOR_CONTRACT, "ord_1", "AB".repeat(32)))).toBe("InvalidArguments");
    expect(codeOf(() => escrowOpenMessage(VECTOR_CONTRACT, "ord_1", "11".repeat(31)))).toBe("InvalidArguments");
    expect(codeOf(() => escrowOpenMessage(VECTOR_CONTRACT, "", CLAIM))).toBe("InvalidArguments");
    expect(codeOf(() => escrowOpenMessage(VECTOR_CONTRACT, "x".repeat(65), CLAIM))).toBe("InvalidArguments");
    expect(codeOf(() => escrowOpenMessage(VECTOR_CONTRACT, "x".repeat(64), CLAIM))).toBeUndefined();
  });
});

describe("signEscrowOpen", () => {
  it("is the rail owner's Ed25519 signature over the message", () => {
    const owner = Keypair.random();
    const sig = signEscrowOpen(VECTOR_CONTRACT, "ord_test123", CLAIM, owner);
    expect(sig).toHaveLength(64);
    expect(owner.verify(Buffer.from(escrowOpenMessage(VECTOR_CONTRACT, "ord_test123", CLAIM)), Buffer.from(sig))).toBe(true);
    expect(Keypair.random().verify(Buffer.from(escrowOpenMessage(VECTOR_CONTRACT, "ord_test123", CLAIM)), Buffer.from(sig))).toBe(false);
  });
});
