/**
 * Jumpseller store adapter.
 *
 * Reads the catalogue and creates paid orders over the REST API v1. The order
 * is written in three calls, which is what the API offers (VT-11): create,
 * then annotate with the settlement hash, then leave a line in the order's
 * history. Only the first one is allowed to fail the checkout — by the time
 * it succeeds the buyer has already paid, so a failed annotation degrades to
 * a warning rather than throwing money away.
 */
import { VitrineeError, currencyDecimals } from "@vitrinee/core";

import { orderTotalLocal, platformLines, resolveOrderLines } from "../lines.js";

import type { CreateOrderInput, PlatformOrder, Product, StoreAdapter } from "../types.js";
import { JumpsellerClient, JumpsellerHttpError } from "./client.js";
import type { JumpsellerClientOptions, JumpsellerCredentials } from "./client.js";
import type { JumpsellerOrder, JumpsellerOrderEnvelope, JumpsellerProductEnvelope } from "./map.js";
import { apiNumberFromDecimal, decimalFromApiNumber, isSellable, toProduct } from "./map.js";

export { JumpsellerClient, JumpsellerHttpError } from "./client.js";
export type { JumpsellerCredentials } from "./client.js";

const PAGE_SIZE = 100;
/** Jumpseller caps a page at 100; more than this many pages means something is wrong. */
const MAX_PAGES = 20;

export interface JumpsellerAdapterOptions extends Omit<JumpsellerClientOptions, "credentials"> {
  credentials: JumpsellerCredentials;
  /** The store's own currency. Must match the gateway's; CLP for this demo. */
  currency?: string;
  /**
   * What the order records as its shipping method. Jumpseller accepts a free
   * name and price instead of a configured method id, so the gateway declares
   * its own and never depends on the store's shipping setup (VT-16).
   */
  shippingMethodName?: string;
  onWarning?: (message: string, details: Record<string, unknown>) => void;
}

export class JumpsellerStoreAdapter implements StoreAdapter {
  readonly name = "jumpseller";
  /**
   * Jumpseller has nowhere to take the buyer's consent (T149, VT-47). Its OpenAPI
   * (api.jumpseller.com/swagger.json) has `accepts_marketing` on a customer only
   * as something to read: neither the order's `customer` (`id` and addresses) nor
   * a customer's create or update body takes it. So the store does not offer UCP's
   * buyer consent extension.
   */
  readonly recordsBuyerConsent = false;

  private readonly client: JumpsellerClient;
  private readonly currency: string;
  private readonly shippingMethodName: string;
  private readonly onWarning: (message: string, details: Record<string, unknown>) => void;

  constructor(options: JumpsellerAdapterOptions) {
    const { credentials, currency, shippingMethodName, onWarning, ...clientOptions } = options;
    this.client = new JumpsellerClient({ credentials, ...clientOptions });
    this.currency = currency ?? "CLP";
    this.shippingMethodName = shippingMethodName ?? "Vitrinee x402";
    this.onWarning = onWarning ?? (() => {});
  }

  async listProducts(): Promise<Product[]> {
    const products: Product[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const envelopes = await this.call<JumpsellerProductEnvelope[]>("/products.json", {
        query: { limit: PAGE_SIZE, page },
      });
      if (!Array.isArray(envelopes) || envelopes.length === 0) break;
      for (const { product } of envelopes) {
        // Disabled and not-available products stay in the API response, and
        // the five Jumpseller demo products even share one SKU. An agent can
        // only reference what is on sale and has a SKU of its own.
        if (isSellable(product)) products.push(toProduct(product, this.currency));
      }
      if (envelopes.length < PAGE_SIZE) break;
    }
    // A SKU shared by several products does not say which one an agent means,
    // so none of them is published (T110). The five demo products Jumpseller
    // puts in a new store are available and all share "demo-product", which is
    // how they reached the directory in T105.
    const count = new Map<string, number>();
    for (const product of products) count.set(product.sku, (count.get(product.sku) ?? 0) + 1);
    const repeated = [...count].filter(([, n]) => n > 1).map(([sku]) => sku);
    if (repeated.length > 0) {
      this.onWarning("products sharing a SKU were left out of the catalogue", { skus: repeated });
    }
    return products.filter((product) => count.get(product.sku) === 1);
  }

  async getProduct(id: string): Promise<Product | null> {
    const envelope = await this.callOptional<JumpsellerProductEnvelope>(`/products/${encodeURIComponent(id)}.json`);
    if (envelope === null) return null;
    return isSellable(envelope.product) ? toProduct(envelope.product, this.currency) : null;
  }

  async createOrder(input: CreateOrderInput): Promise<PlatformOrder> {
    const products = await resolveOrderLines(input.lines, (id) => this.getProduct(id));
    const decimals = currencyDecimals(this.currency);
    const totalLocal = orderTotalLocal(input.lines, products, this.currency);

    const created = await this.call<JumpsellerOrderEnvelope>("/orders.json", {
      method: "POST",
      body: {
        order: {
          status: "Paid",
          shipping_method_name: this.shippingMethodName,
          shipping_price: 0,
          shipping_required: true,
          customer: this.toCustomer(input),
          products: input.lines.map((line) => {
            const product = products.get(line.productId)!;
            return { id: Number(product.id), qty: line.quantity, price: apiNumberFromDecimal(product.priceLocal, decimals, "price") };
          }),
        },
      },
    });

    const platformOrderId = String(created.order.id);
    await this.annotate(platformOrderId, input);

    return {
      platformOrderId,
      platform: this.name,
      status: "paid",
      reference: input.reference,
      lines: platformLines(input.lines, products),
      totalLocal,
      currency: this.currency,
      paymentRef: structuredClone(input.paymentRef),
      buyer: structuredClone(input.buyer),
      createdAt: created.order.created_at ?? new Date().toISOString(),
    };
  }

