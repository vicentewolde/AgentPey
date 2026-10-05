/**
 * What crosses a border, as zod reads it: what a store publishes and answers,
 * and what a caller hands in. Moved out of the AgentPey agent in T136, so the
 * agent and this package refuse exactly the same answers.
 *
 * Store answers are read with `looseObject`: UCP lets a store add members, and
 * the checkout a payment closes over must keep every byte the store sent.
 */
import { z } from "zod";

/** The payment handler this package pays with (Fase 7, E-1). */
export const STELLAR_X402_HANDLER = "com.agentpey.stellar_x402";
/** The only network this package pays on: mainnet is out of scope. */
export const STELLAR_TESTNET = "stellar:testnet";
/** The most lines one checkout carries, as the stores take them. */
export const MAX_UCP_LINES = 10;

export const reverseDomain = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

const declaration = z.looseObject({ version: z.string(), spec: z.string().optional(), schema: z.string().optional(), config: z.unknown().optional() });

/** A store's `/.well-known/ucp`, as far as paying it needs. */
export const ucpBusinessProfileSchema = z.looseObject({
  ucp: z.looseObject({
    version: z.string(),
    services: z.record(z.string().regex(reverseDomain), z.array(declaration.extend({ transport: z.string(), endpoint: z.string().optional() }))),
    capabilities: z.record(z.string().regex(reverseDomain), z.array(declaration)).optional(),
    payment_handlers: z.record(z.string().regex(reverseDomain), z.array(declaration.extend({ id: z.string() }))),
  }),
  keys: z.array(z.unknown()).optional(),
});
export type UcpBusinessProfile = z.infer<typeof ucpBusinessProfileSchema>;

/** The Stellar x402 handler's business config: where the money goes, in what, on which network. */
export const handlerConfigSchema = z.looseObject({
  x402_version: z.literal(2),
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.looseObject({ code: z.string(), contract: z.string().regex(/^C[A-Z2-7]{55}$/), decimals: z.number().int() }),
  pay_to: z.string().regex(/^G[A-Z2-7]{55}$/),
});
export type StellarX402HandlerConfig = z.infer<typeof handlerConfigSchema>;

export const requirementsSchema = z.looseObject({
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const messageSchema = z.looseObject({ type: z.string(), code: z.string().optional(), content: z.string().optional(), severity: z.string().optional() });

export const receiptSchema = z.looseObject({
  jws: z.string(),
  hash: z.string(),
  settlement_tx_hash: z.string(),
  verify_url: z.string(),
  anchor: z.looseObject({ status: z.string(), registry: z.string() }),
});
export type UcpReceipt = z.infer<typeof receiptSchema>;

export const checkoutSchema = z.looseObject({
  ucp: z.looseObject({ payment_handlers: z.record(z.string(), z.array(z.looseObject({ id: z.string(), config: z.unknown().optional() }))).optional() }),
  id: z.string().min(1),
  status: z.string(),
  currency: z.string(),
  totals: z.array(z.looseObject({ type: z.string(), amount: z.number() })),
  messages: z.array(messageSchema).optional(),
  order: z.looseObject({ id: z.string(), permalink_url: z.string() }).optional(),
  receipt: receiptSchema.optional(),
});
export type UcpCheckout = z.infer<typeof checkoutSchema>;

/** The lines a checkout says it is for: what the store will charge and ship, read from its own answer. */
export const checkoutLinesSchema = z.array(z.looseObject({ item: z.looseObject({ id: z.string().min(1) }), quantity: z.int().positive() })).min(1);

// ---------------------------------------------------------------- caller input

/** HTTPS, or plain HTTP on a loopback host (a store running on this machine, for tests). */
export const storeUrlSchema = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback);
}, "an https URL (http only on localhost)");

export const lineSchema = z.object({ productId: z.string().min(1), quantity: z.int().positive() });
export type UcpLine = z.infer<typeof lineSchema>;

export const destinationSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  street_address: z.string().min(1),
  address_locality: z.string().min(1),
  address_region: z.string().min(1).optional(),
  /** ISO 3166-1 alpha-2. */
  address_country: z.string().regex(/^[A-Za-z]{2}$/),
  postal_code: z.string().min(1).optional(),
});
export type UcpDestination = z.infer<typeof destinationSchema>;

export const buyerSchema = z.object({
  email: z.email().optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  /** UCP's buyer consent extension, in the shape of the version the store answers in; sent as given. */
  consent: z.record(z.string(), z.unknown()).optional(),
});
export type UcpBuyer = z.infer<typeof buyerSchema>;

const oneProduct = z.object({ productId: z.string().min(1), quantity: z.int().positive(), lines: z.undefined().optional() });
const cart = z.object({ lines: z.array(lineSchema).min(1).max(MAX_UCP_LINES), productId: z.undefined().optional(), quantity: z.undefined().optional() });

export const quoteInputSchema = z.intersection(
  z.union([oneProduct, cart]),
  z.object({ storeUrl: storeUrlSchema, buyer: buyerSchema.optional(), destination: destinationSchema }),
);

/** What {@link pay} needs of a quote: enough to read it again and pay exactly it. */
export const payableQuoteSchema = z.looseObject({
  storeUrl: storeUrlSchema,
  endpoint: storeUrlSchema,
  handlerId: z.string().min(1),
  checkoutId: z.string().min(1),
  lines: z.array(lineSchema).min(1).max(MAX_UCP_LINES),
  requirements: requirementsSchema,
  checkout: z.record(z.string(), z.unknown()),
  asset: z.looseObject({ code: z.string(), contract: z.string(), decimals: z.number().int().min(0).max(38) }).optional(),
});
