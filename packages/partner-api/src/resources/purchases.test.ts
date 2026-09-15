import { describe, expect, it } from "vitest";

import {
  createPurchaseRequestSchema,
  purchaseResourceSchema,
  toPurchaseResource,
  venueIdSchema,
} from "./purchases.js";

const TENANT = "ptn_01JB0000000000000000000000:01JB0000000000000000000001";
const AGENT = "agt_01JB0000000000000000000002";
const PURCHASE = "pur_01JB0000000000000000000003";
const MANDATE = "mdt_01JB0000000000000000000004";
const VENUE = "signaldesk:CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F";

function request(overrides: Record<string, unknown> = {}) {
  return { tenant_id: TENANT, venue: VENUE, product_id: "signaldesk:market-brief-xlm-usdc", quantity: 1, ...overrides };
}

describe("venueIdSchema", () => {
  it("accepts a slug paired with a contract id", () => {
    expect(venueIdSchema.safeParse(VENUE).success).toBe(true);
  });

  it("refuses a bare slug, which names no venue anyone could be paid at", () => {
    expect(venueIdSchema.safeParse("signaldesk").success).toBe(false);
  });

  /**
   * T79 widened a venue's identity: an HTTP merchant is not a Soroban contract
   * and never will be, so the account it is paid at is its identity. This copy
   * of the shape kept refusing it, which would have made `POST /v1/purchases`
   * answer `400` for the pilot's own merchant (`C-97`).
   */
  it("accepts a slug paired with a classic account, since T79", () => {
    expect(venueIdSchema.safeParse("signaldesk:GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF").success).toBe(true);
  });

  it("still refuses an address that is neither form", () => {
    expect(venueIdSchema.safeParse("signaldesk:SB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF").success).toBe(false);
    expect(venueIdSchema.safeParse("signaldesk:not-an-address").success).toBe(false);
  });

  it("refuses an uppercase or underscored slug, so one venue has one spelling", () => {
    expect(venueIdSchema.safeParse(`SignalDesk:${VENUE.split(":")[1]}`).success).toBe(false);
    expect(venueIdSchema.safeParse(`signal_desk:${VENUE.split(":")[1]}`).success).toBe(false);
  });
});

