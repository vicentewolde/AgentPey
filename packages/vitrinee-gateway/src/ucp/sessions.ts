/**
 * UCP checkout sessions (T122): what a platform created with
 * `POST /checkout-sessions` and completes later. They live next to the
 * orders: in Postgres on the platform (one row per session, scoped to its
 * comercio), in memory for the single-store gateway and the tests.
 *
 * A session stores its own quote and the exact x402 payment requirements it
 * handed the platform. `complete` settles against those stored requirements,
 * never against a fresh quote, so the platform signs for exactly what it saw.
 */
import { randomBytes } from "node:crypto";

import { VitrineeError } from "@vitrinee/core";
import { z } from "zod";

export const CHECKOUT_SESSION_STATUSES = ["incomplete", "ready_for_complete", "complete_in_progress", "completed", "canceled"] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

/** Six hours, UCP's default session lifetime. */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const addressSchema = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  street_address: z.string().max(300).optional(),
  extended_address: z.string().max(300).optional(),
  address_locality: z.string().max(100).optional(),
  address_region: z.string().max(100).optional(),
  address_country: z.string().regex(/^[A-Z]{2}$/).optional(),
  postal_code: z.string().max(20).optional(),
  phone_number: z.string().max(40).optional(),
});
export type UcpAddress = z.infer<typeof addressSchema>;

/** The x402 PaymentRequirements handed to the platform, kept verbatim. */
export const storedRequirementsSchema = z.looseObject({
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type StoredRequirements = z.infer<typeof storedRequirementsSchema>;

export const checkoutSessionSchema = z.object({
  id: z.string().regex(/^cs_[0-9a-z]+$/),
  status: z.enum(CHECKOUT_SESSION_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  buyer: z.object({
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    email: z.string().max(200).optional(),
    phone_number: z.string().max(40).optional(),
  }),
  destination: addressSchema.extend({ id: z.string().max(100) }).nullable(),
  /** The quote the requirements were built from, so a price change is noticed before charging. */
  quote: z
    .object({
      unitAtomic: z.string().regex(/^\d+$/),
      totalAtomic: z.string().regex(/^\d+$/),
      totalLocal: z.string(),
      currency: z.string(),
      fx: z.object({ base: z.literal("USD"), quote: z.string(), rate: z.string(), asOf: z.string() }),
      /** What the order is created from once paid, without asking the store again. */
      productSku: z.string(),
      productName: z.string(),
    })
    .nullable(),
  requirements: storedRequirementsSchema.nullable(),
  /** The signed transaction a `complete` settled or is settling. Set before settlement, so a retry finds it. */
  paymentKey: z.string().nullable(),
  completeIdempotencyKey: z.string().nullable(),
  orderId: z.string().nullable(),
  /**
   * The settlement, persisted the moment the facilitator confirms it and before
   * the order is created: a `complete` that failed after paying finishes from
   * here, never by settling again.
   */
  settlement: z
    .object({
      txHash: z.string(),
      network: z.string(),
      payer: z.string().optional(),
      payTo: z.string(),
      asset: z.string(),
      amountAtomic: z.string().regex(/^\d+$/),
      settledAt: z.string(),
    })
    .nullable()
    .default(null),
  /**
   * A settlement whose outcome is unknown (timeout, network error, a broadcast
   * transaction the facilitator gave up on). The checkout stays
   * `complete_in_progress` and is never settled again until someone reconciles it.
   */
  settleAttempt: z.object({ transaction: z.string().nullable(), error: z.string(), at: z.string() }).nullable().default(null),
  /**
   * AP2 (T134, R-15): set when the session is created with the extension
   * negotiated, and never cleared. From then on the checkout is security
   * locked: every 2026-08-25 response is signed, and `complete` needs a mandate
   * from this same platform profile, whatever a later request negotiates.
   * `mandate` is the closed mandate the charge was made under, kept as evidence.
   */
  ap2: z
    .object({ platformProfile: z.string().max(2_048), mandate: z.string().max(32_000).nullable() })
    .nullable()
    .default(null),
  /**
   * Where the platform that completes this checkout wants the order's events
   * (T147): its profile's `webhook_url`, read at `complete` and handed to the
   * order once it exists. Unvetted here; every delivery vets it again.
   */
  webhook: z
    .object({ url: z.string().max(2_048), platformProfile: z.string().max(2_048), version: z.enum(["2026-04-08", "2026-08-25"]), origin: z.string().max(2_048) })
    .nullable()
    .default(null),
});
export type CheckoutSession = z.infer<typeof checkoutSessionSchema>;

export interface CheckoutSessionPersistence {
  get(id: string): Promise<CheckoutSession | undefined>;
  save(session: CheckoutSession): Promise<void>;
}

/** Sessions of one process, gone on restart. The single-store gateway and the tests use it. */
export class MemoryCheckoutSessions implements CheckoutSessionPersistence {
  private readonly sessions = new Map<string, CheckoutSession>();

  async get(id: string): Promise<CheckoutSession | undefined> {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : structuredClone(session);
  }

  async save(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(checkoutSessionSchema.parse(session)));
  }
}

export function newSessionId(now: Date): string {
  return `cs_${now.getTime().toString(36)}${randomBytes(10).toString("hex")}`;
}

/** Parses a stored row back into a session. @throws VitrineeError `StorageError` for a row that no longer fits. */
export function sessionFromRecord(id: string, record: unknown): CheckoutSession {
  const parsed = checkoutSessionSchema.safeParse(record);
  if (!parsed.success) {
    throw new VitrineeError("StorageError", "a checkout session row does not have the expected shape", { details: { id } });
  }
  return parsed.data;
}
