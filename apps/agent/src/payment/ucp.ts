/**
 * Paying a UCP checkout on Stellar (T122, Fase 7, E-1): the buyer's side of
 * the `com.agentpey.stellar_x402` payment handler.
 *
 * The twin of {@link executeBazaarPayment}, with the same guarantees in the
 * same order. What differs is only how the price arrives and how the payment
 * leaves: the payment requirements come from the checkout session's handler
 * config instead of an HTTP 402, and the signed payload goes back in the body
 * of Complete Checkout instead of a `PAYMENT-SIGNATURE` header.
 *
 * **Before anything is signed**, three independent checks, in this order:
 *
 * 1. The requirements name the same recipient, asset and network as the
 *    handler the store declares at its `/.well-known/ucp` (the handler spec's
 *    step 2). The checkout response alone is not enough: the store writes it.
 * 2. `toPaymentTerms` pins the recipient to the venue's own account and maps
 *    the asset through the venue registry, as for any x402 venue.
 * 3. `policyRail.authorise` reconciles them against the signed intent, the
 *    scope and the Mandate. Untouched by this module (P-14).
 *
 * Paying from a `policy_rail`, the network then checks `perTx`/`perDay` a
 * fourth time, inside the transfer.
 *
 * Nothing in this file knows Vitrinee: it speaks UCP and the handler spec, so
 * any business that declares the handler can be paid the same way (C-88).
 */
import { AgentPassError } from "@agentpass/core";
import type { Scope } from "@agentpass/core";
import type { AgentPayMandate } from "@agentpey/mandate";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ExactStellarScheme, STELLAR_TESTNET_CAIP2, createEd25519Signer } from "@x402/stellar";
import { z } from "zod";

import { DEFAULT_VENUE_REGISTRY } from "../catalog/default-registry.js";
import type { VenueId } from "../catalog/ids.js";
import type { VenueRegistry } from "../catalog/registry.js";
import type { PurchaseIntent } from "../intent/intent.js";
import { policyRailError, type PolicyRail } from "../policy/policy-rail.js";
import { PolicyRailStellarScheme, type PolicyRailPayer } from "./policy-rail-payer.js";
import { spendControlsFor, toPaymentTerms, withPaymentSent } from "./x402.js";

export const UCP_VERSION = "2026-04-08";
export const STELLAR_X402_HANDLER = "com.agentpey.stellar_x402";
/** AgentPey's platform profile, sent with every request as UCP asks. */
export const AGENTPEY_PLATFORM_PROFILE = "https://agentpey.com/ucp/platform/agentpey.json";

const reverseDomain = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

// ---------------------------------------------------------------- wire shapes

const declaration = z.looseObject({ version: z.string(), spec: z.string().optional(), schema: z.string().optional(), config: z.unknown().optional() });

const profileSchema = z.looseObject({
  ucp: z.looseObject({
    version: z.string(),
    services: z.record(z.string().regex(reverseDomain), z.array(declaration.extend({ transport: z.string(), endpoint: z.string().optional() }))),
    capabilities: z.record(z.string().regex(reverseDomain), z.array(declaration)).optional(),
    payment_handlers: z.record(z.string().regex(reverseDomain), z.array(declaration.extend({ id: z.string() }))),
  }),
});

const handlerConfigSchema = z.looseObject({
  x402_version: z.literal(2),
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.looseObject({ code: z.string(), contract: z.string().regex(/^C[A-Z2-7]{55}$/), decimals: z.number().int() }),
  pay_to: z.string().regex(/^G[A-Z2-7]{55}$/),
});

