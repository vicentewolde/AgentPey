import { didToPublicJWK, hasErrorCode, stellarAddressToDid } from "@agentpass/core";
import type { AgentPassErrorCode, Scope } from "@agentpass/core";
import { sdHash, verifyOpenMandatePair } from "@agentpey/ap2";
import { createMandate, signMandate } from "@agentpey/mandate";
import { Keypair } from "@stellar/stellar-sdk/base";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { makeVenueId } from "../catalog/ids.js";
import { EURC_MOCK, MOCK_VENUE_ID, USDC_TESTNET } from "../catalog/mock.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { signIntent } from "../intent/sign.js";
import { PILOT_SCOPE, TEST_REGISTRY, createStubVerifier, makeTestCredential } from "../testing/credentials.js";
import type { SimulatedStatus } from "../testing/credentials.js";
import { createStubMandateVerifier } from "../testing/mandates.js";
import type { SimulatedMandateStatus } from "../testing/mandates.js";
import { AP2_CROSS_CHECK_ISSUER_PREFIX, exportMandateAsAp2ForCrossCheck } from "./cross-check.js";
import { AP2_EXPORT_MAX_TTL_SECONDS, exportMandateAsAp2, stellarAp2Issuer } from "./export.js";
import type { Ap2Issuer, ExportMandateAsAp2Input } from "./export.js";

const NOW = new Date("2026-10-01T15:00:00.000Z");
const INTENT_EXPIRES = "2026-10-01T15:14:00.000Z";
const MERCHANT = { name: "Bazar de prueba", website: "https://bazar.example" };
const OTHER_VENUE = makeVenueId("otro-bazaar", "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F");

const principal = Keypair.random();
const agent = Keypair.random();
const stranger = Keypair.random();
const PRINCIPAL_DID = stellarAddressToDid(principal.publicKey(), "testnet");
const provider = stellarAp2Issuer(Keypair.random(), "testnet");

type Grant = Parameters<typeof createMandate>[0]["grant"];

interface Setup {
  readonly scope?: Scope;
  readonly grant?: Partial<Grant>;
  readonly mandatePrincipal?: Keypair;
  readonly validUntil?: string;
  readonly credentialStatus?: SimulatedStatus;
  readonly mandateStatus?: SimulatedMandateStatus;
  readonly intent?: Partial<PurchaseIntent>;
  readonly intentSigner?: Keypair;
  /** Applied to the signed intent JWS, e.g. to tamper with it. */
  readonly alterIntent?: (jws: string) => string;
  readonly now?: Date;
  readonly extra?: Partial<ExportMandateAsAp2Input>;
}

async function setup(options: Setup = {}) {
  const credential = await makeTestCredential({ issuer: principal, subject: agent, scope: options.scope ?? PILOT_SCOPE });
  const mandatePrincipal = options.mandatePrincipal ?? principal;
  const mandate = await signMandate(
    createMandate({
      principal: stellarAddressToDid(mandatePrincipal.publicKey(), "testnet"),
      agent: stellarAddressToDid(agent.publicKey(), "testnet"),
      grant: { ...PILOT_SCOPE, ...options.grant },
      registry: TEST_REGISTRY,
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: options.validUntil ?? "2026-12-01T00:00:00.000Z",
    }),
    mandatePrincipal,
  );
  const signer = options.intentSigner ?? agent;
  const intent: PurchaseIntent = {
    type: ["AgentPayIntent", "PurchaseIntent"],
    intentId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
    issuedAt: "2026-10-01T14:59:00.000Z",
    expiresAt: INTENT_EXPIRES,
    agent: stellarAddressToDid(signer.publicKey(), "testnet"),
    principal: PRINCIPAL_DID,
    credential: { hash: credential.hash, registry: TEST_REGISTRY },
    venue: MOCK_VENUE_ID,
    purchase: { productId: "mate-calabaza", quantity: 2, unitAmount: "18.50", totalAmount: "37.00", asset: USDC_TESTNET },
    authorisation: { perTx: "50.00", currency: "USDC" },
    ...options.intent,
  };
  const intentJws = (await signIntent(intent, signer)).jws;
  const verifiers = {
    credentials: createStubVerifier({ status: options.credentialStatus ?? "Active" }),
    mandates: createStubMandateVerifier({ status: options.mandateStatus ?? "Active" }),
  };
  const input: ExportMandateAsAp2Input = {
    credential: credential.jws,
    mandate: mandate.jws,
    intentJws: options.alterIntent?.(intentJws) ?? intentJws,
    merchant: MERCHANT,
    itemTitle: "Mate de calabaza",
    issuer: provider,
    now: options.now ?? NOW,
    ...options.extra,
  };
  return { mandate, verifiers, input };
}

