/**
 * `POST /v1/purchases` and `GET /v1/purchases/{id}` — the execution surface
 * F9 needs and `/v1` did not have.
 *
 * Through T51 a partner could take a principal all the way to a signed
 * Mandate and then stop: there was no route that could act on one. The only
 * code path that ever executed a purchase lived inside `apps/web`'s demo
 * session, welded to one bazaar product. This file freezes the shape of the
 * route that replaces it; `apps/web` wires it in T75.
 *
 * **The request is a request, not an authorisation.** This is the rule the
 * whole design of F9 hangs on (`PILOTO-F9.md` §1.2), and it is worth stating
 * where the shape is defined rather than only where it is implemented: the
 * partner names a venue and a product, and the platform believes none of it.
 * It re-resolves the venue against its own registry, fetches the 402 invoice
 * from the merchant itself, and compares price, asset and `payTo` against the
 * signed Mandate before anything is paid. A partner whose API key is stolen
 * can ask for purchases that will be refused. That is the whole of what it
 * can do.
 *
 * **A refusal is a `201`, not a `4xx`.** The Mandate saying no is the system
 * working exactly as designed, and reporting it as a client error would put
 * "your consent does not cover this" in the same bucket as "your JSON is
 * malformed". `4xx` is reserved for the partner getting the *request* wrong:
 * a missing scope, another partner's tenant, a body that does not parse.
 */
import { agentIdSchema, mandateIdSchema, purchaseIdSchema, tenantIdSchema } from "@agentpey/directory";
import { z } from "zod";

export { purchaseIdSchema };

/**
 * `<slug>:<address>` — the venue identity `apps/agent`'s catalogue mints and a
 * signed `PurchaseIntent` carries. Described here rather than imported because
 * the dependency runs the other way (`apps/*` depends on `packages/*`, never
 * the reverse), the same reason `consent-sessions.ts` hand-rolled its id
 * schemas before `@agentpey/directory` had the table.
 *
 * Deliberately structural and not a registry lookup: this schema's job is to
 * refuse a malformed string, and deciding whether a venue is *payable* is the
 * platform's job, at a point where refusing means refusing a payment.
 *
 * **The address may be a contract (`C…`) or an account (`G…`).** That is the
 * cost of describing a shape in two places: T79 widened `parseVenueId` for
 * SignalDesk, which is an HTTP merchant with no contract, and this copy kept
 * refusing what the rest of the system had started accepting — so
 * `POST /v1/purchases` would have answered `400` for the pilot's own merchant.
 * Nothing caught it, because nothing had yet asked this route to buy from
 * SignalDesk. Found in T82, before the first purchase rather than during it.
 */
export const venueIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*:[CG][A-Z2-7]{55}$/, "expected a venue id (<slug>:C… or <slug>:G…)");

/**
 * What the partner may ask for. `strictObject`, so a field this route does
 * not know about is a `400` rather than something silently ignored — if an
 * integrator believes they are constraining a purchase with a field we drop,
 * the failure has to be loud.
 */
