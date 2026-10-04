import { randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  checkOpenCheckoutConstraints,
  checkoutJwtFrom,
  closeCheckoutMandate,
  signMerchantAuthorization,
  verifyCheckoutJwt,
  verifyCheckoutMandateChain,
  verifyMerchantAuthorization,
} from "./checkout.js";
import { issueOpenMandatePair } from "./issue.js";
import type { Ap2PublicJwk, Ap2Signer } from "./sd-jwt.js";

type Key = { signer: Ap2Signer; public: Ap2PublicJwk & { kid: string } };

async function p256(kid: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const pub = (await exportJWK(publicKey)) as { x: string; y: string };
  return { signer: { alg: "ES256", privateJwk: await exportJWK(privateKey), kid }, public: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y, kid } };
}

const ORIGIN = "https://agentcommerce.vitrinee.agentpey.com";
const NOW = new Date("2026-10-04T12:00:00Z");

describe("AP2 inside a UCP checkout (T134, R-15)", () => {
  let platform: Key;
  let agent: Key;
  let business: Key;
  let stranger: Key;
  let open: string;
  let checkout: Record<string, unknown>;

  const openMandate = async (overrides: { item?: string; quantity?: number; website?: string; expiresAt?: Date } = {}) =>
    (
      await issueOpenMandatePair(
        {
          issuer: "https://agentpey.com",
          source: { mandate_id: randomUUID(), hash: "a".repeat(64), registry: "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F" },
          agentKey: agent.public,
          merchant: { id: overrides.website ?? ORIGIN, name: "agentcommerce", website: overrides.website ?? ORIGIN },
          item: { id: overrides.item ?? "67624104591666", title: "Imán de cobre Atacama" },
          quantity: overrides.quantity ?? 1,
          maxAmount: 300n,
          currency: "USD",
          paymentInstrument: { id: "stellar_x402", type: "stellar_x402" },
          issuedAt: new Date(NOW.getTime() - 60_000),
          expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 15 * 60_000),
        },
        platform.signer,
      )
    ).checkout;

  beforeAll(async () => {
    [platform, agent, business, stranger] = await Promise.all([p256("platform#ap2"), p256("agent#ap2"), p256("business#ap2"), p256("stranger#ap2")]);
    open = await openMandate();
    const unsigned = {
      ucp: { version: "2026-08-25", status: "success" },
      id: "cs_abc123",
      merchant: { id: ORIGIN, name: "agentcommerce", website: ORIGIN },
      status: "ready_for_complete",
      currency: "CLP",
      line_items: [{ id: "li_1", item: { id: "67624104591666", title: "Imán de cobre Atacama", price: 1490 }, quantity: 1 }],
      totals: [{ type: "total", amount: 1490 }],
      links: [],
    };
    checkout = { ...unsigned, ap2: { merchant_authorization: await signMerchantAuthorization(unsigned, business.signer) } };
  });

  const close = (overrides: Partial<{ open: string; holder: Ap2Signer; checkoutJwt: string; aud: string; nonce: string; issuedAt: Date }> = {}) =>
    closeCheckoutMandate({ open, holder: agent.signer, checkoutJwt: checkoutJwtFrom(checkout), aud: ORIGIN, nonce: "cs_abc123", issuedAt: NOW, ...overrides });
  const verify = (chain: string, overrides: Partial<{ aud: string; nonce: string; now: Date; platformKey: (kid: string | undefined) => (Ap2PublicJwk & { kid?: string }) | undefined }> = {}) =>
    verifyCheckoutMandateChain(chain, { platformKey: (kid) => (kid === platform.public.kid ? platform.public : undefined), aud: ORIGIN, nonce: "cs_abc123", now: NOW, ...overrides });

  it("signs the checkout detached (header..signature), and an agent checks it against the business key", async () => {
    expect((checkout.ap2 as { merchant_authorization: string }).merchant_authorization).toMatch(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
    await expect(verifyMerchantAuthorization(checkout, business.public)).resolves.toBeUndefined();
    await expect(verifyMerchantAuthorization({ ...checkout, totals: [{ type: "total", amount: 1 }] }, business.public)).rejects.toMatchObject({ code: "Ap2MerchantAuthorizationInvalid" });
    await expect(verifyMerchantAuthorization(checkout, stranger.public)).rejects.toMatchObject({ code: "Ap2MerchantAuthorizationInvalid" });
  });

  it("closes and verifies end to end: the business gets back the checkout it signed, and the constraints hold", async () => {
    const chain = await close();
    expect(chain.split("~~")).toHaveLength(2);
    const verified = await verify(chain);
    const signed = await verifyCheckoutJwt(verified.checkoutJwt, business.public);
    const { ap2: _ap2, ...withoutAp2 } = checkout;
    expect(signed).toEqual(withoutAp2);
    expect(() => checkOpenCheckoutConstraints(verified.open, signed, ORIGIN)).not.toThrow();
  });

  it("rejects a mandate whose platform key it does not know (agent_missing_key)", async () => {
    await expect(verify(await close(), { platformKey: () => undefined })).rejects.toMatchObject({ code: "Ap2KeyNotFound" });
  });

  it("rejects an open mandate not signed by the platform (mandate_invalid_signature)", async () => {
    await expect(verify(await close(), { platformKey: () => stranger.public })).rejects.toMatchObject({ code: "Ap2SignatureInvalid" });
  });

  it("rejects an expired open mandate (mandate_expired)", async () => {
    await expect(verify(await close(), { now: new Date(NOW.getTime() + 60 * 60_000) })).rejects.toMatchObject({ code: "Ap2MandateExpired" });
  });

  it("rejects a hop the agent named by cnf did not sign", async () => {
    await expect(verify(await close({ holder: stranger.signer }))).rejects.toMatchObject({ code: "Ap2KeyBindingInvalid" });
  });

  it("rejects a hop for another business, or bound to another open mandate", async () => {
    await expect(verify(await close({ aud: "https://other.example" }))).rejects.toMatchObject({ code: "Ap2KeyBindingInvalid" });
    const otherOpen = await openMandate();
    const hop = (await close({ open: otherOpen })).split("~~")[1];
    await expect(verify(`${open.slice(0, -1)}~~${hop}`)).rejects.toMatchObject({ code: "Ap2KeyBindingInvalid" });
  });

  it("rejects a mandate closed for another checkout (mandate_scope_mismatch)", async () => {
    await expect(verify(await close({ nonce: "cs_other" }))).rejects.toMatchObject({ code: "Ap2ScopeMismatch" });
  });

  it("rejects a checkout_jwt the business did not sign (merchant_authorization_invalid)", async () => {
    const forged = { ...checkout, totals: [{ type: "total", amount: 1 }] };
    const verified = await verify(await close({ checkoutJwt: checkoutJwtFrom(forged) }));
    await expect(verifyCheckoutJwt(verified.checkoutJwt, business.public)).rejects.toMatchObject({ code: "Ap2MerchantAuthorizationInvalid" });
  });

  it.each([
    [{ item: "another-product" }, "another item"],
    [{ quantity: 2 }, "another quantity"],
    [{ website: "https://elsewhere.example" }, "another merchant"],
  ])("rejects a checkout outside the open mandate's constraints: %o (%s)", async (overrides) => {
    const narrowOpen = await openMandate(overrides);
    const verified = await verify(await close({ open: narrowOpen }));
    const signed = await verifyCheckoutJwt(verified.checkoutJwt, business.public);
    expect(() => checkOpenCheckoutConstraints(verified.open, signed, ORIGIN)).toThrow(expect.objectContaining({ code: "Ap2ScopeMismatch" }));
  });

  it("rejects a chain that is not open~~close", async () => {
    await expect(verify(open)).rejects.toMatchObject({ code: "Ap2MandateInvalid" });
  });
});
