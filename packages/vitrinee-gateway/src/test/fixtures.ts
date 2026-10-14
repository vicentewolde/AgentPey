import { Keypair } from "@stellar/stellar-sdk";
import type { AnchorInput, AnchorResult, AnchoredRecord, EscrowConfig, EscrowPurchase, EscrowReader, EscrowReaderFactory, HoldInput, HoldResult } from "@vitrinee/anchor";
import { USDC_TESTNET } from "@vitrinee/core";

import type { Anchorer, Holder } from "../anchoring.js";
import { loadConfig, type GatewayConfig } from "../config.js";
import type { OutboundRequest, PlatformClient, PlatformProfileSummary, ProfileResult, SendResult } from "../ucp/platform-profile.js";
import { FAKE_PAYER, FAKE_TX_HASH } from "./fake-facilitator.js";

export const MERCHANT = USDC_TESTNET.issuer;
export const SIGNER = Keypair.random();
export const REGISTRY_ID = "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5";

export function testConfig(env: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    MERCHANT_STELLAR_ACCOUNT: MERCHANT,
    MERCHANT_SIGNING_SECRET: SIGNER.secret(),
    RECEIPT_REGISTRY_ID: REGISTRY_ID,
    FX_RATE_CLP_USD: "950",
    ...env,
  });
}

/**
 * An in-memory receipt-registry: anchors land in a map the verifier reads,
 * so the whole anchor → verify path runs without a network.
 */
export function fakeRegistry(options: { failTimes?: number } = {}) {
  const records = new Map<string, AnchoredRecord>();
  const calls: AnchorInput[] = [];
  let failures = options.failTimes ?? 0;
  let ledger = 4_900_000;
  const anchorer: Anchorer = {
    async anchor(input: AnchorInput): Promise<AnchorResult> {
      calls.push(input);
      if (failures > 0) {
        failures -= 1;
        throw new Error("rpc: txBadSeq");
      }
      ledger += 1;
      records.set(input.hash, { merchant: SIGNER.publicKey(), amount: input.amount, orderRef: input.orderRef, ledger, timestamp: 1_790_000_000 });
      return { txHash: `${ledger.toString(16)}`.padStart(64, "a"), ledger, alreadyAnchored: false };
    },
  };
  return { anchorer, calls, records, registry: { contractId: REGISTRY_ID, get: async (hash: string) => records.get(hash) ?? null } };
}

/** The test store's escrow (T159). */
export const ESCROW_ID = "CCTVYTWFGOBD23UF7A2AX6CMCKF7ACHENU6YNFJPG6S3O5P3FBKCYLDO";

/**
 * An in-memory `purchase-escrow`: holds land in a map its reader serves, so
 * hold → verify runs without a network. `failTimes` makes the first holds throw.
 */
export function fakeEscrow(options: { failTimes?: number; config?: Partial<EscrowConfig> } = {}) {
  const purchases = new Map<string, EscrowPurchase>();
  const calls: HoldInput[] = [];
  let failures = options.failTimes ?? 0;
  let ledger = 5_000_000;
  const holder: Holder = {
    async hold(input: HoldInput): Promise<HoldResult> {
      calls.push(input);
      if (failures > 0) {
        failures -= 1;
        throw new Error("rpc: txBadSeq");
      }
      ledger += 1;
      purchases.set(input.txHash, {
        orderRef: input.orderRef,
        payer: input.payer,
        amountAtomic: input.amount,
        txHash: input.txHash,
        receiptHash: input.receiptHash,
        status: "held",
        heldAt: 1_790_000_000,
        shippedAt: null,
        claimHash: null,
        openedAt: null,
        responseHash: null,
        verdictHash: null,
        refundAtomic: 0n,
        refundOwedAtomic: 0n,
        closedAt: null,
      });
      return { txHash: `${ledger.toString(16)}`.padStart(64, "b"), ledger, alreadyHeld: false };
    },
  };
  const config: EscrowConfig = {
    operator: SIGNER.publicKey(),
    payee: MERCHANT,
    arbiter: Keypair.random().publicKey(),
    token: USDC_TESTNET.contractId,
    releaseWindowSeconds: 600,
    responseWindowSeconds: 900,
    resolveWindowSeconds: 3600,
    ...options.config,
  };
  const reader: EscrowReader = {
    contractId: ESCROW_ID,
    config: async () => config,
    get: async (orderRef) => [...purchases.values()].find((p) => p.orderRef === orderRef) ?? null,
    byTx: async (txHash) => purchases.get(txHash) ?? null,
  };
  const escrows: EscrowReaderFactory = (contractId) => {
    if (contractId !== ESCROW_ID) throw new Error(`no such escrow ${contractId}`);
    return reader;
  };
  return { holder, calls, purchases, escrows };
}

/**
 * A Horizon that confirms any settlement for FAKE_TX_HASH of `amount` from FAKE_PAYER to MERCHANT, or, with
 * `creditContract`, to that contract (an escrow, T159) as Horizon reports it: `contract_credited`, with the
 * transaction's source in `account` (X-14).
 */
export function fakeHorizon(options: { creditContract?: string } = {}): typeof fetch {
  const amounts = new Map<string, string>();
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(`/transactions/${FAKE_TX_HASH}`)) return Response.json({ successful: true, ledger: 4_899_999, created_at: "2026-09-23T12:00:00Z" });
    if (url.includes(`/transactions/${FAKE_TX_HASH}/effects`)) {
      const records = [...amounts.values()].flatMap((amount) => [
        { type: "account_debited", account: FAKE_PAYER, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
        options.creditContract === undefined
          ? { type: "account_credited", account: MERCHANT, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer }
          : { type: "contract_credited", account: FAKE_PAYER, contract: options.creditContract, amount, asset_code: "USDC", asset_issuer: USDC_TESTNET.issuer },
      ]);
      return Response.json({ _embedded: { records } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch & { allow(amount: string): void };
  fn.allow = (amount: string) => amounts.set(amount, amount);
  return fn;
}

/** AgentPey's platform profile, the one its agent and the tests send in `UCP-Agent`. */
export const AGENTPEY_PLATFORM_PROFILE = "https://agentpey.com/ucp/platform/agentpey.json";

/**
 * Platform profiles without a network (T133): each URL answers the version
 * given, anything else does not answer. By default AgentPey's own profile
 * speaks 2026-04-08, as the file in apps/web does. It also takes order webhook
 * deliveries (T147): each is recorded in `sent`, and `respond` decides the
 * receiver's answer (200 unless told otherwise).
 */
export function fakePlatformProfiles(
  versions: Record<string, string | PlatformProfileSummary> = { [AGENTPEY_PLATFORM_PROFILE]: "2026-04-08" },
): PlatformClient & { reads: string[]; sent: Array<{ url: string; headers: Record<string, string>; body: string }>; respond: (url: string, attempt: number) => SendResult } {
  const reads: string[] = [];
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fake = {
    reads,
    sent,
    respond: (_url: string, _attempt: number): SendResult => ({ ok: true, status: 200 }),
    async read(url: string): Promise<ProfileResult> {
      reads.push(url);
      const entry = versions[url];
      if (entry === undefined) return { ok: false, reason: "unreachable" };
      return { ok: true, profile: typeof entry === "string" ? { ucp: { version: entry, capabilities: [] }, keys: [] } : entry };
    },
    async send(url: string, request: OutboundRequest): Promise<SendResult> {
      sent.push({ url, headers: { ...request.headers }, body: request.body });
      return fake.respond(url, sent.filter((s) => s.url === url).length);
    },
  };
  return fake;
}
