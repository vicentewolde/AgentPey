import { didToPublicJWK, hasErrorCode, stellarAddressToDid } from "@agentpass/core";
import type { AgentPassErrorCode } from "@agentpass/core";
import { sdHash, verifyOpenMandatePair } from "@agentpey/ap2";
import { Keypair } from "@stellar/stellar-sdk/base";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { makeVenueId } from "../catalog/ids.js";
import { MOCK_VENUE_ID, USDC_TESTNET } from "../catalog/mock.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { signIntent } from "../intent/sign.js";
import { TEST_REGISTRY } from "../testing/credentials.js";
import { createStubMandateVerifier, makeTestMandate } from "../testing/mandates.js";
import type { SimulatedMandateStatus } from "../testing/mandates.js";
import { AP2_EXPORT_MAX_TTL_SECONDS, exportMandateAsAp2, stellarAp2Issuer } from "./export.js";
import type { Ap2Issuer, ExportMandateAsAp2Input } from "./export.js";

const NOW = new Date("2026-10-01T15:00:00.000Z");
const MERCHANT = { name: "Bazar de prueba", website: "https://bazar.example" };

const principal = Keypair.random();
const agent = Keypair.random();
const provider = stellarAp2Issuer(Keypair.random(), "testnet");

async function signedIntent(overrides: Partial<PurchaseIntent> = {}, signer: Keypair = agent): Promise<string> {
  const intent: PurchaseIntent = {
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
    issuedAt: "2026-10-01T14:59:00.000Z",
    expiresAt: "2026-10-01T15:14:00.000Z",
    agent: stellarAddressToDid(signer.publicKey(), "testnet"),
    principal: stellarAddressToDid(principal.publicKey(), "testnet"),
    credential: { hash: "a".repeat(64), registry: TEST_REGISTRY },
    venue: MOCK_VENUE_ID,
    purchase: { productId: "mate-calabaza", quantity: 2, unitAmount: "18.50", totalAmount: "37.00", asset: USDC_TESTNET },
    authorisation: { perTx: "50.00", currency: "USDC" },
    ...overrides,
  };
  return (await signIntent(intent, signer)).jws;
}

