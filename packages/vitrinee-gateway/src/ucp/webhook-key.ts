/**
 * The key a storefront signs its UCP order webhooks with (T147, VT-44): P-256,
 * because ES256 is the one algorithm every UCP platform must verify (2026-04-08
 * admits no Ed25519). Derived from the receipt key under a label of its own, as
 * the AP2 key is (VT-43), so the two never share a key: no new secret, no
 * migration, and the same in single-store and platform mode.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { deriveP256, type P256Key } from "@agentpey/ap2";

export type StoreWebhookKey = P256Key;

export const STORE_WEBHOOK_KEY_LABEL = "vitrinee/ucp-webhook/p256/v1";

export function deriveStoreWebhookKey(signingSecret: string, kidPrefix: string): StoreWebhookKey {
  return deriveP256(StrKey.decodeEd25519SecretSeed(signingSecret), STORE_WEBHOOK_KEY_LABEL, `${kidPrefix}#ucp-p256`);
}
