/**
 * Pure helpers for the `purchase-escrow` scripts (T157): what the Stellar CLI
 * prints for the contract's reads, and the store accounts its UCP profile
 * declares. No network here, so every rule is tested.
 */
import { AgentPassError, stellarAddressSchema, stellarContractIdSchema } from "@agentpass/core";
import { z } from "zod";

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const seconds = z.coerce.number().int().positive();

/** `config` as the CLI prints it. */
export const escrowConfigSchema = z.object({
  operator: stellarAddressSchema,
  payee: stellarAddressSchema,
  arbiter: stellarAddressSchema,
  token: stellarContractIdSchema,
  release_window: seconds,
  response_window: seconds,
  resolve_window: seconds,
});
export type EscrowConfig = z.infer<typeof escrowConfigSchema>;

export const ESCROW_STATUSES = ["Held", "Shipped", "Released", "Disputed", "Responded", "Resolved", "Expired"] as const;

/** `get` / `by_tx` as the CLI prints a `Purchase`: bytes in hex, i128 as a string, `None` as null. */
export const escrowPurchaseSchema = z.object({
  order_ref: z.string().regex(/^[0-9a-f]{2,128}$/),
  payer: z.union([stellarAddressSchema, stellarContractIdSchema]),
  amount: z.coerce.bigint(),
  tx_hash: hex32,
  receipt_hash: hex32,
  status: z.enum(ESCROW_STATUSES),
  held_at: z.coerce.number().int(),
  shipped_at: z.coerce.number().int(),
  claim_hash: hex32.nullable(),
  opened_at: z.coerce.number().int(),
  response_hash: hex32.nullable(),
  verdict_hash: hex32.nullable(),
  refund: z.coerce.bigint(),
  closed_at: z.coerce.number().int(),
});
export type EscrowPurchase = z.infer<typeof escrowPurchaseSchema>;

export interface EscrowWindows {
  readonly releaseWindowSeconds: number;
  readonly responseWindowSeconds: number;
  readonly resolveWindowSeconds: number;
}

/**
 * The three windows, from `--release`, `--response` and `--resolve` (seconds).
 * All three are required: they are fixed for the contract's life (`X-6`), so
 * none of them gets a silent default.
 */
export function parseWindows(argv: readonly string[]): EscrowWindows {
  const read = (flag: string): number => {
    const at = argv.indexOf(flag);
    const raw = at === -1 ? undefined : argv[at + 1];
    const parsed = seconds.safeParse(raw);
    if (!parsed.success) {
      throw new AgentPassError("InvalidArguments", `${flag} <seconds> is required and must be a positive integer`, { details: { flag, value: raw ?? null } });
    }
    return parsed.data;
  };
  return { releaseWindowSeconds: read("--release"), responseWindowSeconds: read("--response"), resolveWindowSeconds: read("--resolve") };
}

const storeProfileSchema = z.object({
  ucp: z.object({
    payment_handlers: z.record(z.string(), z.array(z.object({ config: z.object({ pay_to: z.string() }).loose() }).loose())),
  }).loose(),
  keys: z.array(z.object({ kid: z.string() }).loose()).min(1),
}).loose();

export interface StoreAccounts {
  /** The signing account: the DID behind the profile's keys (`X-4`). */
  readonly operator: string;
  /** The payout account: the Stellar handler's `pay_to` (`X-4`). */
  readonly payee: string;
}

/**
 * The store's signing and payout accounts, read from its live UCP profile, so
 * an escrow is never deployed with an account the store does not use.
 */
export function storeAccountsFromProfile(profile: unknown, handlerId = "com.agentpey.stellar_x402"): StoreAccounts {
  const parsed = storeProfileSchema.safeParse(profile);
  if (!parsed.success) throw new AgentPassError("ConfigError", "the store's UCP profile does not have the expected shape", { details: { issues: z.treeifyError(parsed.error) } });
  const handler = parsed.data.ucp.payment_handlers[handlerId]?.[0];
  if (handler === undefined) throw new AgentPassError("ConfigError", `the store's profile declares no ${handlerId} handler`, { details: { handlerId } });

  const signers = new Set(parsed.data.keys.map((key) => /^did:stellar:testnet:(G[A-Z2-7]{55})#/.exec(key.kid)?.[1]));
  if (signers.size !== 1 || signers.has(undefined)) {
    throw new AgentPassError("ConfigError", "the store's keys do not name exactly one testnet signing account", { details: { kids: parsed.data.keys.map((key) => key.kid) } });
  }
  const operator = stellarAddressSchema.parse([...signers][0]);
  const payee = stellarAddressSchema.safeParse(handler.config.pay_to);
  if (!payee.success) throw new AgentPassError("ConfigError", "the store's pay_to is not a Stellar account", { details: { payTo: handler.config.pay_to } });
  if (payee.data === operator) throw new AgentPassError("ConfigError", "the store signs and collects with the same account; X-4 expects two", { details: { operator } });
  return { operator, payee: payee.data };
}

/** An order reference as the CLI takes `Bytes`: hex of its UTF-8. */
export function orderRefHex(orderRef: string): string {
  const bytes = Buffer.from(orderRef, "utf8");
  if (bytes.length === 0 || bytes.length > 64) throw new AgentPassError("InvalidArguments", "an order reference is 1 to 64 bytes", { details: { orderRef } });
  return bytes.toString("hex");
}
