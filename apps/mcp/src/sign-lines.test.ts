import { AgentPassError } from "@agentpass/core";
import { describe, expect, it, vi } from "vitest";

import { signLines, type LineSigner } from "./sign-lines.js";

function agent(overrides: Partial<LineSigner> = {}) {
  const invoke = vi.fn(async () => ({ jws: "single" }));
  const signCart = vi.fn(async () => ({ jws: "cart" }));
  const signer = {
    tools: { invoke } as unknown as LineSigner["tools"],
    signCart: signCart as unknown as LineSigner["signCart"],
    credential: { usable: true } as unknown as LineSigner["credential"],
    mandate: { usable: true } as unknown as LineSigner["mandate"],
    ...overrides,
  };
  return { signer, invoke, signCart };
}

describe("signLines (T150)", () => {
  it("signs one line with the model's own create_purchase_intent", async () => {
    const { signer, invoke, signCart } = agent();
    await expect(signLines(signer, [{ productId: "gorro-andes", quantity: 2 }])).resolves.toEqual({ jws: "single" });
    expect(invoke).toHaveBeenCalledWith("create_purchase_intent", { product_id: "gorro-andes", quantity: 2 });
    expect(signCart).not.toHaveBeenCalled();
  });

  it("signs two or more lines with the agent's cart signer", async () => {
    const { signer, invoke, signCart } = agent();
    const lines = [
      { productId: "gorro-andes", quantity: 1 },
      { productId: "stickers-cordillera", quantity: 2 },
    ];
    await expect(signLines(signer, lines)).resolves.toEqual({ jws: "cart" });
    expect(signCart).toHaveBeenCalledWith(lines);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says why a cart cannot be signed: the credential's or the Mandate's own problem", async () => {
    const revoked = new AgentPassError("CredentialRevoked", "revoked", { details: {} });
    const { signer } = agent({ signCart: undefined, credential: { usable: false, problem: revoked } as unknown as LineSigner["credential"] });
    await expect(signLines(signer, [{ productId: "a", quantity: 1 }, { productId: "b", quantity: 1 }])).rejects.toBe(revoked);

    const mandateRevoked = new AgentPassError("MandateRevoked", "revoked", { details: {} });
    const second = agent({ signCart: undefined, mandate: { usable: false, problem: mandateRevoked } as unknown as LineSigner["mandate"] });
    await expect(signLines(second.signer, [{ productId: "a", quantity: 1 }, { productId: "b", quantity: 1 }])).rejects.toBe(mandateRevoked);
  });

  it("refuses no lines", async () => {
    await expect(signLines(agent().signer, [])).rejects.toMatchObject({ code: "InvalidArguments" });
  });
});
