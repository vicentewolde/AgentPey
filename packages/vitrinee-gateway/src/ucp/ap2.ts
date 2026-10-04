/**
 * A storefront's AP2 key (T134, R-15, VT-43). The business signs every
 * checkout response with a P-256 key (UCP's AP2 extension is ECDSA, R-5),
 * derived from the storefront's receipt key under a label of its own: no new
 * secret, no migration; the receipt key is already the storefront's identity.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { deriveP256, type P256Key } from "@agentpey/ap2";

export type StoreAp2Key = P256Key;

export const STORE_AP2_KEY_LABEL = "vitrinee/ucp-ap2/p256/v1";

export function deriveStoreAp2Key(signingSecret: string, kidPrefix: string): StoreAp2Key {
  return deriveP256(StrKey.decodeEd25519SecretSeed(signingSecret), STORE_AP2_KEY_LABEL, `${kidPrefix}#ap2-p256`);
}
