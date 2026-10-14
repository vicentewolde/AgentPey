import { hasErrorCode } from "@agentpass/core";
import { describe, expect, it } from "vitest";

import { escrowConfigSchema, escrowDrift, escrowPurchaseSchema, orderRefHex, parseWindows, storeAccountsFromProfile } from "./purchase-escrow.js";

const OPERATOR = "GAPCCUMMA4VY55DUH5KBQUQDBWVD52YEJ72XKDECTVYD7B4GKSZ25YVZ";
const PAYEE = "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN";

function profile(payTo = PAYEE, kids = [`did:stellar:testnet:${OPERATOR}#key-1`, `did:stellar:testnet:${OPERATOR}#ucp-p256`]): unknown {
  return {
    ucp: { version: "2026-08-25", payment_handlers: { "com.agentpey.stellar_x402": [{ id: "stellar_x402", config: { pay_to: payTo, network: "stellar:testnet" } }] } },
    keys: kids.map((kid) => ({ kid, kty: "OKP" })),
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return hasErrorCode(error, "ConfigError") ? "ConfigError" : hasErrorCode(error, "InvalidArguments") ? "InvalidArguments" : "other";
  }
  return undefined;
}

describe("storeAccountsFromProfile", () => {
  it("reads the signing account from the keys and the payout account from the Stellar handler", () => {
    expect(storeAccountsFromProfile(profile())).toEqual({ operator: OPERATOR, payee: PAYEE });
  });

  it("refuses a profile with two signing accounts, none, or a pay_to that is not an account", () => {
    expect(codeOf(() => storeAccountsFromProfile(profile(PAYEE, [`did:stellar:testnet:${OPERATOR}#key-1`, `did:stellar:testnet:${PAYEE}#key-2`])))).toBe("ConfigError");
    expect(codeOf(() => storeAccountsFromProfile(profile(PAYEE, ["did:web:example.com#key-1"])))).toBe("ConfigError");
    expect(codeOf(() => storeAccountsFromProfile(profile("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")))).toBe("ConfigError");
    expect(codeOf(() => storeAccountsFromProfile({ ucp: { payment_handlers: {} }, keys: [{ kid: `did:stellar:testnet:${OPERATOR}#key-1` }] }))).toBe("ConfigError");
  });

  it("refuses a store that signs and collects with one account (X-4)", () => {
    expect(codeOf(() => storeAccountsFromProfile(profile(OPERATOR)))).toBe("ConfigError");
  });
});

describe("parseWindows", () => {
  it("takes the three windows in seconds", () => {
    expect(parseWindows(["--store", "agentcommerce", "--release", "600", "--response", "900", "--resolve", "3600"])).toEqual({
      releaseWindowSeconds: 600,
      responseWindowSeconds: 900,
      resolveWindowSeconds: 3600,
    });
  });

  it("has no default: a missing, zero or fractional window is refused", () => {
    expect(codeOf(() => parseWindows(["--release", "600", "--response", "900"]))).toBe("InvalidArguments");
    expect(codeOf(() => parseWindows(["--release", "0", "--response", "900", "--resolve", "3600"]))).toBe("InvalidArguments");
    expect(codeOf(() => parseWindows(["--release", "1.5", "--response", "900", "--resolve", "3600"]))).toBe("InvalidArguments");
  });
});

describe("CLI output schemas", () => {
  it("reads config and a purchase as the CLI prints them", () => {
    expect(
      escrowConfigSchema.parse({
        operator: OPERATOR,
        payee: PAYEE,
        arbiter: "GAEB2EG3CSMEHLCYKHPPOMBRVISQOTBRS7T4K2D2EMNOA2AMUSJ32VV6",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        release_window: 600,
        response_window: 900,
        resolve_window: 3600,
      }).release_window,
    ).toBe(600);
    const purchase = escrowPurchaseSchema.parse({
      order_ref: orderRefHex("ord_001"),
      payer: "CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA",
      amount: "500000",
      tx_hash: "ab".repeat(32),
      receipt_hash: "cd".repeat(32),
      status: "Held",
      held_at: 1_790_000_000,
      shipped_at: 0,
      claim_hash: null,
      opened_at: 0,
      response_hash: null,
      verdict_hash: null,
      refund: "0",
      refund_owed: "0",
      closed_at: 0,
    });
    expect(purchase.amount).toBe(500_000n);
    expect(Buffer.from(purchase.order_ref, "hex").toString("utf8")).toBe("ord_001");
  });

  it("refuses an order reference out of bounds, and hex of odd length", () => {
    expect(codeOf(() => orderRefHex(""))).toBe("InvalidArguments");
    expect(codeOf(() => orderRefHex("x".repeat(65)))).toBe("InvalidArguments");
    expect(escrowPurchaseSchema.shape.order_ref.safeParse("abc").success).toBe(false);
    expect(escrowPurchaseSchema.shape.order_ref.safeParse("ab".repeat(65)).success).toBe(false);
  });
});

describe("escrowDrift", () => {
  const base = {
    operator: OPERATOR,
    payee: PAYEE,
    arbiter: "GAEB2EG3CSMEHLCYKHPPOMBRVISQOTBRS7T4K2D2EMNOA2AMUSJ32VV6",
    token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    releaseWindowSeconds: 600,
    responseWindowSeconds: 900,
    resolveWindowSeconds: 3600,
  };

  it("is empty when the recorded escrow is the one asked for", () => {
    expect(escrowDrift(base, { ...base })).toEqual([]);
  });

  it("names each field a re-run would silently not change", () => {
    expect(escrowDrift(base, { ...base, releaseWindowSeconds: 604_800, payee: OPERATOR })).toEqual(["payee", "releaseWindowSeconds"]);
  });
});
