import { randomBytes } from "node:crypto";

import { signStellarMessage } from "@agentpass/core";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE, WalletSessions } from "./wallet-session.js";

const HOST = "vitrinee.test";

function sessions(now: { t: number }, key = randomBytes(32)) {
  return new WalletSessions({ sessionKey: key, now: () => now.t });
}

/** The `name=value` part of a `Set-Cookie`, as a browser would send it back. */
const cookieOf = (setCookie: string) => setCookie.split(";")[0]!;

describe("signing in to the portal with the payout account's wallet (T105, VT-29)", () => {
  const owner = Keypair.random();

  it("opens a session for a wallet that signed its challenge", () => {
    const now = { t: Date.parse("2026-09-24T12:00:00Z") };
    const s = sessions(now);
    const challenge = s.issueChallenge(owner.publicKey(), HOST);
    expect(challenge.message).toContain(`Account: ${owner.publicKey()}`);
    expect(challenge.message).toContain(`Host: ${HOST}`);
    const account = s.verifyProof(owner.publicKey(), challenge.nonce, signStellarMessage(owner, challenge.message));
    expect(account).toBe(owner.publicKey());
    expect(s.readSession(cookieOf(s.sessionCookie(account, true)))).toBe(owner.publicKey());
  });

  it("refuses a signature by another key", () => {
    const s = sessions({ t: 0 });
    const challenge = s.issueChallenge(owner.publicKey(), HOST);
    const intruder = Keypair.random();
    expect(() => s.verifyProof(owner.publicKey(), challenge.nonce, signStellarMessage(intruder, challenge.message))).toThrow(
      expect.objectContaining({ code: "WalletProofInvalid" }),
    );
  });

  it("refuses a challenge issued to another account, even signed by that other account", () => {
    const s = sessions({ t: 0 });
    const other = Keypair.random();
    const challenge = s.issueChallenge(owner.publicKey(), HOST);
    expect(() => s.verifyProof(other.publicKey(), challenge.nonce, signStellarMessage(other, challenge.message))).toThrow(
      expect.objectContaining({ code: "WalletProofInvalid" }),
    );
  });

  it("never accepts the same challenge twice, and a failed attempt burns it too", () => {
    const s = sessions({ t: 0 });
    const challenge = s.issueChallenge(owner.publicKey(), HOST);
    expect(() => s.verifyProof(owner.publicKey(), challenge.nonce, "AAAA")).toThrow(expect.objectContaining({ code: "WalletProofInvalid" }));
    expect(() => s.verifyProof(owner.publicKey(), challenge.nonce, signStellarMessage(owner, challenge.message))).toThrow(
      expect.objectContaining({ code: "WalletProofInvalid" }),
    );
  });

  it("refuses an expired challenge", () => {
    const now = { t: 0 };
    const s = sessions(now);
    const challenge = s.issueChallenge(owner.publicKey(), HOST);
    now.t += 5 * 60_000 + 1;
    expect(() => s.verifyProof(owner.publicKey(), challenge.nonce, signStellarMessage(owner, challenge.message))).toThrow(
      expect.objectContaining({ code: "WalletProofInvalid" }),
    );
  });

  it("refuses something that is not a Stellar account", () => {
    expect(() => sessions({ t: 0 }).issueChallenge("not-an-account", HOST)).toThrow(expect.objectContaining({ code: "ValidationError" }));
  });

  it("sets a host-only, HttpOnly, SameSite=Strict cookie, so it never reaches a store's subdomain (C-142)", () => {
    const cookie = sessions({ t: 0 }).sessionCookie(owner.publicKey(), true);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).not.toMatch(/domain=/i);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
  });

  it("does not read a session that was edited, expired, or signed under another key", () => {
    const now = { t: 0 };
    const key = randomBytes(32);
    const s = sessions(now, key);
    const good = cookieOf(s.sessionCookie(owner.publicKey(), false));

    const [name, value] = good.split("=") as [string, string];
    const [payload, mac] = value.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, sub: Keypair.random().publicKey(), exp: now.t + 60_000 }), "utf8").toString("base64url");
    expect(s.readSession(`${name}=${forged}.${mac}`)).toBeUndefined();
    expect(s.readSession(`${name}=${payload}.${mac.slice(0, -2)}xx`)).toBeUndefined();
    expect(sessions(now).readSession(good)).toBeUndefined();
    expect(s.readSession(undefined)).toBeUndefined();
    expect(s.readSession("other=1")).toBeUndefined();

    expect(s.readSession(`theme=dark; ${good}`)).toBe(owner.publicKey());
    now.t += 12 * 60 * 60_000 + 1;
    expect(s.readSession(good)).toBeUndefined();
  });
});