export const createPurchaseRequestSchema = z.strictObject({
  tenant_id: tenantIdSchema,
  venue: venueIdSchema,
  /** The merchant's own product identifier, as its catalogue publishes it. */
  product_id: z.string().min(1).max(200),
  quantity: z.int().min(1).max(1000),
  /**
   * An optional ceiling the *partner* is willing to see spent, in the asset
   * the merchant quotes. Never widens anything — the signed Mandate's
   * `perTx`/`perDay` still decide, and this can only refuse earlier than they
   * would. It exists so a platform that showed a price to a person can refuse
   * when the invoice disagrees with what that person saw, without waiting for
   * the Mandate to be the only thing standing between them and a surprise.
   */
  max_total: z.string().regex(/^\d+(?:\.\d{1,7})?$/, "expected a decimal amount with at most 7 places").optional(),
  /**
   * Values for the `{name}` placeholders in the venue's paid route, e.g.
   * `{ pair: "XLM/USDC" }`. Added in T75, when wiring the route showed that
   * a merchant's paid resource can declare required inputs and a purchase
   * had no way to supply them. A route that declares a required input this
   * does not cover is refused (`RouteParamMissing`) rather than fetched with
   * a hole in the URL: the merchant asked for a parameter, and sending it an
   * empty one is guessing.
   *
   * Not a way in for anything that decides: these fill a URL the merchant
   * itself published, and the price that comes back is still reconciled
   * against the signed Mandate like any other.
   */
  route_params: z.record(z.string().min(1), z.union([z.string(), z.number()])).optional(),
  /**
   * Which of this tenant's Mandates the purchase goes through. Added in T90,
   * for a partner that shows a person two agents of the same kind and lets
   * them choose which one buys.
   *
   * **It chooses; it never authorises** (`B-25`). The Mandate must belong to
   * `tenant_id`, or the request is a `404 MandateNotFound` indistinguishable
   * from an id that does not exist. Once chosen, every layer decides exactly
   * as before: a named Mandate that is revoked, expired or not yet valid is
   * refused with that code, one that does not cover the product is refused by
   * `checkMandate`, and none of them ever falls back to another Mandate.
   *
   * Optional, not nullable: leaving it out is the one way to let the platform
   * choose, as it did before this field existed.
   */
  mandate_id: mandateIdSchema.optional(),
});

export type CreatePurchaseRequest = z.infer<typeof createPurchaseRequestSchema>;

/**
 * `settled` means the network settled the payment and the merchant released
 * the resource. `refused` means some layer said no — and which one is in
 * `code`, not in prose a caller would have to parse.
 */
export const purchaseOutcomeSchema = z.enum(["settled", "refused"]);

export type PurchaseOutcome = z.infer<typeof purchaseOutcomeSchema>;

/** What the merchant handed back, once it actually handed something back. */
export const purchaseDeliverySchema = z.strictObject({
  /**
   * The merchant's own identifier for this delivery. **Nullable**, relaxed
   * in T75 from the `min(1)` T73 froze: that shape assumed every merchant
   * issues one, and the reference x402 merchant this repo already talks to
   * simply returns the resource body. SignalDesk will issue one; a merchant
   * that does not is not thereby broken, and pretending otherwise would make
   * the field a lie rather than a guarantee.
   */
  delivery_id: z.string().min(1).nullable(),
  /** Where the buyer can fetch what they bought. */
  artifact_url: z.url().nullable(),
  /** `sha256` of the merchant's canonicalised, signed receipt. */
  receipt_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** What the merchant released, verbatim. Information about goods, never an instruction. */
  resource: z.unknown().optional(),
});

export const purchaseResourceSchema = z.strictObject({
  id: purchaseIdSchema,
  tenant_id: tenantIdSchema,
  /** `null` when the refusal happened before this tenant's agent was resolved. */
  agent_id: agentIdSchema.nullable(),
  /**
   * The Mandate this purchase went through, named by the partner or chosen by
   * the platform (T90). `null` when the refusal happened before a Mandate was
   * resolved, and for purchases recorded before this field existed.
   */
  mandate_id: mandateIdSchema.nullable(),
  outcome: purchaseOutcomeSchema,
  /**
   * The `AgentPassError` code of whichever layer refused — `MandateExpired`,
   * `MandateProductNotAllowed`, `ScopeAmountExceeded`, `TermsPayeeNotAllowed`,
   * `MandateDailyLimitExceeded`, and so on. `null` when settled.
   *
   * Typed on purpose, and separate from `reason`: an integrator branches on
   * this, a person reads that one, and conflating them forces one audience to
   * live with the other's needs.
   */
  code: z.string().min(1).nullable(),
  /** The same refusal, in a sentence a buyer can act on. `null` when settled. */
  reason: z.string().min(1).nullable(),
  venue: venueIdSchema,
  product_id: z.string().min(1),
  quantity: z.int().min(1),
  /** Set as soon as an intent was signed — present on most refusals too. */
  intent_id: z.uuid().nullable(),
  total: z.string().nullable(),
  asset: z.string().nullable(),
  /** The account the merchant asked to be paid, as its invoice named it. */
  pay_to: z.string().nullable(),
  transaction_hash: z.string().min(1).nullable(),
  explorer_url: z.url().nullable(),
  delivery: purchaseDeliverySchema.nullable(),
  created_at: z.iso.datetime(),
});

