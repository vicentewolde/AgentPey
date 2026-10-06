/**
 * The merchant's page (`apps/web/public/resolve/responder.js`) and the
 * verifier (`response.ts`) build the signed message separately — one in the
 * browser, one in Node. If they differ by a byte, every real response fails
 * its signature. This test runs the page's own module against the verifier.
 */
import { fileURLToPath } from "node:url";

import { signStellarMessage } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk/base";
import { describe, expect, it } from "vitest";

import { checkClaim, claimHash, signClaim } from "./claim.js";
import { formatAtomic, responseChallengeMessage, responseHash, verifyMerchantResponse } from "./response.js";
import type { AgentResolveResponse } from "./response.js";
import { NOW, agentKey, claimFor, merchantOwnerKey, railController, verifiedReceipt } from "./test/fixtures.js";

interface ResponderModule {
  readClaim(jws: string): Promise<{ claim: { claimId: string; receipt: { hash: string } }; receipt: { merchantAccount: string }; claimHash: string }>;
  buildResponse(input: Record<string, unknown>): AgentResolveResponse;
  responseChallengeMessage(response: AgentResolveResponse): Promise<string>;
  responseHash(response: AgentResolveResponse): Promise<string>;
  responseFile(response: AgentResolveResponse, signature: string): string;
  formatAtomic(atomic: string): string;
  parseUsdc(text: string): string | null;
  publicKeyBytes(address: string): Uint8Array | null;
  verifySep53(address: string, message: string, signature: string): Promise<boolean | null>;
}

const PAGE_MODULE = fileURLToPath(new URL("../../../apps/web/public/resolve/responder.js", import.meta.url));
const page = (await import(PAGE_MODULE)) as ResponderModule;

async function claimJws() {
  const receipt = verifiedReceipt();
  const signed = await signClaim(claimFor(receipt), agentKey);
  const checked = await checkClaim(signed.document, receipt, { controllerOf: railController, now: NOW });
  return { receipt, signed, checked };
}

describe("the merchant's page signs exactly what the verifier checks", () => {
  it.each([
    ["a contest with evidence", { position: "contest", acceptedAtomic: null }],
    ["a partial acceptance", { position: "accept_partial", acceptedAtomic: "5000000" }],
    ["a full acceptance", { position: "accept_full", acceptedAtomic: null }],
  ] as const)("builds %s whose message and hash match the verifier byte for byte, and verifies end to end", async (_name, choice) => {
    const { receipt, signed, checked } = await claimJws();
    const read = await page.readClaim(`${signed.jws}\n`);
    expect(read.claimHash).toBe(claimHash(signed.jws));
    expect(read.receipt.merchantAccount).toBe(merchantOwnerKey.publicKey());

    const response = page.buildResponse({
      claim: read.claim,
      claimHash: read.claimHash,
      address: merchantOwnerKey.publicKey(),
      position: choice.position,
      acceptedAtomic: choice.acceptedAtomic ?? undefined,
      // Accents, quotes, `<` and surrounding spaces: what a real statement has.
      statement: '  Despachado el 3 de octubre. "Seguimiento" CL123 <ver adjunto> ñandú  ',
      evidence: [{ kind: "url", content: " https://example.com/tracking/CL123 " }],
      responseId: "9d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a",
      createdAt: "2026-10-02T12:30:00.000Z",
    });

    const pageMessage = await page.responseChallengeMessage(response);
    expect(pageMessage).toBe(responseChallengeMessage(response));
    expect(await page.responseHash(response)).toBe(responseHash(response));

    // Freighter's part, played by the same key: it signs the page's message.
    const file = JSON.parse(page.responseFile(response, signStellarMessage(merchantOwnerKey, pageMessage))) as unknown;
    const verified = verifyMerchantResponse(file, {
      receipt: receipt.receipt,
      receiptHash: receipt.hash,
      claimHash: claimHash(signed.jws),
      claimId: signed.document.claimId,
      disputedAtomic: checked.disputedAtomic,
    });
    expect(verified.response.position).toBe(choice.position);
  });

  it("formats and parses amounts the way the verifier does", () => {
    for (const atomic of ["1", "5000000", "10000000", "15684211", "123456789012"]) expect(page.formatAtomic(atomic)).toBe(formatAtomic(atomic));
    expect(page.parseUsdc("0.5")).toBe("5000000");
    expect(page.parseUsdc("1,5684211")).toBe("15684211");
    expect(page.parseUsdc("2")).toBe("20000000");
    expect(page.parseUsdc("0")).toBeNull();
    expect(page.parseUsdc("0.00000001")).toBeNull();
    expect(page.parseUsdc("-1")).toBeNull();
  });

  it("refuses to read something that is not a claim", async () => {
    await expect(page.readClaim("not.a.claim")).rejects.toThrow();
    await expect(page.readClaim(verifiedReceipt().jws)).rejects.toThrow("not an AgentResolve claim");
  });

  it("refuses a claim whose amount or payout account the page could not use", async () => {
    const { signed } = await claimJws();
    const [header, body = "", signature] = signed.jws.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = [header, Buffer.from(JSON.stringify({ ...payload, amountAtomic: "abc" })).toString("base64url"), signature].join(".");
    await expect(page.readClaim(forged)).rejects.toThrow("not an AgentResolve claim");
  });
});

describe("the page checks Freighter's signature before it hands out the file", () => {
  const message = "AgentResolve merchant response\nHash: " + "a".repeat(64);

  it("decodes a G address to the same 32 bytes as the Stellar SDK, and refuses a bad checksum", () => {
    const key = Keypair.random();
    expect(Buffer.from(page.publicKeyBytes(key.publicKey()) ?? []).equals(Buffer.from(key.rawPublicKey()))).toBe(true);
    const address = key.publicKey();
    const tampered = address.slice(0, -1) + (address.endsWith("A") ? "B" : "A");
    expect(page.publicKeyBytes(tampered)).toBeNull();
    expect(page.publicKeyBytes("CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP")).toBeNull();
  });

  it("accepts the SEP-53 signature the verifier accepts, and only that", async () => {
    const signature = signStellarMessage(merchantOwnerKey, message);
    expect(await page.verifySep53(merchantOwnerKey.publicKey(), message, signature)).toBe(true);
    expect(await page.verifySep53(Keypair.random().publicKey(), message, signature)).toBe(false);
    expect(await page.verifySep53(merchantOwnerKey.publicKey(), `${message}x`, signature)).toBe(false);
    expect(await page.verifySep53(merchantOwnerKey.publicKey(), message, "")).toBe(false);
    expect(await page.verifySep53(merchantOwnerKey.publicKey(), message, "not base64!")).toBe(false);
  });

});
