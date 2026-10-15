import { readFileSync } from "node:fs";

import { MockStoreAdapter } from "@vitrinee/adapters";
import type { EscrowConfig } from "@vitrinee/anchor";
import {
  MANIFEST_PATH,
  STELLAR_X402_ESCROW_HANDLER_VERSION,
  STELLAR_X402_ESCROW_SCHEMA_URL,
  STELLAR_X402_ESCROW_SPEC_URL,
  STELLAR_X402_HANDLER,
  STELLAR_X402_HANDLER_VERSION,
  UCP_PROFILE_PATH,
  UCP_REST_PREFIX,
  USDC_TESTNET,
  checkReceiptSignature,
  isVitrineeError,
  storefrontManifestSchema,
  ucpBusinessProfileSchema,
} from "@vitrinee/core";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp, type VitrineeApp } from "./app.js";
import { payToOf, verifyStoreEscrow } from "./escrow.js";
import { FAKE_PAYER, fakeFacilitator } from "./test/fake-facilitator.js";
import { ARBITER, ESCROW_ID, MERCHANT, SIGNER, escrowConfig, fakeEscrow, fakePlatformProfiles, fakeRegistry, testConfig } from "./test/fixtures.js";
import { listen } from "./test/listen.js";
import { UCP_SCHEMA_2026_08_25, addSchema, ucpErrors } from "./test/ucp-schemas.js";

const ESCROW_HANDLER_SCHEMA = JSON.parse(
  readFileSync(new URL("../../../apps/web/public/ucp/handlers/stellar-x402/2026-10-15/schema.json", import.meta.url), "utf8"),
) as { $id: string };
addSchema(ESCROW_HANDLER_SCHEMA);

/** The check a store runs, against its escrow as the chain would answer with `overrides`. */
/** What the UCP test reads of a checkout reply. */
const checkoutReply = z.looseObject({
  id: z.string(),
  status: z.string(),
  ucp: z.looseObject({
    payment_handlers: z.record(
      z.string(),
      z.array(z.looseObject({ version: z.string(), config: z.looseObject({ pay_to: z.string(), payment_requirements: z.looseObject({ payTo: z.string() }).optional() }) })),
    ),
  }),
  order: z.looseObject({ id: z.string() }).optional(),
  receipt: z.looseObject({ jws: z.string(), hash: z.string() }).optional(),
});

const onChain = (overrides: Partial<EscrowConfig> = {}) => ({ arbiters: [ARBITER], reader: fakeEscrow({ config: overrides }).reader });
const configErrorWith = (text: string) => (error: unknown) => isVitrineeError(error) && error.code === "ConfigError" && error.message.includes(text);

describe("verifyStoreEscrow (T160): no store charges into a contract that is not its own escrow", () => {
  const configured = testConfig({ ESCROW_CONTRACT_ID: ESCROW_ID });

  it("reads the escrow on chain and returns the config with it, as the profile will publish it", async () => {
    const verified = await verifyStoreEscrow(configured, onChain());
    expect(verified.escrow).toEqual({
      contract: ESCROW_ID,
      payee: MERCHANT,
      arbiter: ARBITER,
      releaseWindowSeconds: 600,
      responseWindowSeconds: 900,
      resolveWindowSeconds: 3600,
    });
    expect(payToOf(verified)).toBe(ESCROW_ID);
  });

  it("leaves a store paid directly untouched, without reading anything", async () => {
    const plain = testConfig();
    const reader = { config: async (): Promise<EscrowConfig> => { throw new Error("must not be read"); } };
    await expect(verifyStoreEscrow(plain, { arbiters: [], reader })).resolves.toBe(plain);
    expect(payToOf(plain)).toBe(MERCHANT);
  });

  it("refuses a contract that runs other code, or is not a wasm contract", async () => {
    await expect(verifyStoreEscrow(configured, onChain({ wasmHash: "d0d1d877ac479aa6367833f467e35ff90be581236c4c2b688dd313ca4cf802c4" }))).rejects.toSatisfy(configErrorWith("purchase-escrow code"));
    await expect(verifyStoreEscrow(configured, onChain({ wasmHash: null }))).rejects.toSatisfy(configErrorWith("purchase-escrow code"));
  });

  it("refuses an escrow whose operator is not the signing account, whose payee is not the payout account, or in another token", async () => {
    await expect(verifyStoreEscrow(configured, onChain({ operator: MERCHANT }))).rejects.toSatisfy(configErrorWith("operator"));
    await expect(verifyStoreEscrow(configured, onChain({ payee: FAKE_PAYER }))).rejects.toSatisfy(configErrorWith("payee"));
    await expect(verifyStoreEscrow(configured, onChain({ token: ESCROW_ID }))).rejects.toSatisfy(configErrorWith("token"));
  });

  it("refuses an escrow whose arbiter buyers would not accept, and any escrow when no arbiter is known", async () => {
    await expect(verifyStoreEscrow(configured, onChain({ arbiter: MERCHANT }))).rejects.toSatisfy(configErrorWith("arbiter"));
    await expect(verifyStoreEscrow(configured, { ...onChain(), arbiters: [] })).rejects.toSatisfy(configErrorWith("arbiter"));
  });

  it("lets an unreachable Soroban RPC fail as it failed, so the platform tries again on the next request", async () => {
    const down = { config: async (): Promise<EscrowConfig> => { throw new Error("rpc: 503"); } };
    await expect(verifyStoreEscrow(configured, { arbiters: [ARBITER], reader: down })).rejects.toThrow("rpc: 503");
  });

  it("is what createApp needs: an escrow id without it opens no store", () => {
    expect(() => createApp({ config: configured, adapter: new MockStoreAdapter(), facilitator: fakeFacilitator(), platformProfiles: null })).toThrow(
      expect.objectContaining({ code: "ConfigError" }),
    );
  });
});

