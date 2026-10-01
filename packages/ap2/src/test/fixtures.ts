import { generateKeyPairSync } from "node:crypto";

import { exportJWK, generateKeyPair } from "jose";

import { AGENTPEY_MANDATE_CLAIM } from "../schemas.js";
import type { OpenMandateTask } from "../issue.js";
import { disclosableArray, issueSdJwt } from "../sd-jwt.js";
import type { Ap2PublicJwk, Ap2Signer } from "../sd-jwt.js";

export interface TestKey {
  readonly signer: Ap2Signer;
  readonly publicJwk: Ap2PublicJwk;
}

/**
 * An Ed25519 key, the curve the real export signs with (`E-9`). A Stellar
 * seed becomes exactly this JWK through `stellarKeypairToJWK`, which core's
 * own tests pin; the exporter's tests use a real Stellar keypair end to end.
 */
export function ed25519TestKey(kid = "did:stellar:testnet:issuer"): TestKey {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const { x, d } = jwk;
  if (x === undefined || d === undefined) throw new TypeError("Ed25519 JWK without x/d");
  return { signer: { alg: "EdDSA", privateJwk: { kty: "OKP", crv: "Ed25519", x, d }, kid }, publicJwk: { kty: "OKP", crv: "Ed25519", x } };
}

/** A single-use P-256 key, the way the cross-check uses one (`E-9`). */
export async function p256TestKey(kid = "ephemeral-p256"): Promise<TestKey> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const { x, y } = privateJwk;
  if (x === undefined || y === undefined) throw new TypeError("P-256 JWK without x/y");
  return { signer: { alg: "ES256", privateJwk, kid }, publicJwk: { kty: "EC", crv: "P-256", x, y } };
}

export const ISSUED_AT = new Date("2026-10-01T15:00:00.000Z");
export const EXPIRES_AT = new Date("2026-10-01T16:00:00.000Z");

export function testTask(agentKey: Ap2PublicJwk, overrides: Partial<OpenMandateTask> = {}): OpenMandateTask {
  return {
    issuer: "did:stellar:testnet:GISSUER",
    source: {
      mandate_id: "0b9f2c1e-3a4d-4e5f-8a6b-7c8d9e0f1a2b",
      hash: "efb42128822a8c8e1d18978ad178dacb93f93923ea918cdcf4ac04226875a81d",
      registry: "CARC2SIQ3GTL34LVHSTGFRKDNNBYUXCSMGAUGKWGMT6Z2SDY6FXPP2DT",
    },
    agentKey,
    merchant: { id: "vitrinee-agentcommerce:GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN", name: "agentcommerce", website: "https://agentcommerce.vitrinee.agentpey.com" },
    item: { id: "67624104591666", title: "Sticker pack" },
    quantity: 1,
    maxAmount: 300n, // 3.00 USDC in cents (E-12)
    currency: "USDC",
    paymentInstrument: { id: "USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", type: "stellar_x402", description: "USDC on Stellar testnet, x402 exact" },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/**
 * Signs an arbitrary mandate the way the exporter does — same root, same
 * disclosure of the mandate — so a test can put in it what the exporter never
 * would (an unknown constraint, a different `cnf`, a forged reference).
 */
export async function signRawMandate(mandate: Record<string, unknown>, signer: Ap2Signer, task: OpenMandateTask): Promise<string> {
  const disclosures: string[] = [];
  const placeholder = disclosableArray([mandate], disclosures);
  return issueSdJwt(
    { iss: task.issuer, iat: Math.floor(task.issuedAt.getTime() / 1000), [AGENTPEY_MANDATE_CLAIM]: task.source, delegate_payload: placeholder },
    disclosures,
    signer,
  );
}

/** The token's disclosures, decoded, in order. */
export function decodedDisclosures(token: string): unknown[] {
  return token
    .split("~")
    .slice(1, -1)
    .map((disclosure) => JSON.parse(Buffer.from(disclosure, "base64url").toString("utf8")) as unknown);
}