async function exportWith(options: Setup = {}) {
  const { mandate, verifiers, input } = await setup(options);
  return { mandate, exported: await exportMandateAsAp2(verifiers, input) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

async function refusedWith(options: Setup): Promise<unknown> {
  const error = await rejection(exportWith(options));
  return (error as { code?: unknown }).code;
}

function amountMax(constraints: ReadonlyArray<{ type: string; max?: unknown }>): unknown {
  return constraints.find((constraint) => constraint.type === "payment.amount_range")?.max;
}

describe("exportMandateAsAp2 — a purchase both authorities allow", () => {
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
      // 50.00 USDC in cents (E-12): the smallest of the four limits, never the purchase total
      { type: "payment.amount_range", currency: "USDC", max: 5000 },
      { type: "payment.allowed_payees", allowed: [{ ...MERCHANT, id: MOCK_VENUE_ID }] },
      { type: "payment.allowed_payment_instruments", allowed: [{ id: USDC_TESTNET, type: "stellar_x402", description: "USDC on Stellar, paid with x402 (exact)" }] },
      { type: "payment.execution_date", not_after: INTENT_EXPIRES },
    ]);
  });

  it("never outlives the intent, the Mandate, or the requested lifetime", async () => {
    expect((await exportWith()).exported.expiresAt.toISOString()).toBe(INTENT_EXPIRES);
    expect((await exportWith({ validUntil: "2026-10-01T15:10:00.000Z" })).exported.expiresAt.toISOString()).toBe("2026-10-01T15:10:00.000Z");
    expect((await exportWith({ extra: { ttlSeconds: 60 } })).exported.expiresAt.toISOString()).toBe("2026-10-01T15:01:00.000Z");
  });

  it.each([
    ["the Mandate's perDay", { grant: { limits: { perTx: "50.00", perDay: "10.00", currency: "USDC" } } }, 1000],
    ["the credential's perTx", { scope: { ...PILOT_SCOPE, limits: { perTx: "40.00", perDay: "200.00", currency: "USDC" } } }, 4000],
    ["the credential's perDay", { scope: { ...PILOT_SCOPE, limits: { perTx: "50.00", perDay: "45.00", currency: "USDC" } } }, 4500],
    ["a fraction of a cent, rounded down", { grant: { limits: { perTx: "50.00", perDay: "0.0199999", currency: "USDC" } } }, 1],
  ] satisfies Array<[string, Setup, number]>)("caps the amount at the smallest limit — %s", async (_name, options, cents) => {
    const { exported } = await exportWith(options);
    const verified = await verifyOpenMandatePair(exported, { issuerKey: provider.publicJwk, now: NOW });
    expect(amountMax(verified.payment.constraints)).toBe(cents);
  });

  it("binds the cross-check variant to a P-256 agent key, under an iss that is not the Stellar issuer (E-9)", async () => {
    const issuerJwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
    const agentJwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    const p256: Ap2Issuer = {
      did: `${AP2_CROSS_CHECK_ISSUER_PREFIX}test`,
      signer: { alg: "ES256", privateJwk: issuerJwk, kid: "ephemeral" },
      publicJwk: { kty: "EC", crv: "P-256", x: issuerJwk.x ?? "", y: issuerJwk.y ?? "" },
    };
    const agentKey = { kty: "EC", crv: "P-256", x: agentJwk.x ?? "", y: agentJwk.y ?? "" } as const;

    const { verifiers, input } = await setup({ extra: { issuer: p256 } });
    const exported = await exportMandateAsAp2ForCrossCheck(verifiers, input, agentKey);
    expect((await verifyOpenMandatePair(exported, { issuerKey: p256.publicJwk, now: NOW })).payment.cnf.jwk).toEqual(agentKey);

    const stellar = await setup();
    const error = await rejection(exportMandateAsAp2ForCrossCheck(stellar.verifiers, stellar.input, agentKey));
    expect(hasErrorCode(error, "InvalidArguments")).toBe(true);
  });
});