describe("a store with an escrow charges into it, at both doors (T160)", () => {
  const escrow = fakeEscrow();
  const registry = fakeRegistry();
  let app: VitrineeApp;
  let url = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    app = createApp({
      config: escrowConfig(),
      adapter: new MockStoreAdapter(),
      facilitator: fakeFacilitator(),
      anchorer: registry.anchorer,
      registry: registry.registry,
      holder: escrow.holder,
      escrows: escrow.escrows,
      platformProfiles: fakePlatformProfiles(),
      anchorRetryDelaysMs: [1],
    });
    ({ url, close } = await listen(app));
  });
  afterAll(async () => {
    app.anchors.stop();
    await close();
  });

  it("declares the escrow version of the handler: pay_to is the contract and the escrow block says whose it is", async () => {
    const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
    expect(ucpErrors(UCP_SCHEMA_2026_08_25.businessProfile, profile, "2026-08-25")).toEqual([]);
    const [handler] = profile.ucp.payment_handlers[STELLAR_X402_HANDLER] ?? [];
    expect(handler).toMatchObject({ version: STELLAR_X402_ESCROW_HANDLER_VERSION, spec: STELLAR_X402_ESCROW_SPEC_URL, schema: STELLAR_X402_ESCROW_SCHEMA_URL });
    expect(ucpErrors(`${ESCROW_HANDLER_SCHEMA.$id}#/$defs/business_config`, handler?.config)).toEqual([]);
    expect(handler?.config).toEqual({
      x402_version: 2,
      scheme: "exact",
      network: "stellar:testnet",
      asset: { code: "USDC", contract: USDC_TESTNET.contractId, decimals: 7 },
      pay_to: ESCROW_ID,
      facilitator: "https://channels.openzeppelin.com/x402/testnet",
      escrow: { contract: ESCROW_ID, payee: MERCHANT, arbiter: ARBITER, release_window_seconds: 600, response_window_seconds: 900, resolve_window_seconds: 3600 },
    });
    // The 2026-04-08 leaf speaks the same handler.
    const leaf = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}/2026-04-08`)).json());
    expect(leaf.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0]).toMatchObject({ version: STELLAR_X402_ESCROW_HANDLER_VERSION, config: { pay_to: ESCROW_ID } });
  });

  it("names the escrow in the manifest, next to the payout account it releases to", async () => {
    const manifest = storefrontManifestSchema.parse(await (await fetch(`${url}${MANIFEST_PATH}`)).json());
    expect(manifest.merchant.stellarAccount).toBe(MERCHANT);
    expect(manifest.settlement.escrow).toEqual({ contract: ESCROW_ID });
  });

  it("asks the x402 door's buyer to pay the escrow", async () => {
    const challenge = await fetch(`${url}/checkout/gorro-andes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(challenge.status).toBe(402);
    const required = decodePaymentRequiredHeader(challenge.headers.get("payment-required") ?? "");
    expect(required.accepts.map((accept) => accept.payTo)).toEqual([ESCROW_ID]);
    expect(((await challenge.json()) as { quote: { payTo: string } }).quote.payTo).toBe(ESCROW_ID);
  });

  it("puts the escrow in the UCP checkout's requirement and handler, and holds what it charged", async () => {
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${url}${UCP_REST_PREFIX}${path}`, {
        method,
        headers: { "content-type": "application/json", "UCP-Agent": 'profile="https://agentpey.com/ucp/platform/agentpey.json"' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return checkoutReply.parse(await res.json());
    };
    const opened = await call("POST", "/checkout-sessions", {
      line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }],
      fulfillment: { methods: [{ type: "shipping", destinations: [{ street_address: "Av. Providencia 1234", address_locality: "Santiago", address_country: "CL" }] }] },
    });
    const handler = opened.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0];
    expect(handler?.version).toBe(STELLAR_X402_ESCROW_HANDLER_VERSION);
    expect(handler?.config.pay_to).toBe(ESCROW_ID);
    const requirements = handler?.config.payment_requirements;
    expect(requirements?.payTo).toBe(ESCROW_ID);
    expect(ucpErrors(`${ESCROW_HANDLER_SCHEMA.$id}#/$defs/payment_requirements`, requirements)).toEqual([]);

    const done = await call("POST", `/checkout-sessions/${opened.id}/complete`, {
      payment: {
        instruments: [
          {
            id: "instr_1",
            handler_id: "stellar_x402",
            type: "stellar_x402",
            selected: true,
            credential: { type: "x402_payment_payload", x402_version: 2, accepted: requirements, payload: { transaction: Buffer.from("fake-tx").toString("base64") } },
          },
        ],
      },
    });
    expect(done.status).toBe("completed");
    await app.anchors.idle();
    const claims = checkReceiptSignature(done.receipt?.jws ?? "").claims;
    // The receipt still names the payout account: get_order's binding and the dispute's merchant do not move (T160).
    expect(claims).toMatchObject({ merchantAccount: MERCHANT, escrow: { contract: ESCROW_ID }, merchantDid: `did:stellar:testnet:${SIGNER.publicKey()}` });
    expect(escrow.calls).toHaveLength(1);
    expect(escrow.calls[0]).toMatchObject({ orderRef: done.order?.id, payer: FAKE_PAYER, receiptHash: done.receipt?.hash });
  });
});

