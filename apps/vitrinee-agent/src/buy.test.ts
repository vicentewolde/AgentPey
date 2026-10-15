/**
 * The test buyer pays only the merchant's own account, or the escrow its manifest names once that escrow checks out
 * on chain (T160). A dry run stops before signing, after the check, so it runs with no network and no key.
 */
import { MockStoreAdapter } from "@vitrinee/adapters";
import type { EscrowConfig } from "@vitrinee/anchor";
import { createApp } from "@vitrinee/gateway";
import { describe, expect, it } from "vitest";

import { fakeFacilitator } from "../../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { ESCROW_ID, MERCHANT, escrowConfig, fakeEscrow, testConfig } from "../../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../../packages/vitrinee-gateway/src/test/listen.js";
import { buy } from "./buy.js";

async function dryRun(config = escrowConfig(), escrowRead?: (contractId: string) => Promise<EscrowConfig>) {
  const app = createApp({ config, adapter: new MockStoreAdapter(), facilitator: fakeFacilitator(), platformProfiles: null });
  const { url, close } = await listen(app);
  try {
    return await buy({
      gatewayUrl: url,
      instruction: "compra un pack de stickers",
      signerSecret: undefined,
      maxUsdc: "5",
      dryRun: true,
      log: () => {},
      ...(escrowRead === undefined ? {} : { escrowConfig: escrowRead }),
    });
  } finally {
    app.anchors.stop();
    await close();
  }
}

describe("vitrinee:buy and a store's escrow (T160)", () => {
  const onChain = (overrides: Partial<EscrowConfig> = {}) => async () => ({ ...(await fakeEscrow().reader.config()), ...overrides });

  it("pays a store's escrow once it checks out on chain", async () => {
    const result = await dryRun(escrowConfig(), onChain());
    expect(result.requirements.payTo).toBe(ESCROW_ID);
  });

  it("refuses an escrow with other code, another payee or another operator, before signing", async () => {
    for (const [what, overrides] of [
      ["código", { wasmHash: "d0d1d877ac479aa6367833f467e35ff90be581236c4c2b688dd313ca4cf802c4" }],
      ["cuenta del comercio", { payee: ESCROW_ID }],
      ["operador", { operator: MERCHANT }],
    ] as const) {
      await expect(dryRun(escrowConfig(), onChain(overrides)), what).rejects.toMatchObject({ code: "PaymentError", message: expect.stringContaining(what) });
    }
  });

  it("pays a store without an escrow at its own account, reading nothing on chain", async () => {
    const result = await dryRun(testConfig(), async () => {
      throw new Error("must not be read");
    });
    expect(result.requirements.payTo).toBe(MERCHANT);
  });
});
