import { hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { issueOpenMandatePair } from "./issue.js";
import { sdHash, verifySdJwt } from "./sd-jwt.js";
import { OPEN_CHECKOUT_MANDATE_VCT, OPEN_PAYMENT_MANDATE_VCT } from "./schemas.js";
import { AP2_SCHEMA, ap2Errors } from "./test/ap2-schemas.js";
import { EXPIRES_AT, ISSUED_AT, decodedDisclosures, p256TestKey, signRawMandate, ed25519TestKey, testTask } from "./test/fixtures.js";
import type { TestKey } from "./test/fixtures.js";
import { verifyOpenMandatePair } from "./verify.js";

const DURING = new Date(ISSUED_AT.getTime() + 60_000);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

async function exportPair(issuer: TestKey = ed25519TestKey(), agent: TestKey = ed25519TestKey()) {
  const task = testTask(agent.publicJwk);
  const pair = await issueOpenMandatePair(task, issuer.signer);
  return { issuer, agent, task, pair };
}

/** The single mandate a token's `delegate_payload` resolves to, signature checked. */
async function mandateOf(token: string, issuer: TestKey): Promise<unknown> {
  const { payload } = await verifySdJwt(token, issuer.publicJwk);
  return (payload.delegate_payload as unknown[])[0];
}

describe("issueOpenMandatePair → verifyOpenMandatePair", () => {
  it.each([
    ["EdDSA, the real export (E-9)", () => Promise.resolve(ed25519TestKey()), () => Promise.resolve(ed25519TestKey())],
    ["ES256, the cross-check (E-9)", () => p256TestKey(), () => p256TestKey("agent")],
  ])("exports and verifies a pair with %s", async (_name, makeIssuer, makeAgent) => {
    const { issuer, agent, task, pair } = await exportPair(await makeIssuer(), await makeAgent());

    const verified = await verifyOpenMandatePair(pair, { issuerKey: issuer.publicJwk, now: DURING });

    expect(verified.issuer).toBe(task.issuer);
    expect(verified.source).toEqual(task.source);
    expect(verified.checkout).toEqual({
      vct: OPEN_CHECKOUT_MANDATE_VCT,
      constraints: [
        { type: "checkout.line_items", items: [{ id: "line_1", acceptable_items: [task.item], quantity: 1 }] },
        { type: "checkout.allowed_merchants", allowed: [task.merchant] },
      ],
      cnf: { jwk: agent.publicJwk },
      iat: ISSUED_AT.getTime() / 1000,
      exp: EXPIRES_AT.getTime() / 1000,
    });
    expect(verified.payment).toEqual({
      vct: OPEN_PAYMENT_MANDATE_VCT,
      constraints: [
        { type: "payment.reference", conditional_transaction_id: sdHash(pair.checkout) },
        { type: "payment.amount_range", currency: "USDC", max: 30_000_000 },
        { type: "payment.allowed_payees", allowed: [task.merchant] },
        { type: "payment.allowed_payment_instruments", allowed: [task.paymentInstrument] },
        { type: "payment.execution_date", not_after: EXPIRES_AT.toISOString() },
      ],
      cnf: { jwk: agent.publicJwk },
      iat: ISSUED_AT.getTime() / 1000,
      exp: EXPIRES_AT.getTime() / 1000,
    });
  });

  it("produces mandates that pass the official AP2 v0.2 JSON schemas", async () => {
    for (const issuer of [ed25519TestKey(), await p256TestKey()]) {
      const { pair } = await exportPair(issuer);
      expect(ap2Errors(AP2_SCHEMA.openCheckoutMandate, await mandateOf(pair.checkout, issuer))).toEqual([]);
      expect(ap2Errors(AP2_SCHEMA.openPaymentMandate, await mandateOf(pair.payment, issuer))).toEqual([]);
    }
  });

  it("keeps the merchant, item and instrument behind digests in the signed payload", async () => {
    const { pair } = await exportPair();
    const signedPayload = JSON.parse(Buffer.from(pair.checkout.split("~")[0]?.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    expect(JSON.stringify(signedPayload)).not.toContain("agentcommerce");
    expect(decodedDisclosures(pair.checkout)).toHaveLength(3); // item, merchant, the mandate
    expect(decodedDisclosures(pair.payment)).toHaveLength(3); // payee, instrument, the mandate
  });

  it("refuses to issue a mandate that would already be expired, or an unrepresentable amount", async () => {
    const agent = ed25519TestKey();
    const issuer = ed25519TestKey();
    for (const overrides of [{ expiresAt: ISSUED_AT }, { maxAmount: 0n }, { maxAmount: 2n ** 60n }, { quantity: 0 }]) {
      const error = await rejection(issueOpenMandatePair(testTask(agent.publicJwk, overrides), issuer.signer));
      expect(hasErrorCode(error, "Ap2MandateInvalid")).toBe(true);
    }
  });
});

describe("verifyOpenMandatePair rejects an altered pair, with a typed error", () => {
  it("a payment mandate from another export", async () => {
    const issuer = ed25519TestKey();
    const first = await exportPair(issuer);
    const second = await exportPair(issuer, first.agent);
    const error = await rejection(verifyOpenMandatePair({ checkout: first.pair.checkout, payment: second.pair.payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2ReferenceMismatch")).toBe(true);
  });

  it("a payment mandate bound to a different agent key", async () => {
    const { issuer, task, pair } = await exportPair();
    const mandate = (await mandateOf(pair.payment, issuer)) as Record<string, unknown>;
    const payment = await signRawMandate({ ...mandate, cnf: { jwk: ed25519TestKey().publicJwk } }, issuer.signer, task);
    const error = await rejection(verifyOpenMandatePair({ checkout: pair.checkout, payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2ReferenceMismatch")).toBe(true);
  });

  it("a signed root altered after signing", async () => {
    const { issuer, pair } = await exportPair();
    const [jwt = "", ...disclosures] = pair.payment.split("~");
    const [header, body = "", signature] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const tampered = Buffer.from(JSON.stringify({ ...payload, iss: "did:stellar:testnet:GOTHER" })).toString("base64url");
    const payment = [[header, tampered, signature].join("."), ...disclosures].join("~");
    const error = await rejection(verifyOpenMandatePair({ checkout: pair.checkout, payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2SignatureInvalid")).toBe(true);
  });

  it("a payment mandate whose limit was raised after signing", async () => {
    const { issuer, pair } = await exportPair();
    const parts = pair.payment.split("~");
    const mandateIndex = parts.length - 2; // the mandate's own disclosure is the last one
    const [salt, mandate] = JSON.parse(Buffer.from(parts[mandateIndex] ?? "", "base64url").toString("utf8")) as [string, { constraints: Array<Record<string, unknown>> }];
    const raised = { ...mandate, constraints: mandate.constraints.map((c) => (c.type === "payment.amount_range" ? { ...c, max: 900_000_000 } : c)) };
    parts[mandateIndex] = Buffer.from(JSON.stringify([salt, raised])).toString("base64url");
    const error = await rejection(verifyOpenMandatePair({ checkout: pair.checkout, payment: parts.join("~") }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2DisclosureMismatch")).toBe(true);
  });

  it("a merchant disclosure swapped for another merchant", async () => {
    const { issuer, pair } = await exportPair();
    const [jwt, item, merchant, ...rest] = pair.checkout.split("~");
    const [salt] = JSON.parse(Buffer.from(merchant ?? "", "base64url").toString("utf8")) as [string];
    const otherMerchant = Buffer.from(JSON.stringify([salt, { id: "evil:GEVIL", name: "evil" }])).toString("base64url");
    const checkout = [jwt, item, otherMerchant, ...rest].join("~");
    const error = await rejection(verifyOpenMandatePair({ checkout, payment: pair.payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2DisclosureMismatch")).toBe(true);
  });

  it("a pair signed by a key other than the trusted issuer's", async () => {
    const { pair } = await exportPair();
    const error = await rejection(verifyOpenMandatePair(pair, { issuerKey: ed25519TestKey().publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2SignatureInvalid")).toBe(true);
  });

  it("a pair past its exp, or before its iat — boundaries inclusive", async () => {
    const { issuer, pair } = await exportPair();
    await expect(verifyOpenMandatePair(pair, { issuerKey: issuer.publicJwk, now: EXPIRES_AT })).resolves.toBeDefined();
    await expect(verifyOpenMandatePair(pair, { issuerKey: issuer.publicJwk, now: ISSUED_AT })).resolves.toBeDefined();

    const late = await rejection(verifyOpenMandatePair(pair, { issuerKey: issuer.publicJwk, now: new Date(EXPIRES_AT.getTime() + 1000) }));
    expect(hasErrorCode(late, "Ap2MandateExpired")).toBe(true);
    const early = await rejection(verifyOpenMandatePair(pair, { issuerKey: issuer.publicJwk, now: new Date(ISSUED_AT.getTime() - 1000) }));
    expect(hasErrorCode(early, "Ap2MandateNotYetValid")).toBe(true);
  });

  it("a constraint type AP2 does not define — the per-day limit E-10 leaves out, smuggled back in", async () => {
    const { issuer, task, pair } = await exportPair();
    const mandate = (await mandateOf(pair.payment, issuer)) as { constraints: unknown[] };
    const payment = await signRawMandate({ ...mandate, constraints: [...mandate.constraints, { type: "com.agentpey.per_day", max: 50_000_000 }] }, issuer.signer, task);
    const error = await rejection(verifyOpenMandatePair({ checkout: pair.checkout, payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2ConstraintUnsupported")).toBe(true);
  });

  it("a checkout mandate without line items, or a payment one without its reference", async () => {
    const { issuer, task, pair } = await exportPair();
    const checkoutMandate = (await mandateOf(pair.checkout, issuer)) as { constraints: Array<{ type: string }> };
    const checkout = await signRawMandate({ ...checkoutMandate, constraints: checkoutMandate.constraints.filter((c) => c.type !== "checkout.line_items") }, issuer.signer, task);
    const noItems = await rejection(verifyOpenMandatePair({ checkout, payment: pair.payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(noItems, "Ap2MandateInvalid")).toBe(true);

    const paymentMandate = (await mandateOf(pair.payment, issuer)) as { constraints: Array<{ type: string }> };
    const payment = await signRawMandate({ ...paymentMandate, constraints: paymentMandate.constraints.filter((c) => c.type !== "payment.reference") }, issuer.signer, task);
    const noReference = await rejection(verifyOpenMandatePair({ checkout: pair.checkout, payment }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(noReference, "Ap2MandateInvalid")).toBe(true);
  });

  it("the checkout and payment tokens swapped", async () => {
    const { issuer, pair } = await exportPair();
    const error = await rejection(verifyOpenMandatePair({ checkout: pair.payment, payment: pair.checkout }, { issuerKey: issuer.publicJwk, now: DURING }));
    expect(hasErrorCode(error, "Ap2ConstraintUnsupported")).toBe(true);
  });
});