describe("a store without an escrow publishes exactly what it did before T160", () => {
  it("declares 2026-09-30 with its payout account as pay_to, and no escrow anywhere", async () => {
    const app = createApp({ config: testConfig(), adapter: new MockStoreAdapter(), facilitator: fakeFacilitator(), platformProfiles: fakePlatformProfiles() });
    const { url, close } = await listen(app);
    try {
      const profile = ucpBusinessProfileSchema.parse(await (await fetch(`${url}${UCP_PROFILE_PATH}`)).json());
      const [handler] = profile.ucp.payment_handlers[STELLAR_X402_HANDLER] ?? [];
      expect(handler).toMatchObject({ version: STELLAR_X402_HANDLER_VERSION, spec: "https://agentpey.com/ucp/handlers/stellar-x402/spec", schema: "https://agentpey.com/ucp/handlers/stellar-x402/schema.json" });
      expect(handler?.config).toEqual({
        x402_version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        asset: { code: "USDC", contract: USDC_TESTNET.contractId, decimals: 7 },
        pay_to: MERCHANT,
        facilitator: "https://channels.openzeppelin.com/x402/testnet",
      });
      const manifest = storefrontManifestSchema.parse(await (await fetch(`${url}${MANIFEST_PATH}`)).json());
      expect(manifest.settlement).not.toHaveProperty("escrow");
      const challenge = await fetch(`${url}/checkout/gorro-andes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(decodePaymentRequiredHeader(challenge.headers.get("payment-required") ?? "").accepts[0]?.payTo).toBe(MERCHANT);
    } finally {
      app.anchors.stop();
      await close();
    }
  });
});
