import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { makeVenueId } from "../catalog/ids.js";
import { loadVenueRegistry } from "../catalog/registry.js";
import { awaitHeld, escrowVerifier, storeSignersOf, type EscrowHeldPurchase, type EscrowOnChain, type EscrowPolicy, type VerifiedEscrow } from "./escrow.js";
import { toPaymentTerms } from "./x402.js";

const ESCROW = "CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A";
const PAYEE = "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN";
const OTHER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";
const ARBITER = "GAEB2EG3CSMEHLCYKHPPOMBRVISQOTBRS7T4K2D2EMNOA2AMUSJ32VV6";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const WASM = "f5c6bbb6a54a017b71efd62e1aa87bd9b1babf5a688c74e253100586d6602fc5";
const TX = "a".repeat(64);

const declared = { contract: ESCROW, payee: PAYEE, arbiter: ARBITER, release_window_seconds: 600, response_window_seconds: 900, resolve_window_seconds: 3600 };
const onChain: EscrowOnChain = {
  operator: OTHER,
  payee: PAYEE,
  arbiter: ARBITER,
  token: USDC,
  releaseWindowSeconds: 600,
  responseWindowSeconds: 900,
  resolveWindowSeconds: 3600,
  wasmHash: WASM,
};

const registry = loadVenueRegistry([{ slug: "agentcommerce", address: PAYEE, baseUrl: "https://agentcommerce.example", assets: [{ code: "USDC", issuer: USDC }] }]);
const venueId = makeVenueId("agentcommerce", PAYEE);

function policy(config: Partial<EscrowOnChain> | Error = {}, held: Array<EscrowHeldPurchase | null | Error> = [], extra: Partial<EscrowPolicy> = {}): EscrowPolicy {
  return {
    ledger: {
      config: async () => {
        if (config instanceof Error) throw config;
        return { ...onChain, ...config };
      },
      byTx: async () => {
        const next = held.length > 1 ? held.shift() : held[0];
        if (next instanceof Error) throw next;
        return next ?? null;
      },
    },
    wasmHashes: [WASM],
    arbiters: [ARBITER],
    heldWaitMs: 60,
    heldPollMs: 10,
    ...extra,
  };
}

/** The store's signing account: `onChain.operator`. */
const SIGNERS = [OTHER];
const verified: VerifiedEscrow[] = [];
const verify = (p: EscrowPolicy, escrow = declared, operators: readonly string[] = SIGNERS) =>
  escrowVerifier(p, venueId, registry, operators, (v) => verified.push(v))(escrow, { asset: USDC, storeUrl: "https://agentcommerce.example" });

describe("escrowVerifier (T160, X-9)", () => {
  it("passes a known escrow that says what the store declares and releases to the venue's account, and hands it back verified", async () => {
    verified.length = 0;
    await expect(verify(policy())).resolves.toBeUndefined();
    expect(verified).toEqual([{ contract: ESCROW, payee: PAYEE }]);
  });

  it("refuses an escrow run by another key than the store signs its receipts with, and hands nothing back", async () => {
    verified.length = 0;
    await expect(verify(policy(), declared, [PAYEE])).rejects.toMatchObject({ code: "EscrowUnverified", message: expect.stringContaining("operator") });
    await expect(verify(policy(), declared, [])).rejects.toMatchObject({ code: "EscrowUnverified" });
    expect(verified).toEqual([]);
  });

  it("refuses, naming the problem, an escrow whose chain state differs from the store's word or the agent's trust", async () => {
    for (const [what, config] of [
      ["purchase-escrow code", { wasmHash: "d0d1d877ac479aa6367833f467e35ff90be581236c4c2b688dd313ca4cf802c4" }],
      ["purchase-escrow code", { wasmHash: null }],
      ["arbiter is not one the agent accepts", { arbiter: OTHER }],
      ["payee is not the one the store declares", { payee: OTHER }],
      ["another asset", { token: ESCROW }],
      ["windows", { releaseWindowSeconds: 60 }],
    ] as const) {
      await expect(verify(policy(config)), what).rejects.toMatchObject({ code: "EscrowUnverified", message: expect.stringContaining(what) });
    }
  });

  it("refuses an escrow declared to release to another account than the venue pins, without reading the chain", async () => {
    let read = false;
    const p = policy();
    const watching: EscrowPolicy = { ...p, ledger: { ...p.ledger, config: async (c) => ((read = true), p.ledger.config(c)) } };
    await expect(verify(watching, { ...declared, payee: OTHER })).rejects.toMatchObject({ code: "EscrowUnverified" });
    expect(read).toBe(false);
  });

  it("refuses when the escrow cannot be read: never pays into a contract nobody checked", async () => {
    await expect(verify(policy(new Error("rpc: 503")))).rejects.toMatchObject({ code: "EscrowUnverified" });
  });
});