  async getOrder(platformOrderId: string): Promise<PlatformOrder | null> {
    const envelope = await this.callOptional<JumpsellerOrderEnvelope>(
      `/orders/${encodeURIComponent(platformOrderId)}.json`,
    );
    return envelope === null ? null : this.toPlatformOrder(envelope.order);
  }

  /**
   * Writes the settlement hash onto the order. Runs after the order exists,
   * so a failure here is reported and swallowed: the receipt already carries
   * the hash, and throwing would tell a buyer who paid that nothing happened.
   */
  private async annotate(platformOrderId: string, input: CreateOrderInput): Promise<void> {
    const note = [
      `Vitrinee ${input.reference}`,
      `x402 ${input.paymentRef.network}`,
      `tx ${input.paymentRef.txHash}`,
      `payer ${input.paymentRef.payerAccount}`,
    ].join(" · ");

    try {
      await this.call(`/orders/${platformOrderId}.json`, {
        method: "PUT",
        body: { order: { additional_information: note } },
      });
    } catch (error) {
      this.onWarning("could not write the settlement hash onto the Jumpseller order", {
        platformOrderId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.call(`/orders/${platformOrderId}/history.json`, {
        method: "POST",
        body: { order_history: { message: note } },
      });
    } catch (error) {
      this.onWarning("could not add the Vitrinee entry to the Jumpseller order history", {
        platformOrderId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private toCustomer(input: CreateOrderInput): Record<string, unknown> {
    const shipping = input.buyer.shipping;
    const [name, ...rest] = (shipping?.name ?? "Agente Vitrinee").split(" ");
    const address = {
      name: name ?? "Agente",
      surname: rest.join(" ") || "Vitrinee",
      address: shipping?.address ?? "",
      city: shipping?.city ?? "",
      region: shipping?.region ?? "",
      country: shipping?.country ?? "CL",
    };
    return {
      name: address.name,
      surname: address.surname,
      email: input.buyer.email ?? `${input.paymentRef.payerAccount.slice(0, 12).toLowerCase()}@agent.vitrinee.test`,
      shipping_address: address,
      billing_address: address,
    };
  }

  private toPlatformOrder(order: JumpsellerOrder): PlatformOrder {
    const decimals = currencyDecimals(order.currency ?? this.currency);
    return {
      platformOrderId: String(order.id),
      platform: this.name,
      status: order.status === "Paid" ? "paid" : order.status === "Canceled" ? "canceled" : "pending",
      reference: referenceFrom(order.additional_information ?? ""),
      lines: (order.products ?? []).map((line) => ({ productId: String(line.product_id ?? line.id ?? ""), sku: line.sku ?? "", quantity: line.qty ?? 0 })),
      totalLocal: order.total === undefined ? "0" : decimalFromApiNumber(order.total, decimals, "total"),
      currency: order.currency ?? this.currency,
      paymentRef: paymentRefFrom(order.additional_information ?? ""),
      buyer: { stellarAccount: payerFrom(order.additional_information ?? "") },
      createdAt: order.created_at ?? "",
    };
  }

  /** A GET whose 404 means "no such thing" rather than a failure. */
  private async callOptional<T>(path: string): Promise<T | null> {
    try {
      return await this.call<T>(path);
    } catch (error) {
      if (error instanceof VitrineeError && error.details.status === 404) return null;
      throw error;
    }
  }

  /** Every call goes through here so Jumpseller's failures become Vitrinee's. */
  private async call<T>(path: string, options: Parameters<JumpsellerClient["request"]>[1] = {}): Promise<T> {
    try {
      return await this.client.request<T>(path, options);
    } catch (error) {
      if (!(error instanceof JumpsellerHttpError)) throw error;
      if (error.status === 403 && /período de prueba|trial/i.test(error.apiMessage)) {
        throw new VitrineeError(
          "AdapterError",
          "Jumpseller refuses to create orders while the store is on a trial plan. " +
            "Ask Jumpseller support to enable order creation for API testing, or subscribe to a plan. " +
            `Store said: "${error.apiMessage}"`,
          { details: { path, status: error.status, trialBlocked: true } },
        );
      }
      if (error.status === 401 || error.status === 403) {
        throw new VitrineeError("AdapterError", `Jumpseller rejected the credentials on ${path}`, {
          details: { path, status: error.status },
        });
      }
      throw new VitrineeError("AdapterError", error.message, {
        details: { path, status: error.status },
      });
    }
  }
}

const field = (note: string, label: string): string => {
  const match = new RegExp(`${label} ([^·\\s]+)`).exec(note);
  return match?.[1] ?? "";
};

const referenceFrom = (note: string): string => field(note, "Vitrinee");
const payerFrom = (note: string): string => field(note, "payer");

function paymentRefFrom(note: string): PlatformOrder["paymentRef"] {
  return {
    txHash: field(note, "tx"),
    network: field(note, "x402"),
    asset: "",
    amountUSDCAtomic: "",
    payerAccount: payerFrom(note),
  };
}
