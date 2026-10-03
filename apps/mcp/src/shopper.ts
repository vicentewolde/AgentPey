/**
 * What AgentPey's MCP server does for a chat (T128): find products in the
 * stores of the Vitrinee platform, quote one, pay the quote, read the order
 * and its receipt, and sign a refund claim. The MCP tools in `tools.ts` are a
 * thin face over this; everything that matters is here, and tested here.
 *
 * Money moves in exactly one place, `pay`, and only through `payUcpQuote`:
 * the store's profile and the checkout are read again, the requirement is
 * reconciled against the venue and the Mandate by `policyRail.authorise`, and
 * the payment leaves from the MCP's own `policy_rail`, whose limits the
 * network applies once more inside the transfer (`R-1`). The model never
 * chooses a recipient or an amount: they come from the store's checkout, and
 * the checkout is checked against what the store declares publicly.
 */
import { randomUUID } from "node:crypto";

import { AgentPassError, isAgentPassError, stellarAddressToDid, type Scope } from "@agentpass/core";
import {
  AGENTPEY_PLATFORM_PROFILE,
  payUcpQuote,
  quoteUcpCheckout,
  type ExecuteUcpPaymentDeps,
  type PolicyRail,
  type PurchaseIntent,
  type UcpDestination,
  type UcpPaymentReceipt,
  type VenueId,
  type VenueRegistry,
  mayHaveBeenPaid,
  parseVenueId,
  withPaymentSent,
} from "@agentpey/agent";
import type { AgentPayMandate } from "@agentpey/mandate";
import { CLAIM_REASONS, signClaim, type ClaimReason } from "@agentpey/resolve";
import { getUcpProduct, searchUcpStore, type ReceiptVerification } from "@vitrinee/anchor";
import { checkReceiptSignature, usdcAtomicToDecimal, type UcpProduct } from "@vitrinee/core";
import type { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";

import type { QuoteBook, QuoteEntry } from "./quotes.js";

export interface SignIntentInput {
  readonly venueId: VenueId;
  readonly registry: VenueRegistry;
  readonly productId: string;
  readonly quantity: number;
}

export interface ShopperDeps {
  /** The venue registry with the platform's current stores in it (`expandPlatformVenues`). */
  readonly venues: () => Promise<VenueRegistry>;
  /** The registry before expansion: a venue in `venues()` and not here is a platform store. */
  readonly fixedVenues: VenueRegistry;
  /** The agent signs a purchase intent for exactly this product and quantity (`create_purchase_intent`). */
  readonly signIntent: (input: SignIntentInput) => Promise<PurchaseIntent>;
  readonly scope: Scope;
  readonly mandate: AgentPayMandate;
  readonly policyRail: PolicyRail;
  /** How the payment leaves: the MCP's own rail (`payer`), signed by its owner key. */
  readonly payment: Pick<ExecuteUcpPaymentDeps, "signerSecret" | "payer" | "schemeForTests">;
  /** The rail's owner, which is also the agent: it signs claims over what the rail paid. */
  readonly agentKey: Keypair;
  readonly verifyReceipt: (jws: string) => Promise<ReceiptVerification>;
  readonly quotes: QuoteBook;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** One platform store, as a chat names it. */
export interface Store {
  /** Its host, e.g. `agentcommerce.vitrinee.agentpey.com`. */
  readonly name: string;
  readonly url: string;
  readonly venueId: VenueId;
  /** The payout account the platform's directory pins for this store: the one in its venue id. */
  readonly payTo: string;
}

export interface ProductHit {
  readonly store: string;
  readonly product_id: string;
  readonly title: string;
  readonly description: string;
  readonly price: { readonly amount: number; readonly currency: string };
  readonly available: boolean;
}

const destinationSchema = z.strictObject({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  street_address: z.string().trim().min(1).max(200),
  address_locality: z.string().trim().min(1).max(100),
  address_region: z.string().trim().min(1).max(100).optional(),
  address_country: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, e.g. CL"),
  postal_code: z.string().trim().min(1).max(20).optional(),
});

export const quoteInputSchema = z.strictObject({
  store: z.string().trim().min(1).max(200),
  product_id: z.string().trim().min(1).max(200),
  quantity: z.int().min(1).max(10).default(1),
  destination: destinationSchema,
  email: z.email().optional(),
});
export type QuoteInput = z.input<typeof quoteInputSchema>;

export const claimInputSchema = z.strictObject({
  store: z.string().trim().min(1).max(200),
  order_id: z.string().trim().min(1).max(200),
  reason: z.enum(CLAIM_REASONS),
  description: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(5).default([]),
});
export type ClaimInput = z.input<typeof claimInputSchema>;

/** What a UCP order says, as far as the MCP shows it. */
const orderSchema = z.looseObject({
  id: z.string(),
  checkout_id: z.string().optional(),
  currency: z.string().optional(),
  totals: z.array(z.looseObject({ type: z.string(), amount: z.number() })).optional(),
  line_items: z.array(z.looseObject({ quantity: z.unknown().optional(), item: z.looseObject({ id: z.string().optional(), title: z.string().optional() }).optional() })).optional(),
  adjustments: z.array(z.looseObject({ type: z.string(), status: z.string().optional() })).optional(),
  receipt: z
    .looseObject({
      jws: z.string(),
      hash: z.string(),
      settlement_tx_hash: z.string().optional(),
      verify_url: z.string().optional(),
      anchor: z.looseObject({ status: z.string() }).optional(),
      dispute: z.looseObject({ status: z.string() }).optional(),
    })
    .optional(),
});

function storeError(message: string, details: Record<string, unknown>): AgentPassError {
  return new AgentPassError("InvalidVenueId", message, { details });
}

export class Shopper {
  constructor(private readonly deps: ShopperDeps) {}

  /** Every store the platform's directory lists right now. */
  async stores(): Promise<{ registry: VenueRegistry; stores: Store[] }> {
    const registry = await this.deps.venues();
    const stores: Store[] = [];
    for (const [venueId, venue] of registry.venues) {
      if (this.deps.fixedVenues.venues.has(venueId) || venue.baseUrl === undefined) continue;
      // A platform merchant's pinned payee is the account in its venue id (`platforms.ts`).
      stores.push({ name: new URL(venue.baseUrl).host, url: venue.baseUrl, venueId, payTo: venue.payTo ?? parseVenueId(venueId).address });
    }
    return { registry, stores };
  }

  /**
   * A store by what a person calls it: its host, its URL, or the first label
   * of its host (`agentcommerce`). Exact matches only.
   */
  async store(name: string): Promise<{ registry: VenueRegistry; store: Store }> {
    const { registry, stores } = await this.stores();
    const wanted = (URL.canParse(name) ? new URL(name).host : name).toLowerCase();
    const found = stores.find((store) => store.name === wanted || store.name.split(".")[0] === wanted);
    if (found === undefined) {
      throw storeError("no store by that name in AgentPey's directory", { store: name, known: stores.map((store) => store.name) });
    }
    return { registry, store: found };
  }

  async searchProducts(input: { query: string; store?: string | undefined }): Promise<{ products: ProductHit[]; unavailable: string[] }> {
    const targets = input.store === undefined ? (await this.stores()).stores : [(await this.store(input.store)).store];
    const settled = await Promise.allSettled(
      targets.map(async (store) => {
        const found = await searchUcpStore(store.url, input.query, { agentProfile: AGENTPEY_PLATFORM_PROFILE, limit: 10, ...this.fetchOption() });
        return found.products.map((product) => hit(store, product));
      }),
    );
    const products: ProductHit[] = [];
    const unavailable: string[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") products.push(...outcome.value);
      else {
        unavailable.push(targets[index]!.name);
        this.log("store search failed", { store: targets[index]!.name, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
      }
    });
    return { products, unavailable };
  }

  async getProduct(input: { store: string; product_id: string }): Promise<ProductHit> {
    const { store } = await this.store(input.store);
    const product = await getUcpProduct(store.url, input.product_id, { agentProfile: AGENTPEY_PLATFORM_PROFILE, ...this.fetchOption() });
    if (product === null) throw new AgentPassError("ProductNotFound", "the store has no product with that id", { details: { store: store.name, productId: input.product_id } });
    return hit(store, product);
  }

  /**
   * Opens a checkout at the store and signs the agent's purchase intent for
   * it (a signed statement, not a payment). Moves no money. The quote says
   * what `pay` would pay, to whom, until when.
   */
  async quote(raw: QuoteInput) {
    const input = quoteInputSchema.parse(raw);
    const { registry, store } = await this.store(input.store);
    const intent = await this.deps.signIntent({ venueId: store.venueId, registry, productId: input.product_id, quantity: input.quantity });
    const destination: UcpDestination = input.destination;
    const quote = await quoteUcpCheckout(this.fetchOption(), {
      storeUrl: store.url,
      productId: input.product_id,
      quantity: input.quantity,
      buyer: { first_name: destination.first_name ?? "", last_name: destination.last_name ?? "", ...(input.email === undefined ? {} : { email: input.email }) },
      destination,
    });
    const entry = this.deps.quotes.issue({ quote, venueId: store.venueId, intent });
    this.log("quote issued", { quoteId: entry.id, store: store.name, checkoutId: quote.checkoutId, amountAtomic: quote.requirements.amount });
    return {
      quote_id: entry.id,
      store: store.name,
      product_id: input.product_id,
      quantity: input.quantity,
      total: quote.total,
      pays: {
        amount_usdc: usdcAtomicToDecimal(BigInt(quote.requirements.amount)),
        to: quote.requirements.payTo,
        network: quote.requirements.network,
        asset: quote.requirements.asset,
        from: this.deps.payment.payer?.contractId ?? null,
      },
      expires_at: entry.expiresAt.toISOString(),
    };
  }

  /**
   * Pays a quote, once, and only when the person confirmed it.
   *
   * @throws AgentPassError `ConfirmationRequired`, `QuoteNotFound`,
   * `QuoteExpired`, `QuoteChanged`, the rail's own refusal, or what
   * `payUcpQuote` throws.
   */
  async pay(input: { quote_id: string; confirm?: boolean | undefined }) {
    let entry: QuoteEntry;
    let registry: VenueRegistry;
    try {
      if (input.confirm !== true) {
        throw new AgentPassError("ConfirmationRequired", "pay only after the person confirmed this exact quote; call again with confirm: true", { details: { quoteId: input.quote_id } });
      }
      // Read before the quote is taken: a directory that is down leaves the quote payable.
      registry = await this.deps.venues();
      entry = this.deps.quotes.take(input.quote_id);
    } catch (error) {
      // Nothing was signed yet: say so, or the chat would be told money may have moved.
      throw withPaymentSent(error, false);
    }
    let paid: UcpPaymentReceipt;
    try {
      paid = await payUcpQuote(
        { policyRail: this.deps.policyRail, ...this.deps.payment, ...this.fetchOption() },
        entry.quote,
        {
          intent: entry.intent,
          scope: this.deps.scope,
          mandate: this.deps.mandate,
          venueId: entry.venueId,
          registry,
          idempotencyKey: `mcp-${entry.id}`,
          recheck: true,
        },
      );
    } catch (error) {
      // `authorise` reserved the day's budget. A payment that provably never
      // left gives it back (`C-113`); one that may have been sent stays counted.
      if (!mayHaveBeenPaid(error)) await this.release(entry.intent.intentId, error);
      throw error;
    }
    this.log("quote paid", { quoteId: entry.id, orderId: paid.orderId, transaction: paid.transaction ?? null });
    return {
      order_id: paid.orderId,
      checkout_id: paid.checkoutId,
      store: new URL(entry.quote.storeUrl).host,
      total: paid.total,
      paid_usdc: usdcAtomicToDecimal(BigInt(paid.paid.amount)),
      paid_to: paid.paid.payTo,
      transaction: paid.transaction ?? null,
      explorer_url: paid.transaction === undefined ? null : `https://stellar.expert/explorer/testnet/tx/${paid.transaction}`,
      receipt: paid.receipt === undefined ? null : { hash: paid.receipt.hash, verify_url: paid.receipt.verify_url, anchor: paid.receipt.anchor.status },
    };
  }

  /** The order as the store shows it, and its receipt checked independently of the store. */
  async getOrder(input: { store: string; order_id: string }) {
    const { store } = await this.store(input.store);
    const order = await this.readOrder(store, input.order_id);
    const receipt = order.receipt;
    const verification = receipt === undefined ? null : await this.deps.verifyReceipt(receipt.jws);
    const binding = receipt === undefined ? null : this.receiptBinding(store, order.id, receipt.jws);
    return {
      order_id: order.id,
      store: store.name,
      checkout_id: order.checkout_id ?? null,
      total: { amount: order.totals?.find((line) => line.type === "total")?.amount ?? null, currency: order.currency ?? null },
      items: (order.line_items ?? []).map((line) => ({ id: line.item?.id ?? null, title: line.item?.title ?? null, quantity: line.quantity ?? null })),
      dispute: receipt?.dispute?.status ?? null,
      receipt:
        receipt === undefined || verification === null
          ? null
          : {
              hash: receipt.hash,
              verify_url: receipt.verify_url ?? null,
              settlement_tx_hash: receipt.settlement_tx_hash ?? null,
              anchor: receipt.anchor?.status ?? null,
              valid: verification.valid && binding?.ok === true,
              checks: {
                order: { ok: binding?.ok === true, reason: binding?.reason ?? null },
                signature: { ok: verification.checks.signature.ok, reason: verification.checks.signature.reason ?? null },
                anchored: { ok: verification.checks.anchored.ok, reason: verification.checks.anchored.reason ?? null },
                settlement: { ok: verification.checks.settlement.ok, reason: verification.checks.settlement.reason ?? null },
              },
            },
    };
  }

  /**
   * Signs a refund claim over an order's receipt with the agent's key, the
   * owner of the rail that paid. It does not open the dispute: the arbiter
   * does, with its own key (`pnpm run resolve:open -- --claim <file>`).
   */
  async openClaim(raw: ClaimInput) {
    const input = claimInputSchema.parse(raw);
    const { store } = await this.store(input.store);
    const order = await this.readOrder(store, input.order_id);
    const jws = order.receipt?.jws;
    if (jws === undefined) throw new AgentPassError("InvalidArguments", "this order has no receipt to claim over", { details: { orderId: input.order_id } });
    const receipt = checkReceiptSignature(jws);
    if (!receipt.ok || receipt.claims === null) {
      throw new AgentPassError("InvalidArguments", "the order's receipt does not verify; a claim needs a valid receipt", { details: { orderId: input.order_id, reason: receipt.reason ?? null } });
    }
    const binding = this.receiptBinding(store, order.id, jws);
    if (!binding.ok) {
      throw new AgentPassError("InvalidArguments", `the store shows a receipt that is not this order's: ${binding.reason ?? ""}`, { details: { orderId: input.order_id } });
    }
    const signed = await signClaim(
      {
        type: "AgentResolveClaim",
        claimId: randomUUID(),
        claimant: stellarAddressToDid(this.deps.agentKey.publicKey(), "testnet"),
        receipt: { hash: receipt.hash, jws },
        reason: input.reason as ClaimReason,
        description: input.description,
        evidence: input.evidence.map((content) => ({ kind: /^https?:\/\//.test(content) ? ("url" as const) : ("text" as const), content })),
        amountAtomic: receipt.claims.amountUSDCAtomic,
        createdAt: new Date().toISOString(),
      },
      this.deps.agentKey,
    );
    this.log("claim signed", { claimHash: signed.hash, receiptHash: receipt.hash });
    return {
      claim_id: signed.document.claimId,
      claim_hash: signed.hash,
      receipt_hash: receipt.hash,
      amount_usdc: usdcAtomicToDecimal(BigInt(receipt.claims.amountUSDCAtomic)),
      claim_jws: signed.jws,
      next_step: "Send claim_jws to the AgentResolve arbiter, who opens the dispute on Stellar with: pnpm run resolve:open -- --claim <file with claim_jws>",
    };
  }

  private async release(intentId: string, cause: unknown): Promise<void> {
    try {
      await this.deps.policyRail.release({ intentId, reason: isAgentPassError(cause) ? cause.code : "UnexpectedError" });
    } catch (error) {
      // Nothing to release (refused before `authorise` reserved anything), or the ledger failed: never mask the refusal.
      this.log("spend not released", { intentId, error: isAgentPassError(error) ? error.code : error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Whether the receipt a store shows for an order is that order's receipt,
   * from that store: same order id, and issued by the payout account the
   * directory pins for the store. The three checks say a receipt is genuine;
   * this says it is the right one (T128).
   */
  private receiptBinding(store: Store, orderId: string, jws: string): { ok: boolean; reason: string | null } {
    const claims = checkReceiptSignature(jws).claims;
    if (claims === null) return { ok: false, reason: "the receipt cannot be read" };
    if (claims.orderId !== orderId) return { ok: false, reason: `the receipt is for order ${claims.orderId}, not ${orderId}` };
    if (claims.merchantAccount !== store.payTo) {
      return { ok: false, reason: "the receipt pays another merchant than the one AgentPey's directory lists for this store" };
    }
    return { ok: true, reason: null };
  }

  private async readOrder(store: Store, orderId: string): Promise<z.infer<typeof orderSchema>> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = `${store.url}/ucp/v1/orders/${encodeURIComponent(orderId)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json", "UCP-Agent": `profile="${AGENTPEY_PLATFORM_PROFILE}"` } });
    } catch (error) {
      throw new AgentPassError("NetworkError", "could not reach the store", { cause: error, details: { store: store.name } });
    }
    const parsed = orderSchema.safeParse(await res.json().catch(() => undefined));
    if (res.status === 404 || !parsed.success) {
      throw new AgentPassError("MerchantRejectedRequest", "the store has no order with that id", { details: { store: store.name, orderId, status: res.status } });
    }
    return parsed.data;
  }

  private fetchOption(): { fetchImpl?: typeof fetch } {
    return this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl };
  }

  private log(message: string, fields?: Record<string, unknown>): void {
    this.deps.log?.(message, fields);
  }
}

function hit(store: Store, product: UcpProduct): ProductHit {
  const variant = product.variants[0];
  return {
    store: store.name,
    product_id: product.id,
    title: product.title,
    description: product.description.plain ?? "",
    price: { amount: variant?.price.amount ?? product.price_range.min.amount, currency: variant?.price.currency ?? product.price_range.min.currency },
    available: variant?.availability?.available !== false,
  };
}