describe("toPaymentTerms with an escrow (T160)", () => {
  const requirements = (payTo: string) => ({ scheme: "exact", network: "stellar:testnet", asset: USDC, amount: "5157895", payTo, maxTimeoutSeconds: 300, extra: {} }) as PaymentRequirements;

  // Only `escrowVerifier` makes a VerifiedEscrow; the cast stands in for it here.
  const checked = (payee: string) => ({ contract: ESCROW, payee }) as VerifiedEscrow;

  it("takes the verified escrow as payee only when it releases to the venue's account", () => {
    expect(toPaymentTerms(requirements(ESCROW), venueId, registry, checked(PAYEE)).payTo).toBe(ESCROW);
    expect(() => toPaymentTerms(requirements(ESCROW), venueId, registry, checked(OTHER))).toThrow(expect.objectContaining({ code: "InvalidProduct" }));
    expect(() => toPaymentTerms(requirements(PAYEE), venueId, registry, checked(PAYEE))).toThrow(expect.objectContaining({ code: "InvalidProduct" }));
  });

  it("without one, still pins the venue's own account, so a contract is never paid", () => {
    expect(toPaymentTerms(requirements(PAYEE), venueId, registry).payTo).toBe(PAYEE);
    const pinned = { ...registry, venues: new Map([[venueId, { ...registry.venues.get(venueId)!, payTo: PAYEE }]]) };
    expect(() => toPaymentTerms(requirements(ESCROW), venueId, pinned)).toThrow(expect.objectContaining({ code: "InvalidProduct", message: expect.stringContaining("over UCP") }));
  });
});

describe("awaitHeld (X-20): after paying, is the purchase held?", () => {
  const input = { contract: ESCROW, transaction: TX, orderId: "ord_1", amount: "5157895", receiptHash: "b".repeat(64), payer: OTHER };
  const purchase: EscrowHeldPurchase = { orderRef: "ord_1", payer: OTHER, amountAtomic: 5157895n, receiptHash: "b".repeat(64) };

  it("finds the hold once the store records it", async () => {
    await expect(awaitHeld(policy({}, [null, null, purchase]), input)).resolves.toEqual({ contract: ESCROW, held: true });
  });

  it("warns, never throws, when nothing is held in time, the escrow cannot be read, or there is no transaction", async () => {
    await expect(awaitHeld(policy({}, [null]), input)).resolves.toMatchObject({ held: false, warning: expect.stringContaining("has not recorded") });
    await expect(awaitHeld(policy({}, [new Error("rpc down")]), input)).resolves.toMatchObject({ held: false, warning: expect.stringContaining("could not be read") });
    await expect(awaitHeld(policy({}, [purchase]), { ...input, transaction: undefined })).resolves.toMatchObject({ held: false });
  });

  it("warns when the payment is held for another order, amount, receipt or payer", async () => {
    // Another payer: the store recorded the agent's payment under an account of its own, so a claim or a refund would
    // not reach the buyer.
    for (const other of [{ orderRef: "ord_2" }, { amountAtomic: 1n }, { receiptHash: "c".repeat(64) }, { payer: PAYEE }]) {
      await expect(awaitHeld(policy({}, [{ ...purchase, ...other }]), input)).resolves.toMatchObject({ held: false, warning: expect.stringContaining("holds this payment for another") });
    }
  });
});

describe("storeSignersOf: the store's signing accounts, from its profile's keys", () => {
  it("reads did:stellar:testnet kids, once each, and ignores everything else", () => {
    expect(
      storeSignersOf([{ kid: `did:stellar:testnet:${OTHER}#key-1` }, { kid: `did:stellar:testnet:${OTHER}#ucp-p256` }, { kid: "did:web:example.com#k" }, { kty: "EC" }, null, "x"]),
    ).toEqual([OTHER]);
    expect(storeSignersOf(undefined)).toEqual([]);
  });
});
