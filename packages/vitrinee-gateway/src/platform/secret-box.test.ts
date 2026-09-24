import { isVitrineeError } from "@vitrinee/core";
import { describe, expect, it } from "vitest";

import { createSecretBox, generateMasterKey } from "./secret-box.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isVitrineeError(error) ? error.code : "untyped";
  }
  return undefined;
}

describe("secret box (VT-27)", () => {
  const box = createSecretBox(generateMasterKey());

  it("round-trips a secret for the same context", () => {
    const sealed = box.seal("SBSECRET", "com_1:signing");
    expect(sealed).not.toContain("SBSECRET");
    expect(box.open(sealed, "com_1:signing")).toBe("SBSECRET");
  });

  it("uses a fresh IV every time, so equal secrets do not look equal at rest", () => {
    expect(box.seal("same", "ctx")).not.toBe(box.seal("same", "ctx"));
  });

  it("refuses a value moved to another merchant or another field", () => {
    const sealed = box.seal("SBSECRET", "com_1:signing");
    expect(codeOf(() => box.open(sealed, "com_2:signing"))).toBe("SecretUnreadable");
    expect(codeOf(() => box.open(sealed, "com_1:credentials"))).toBe("SecretUnreadable");
  });

  it("refuses a tampered value", () => {
    const sealed = box.seal("SBSECRET", "ctx");
    const [v, iv, body] = sealed.split(":") as [string, string, string];
    const flipped = Buffer.from(body, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(codeOf(() => box.open(`${v}:${iv}:${flipped.toString("base64url")}`, "ctx"))).toBe("SecretUnreadable");
    expect(codeOf(() => box.open("garbage", "ctx"))).toBe("SecretUnreadable");
  });

  it("does not open with another master key", () => {
    const sealed = box.seal("SBSECRET", "ctx");
    expect(codeOf(() => createSecretBox(generateMasterKey()).open(sealed, "ctx"))).toBe("SecretUnreadable");
  });

  it("refuses a master key of the wrong length, without echoing it", () => {
    try {
      createSecretBox(Buffer.alloc(16).toString("base64"));
      expect.unreachable();
    } catch (error) {
      expect(isVitrineeError(error) && error.code).toBe("ConfigError");
      expect(String(error)).not.toContain(Buffer.alloc(16).toString("base64"));
    }
  });
});
