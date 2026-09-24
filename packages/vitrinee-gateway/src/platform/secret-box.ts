/**
 * Seals the secrets Vitrinee keeps for each merchant (comercio): the key that
 * signs its receipts and the credentials of its store (VT-27).
 *
 * AES-256-GCM under one master key that lives only in the environment
 * (`VITRINEE_MASTER_KEY` on Render, loaded by the user, P-10). Two properties
 * matter more than the cipher:
 *
 * - **Authenticated.** A sealed value edited in the database does not open to
 *   something else; it fails with `SecretUnreadable`.
 * - **Bound to where it belongs.** Every seal carries a context string (the
 *   merchant id and the field) as additional authenticated data. A ciphertext
 *   copied from one merchant's row to another's, or from the credentials
 *   column to the signing-key column, does not open.
 *
 * Nothing here logs, and no error message carries a plaintext or the key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { VitrineeError } from "@vitrinee/core";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  /** Encrypts `plaintext` for `context`. Every call uses a fresh IV. */
  seal(plaintext: string, context: string): string;
  /** @throws VitrineeError `SecretUnreadable` for a tampered value, another context, or another master key. */
  open(sealed: string, context: string): string;
}

/**
 * @param masterKey 32 random bytes, base64 (standard or url-safe). `pnpm run
 * vitrinee:master-key` prints a fresh one.
 * @throws VitrineeError `ConfigError` for a key of the wrong length, naming the rule, never the value.
 */
export function createSecretBox(masterKey: string): SecretBox {
  const key = Buffer.from(masterKey.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new VitrineeError("ConfigError", `MASTER_KEY must be ${KEY_BYTES} bytes, base64-encoded (pnpm run vitrinee:master-key)`);
  }
  return {
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return `${VERSION}:${iv.toString("base64url")}:${body.toString("base64url")}`;
    },
    open(sealed, context) {
      const parts = sealed.split(":");
      const [version, ivPart, bodyPart] = parts;
      if (parts.length !== 3 || version !== VERSION || ivPart === undefined || bodyPart === undefined) {
        throw unreadable(context, "not a sealed value of a known version");
      }
      const iv = Buffer.from(ivPart, "base64url");
      const body = Buffer.from(bodyPart, "base64url");
      if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw unreadable(context, "malformed sealed value");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        throw unreadable(context, "authentication failed: tampered, another context, or another master key");
      }
    },
  };
}

/** A fresh master key, base64. What `pnpm run vitrinee:master-key` prints. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

function unreadable(context: string, reason: string): VitrineeError {
  return new VitrineeError("SecretUnreadable", `a sealed secret could not be opened (${reason})`, { details: { context } });
}