describe("exportMandateAsAp2 — issues nothing either authority does not allow", () => {
  it.each([
    ["a venue the credential does not list", { intent: { venue: OTHER_VENUE } }, "ScopeVenueNotAllowed"],
    ["an asset the credential does not list", { intent: { purchase: { productId: "mate-calabaza", quantity: 1, unitAmount: "18.50", totalAmount: "18.50", asset: EURC_MOCK } } }, "ScopeAssetNotAllowed"],
    ["a total above the credential's perTx", { scope: { ...PILOT_SCOPE, limits: { perTx: "30.00", perDay: "200.00", currency: "USDC" } } }, "ScopeAmountExceeded"],
    ["a venue the Mandate does not list", { grant: { venues: [OTHER_VENUE] } }, "MandateVenueNotAllowed"],
    ["a total above the Mandate's perTx", { grant: { limits: { perTx: "30.00", perDay: "200.00", currency: "USDC" } } }, "MandateAmountExceeded"],
    ["a product outside the Mandate's grant.products", { grant: { products: ["yerba-mate"] } }, "MandateProductNotAllowed"],
    ["a Mandate from another principal", { mandatePrincipal: stranger }, "MandatePrincipalMismatch"],
    ["limits that round to zero cents — perDay 0.00, the spending pause", { grant: { limits: { perTx: "50.00", perDay: "0.00", currency: "USDC" } } }, "Ap2MandateInvalid"],
  ] satisfies Array<[string, Setup, AgentPassErrorCode]>)("refuses %s", async (_name, options, code) => {
    expect(await refusedWith(options)).toBe(code);
  });

  it.each([
    ["signed by an agent the credential does not name", { intentSigner: stranger }],
    ["naming another credential", { intent: { credential: { hash: "b".repeat(64), registry: TEST_REGISTRY } } }],
    ["naming another principal", { intent: { principal: stellarAddressToDid(stranger.publicKey(), "testnet") } }],
  ] satisfies Array<[string, Setup]>)("refuses an intent %s, as InvalidIntent", async (_name, options) => {
    expect(await refusedWith(options)).toBe("InvalidIntent");
  });

  it("refuses an expired intent, and one altered after signing", async () => {
    expect(await refusedWith({ now: new Date("2026-10-01T15:20:00.000Z") })).toBe("IntentExpired");
    const altered = (jws: string): string => {
      const [header, body = "", signature] = jws.split(".");
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { purchase: { quantity: number } };
      payload.purchase.quantity = 1;
      return [header, Buffer.from(JSON.stringify(payload)).toString("base64url"), signature].join(".");
    };
    expect(await refusedWith({ alterIntent: altered })).toBe("InvalidSignature");
  });

  it.each([
    ["a credential the registry reports as revoked — the cut from outside", { credentialStatus: "Revoked" }, "CredentialRevoked"],
    ["a Mandate the registry reports as revoked", { mandateStatus: "Revoked" }, "MandateRevoked"],
    ["a Mandate never anchored", { mandateStatus: "Unknown" }, "MandateUnknown"],
  ] satisfies Array<[string, Setup, AgentPassErrorCode]>)("refuses %s", async (_name, options, code) => {
    expect(await refusedWith(options)).toBe(code);
  });

  it("refuses a lifetime above the one-hour ceiling (E-10), and display text out of bounds", async () => {
    expect(await refusedWith({ extra: { ttlSeconds: AP2_EXPORT_MAX_TTL_SECONDS + 1 } })).toBe("InvalidArguments");
    expect(await refusedWith({ extra: { itemTitle: "x".repeat(201) } })).toBe("InvalidArguments");
    expect(await refusedWith({ extra: { merchant: { name: "", website: "https://bazar.example" } } })).toBe("InvalidArguments");
  });
});
