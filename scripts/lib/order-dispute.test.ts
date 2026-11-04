import { describe, expect, it } from "vitest";

import { orderDisputeUrl, readOrderDispute } from "./order-dispute.js";

describe("the arbiter reads a dispute from its order (T163)", () => {
  it("finds the dispute next to the order, with or without the scheme", () => {
    expect(orderDisputeUrl("agentcommerce.vitrinee.agentpey.com/orders/ord_1").toString()).toBe("https://agentcommerce.vitrinee.agentpey.com/orders/ord_1/dispute");
    expect(orderDisputeUrl("https://agentcommerce.vitrinee.agentpey.com/ucp/v1/orders/ord_1").toString()).toBe("https://agentcommerce.vitrinee.agentpey.com/orders/ord_1/dispute");
    expect(orderDisputeUrl("http://127.0.0.1:4100/orders/ord_1").toString()).toBe("http://127.0.0.1:4100/orders/ord_1/dispute");
  });

  it("refuses anything that is not an order, or plain http to a remote host", () => {
    for (const bad of ["agentcommerce.vitrinee.agentpey.com/receipts/x", "http://agentcommerce.vitrinee.agentpey.com/orders/ord_1", "not a url at all"]) {
      expect(() => orderDisputeUrl(bad), bad).toThrow(expect.objectContaining({ code: "InvalidArguments" }));
    }
  });

  it("reads what the store keeps, and refuses a store that keeps no dispute", async () => {
    const kept = { order_id: "ord_1", escrow: "CB…", claim_jws: "a.b.c", response: null };
    const ok = (async () => Response.json(kept)) as unknown as typeof fetch;
    expect(await readOrderDispute("agentcommerce.vitrinee.agentpey.com/orders/ord_1", ok)).toEqual(kept);
    const missing = (async () => Response.json({ error: "OrderNotFound" }, { status: 404 })) as unknown as typeof fetch;
    await expect(readOrderDispute("agentcommerce.vitrinee.agentpey.com/orders/ord_1", missing)).rejects.toMatchObject({ code: "ResolveReceiptInvalid" });
  });
});