async function exportWith(
  options: { status?: SimulatedMandateStatus; validUntil?: string; intent?: string; issuer?: Ap2Issuer; extra?: Partial<ExportMandateAsAp2Input> } = {},
) {
  const mandate = await makeTestMandate({ principal, agent, validFrom: "2026-09-01T00:00:00.000Z", validUntil: options.validUntil ?? "2026-12-01T00:00:00.000Z" });
  const exported = await exportMandateAsAp2(createStubMandateVerifier({ status: options.status ?? "Active" }), {
    mandate: mandate.jws,
    intentJws: options.intent ?? (await signedIntent()),
    merchant: MERCHANT,
    itemTitle: "Mate de calabaza",
    issuer: options.issuer ?? provider,
    now: NOW,
    ...options.extra,
  });
  return { mandate, exported };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("exportMandateAsAp2 — a purchase the Mandate allows", () => {
  it("exports a pair any holder of the provider's key can verify, restating the Mandate for this purchase", async () => {
    const { mandate, exported } = await exportWith();

    const verified = await verifyOpenMandatePair(exported, { issuerKey: provider.publicJwk, now: NOW });

    expect(verified.issuer).toBe(provider.did);
    expect(verified.source).toEqual({ mandate_id: mandate.mandate.mandateId, hash: mandate.hash, registry: TEST_REGISTRY });
    expect(verified.checkout.cnf.jwk).toEqual(didToPublicJWK(stellarAddressToDid(agent.publicKey(), "testnet")));
    expect(verified.checkout.constraints).toEqual([
      { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [{ id: "mate-calabaza", title: "Mate de calabaza" }], quantity: 2 }] },
      { type: "checkout.allowed_merchants", allowed: [{ ...MERCHANT, id: MOCK_VENUE_ID }] },
    ]);
    expect(verified.payment.constraints).toEqual([
      { type: "payment.reference", conditional_transaction_id: sdHash(exported.checkout) },
      // the Mandate's perTx (50.00), in 7-decimal units — not the purchase total, and never perDay (E-10)
      { type: "payment.amount_range", currency: "USDC", max: 500_000_000 },
      { type: "payment.allowed_payees", allowed: [{ ...MERCHANT, id: MOCK_VENUE_ID }] },
      { type: "payment.allowed_payment_instruments", allowed: [{ id: USDC_TESTNET, type: "stellar_x402", description: "USDC on Stellar, paid with x402 (exact)" }] },
      { type: "payment.execution_date", not_after: "2026-10-01T16:00:00.000Z" },
    ]);
    expect(exported.expiresAt.toISOString()).toBe("2026-10-01T16:00:00.000Z");
  });

  it("never outlives the Mandate: exp is the Mandate's validUntil when that comes first", async () => {
    const { exported } = await exportWith({ validUntil: "2026-10-01T15:20:00.000Z" });
    expect(exported.expiresAt.toISOString()).toBe("2026-10-01T15:20:00.000Z");
    const verified = await verifyOpenMandatePair(exported, { issuerKey: provider.publicJwk, now: NOW });
    expect(verified.payment.exp).toBe(Date.parse("2026-10-01T15:20:00.000Z") / 1000);
  });

  it("binds to a P-256 agent key and signs ES256 when the cross-check asks for it (E-9)", async () => {
    const issuerPair = await generateKeyPair("ES256", { extractable: true });
    const issuerJwk = await exportJWK(issuerPair.privateKey);
    const agentJwk = await exportJWK((await generateKeyPair("ES256", { extractable: true })).publicKey);
    const issuer: Ap2Issuer = {
      did: "https://agentpey.com",
      signer: { alg: "ES256", privateJwk: issuerJwk, kid: "ephemeral" },
      publicJwk: { kty: "EC", crv: "P-256", x: issuerJwk.x ?? "", y: issuerJwk.y ?? "" },
    };
    const agentKey = { kty: "EC", crv: "P-256", x: agentJwk.x ?? "", y: agentJwk.y ?? "" } as const;

    const { exported } = await exportWith({ issuer, extra: { agentKey } });

    const verified = await verifyOpenMandatePair(exported, { issuerKey: issuer.publicJwk, now: NOW });
    expect(verified.payment.cnf.jwk).toEqual(agentKey);
  });
});

describe("exportMandateAsAp2 — issues nothing the Mandate does not allow", () => {
  it.each([
    ["a venue the Mandate does not list", { venue: makeVenueId("otro-bazaar", "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F") }, "MandateVenueNotAllowed"],
    [
      "a total above the Mandate's perTx",
      { purchase: { productId: "mate-calabaza", quantity: 3, unitAmount: "18.50", totalAmount: "55.50", asset: USDC_TESTNET } },
      "MandateAmountExceeded",
    ],
  ] satisfies Array<[string, Partial<PurchaseIntent>, AgentPassErrorCode]>)("refuses %s, with checkMandate's own code", async (_name, overrides, code) => {
    const error = await rejection(exportWith({ intent: await signedIntent(overrides) }));
    expect(hasErrorCode(error, code)).toBe(true);
  });

  it("refuses an intent signed by an agent the Mandate does not empower", async () => {
    const error = await rejection(exportWith({ intent: await signedIntent({}, Keypair.random()) }));
    expect(hasErrorCode(error, "MandateAgentMismatch")).toBe(true);
  });

  it.each([
    ["Revoked", "MandateRevoked"],
    ["Unknown", "MandateUnknown"],
  ] as const)("refuses a Mandate the registry reports as %s", async (status, code) => {
    const error = await rejection(exportWith({ status }));
    expect(hasErrorCode(error, code)).toBe(true);
  });

  it("refuses a lifetime above the one-hour ceiling (E-10)", async () => {
    const error = await rejection(exportWith({ extra: { ttlSeconds: AP2_EXPORT_MAX_TTL_SECONDS + 1 } }));
    expect(hasErrorCode(error, "InvalidArguments")).toBe(true);
  });
});