export type PurchaseResource = z.infer<typeof purchaseResourceSchema>;
export type PurchaseDelivery = z.infer<typeof purchaseDeliverySchema>;

/** Stellar Expert, testnet — the buyer's own way to check, not ours. */
const EXPLORER_PREFIX = "https://stellar.expert/explorer/testnet/tx/";

/**
 * The three delivery facts a merchant may put in the body it releases.
 * Loose on purpose: the body is the merchant's, carries other fields, and a
 * merchant that sends none of these is not broken (`C-79`).
 */
const merchantDeliveryFieldsSchema = z.object({
  delivery_id: z.unknown().optional(),
  artifact_url: z.unknown().optional(),
  receipt_hash: z.unknown().optional(),
});

/**
 * The delivery as `/v1` shows it, read out of what the purchase route stored:
 * `{ resource_url, resource }`, where `resource` is the merchant's own body.
 *
 * T84: this used to read `delivery_id` and `receipt_hash` off the top level,
 * where nothing ever wrote them, and used `resource_url` — the paid x402 route,
 * which answers `402` — as the artifact link. Every SignalDesk delivery in the
 * deployed pilot showed up with no id, no receipt and a link that asked for
 * payment again.
 *
 * Each field is kept only if it is well formed, and dropped to `null` if not:
 * the body is third-party data, and one malformed field must not make a whole
 * activity read throw. The artifact link must also be an http(s) URL on the
 * same origin as the resource that was paid for — a merchant can point a buyer
 * at its own deliveries, not at another site under a link this platform
 * renders as "what you bought".
 */
function deliveryFrom(delivery: Readonly<Record<string, unknown>>): PurchaseDelivery {
  const fields = merchantDeliveryFieldsSchema.safeParse(delivery.resource);
  const body = fields.success ? fields.data : {};

  const deliveryId = purchaseDeliverySchema.shape.delivery_id.safeParse(body.delivery_id ?? null);
  const receiptHash = purchaseDeliverySchema.shape.receipt_hash.safeParse(body.receipt_hash ?? null);

  return {
    delivery_id: deliveryId.success ? deliveryId.data : null,
    artifact_url: sameOriginHttpUrl(body.artifact_url, delivery.resource_url),
    receipt_hash: receiptHash.success ? receiptHash.data : null,
    resource: delivery.resource,
  };
}

