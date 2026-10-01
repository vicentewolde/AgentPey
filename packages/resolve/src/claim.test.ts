import { hasErrorCode } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk/base";
import { describe, expect, it } from "vitest";

import { checkClaim, claimHash, signClaim, verifyClaim } from "./claim.js";
import { NOW, PAID_ATOMIC, agentKey, claimFor, railController, verifiedReceipt } from "./test/fixtures.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("a claim is signed by its claimant and verified offline", () => {
  it("round-trips, and its hash is sha256 of the JWS", async () => {
    const receipt = verifiedReceipt();
    const signed = await signClaim(claimFor(receipt), agentKey);
    const verified = await verifyClaim(signed.jws);
    expect(verified.document).toEqual(claimFor(receipt));
    expect(claimHash(signed.jws)).toBe(signed.hash);
  });

  it("cannot be signed by anyone but the claimant it names", async () => {
    const error = await rejection(signClaim(claimFor(verifiedReceipt()), Keypair.random()));
    expect(hasErrorCode(error, "SignerMismatch")).toBe(true);
  });

  it("rejects a claim altered after signing", async () => {
    const signed = await signClaim(claimFor(verifiedReceipt()), agentKey);
    const [header, body = "", signature] = signed.jws.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { amountAtomic: string };
    payload.amountAtomic = "999999999";
    const forged = [header, Buffer.from(JSON.stringify(payload)).toString("base64url"), signature].join(".");
    const error = await rejection(verifyClaim(forged));
    expect(hasErrorCode(error, "InvalidSignature")).toBe(true);
  });

  it("rejects a claim off its schema", async () => {
    const receipt = verifiedReceipt();
    const error = await rejection(signClaim({ ...claimFor(receipt), amountAtomic: "0" }, agentKey));
    expect(hasErrorCode(error, "ResolveClaimInvalid")).toBe(true);
  });
});

describe("checkClaim — may this claim open a dispute over this receipt?", () => {
  it("accepts the key that controls a policy_rail payer, and returns what to lock and whom to refund", async () => {
    const receipt = verifiedReceipt();
    const checked = await checkClaim(claimFor(receipt), receipt, { controllerOf: railController, now: NOW });
    expect(checked.disputedAtomic).toBe(BigInt(PAID_ATOMIC));
    expect(checked.payer).toBe(receipt.receipt.payerAccount);
  });

  it("accepts a classic payer signing for itself, without asking the chain", async () => {
    const payer = Keypair.random();
    const receipt = verifiedReceipt({ payerAccount: payer.publicKey() });
    const controllerOf = (): Promise<string> => Promise.reject(new Error("must not be called for a G... payer"));
    const checked = await checkClaim(claimFor(receipt, {}, payer), receipt, { controllerOf, now: NOW });
    expect(checked.payer).toBe(payer.publicKey());
  });

  it("refuses a claimant who neither paid nor controls the payer", async () => {
    const receipt = verifiedReceipt();
    const stranger = Keypair.random();
    const error = await rejection(checkClaim(claimFor(receipt, {}, stranger), receipt, { controllerOf: railController, now: NOW }));
    expect(hasErrorCode(error, "ResolveClaimantNotPayer")).toBe(true);
  });

  it("refuses more than the receipt paid", async () => {
    const receipt = verifiedReceipt();
    const error = await rejection(checkClaim(claimFor(receipt, { amountAtomic: "15684212" }), receipt, { controllerOf: railController, now: NOW }));
    expect(hasErrorCode(error, "ResolveAmountExceeded")).toBe(true);
  });

  it("refuses a claim after the refund window", async () => {
    const receipt = verifiedReceipt();
    const error = await rejection(checkClaim(claimFor(receipt), receipt, { controllerOf: railController, now: new Date("2026-10-11T13:18:13.000Z") }));
    expect(hasErrorCode(error, "ResolveClaimWindowClosed")).toBe(true);
  });

  it("refuses a claim that embeds a receipt other than the one verified", async () => {
    const receipt = verifiedReceipt();
    const other = verifiedReceipt({ orderId: "ord_other" });
    const error = await rejection(checkClaim(claimFor(other), receipt, { controllerOf: railController, now: NOW }));
    expect(hasErrorCode(error, "ResolveReceiptInvalid")).toBe(true);
  });
});
