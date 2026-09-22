/**
 * The real thing: Stellar testnet, the OpenZeppelin facilitator, testnet USDC.
 * Runs only with RUN_INTEGRATION=1 and a bootstrapped .env.local. Buys the
 * cheapest product so one faucet drip covers many runs.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import { MockStoreAdapter } from "@vitrinee/adapters";
import { createApp, loadConfig } from "@vitrinee/gateway";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buy } from "./buy.js";

function loadRepoEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadRepoEnv();

const AGENT_SECRET = process.env["AGENT_SECRET_KEY"];
const ready =
  process.env["RUN_INTEGRATION"] === "1" &&
  AGENT_SECRET !== undefined &&
  process.env["FACILITATOR_API_KEY"] !== undefined &&
  process.env["MERCHANT_STELLAR_ACCOUNT"] !== undefined;

function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveListen) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolveListen({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function horizonTransaction(hash: string): Promise<{ successful: boolean } | undefined> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const res = await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`);
    if (res.status === 200) return (await res.json()) as { successful: boolean };
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return undefined;
}

describe.skipIf(!ready)("compra real contra Stellar testnet", () => {
  const config = loadConfig({ ...process.env, ADAPTER: "mock" });
  const adapter = new MockStoreAdapter();
  const app = createApp({ config, adapter, log: (message, fields) => console.log(`[gateway] ${message}`, fields ?? "") });
  let url = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    ({ url, close } = await listen(app));
  });
  afterAll(() => close());

  it("answers a real 402 from the real facilitator (dry run, needs no USDC)", async () => {
    const result = await buy({ gatewayUrl: url, instruction: "compra el café de grano", signerSecret: undefined, maxUsdc: "100", dryRun: true, log: console.log });
    expect(result.order).toBeUndefined();
    expect(result.requirements).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      amount: "94631579",
      payTo: config.merchant.stellarAccount,
      extra: { paymentFlow: "upfront", areFeesSponsored: true },
    });
  });

  it("buys one product for real: USDC moves, the order exists, the tx is on Horizon", async () => {
    const agentAccount = Keypair.fromSecret(AGENT_SECRET!).publicKey();
    const result = await buy({
      gatewayUrl: url,
      instruction: "cómprame un café de grano y envíalo a Ñuñoa",
      signerSecret: AGENT_SECRET,
      maxUsdc: "100",
      log: console.log,
    });
    const order = result.order;
    expect(order).toBeDefined();
    expect(order!.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(order!.status).toBe("paid");
    expect(order!.platform).toBe("mock");
    expect(order!.platformOrderId).toBe("mock-0001");
    expect(order!.amountUSDC).toBe("9.4631579");

    const onChain = await horizonTransaction(order!.txHash);
    expect(onChain?.successful).toBe(true);

    const recorded = (await (await fetch(`${url}/orders/${order!.orderId}`)).json()) as { settlement: { payer: string; payTo: string } };
    expect(recorded.settlement.payer).toBe(agentAccount);
    expect(recorded.settlement.payTo).toBe(config.merchant.stellarAccount);
    expect((await adapter.getProduct("cafe-nunoa-250"))!.stock).toBe(29);
    expect(result.elapsedMs).toBeLessThan(60_000);
  });
});
