import { createHash } from "node:crypto";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { walletKitIntegrity, walletKitVersion } from "./index.js";

const sri = (text: string) => `sha384-${createHash("sha384").update(text).digest("base64")}`;

describe("walletKitIntegrity", () => {
  it("is the sha384 of the file, and follows the file when it is rebuilt under a running server", () => {
    const bundle = join(mkdtempSync(join(tmpdir(), "wallet-kit-sri-")), "wallet-kit.js");
    writeFileSync(bundle, "old bundle");
    expect(walletKitIntegrity(bundle)).toBe(sri("old bundle"));
    writeFileSync(bundle, "a new, longer bundle");
    utimesSync(bundle, new Date(), new Date(Date.now() + 5_000));
    expect(walletKitIntegrity(bundle)).toBe(sri("a new, longer bundle"));
  });

  it("is undefined for a bundle that is not built", () => {
    expect(walletKitIntegrity("/nonexistent/wallet-kit.js")).toBeUndefined();
  });

  it("gives a short, URL-safe fingerprint that changes with the bundle", () => {
    expect(walletKitVersion(sri("a"))).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(walletKitVersion(sri("a"))).not.toBe(walletKitVersion(sri("b")));
  });
});