const requirementsSchema = z.looseObject({
  scheme: z.literal("exact"),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const messageSchema = z.looseObject({ type: z.string(), code: z.string().optional(), content: z.string().optional(), severity: z.string().optional() });

const checkoutSchema = z.looseObject({
  ucp: z.looseObject({ payment_handlers: z.record(z.string(), z.array(z.looseObject({ id: z.string(), config: z.unknown().optional() }))).optional() }),
  id: z.string().min(1),
  status: z.string(),
  currency: z.string(),
  totals: z.array(z.looseObject({ type: z.string(), amount: z.number() })),
  messages: z.array(messageSchema).optional(),
  order: z.looseObject({ id: z.string(), permalink_url: z.string() }).optional(),
  receipt: z
    .looseObject({
      jws: z.string(),
      hash: z.string(),
      settlement_tx_hash: z.string(),
      verify_url: z.string(),
      anchor: z.looseObject({ status: z.string(), registry: z.string() }),
    })
    .optional(),
});
type UcpCheckout = z.infer<typeof checkoutSchema>;

// ---------------------------------------------------------------- public API

export interface UcpDestination {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly street_address: string;
  readonly address_locality: string;
  readonly address_region?: string;
  /** ISO 3166-1 alpha-2. */
  readonly address_country: string;
  readonly postal_code?: string;
}

export interface ExecuteUcpPaymentDeps {
  readonly policyRail: PolicyRail;
  /** The agent's own Stellar secret key, when it pays from its classic account. */
  readonly signerSecret: string;
  /** When set, the `policy_rail` smart account pays, and the network enforces its limits. */
  readonly payer?: PolicyRailPayer;
  readonly fetchImpl?: typeof fetch;
  /** Tests only: the scheme that builds the payment, in place of the real Stellar one. */
  readonly schemeForTests?: SchemeNetworkClient;
}

export interface ExecuteUcpPaymentInput {
  /** The store's origin: where its `/.well-known/ucp` is. */
  readonly storeUrl: string;
  readonly productId: string;
  readonly quantity: number;
  readonly buyer?: { readonly email?: string; readonly first_name?: string; readonly last_name?: string };
  readonly destination: UcpDestination;
  /** The already-signed intent this payment is for. */
  readonly intent: PurchaseIntent;
  readonly scope: Scope;
  readonly mandate: AgentPayMandate;
  readonly venueId: VenueId;
  readonly registry?: VenueRegistry;
  /** Sent on Complete Checkout, so a retried request cannot pay twice. */
  readonly idempotencyKey?: string;
}

export interface UcpPaymentReceipt {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly permalinkUrl: string;
  /** The store's total, in its own currency's minor units. */
  readonly total: { readonly amount: number; readonly currency: string };
  /** What was paid: the requirements `authorise()` reconciled. */
  readonly paid: { readonly amount: string; readonly asset: string; readonly payTo: string };
  readonly transaction: string | undefined;
  readonly receipt: NonNullable<UcpCheckout["receipt"]> | undefined;
}

function networkError(message: string, details: Record<string, unknown>, cause?: unknown): AgentPassError {
  return new AgentPassError("NetworkError", message, { cause, details });
}

function authorityOf(name: string): string {
  const [tld, domain] = name.split(".");
  return `${domain ?? ""}.${tld ?? ""}`;
}

/** UCP's spec-URL binding: HTTPS, default port, exactly the name's domain. */
export function originMatchesNamespace(name: string, url: string | undefined): boolean {
  if (url === undefined || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.port === "" && parsed.hostname === authorityOf(name);
}

/**
 * Pays one product at a UCP store with the Stellar x402 handler.
 *
 * @throws AgentPassError `MerchantRejectedRequest` when the store does not
 * declare the handler properly, or does not make the checkout ready.
 * @throws AgentPassError `InvalidProduct` when the requirements disagree with
 * the store's profile or the venue's pinned account.
 * @throws AgentPassError with the rail's own code when `authorise()` refuses.
 * @throws AgentPassError `NetworkError` for anything network-shaped, and when
 * the store does not confirm the completed checkout.
 * Every error carries `paymentSent` (`C-113`): whether a signed payment may
 * have left this process.
 */
export async function executeUcpPayment(deps: ExecuteUcpPaymentDeps, input: ExecuteUcpPaymentInput): Promise<UcpPaymentReceipt> {
  let paymentSent = false;
  try {
    return await payAndMark();
  } catch (error) {
    throw withPaymentSent(error, paymentSent);
  }

  async function payAndMark(): Promise<UcpPaymentReceipt> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const origin = input.storeUrl.replace(/\/+$/, "");
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { accept: "application/json", "UCP-Agent": `profile="${AGENTPEY_PLATFORM_PROFILE}"`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw networkError("could not reach the UCP store", { url }, error);
      }
      const json: unknown = await res.json().catch(() => undefined);
      return { status: res.status, json };
    };

    // 1. The store's profile: where to talk to it, and where the money goes.
    const profileReply = await call("GET", `${origin}/.well-known/ucp`);
    const profile = profileSchema.safeParse(profileReply.json);
    if (profileReply.status !== 200 || !profile.success) {
      throw new AgentPassError("MerchantRejectedRequest", "the store does not publish a UCP business profile", { details: { storeUrl: origin, status: profileReply.status } });
    }
    const [handler] = profile.data.ucp.payment_handlers[STELLAR_X402_HANDLER] ?? [];
    if (handler === undefined || !originMatchesNamespace(STELLAR_X402_HANDLER, handler.spec) || !originMatchesNamespace(STELLAR_X402_HANDLER, handler.schema)) {
      throw new AgentPassError("MerchantRejectedRequest", `the store does not declare ${STELLAR_X402_HANDLER} with its spec on agentpey.com`, { details: { storeUrl: origin } });
    }
    const declared = handlerConfigSchema.safeParse(handler.config);
    if (!declared.success) {
      throw new AgentPassError("MerchantRejectedRequest", "the store's Stellar x402 handler config is malformed", { details: { storeUrl: origin } });
    }
    const endpoint = profile.data.ucp.services["dev.ucp.shopping"]?.find((service) => service.transport === "rest")?.endpoint;
    if (endpoint === undefined || !URL.canParse(endpoint) || new URL(endpoint).origin !== new URL(origin).origin) {
      throw new AgentPassError("MerchantRejectedRequest", "the store declares no REST endpoint of its own", { details: { storeUrl: origin } });
    }

    // 2. The checkout: what exactly this purchase costs.
    const created = await call("POST", `${endpoint}/checkout-sessions`, {
      line_items: [{ item: { id: input.productId }, quantity: input.quantity }],
      ...(input.buyer === undefined ? {} : { buyer: input.buyer }),
      fulfillment: { methods: [{ type: "shipping", destinations: [input.destination] }] },
    });
    const checkout = checkoutSchema.safeParse(created.json);
    if (!checkout.success || created.status >= 300) {
      throw new AgentPassError("MerchantRejectedRequest", "the store did not open a checkout for this product", {
        details: { storeUrl: origin, status: created.status, messages: messagesOf(created.json) },
      });
    }
    if (checkout.data.status !== "ready_for_complete") {
      throw new AgentPassError("MerchantRejectedRequest", "the store's checkout is not ready to pay", {
        details: { checkoutId: checkout.data.id, status: checkout.data.status, messages: checkout.data.messages ?? [] },
      });
    }
    const resolved = z
      .looseObject({ payment_requirements: requirementsSchema, binding: z.looseObject({ checkout_id: z.string() }) })
      .safeParse(checkout.data.ucp.payment_handlers?.[STELLAR_X402_HANDLER]?.[0]?.config);
    if (!resolved.success || resolved.data.binding.checkout_id !== checkout.data.id) {
      throw new AgentPassError("MerchantRejectedRequest", "the checkout carries no payment requirements for this session", { details: { checkoutId: checkout.data.id } });
    }
    const requirements = resolved.data.payment_requirements as unknown as PaymentRequirements;

    // 3. Before signing: the requirements agree with what the store declared publicly…
    if (requirements.payTo !== declared.data.pay_to || requirements.asset !== declared.data.asset.contract || requirements.network !== declared.data.network) {
      throw new AgentPassError("InvalidProduct", "the checkout asks to pay someone or something other than the store's declared handler", {
        details: { checkoutId: checkout.data.id, payTo: requirements.payTo, declaredPayTo: declared.data.pay_to, asset: requirements.asset, network: requirements.network },
      });
    }
    // …with the venue's pinned account and assets, and with the Mandate.
    const terms = toPaymentTerms(requirements, input.venueId, input.registry ?? DEFAULT_VENUE_REGISTRY);
    const decision = await deps.policyRail.authorise({ intent: input.intent, scope: input.scope, mandate: input.mandate, terms });
    if (!decision.authorised) throw policyRailError(decision);

    // 4. Sign exactly the authorised requirement, capped at its own amount.
    const scheme =
      deps.schemeForTests ??
      (deps.payer === undefined ? new ExactStellarScheme(createEd25519Signer(deps.signerSecret, STELLAR_TESTNET_CAIP2)) : new PolicyRailStellarScheme(deps.payer));
    const client = x402Client.fromConfig({ schemes: [{ network: STELLAR_TESTNET_CAIP2, client: scheme }] });
    client.setSpendControls(spendControlsFor(requirements));
    const completeUrl = `${endpoint}/checkout-sessions/${encodeURIComponent(checkout.data.id)}/complete`;
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: completeUrl, description: `UCP checkout ${checkout.data.id}`, mimeType: "application/json" },
      accepts: [requirements],
    };
    const payload = await new x402HTTPClient(client).createPaymentPayload(paymentRequired);
    const transaction = (payload.payload as { transaction?: unknown }).transaction;
    if (typeof transaction !== "string") throw new AgentPassError("PaymentNotCreated", "the payment scheme produced no transaction", { details: {} });

    // The door. From here on money may have moved.
    paymentSent = true;
    const completed = await call(
      "POST",
      completeUrl,
      {
        payment: {
          instruments: [
            {
              id: "instr_1",
              handler_id: handler.id,
              type: "stellar_x402",
              selected: true,
              credential: { type: "x402_payment_payload", x402_version: 2, accepted: payload.accepted, payload: { transaction } },
            },
          ],
        },
      },
      input.idempotencyKey === undefined ? {} : { "Idempotency-Key": input.idempotencyKey },
    );
    const done = checkoutSchema.safeParse(completed.json);
    if (!done.success || done.data.status !== "completed" || done.data.order === undefined) {
      throw networkError("the store did not confirm the completed checkout", {
        checkoutId: checkout.data.id,
        status: completed.status,
        checkoutStatus: done.success ? done.data.status : undefined,
        messages: messagesOf(completed.json),
      });
    }
    const total = done.data.totals.find((line) => line.type === "total");
    return {
      checkoutId: done.data.id,
      orderId: done.data.order.id,
      permalinkUrl: done.data.order.permalink_url,
      total: { amount: total?.amount ?? 0, currency: done.data.currency },
      paid: { amount: requirements.amount, asset: requirements.asset, payTo: requirements.payTo },
      transaction: done.data.receipt?.settlement_tx_hash,
      receipt: done.data.receipt,
    };
  }
}

function messagesOf(json: unknown): unknown[] {
  const messages = (json as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? messages.slice(0, 5) : [];
}