describe("createPurchaseRequestSchema", () => {
  it("accepts the minimal request", () => {
    expect(createPurchaseRequestSchema.safeParse(request()).success).toBe(true);
  });

  it("accepts an optional partner-side ceiling", () => {
    expect(createPurchaseRequestSchema.safeParse(request({ max_total: "1.5000000" })).success).toBe(true);
  });

  it("refuses a ceiling with more precision than Stellar carries", () => {
    expect(createPurchaseRequestSchema.safeParse(request({ max_total: "1.12345678" })).success).toBe(false);
  });

  it("refuses a quantity of zero or a fraction", () => {
    expect(createPurchaseRequestSchema.safeParse(request({ quantity: 0 })).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse(request({ quantity: 1.5 })).success).toBe(false);
  });

  it("refuses an unknown field rather than ignoring it", () => {
    // An integrator who believes they constrained a purchase with a field we
    // silently drop has to find out at the boundary, not after a payment.
    expect(createPurchaseRequestSchema.safeParse(request({ per_tx: "0.01" })).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse(request({ pay_to: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K" })).success).toBe(false);
  });

  it("refuses a tenant id that is not one", () => {
    expect(createPurchaseRequestSchema.safeParse(request({ tenant_id: "usuario-42" })).success).toBe(false);
  });

  /** T90: which of the tenant's Mandates to go through. Optional, and leaving it out is the only way to say "you choose". */
  it("accepts a Mandate id, and still accepts a request without one", () => {
    expect(createPurchaseRequestSchema.safeParse(request({ mandate_id: MANDATE })).success).toBe(true);
    expect(createPurchaseRequestSchema.parse(request())).not.toHaveProperty("mandate_id");
  });

  it("refuses a mandate_id that is null, empty, or another kind of id", () => {
    expect(createPurchaseRequestSchema.safeParse(request({ mandate_id: null })).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse(request({ mandate_id: "" })).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse(request({ mandate_id: AGENT })).success).toBe(false);
  });
});

describe("purchaseResourceSchema", () => {
  const settled = {
    id: PURCHASE,
    tenant_id: TENANT,
    agent_id: AGENT,
    mandate_id: MANDATE,
    outcome: "settled" as const,
    code: null,
    reason: null,
    venue: VENUE,
    product_id: "signaldesk:market-brief-xlm-usdc",
    quantity: 1,
    intent_id: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
    total: "0.5000000",
    asset: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    pay_to: "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K",
    transaction_hash: "b".repeat(64),
    explorer_url: "https://stellar.expert/explorer/testnet/tx/" + "b".repeat(64),
    delivery: { delivery_id: "dlv_1", artifact_url: "https://signaldesk.example/d/1", receipt_hash: "c".repeat(64) },
    created_at: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a settled purchase", () => {
    expect(purchaseResourceSchema.safeParse(settled).success).toBe(true);
  });

  it("accepts a refusal, where everything about the payment is absent", () => {
    const refused = {
      ...settled,
      outcome: "refused" as const,
      code: "MandateProductNotAllowed",
      reason: "tu Mandato no permite este producto",
      total: null,
      asset: null,
      pay_to: null,
      transaction_hash: null,
      explorer_url: null,
      delivery: null,
    };
    expect(purchaseResourceSchema.safeParse(refused).success).toBe(true);
  });

  it("refuses a resource that omits a field rather than setting it null", () => {
    const { delivery: _delivery, ...withoutDelivery } = settled;
    expect(purchaseResourceSchema.safeParse(withoutDelivery).success).toBe(false);
  });

  it("accepts a purchase recorded before T90, which went through no named Mandate", () => {
    expect(purchaseResourceSchema.safeParse({ ...settled, mandate_id: null }).success).toBe(true);
  });

  it("refuses an outcome outside the two this route can produce", () => {
    expect(purchaseResourceSchema.safeParse({ ...settled, outcome: "pending" }).success).toBe(false);
  });
});

/**
 * T84. The purchase route stores `{ resource_url, resource }`, where
 * `resource` is the merchant's own body. This used to read the delivery id and
 * receipt hash off the top level, where nothing wrote them, and linked the
 * artifact to the paid x402 route, which answers `402` — so every SignalDesk
 * delivery in the deployed pilot showed no id, no receipt, and a link that
 * asked for payment again.
 */
describe("toPurchaseResource delivery", () => {
  const PAID_ROUTE = "https://agentpey-signaldesk.onrender.com/api/x402/market-brief?pair=XLM%2FUSDC";

  function stored(resource: unknown, resourceUrl: unknown = PAID_ROUTE) {
    return {
      id: PURCHASE,
      tenantId: TENANT,
      agentId: AGENT,
      mandateId: MANDATE,
      outcome: "settled" as const,
      code: null,
      reason: null,
      venue: VENUE,
      productId: "signaldesk:market-brief-xlm-usdc",
      quantity: 1,
      intentId: "8b0851b3-94e9-45b0-ba36-d6e9e32541d2",
      total: "0.2500000",
      asset: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: "GB4D4PLLFEIKZK6MDW42MZRQ5XMPC6QRJN4FFRODO6D3PRB3MDGGYOOF",
      transactionHash: "b".repeat(64),
      delivery: { resource_url: resourceUrl, resource },
      createdAt: new Date("2026-09-13T19:11:27.624Z"),
    };
  }

  /** The body SignalDesk actually released for tx 8894085a… in the pilot. */
  const SIGNALDESK_BODY = {
    ok: true,
    delivery_id: "01M2E2WZBRT9TVVWNRFX3D6Y2A",
    product_id: "signaldesk:market-brief-xlm-usdc",
    artifact_url: "https://agentpey-signaldesk.onrender.com/deliveries/01M2E2WZBRT9TVVWNRFX3D6Y2A",
    artifact_hash: "4d896029c49d87c1ad4c202790e87a4945bbad7341a13cf7e8d433ee735bdb27",
    receipt_hash: "547622d88434fc47310e32638bb8314f4de366da390779528ada48568ea20b5d",
    delivered_at: "2026-09-13T19:11:27.608Z",
  };

  it("reads the delivery id, receipt hash and artifact link out of the merchant's body", () => {
    const { delivery } = toPurchaseResource(stored(SIGNALDESK_BODY));

    expect(delivery?.delivery_id).toBe("01M2E2WZBRT9TVVWNRFX3D6Y2A");
    expect(delivery?.receipt_hash).toBe("547622d88434fc47310e32638bb8314f4de366da390779528ada48568ea20b5d");
    expect(delivery?.artifact_url).toBe("https://agentpey-signaldesk.onrender.com/deliveries/01M2E2WZBRT9TVVWNRFX3D6Y2A");
  });

  it("never links the artifact to the paid route, which would ask for payment again", () => {
    const { delivery } = toPurchaseResource(stored({ ok: true }));

    expect(delivery?.artifact_url).toBeNull();
  });

  /** C-79: a merchant that returns only the resource body is not broken. */
  it("keeps every field null for a merchant that sends none of them, without throwing", () => {
    const { delivery } = toPurchaseResource(stored("plain resource body"));

    expect(delivery).toMatchObject({ delivery_id: null, artifact_url: null, receipt_hash: null });
  });

  it("drops a malformed field instead of making the whole read throw", () => {
    const { delivery } = toPurchaseResource(stored({ ...SIGNALDESK_BODY, receipt_hash: "not-a-hash", delivery_id: 42 }));

    expect(delivery?.receipt_hash).toBeNull();
    expect(delivery?.delivery_id).toBeNull();
    expect(delivery?.artifact_url).toBe(SIGNALDESK_BODY.artifact_url);
  });

  it("refuses an artifact link to another origin, to a script, or with embedded credentials", () => {
    for (const artifact_url of [
      "https://attacker.example/deliveries/01M2E2WZBRT9TVVWNRFX3D6Y2A",
      "https://agentpey-signaldesk.onrender.com.attacker.example/d",
      "javascript:alert(1)",
      "https://agentpey-signaldesk.onrender.com@attacker.example/d",
      "https://user:pass@agentpey-signaldesk.onrender.com/d",
    ]) {
      const { delivery } = toPurchaseResource(stored({ ...SIGNALDESK_BODY, artifact_url }));
      expect(delivery?.artifact_url, artifact_url).toBeNull();
    }
  });
});