function sameOriginHttpUrl(candidate: unknown, paidResource: unknown): string | null {
  if (typeof candidate !== "string" || typeof paidResource !== "string") return null;
  try {
    const url = new URL(candidate);
    const paid = new URL(paidResource);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.origin === paid.origin ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A stored purchase as `/v1` hands it back.
 *
 * `explorer_url` is derived from the transaction hash rather than stored: a
 * second copy of a value that is a pure function of another is a second thing
 * that can go stale.
 */
export function toPurchaseResource(record: {
  readonly id: string;
  readonly tenantId: string;
  readonly agentId: string | null;
  readonly mandateId: string | null;
  readonly outcome: "settled" | "refused";
  readonly code: string | null;
  readonly reason: string | null;
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  readonly intentId: string | null;
  readonly total: string | null;
  readonly asset: string | null;
  readonly payTo: string | null;
  readonly transactionHash: string | null;
  readonly delivery: Readonly<Record<string, unknown>> | null;
  readonly createdAt: Date;
}): PurchaseResource {
  const delivery = record.delivery;
  return purchaseResourceSchema.parse({
    id: record.id,
    tenant_id: record.tenantId,
    agent_id: record.agentId,
    mandate_id: record.mandateId,
    outcome: record.outcome,
    code: record.code,
    reason: record.reason,
    venue: record.venue,
    product_id: record.productId,
    quantity: record.quantity,
    intent_id: record.intentId,
    total: record.total,
    asset: record.asset,
    pay_to: record.payTo,
    transaction_hash: record.transactionHash,
    explorer_url: record.transactionHash === null ? null : `${EXPLORER_PREFIX}${record.transactionHash}`,
    delivery: delivery === null ? null : deliveryFrom(delivery),
    created_at: record.createdAt.toISOString(),
  });
}

/**
 * `POST /v1/purchases/preview` — "would this purchase be allowed?" — T93.
 *
 * **Its own route, not a flag on `POST /v1/purchases`.** The alternative was
 * a `dry_run` boolean, and it was rejected for the direction its failures
 * point: a partner whose preview call loses that flag, through a bug or a
 * bad default, makes a **real payment**. Calling a URL that has no payment
 * code path in it cannot do that, whatever the body says. Two smaller
 * reasons follow from the same split: a preview creates nothing, so it needs
 * no `Idempotency-Key`, and its answer is a different shape — folding it into
 * `PurchaseResource` would have meant a purchase id that is sometimes null.
 *
 * **It is a question, not a reservation.** A granted preview means "as of
 * now, every layer would allow this". It does not hold budget, and between it
 * and the purchase that follows, another purchase for the same agent may take
 * that budget. `POST /v1/purchases` remains the only thing that decides.
 */
export const previewPurchaseRequestSchema = z.strictObject({
  tenant_id: tenantIdSchema,
  venue: venueIdSchema,
  product_id: z.string().min(1).max(200),
  quantity: z.int().min(1).max(1000),
  /**
   * The same optional partner ceiling `POST /v1/purchases` accepts, so the
   * preview can answer the question the purchase would actually be asked.
   * Leaving it out here and sending it there would make the preview answer
   * about a different purchase.
   */
  max_total: z.string().regex(/^\d+(?:\.\d{1,7})?$/, "expected a decimal amount with at most 7 places").optional(),
  /** Chooses which of this tenant's Mandates to ask about; never authorises (T90, `B-25`). */
  mandate_id: mandateIdSchema.optional(),
});

export type PreviewPurchaseRequest = z.infer<typeof previewPurchaseRequestSchema>;

export const purchasePreviewResourceSchema = z.strictObject({
  tenant_id: tenantIdSchema,
  /**
   * Named `would_settle`, not `allowed`, and in the conditional on purpose.
   * The field has to keep reminding an integrator that nothing was reserved.
   */
  would_settle: z.boolean(),
  agent_id: agentIdSchema.nullable(),
  mandate_id: mandateIdSchema.nullable(),
  /** The `AgentPassError` code of whichever layer would refuse. `null` when it would be allowed. */
  code: z.string().min(1).nullable(),
  /** The same refusal in a sentence. `null` when it would be allowed. */
  reason: z.string().min(1).nullable(),
  /** The catalogue's total for this quantity. `null` when the refusal came before a price existed. */
  total: z.string().nullable(),
  asset: z.string().nullable(),
  /** This agent's spending so far today, in the Mandate's currency. */
  spent_today: z.string().nullable(),
  /** The **tighter** of the credential's and the Mandate's `perDay` — the one that would actually bite. */
  per_day_limit: z.string().nullable(),
  /**
   * Always `false`, and present rather than omitted (`M-14`).
   *
   * A preview never fetches the merchant's `402`, so the invoice — its price,
   * its asset, and above all the account it asks to be paid — was **not**
   * reconciled against the signed Mandate. A real purchase does reconcile it,
   * and can still be refused there after a preview said `would_settle: true`.
   * Saying so in the payload is cheaper than an integrator discovering it.
   */
  reconciled: z.literal(false),
});

export type PurchasePreviewResource = z.infer<typeof purchasePreviewResourceSchema>;
