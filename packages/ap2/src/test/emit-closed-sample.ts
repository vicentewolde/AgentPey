/**
 * Writes a sample closed checkout mandate (T134, R-15) with throwaway P-256 keys, for
 * `scripts/ap2-crosscheck/verify.py --closed <dir>`: the AP2 reference SDK must verify its shape.
 *
 *   pnpm --filter @agentpey/ap2 exec tsx src/test/emit-closed-sample.ts <dir>
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { exportJWK, generateKeyPair } from "jose";
import { checkoutJwtFrom, closeCheckoutMandate, issueOpenMandatePair, signMerchantAuthorization } from "../index.js";
const dir = process.argv[2] ?? ".vitrinee/ap2-closed-sample";
mkdirSync(dir, { recursive: true });

async function p256(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const pub = (await exportJWK(publicKey)) as { x: string; y: string };
  return { signer: { alg: "ES256" as const, privateJwk: await exportJWK(privateKey), kid }, public: { kty: "EC" as const, crv: "P-256" as const, x: pub.x, y: pub.y, kid } };
}
const [platform, agent, business] = await Promise.all([p256("platform#ap2"), p256("agent#ap2"), p256("business#ap2")]);
const now = new Date();
const open = (await issueOpenMandatePair({ issuer: "https://agentpey.com", source: { mandate_id: randomUUID(), hash: "a".repeat(64), registry: "CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F" }, agentKey: agent.public, merchant: { id: "https://agentcommerce.vitrinee.agentpey.com", name: "agentcommerce", website: "https://agentcommerce.vitrinee.agentpey.com" }, item: { id: "67624104591666", title: "Iman" }, quantity: 1, maxAmount: 300n, currency: "USD", paymentInstrument: { id: "stellar_x402", type: "stellar_x402" }, issuedAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 600_000) }, platform.signer)).checkout;
const unsigned = { ucp: { version: "2026-08-25", status: "success" }, id: "cs_abc123", merchant: { id: "https://agentcommerce.vitrinee.agentpey.com", name: "agentcommerce", website: "https://agentcommerce.vitrinee.agentpey.com" }, status: "ready_for_complete", currency: "CLP", line_items: [{ id: "li_1", item: { id: "67624104591666", title: "Iman", price: 1490 }, quantity: 1, totals: [{ type: "total", amount: 1490 }] }], totals: [{ type: "total", amount: 1490 }], links: [] };
const checkout = { ...unsigned, ap2: { merchant_authorization: await signMerchantAuthorization(unsigned, business.signer) } };
const checkoutJwt = checkoutJwtFrom(checkout);
const chain = await closeCheckoutMandate({ open, holder: agent.signer, checkoutJwt, aud: "https://agentcommerce.vitrinee.agentpey.com", nonce: "cs_abc123", issuedAt: now });
writeFileSync(`${dir}/chain.txt`, chain);
writeFileSync(`${dir}/platform.jwk.json`, JSON.stringify(platform.public));
writeFileSync(`${dir}/business.jwk.json`, JSON.stringify(business.public));
writeFileSync(`${dir}/binding.json`, JSON.stringify({ aud: "https://agentcommerce.vitrinee.agentpey.com", nonce: "cs_abc123" }));
console.log("chain written", chain.length);
