/**
 * The real thing: Stellar testnet, the OpenZeppelin facilitator, testnet USDC,
 * receipt-registry on Soroban. Runs only with RUN_INTEGRATION=1 and a
 * bootstrapped .env.local. Buys the cheapest product (V-14).
 */
import type { AddressInfo } from "node:net";

import { Keypair } from "@stellar/stellar-sdk";
import { MockStoreAdapter } from "@vitrinee/adapters";
import { ReceiptRegistryClient, verifyReceipt } from "@vitrinee/anchor";
import { createApp, loadConfig } from "@vitrinee/gateway";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buy } from "./buy.js";
import { loadRepoEnv, registryId } from "./env.js";
import { tamperAmount } from "./tamper.js";

loadRepoEnv();
process.env["RECEIPT_REGISTRY_ID"] ??= registryId();

const AGENT_SECRET = process.env["AGENT_SECRET_KEY"];
const ready =
  process.env["RUN_INTEGRATION"] === "1" &&
  AGENT_SECRET !== undefined &&
  process.env["FACILITATOR_API_KEY"] !== undefined &&
  process.env["MERCHANT_STELLAR_ACCOUNT"] !== undefined &&
  process.env["RECEIPT_REGISTRY_ID"] !== undefined;

function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveListen) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolveListen({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

describe.skipIf(!ready)("compra real contra Stellar testnet", () => {
  const config = loadConfig({ ...process.env, ADAPTER: "mock", ORDERS_FILE: "", MOCK_ORDERS_FILE: "" });
  const adapter = new MockStoreAdapter();
  const app = createApp({ config, adapter, log: (message, fields) => console.log(`[gateway] ${message}`, fields ?? "") });
  const registry = new ReceiptRegistryClient({ contractId: config.receiptRegistryId, rpcUrl: config.stellar.rpcUrl, networkPassphrase: config.stellar.networkPassphrase });
  let url = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    ({ url, close } = await listen(app));
  });
  afterAll(() => close());

  it("answers a real 402 from the real facilitator (dry run, needs no USDC)", async () => {
    const result = await buy({ gatewayUrl: url, instruction: "compra el pack de stickers", signerSecret: undefined, maxUsdc: "100", dryRun: true, log: console.log });
    expect(result.order).toBeUndefined();
    expect(result.requirements).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      amount: "10421053",
      payTo: config.merchant.stellarAccount,
      extra: { paymentFlow: "upfront", areFeesSponsored: true },
    });
  });

  it("buys for real: USDC moves, the receipt is anchored on Soroban and verifies; an edited copy does not", async () => {
    const agentAccount = Keypair.fromSecret(AGENT_SECRET!).publicKey();
    const countBefore = await registry.count(config.signing.account);

    const result = await buy({
      gatewayUrl: url,
      instruction: "compra el pack de stickers y envíalo a Ñuñoa",
      signerSecret: AGENT_SECRET,
      maxUsdc: "100",
      log: console.log,
    });
    const order = result.order!;
    expect(order).toMatchObject({ status: "paid", platform: "mock", platformOrderId: "mock-0001", amountUSDC: "1.0421053" });
    expect(order.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(order.anchor?.status).toBe("anchored");

    // Verified by the gateway endpoint the agent called…
    expect(result.verification).toMatchObject({ valid: true, checks: { signature: { ok: true }, anchored: { ok: true }, settlement: { ok: true } } });
    expect(result.verification!.receipt).toMatchObject({ payerAccount: agentAccount, merchantAccount: config.merchant.stellarAccount, settlementTxHash: order.txHash });

    // …and independently, straight from the chain, with no gateway in the loop.
    const direct = await verifyReceipt(order.receiptJws!, { registry, horizonUrl: config.stellar.horizonUrl, settlementAttempts: 5 });
    expect(direct.valid).toBe(true);
    const record = await registry.get(order.receiptHash!);
    expect(record).toMatchObject({ merchant: config.signing.account, amount: 10421053n, orderRef: order.orderId });
    expect(await registry.count(config.signing.account)).toBe(countBefore + 1);

    // The dishonest edit: same signature, lower amount. All three checks go red.
    const edited = tamperAmount(order.receiptJws!);
    const red = await verifyReceipt(edited.jws, { registry, horizonUrl: config.stellar.horizonUrl });
    expect(red).toMatchObject({ valid: false, checks: { signature: { ok: false }, anchored: { ok: false }, settlement: { ok: false } } });

    console.log("timings (ms from start)", result.timings);
  });
});
