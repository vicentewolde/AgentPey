import { createHash } from "node:crypto";

import { hasErrorCode } from "@agentpass/core";
import { CompactSign, importJWK } from "jose";
import { describe, expect, it } from "vitest";

import { AP2_SD_JWT_TYP, disclosableArray, issueSdJwt, sdHash, sha256Base64Url, verifySdJwt } from "./sd-jwt.js";
import { p256TestKey, ed25519TestKey } from "./test/fixtures.js";

async function issueList(values: readonly unknown[], key = ed25519TestKey()): Promise<string> {
  const disclosures: string[] = [];
  const list = disclosableArray(values, disclosures);
  return issueSdJwt({ iss: "issuer", list }, disclosures, key.signer);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("issueSdJwt / verifySdJwt", () => {
  it.each([
    ["EdDSA (a Stellar key)", () => Promise.resolve(ed25519TestKey())],
    ["ES256 (a single-use P-256 key)", () => p256TestKey()],
  ])("round-trips with %s, resolving every disclosed element", async (_name, makeKey) => {
    const key = await makeKey();
    const disclosures: string[] = [];
    const list = disclosableArray(["a", { b: 1 }], disclosures);
    const token = await issueSdJwt({ iss: "issuer", list, plain: [1, 2] }, disclosures, key.signer);

    expect(token.endsWith("~")).toBe(true);
    const { header, payload } = await verifySdJwt(token, key.publicJwk);
    expect(header).toMatchObject({ alg: key.signer.alg, typ: AP2_SD_JWT_TYP, kid: key.signer.kid });
    expect(payload).toEqual({ iss: "issuer", list: ["a", { b: 1 }], plain: [1, 2] });
  });

  it("puts only digests in the signed payload, each salted", async () => {
    const disclosures: string[] = [];
    const [first, second] = disclosableArray(["same", "same"], disclosures);
    expect(first?.["..."]).not.toBe(second?.["..."]);
    expect(disclosures).toHaveLength(2);
  });

  it("withholds an element whose disclosure is left out, rather than failing", async () => {
    const key = ed25519TestKey();
    const token = await issueList(["kept", "withheld"], key);
    const [jwt, kept] = token.split("~");
    const { payload } = await verifySdJwt(`${jwt}~${kept}~`, key.publicJwk);
    expect(payload).toEqual({ iss: "issuer", list: ["kept"] });
  });

  it("treats a disclosed claim named __proto__ or constructor as a plain claim", async () => {
    const key = ed25519TestKey();
    const disclosures = ["__proto__", "constructor"].map((name) => Buffer.from(JSON.stringify(["salt-" + name, name, { polluted: true }])).toString("base64url"));
    const token = await issueSdJwt({ iss: "issuer", _sd: disclosures.map(sha256Base64Url) }, disclosures, key.signer);
    const { payload } = await verifySdJwt(token, key.publicJwk);
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect(Object.hasOwn(payload, "__proto__") && Object.hasOwn(payload, "constructor")).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("rejects a token signed by any key other than the trusted one", async () => {
    const token = await issueList(["x"]);
    const error = await rejection(verifySdJwt(token, ed25519TestKey().publicJwk));
    expect(hasErrorCode(error, "Ap2SignatureInvalid")).toBe(true);
  });

  it("rejects a token whose alg is not the trusted key's algorithm", async () => {
    const token = await issueList(["x"], await p256TestKey());
    const error = await rejection(verifySdJwt(token, ed25519TestKey().publicJwk));
    expect(hasErrorCode(error, "Ap2MandateInvalid")).toBe(true);
  });

  it("rejects a token whose typ is not dc+sd-jwt", async () => {
    const key = ed25519TestKey();
    const jwt = await new CompactSign(new TextEncoder().encode(JSON.stringify({ iss: "issuer" })))
      .setProtectedHeader({ alg: "EdDSA", typ: "mandate+jwt" })
      .sign(await importJWK(key.signer.privateJwk, "EdDSA"));
    const error = await rejection(verifySdJwt(`${jwt}~`, key.publicJwk));
    expect(hasErrorCode(error, "Ap2MandateInvalid")).toBe(true);
  });

  it("rejects a token carrying a Key Binding JWT or missing its trailing ~", async () => {
    const key = ed25519TestKey();
    const token = await issueList(["x"], key);
    const error = await rejection(verifySdJwt(token.slice(0, -1), key.publicJwk));
    expect(hasErrorCode(error, "Ap2MandateInvalid")).toBe(true);
  });

  it("rejects a disclosure the issuer never signed", async () => {
    const key = ed25519TestKey();
    const token = await issueList(["x"], key);
    const forged = Buffer.from(JSON.stringify(["salt", "injected"])).toString("base64url");
    const error = await rejection(verifySdJwt(`${token}${forged}~`, key.publicJwk));
    expect(hasErrorCode(error, "Ap2DisclosureMismatch")).toBe(true);
  });

  it("rejects a disclosure whose value was altered", async () => {
    const key = ed25519TestKey();
    const token = await issueList(["3000000"], key);
    const [jwt, disclosure] = token.split("~");
    const [salt] = JSON.parse(Buffer.from(disclosure ?? "", "base64url").toString("utf8")) as [string, string];
    const altered = Buffer.from(JSON.stringify([salt, "999999999"])).toString("base64url");
    const error = await rejection(verifySdJwt(`${jwt}~${altered}~`, key.publicJwk));
    expect(hasErrorCode(error, "Ap2DisclosureMismatch")).toBe(true);
  });

  it("rejects the same disclosure presented twice", async () => {
    const key = ed25519TestKey();
    const token = await issueList(["x"], key);
    const [jwt, disclosure] = token.split("~");
    const error = await rejection(verifySdJwt(`${jwt}~${disclosure}~${disclosure}~`, key.publicJwk));
    expect(hasErrorCode(error, "Ap2DisclosureMismatch")).toBe(true);
  });
});

describe("sdHash", () => {
  it("is base64url(sha256) of the whole token, disclosures included, as the AP2 SDK computes it", async () => {
    const token = await issueList(["x"]);
    expect(sdHash(token)).toBe(createHash("sha256").update(token, "ascii").digest("base64url"));
  });
});
