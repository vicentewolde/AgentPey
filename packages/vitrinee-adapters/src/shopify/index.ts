/**
 * Shopify store adapter (T112, VT-33, VT-34, VT-35).
 *
 * Reads the catalogue and creates paid orders over the Admin GraphQL API. Two
 * things differ from Jumpseller and both are on purpose:
 *
 * - The order is created in **one** call, already `PAID`, with the settlement
 *   recorded as a SALE transaction and as custom attributes (the hash, the
 *   network, the payer). There is no second "annotate" step that could fail
 *   after the buyer has paid.
 * - Only the store's own currency is accepted: the adapter asks Shopify for
 *   it once and refuses to sell if it is not the one the gateway prices in.
 */
import { VitrineeError, currencyDecimals, formatUnits, parseDecimal } from "@vitrinee/core";

import type { CreateOrderInput, PlatformOrder, Product, StoreAdapter } from "../types.js";
import { ShopifyClient, ShopifyGraphqlError, ShopifyHttpError } from "./client.js";
import type { ShopifyClientOptions, ShopifyCredentials } from "./client.js";
import type { ShopifyProductNode, ShopifyVariantNode } from "./map.js";
import { exactDecimal, isSellable, numericId, orderGid, toProduct, variantGid } from "./map.js";

export { ShopifyClient, ShopifyGraphqlError, ShopifyHttpError, isShopifyShopHost, SHOPIFY_API_VERSION } from "./client.js";
export type { ShopifyCredentials } from "./client.js";

const PAGE_SIZE = 50;
/** More pages than this means something is wrong, not that the store is big. */
const MAX_PAGES = 20;

const PRODUCT_FIELDS = `
  id title status description
  media(first: 5) { nodes { ... on MediaImage { image { url } } } }
`;
const VARIANT_FIELDS = `id title sku price inventoryQuantity inventoryItem { tracked }`;

const LIST_QUERY = `
  query Catalogue($cursor: String) {
    shop { currencyCode }
    products(first: ${PAGE_SIZE}, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} variants(first: 100) { nodes { ${VARIANT_FIELDS} } } }
    }
  }
`;

const VARIANT_QUERY = `
  query Variant($id: ID!) {
    shop { currencyCode }
    productVariant(id: $id) { ${VARIANT_FIELDS} product { ${PRODUCT_FIELDS} } }
  }
`;

const CREATE_ORDER = `
  mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors { field message }
      order { id createdAt }
    }
  }
`;

const ORDER_QUERY = `
  query Order($id: ID!) {
    order(id: $id) {
      id createdAt cancelledAt displayFinancialStatus
      currencyCode
      totalPriceSet { shopMoney { amount currencyCode } }
      customAttributes { key value }
      lineItems(first: 1) { nodes { quantity sku variant { id } } }
    }
  }
`;

interface ProductsResponse {
  shop: { currencyCode: string };
  products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProductNode[] };
}
interface VariantResponse {
  shop: { currencyCode: string };
  productVariant: (ShopifyVariantNode & { product: ShopifyProductNode }) | null;
}
interface OrderCreateResponse {
  orderCreate: { userErrors: { field?: string[] | null; message: string }[]; order: { id: string; createdAt?: string } | null };
}
interface OrderResponse {
  order: {
    id: string;
    createdAt?: string;
    cancelledAt?: string | null;
    displayFinancialStatus?: string | null;
    currencyCode?: string;
    totalPriceSet?: { shopMoney: { amount: string; currencyCode: string } };
    customAttributes?: { key: string; value?: string | null }[];
    lineItems?: { nodes: { quantity?: number; sku?: string | null; variant?: { id: string } | null }[] };
  } | null;
}

export interface ShopifyAdapterOptions extends Omit<ShopifyClientOptions, "credentials"> {
  credentials: ShopifyCredentials;
  /** The store's own currency. Must match the gateway's; CLP for this demo. */
  currency?: string;
  /** What the order records as its shipping method (the gateway declares its own, like VT-16). */
  shippingMethodName?: string;
  onWarning?: (message: string, details: Record<string, unknown>) => void;
}

export class ShopifyStoreAdapter implements StoreAdapter {
  readonly name = "shopify";

  private readonly client: ShopifyClient;
  private readonly currency: string;
  private readonly shippingMethodName: string;
  private readonly onWarning: (message: string, details: Record<string, unknown>) => void;

  constructor(options: ShopifyAdapterOptions) {
    const { currency, shippingMethodName, onWarning, ...clientOptions } = options;
    this.client = new ShopifyClient(clientOptions);
    this.currency = currency ?? "CLP";
    this.shippingMethodName = shippingMethodName ?? "Vitrinee x402";
    this.onWarning = onWarning ?? (() => {});
  }

  async listProducts(): Promise<Product[]> {
    const products: Product[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data: ProductsResponse = await this.call<ProductsResponse>(LIST_QUERY, { cursor });
      this.assertCurrency(data.shop.currencyCode);
      for (const product of data.products.nodes) {
        for (const variant of product.variants?.nodes ?? []) {
          if (isSellable(product, variant)) products.push(toProduct(product, variant, this.currency));
        }
      }
      if (!data.products.pageInfo.hasNextPage || data.products.pageInfo.endCursor === null) break;
      cursor = data.products.pageInfo.endCursor;
    }
    // A SKU shared by several variants does not say which one an agent means,
    // so none of them is published (VT-32).
    const count = new Map<string, number>();
    for (const product of products) count.set(product.sku, (count.get(product.sku) ?? 0) + 1);
    const repeated = [...count].filter(([, n]) => n > 1).map(([sku]) => sku);
    if (repeated.length > 0) this.onWarning("products sharing a SKU were left out of the catalogue", { skus: repeated });
    return products.filter((product) => count.get(product.sku) === 1);
  }

  async getProduct(id: string): Promise<Product | null> {
    if (!/^\d+$/.test(id)) return null;
    const data = await this.call<VariantResponse>(VARIANT_QUERY, { id: variantGid(id) });
    this.assertCurrency(data.shop.currencyCode);
    const variant = data.productVariant;
    if (variant === null || !isSellable(variant.product, variant)) return null;
    return toProduct(variant.product, variant, this.currency);
  }

  async createOrder(input: CreateOrderInput): Promise<PlatformOrder> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new VitrineeError("ValidationError", "quantity must be a positive integer", { details: { quantity: input.quantity } });
    }
    const product = await this.getProduct(input.productId);
    if (product === null) {
      throw new VitrineeError("ProductNotFound", `no product with id "${input.productId}"`, { details: { productId: input.productId } });
    }
    if (product.stock !== null && product.stock < input.quantity) {
      throw new VitrineeError("OutOfStock", `only ${product.stock} left of "${product.name}"`, {
        details: { productId: product.id, available: product.stock, requested: input.quantity },
      });
    }

    const decimals = currencyDecimals(this.currency);
    const unit = parseDecimal(product.priceLocal, decimals);
    const totalLocal = formatUnits(unit * BigInt(input.quantity), decimals);
    const money = (amount: string) => ({ shopMoney: { amount, currencyCode: this.currency } });
    const pay = input.paymentRef;
    const note = [`Vitrinee ${input.reference}`, `x402 ${pay.network}`, `tx ${pay.txHash}`, `payer ${pay.payerAccount}`].join(" · ");

    const shipping = this.toAddress(input);
    const data = await this.call<OrderCreateResponse>(CREATE_ORDER, {
      order: {
        currency: this.currency,
        financialStatus: "PAID",
        email: this.email(input),
        note,
        tags: ["vitrinee", "x402"],
        customAttributes: [
          { key: "vitrinee_reference", value: input.reference },
          { key: "x402_network", value: pay.network },
          { key: "x402_tx", value: pay.txHash },
          { key: "x402_asset", value: pay.asset },
          { key: "x402_amount_atomic", value: pay.amountUSDCAtomic },
          { key: "x402_payer", value: pay.payerAccount },
        ],
        lineItems: [{ variantId: variantGid(product.id), quantity: input.quantity, priceSet: money(product.priceLocal) }],
        transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "Vitrinee x402", amountSet: money(totalLocal) }],
        shippingLines: [{ title: this.shippingMethodName, priceSet: money("0") }],
        shippingAddress: shipping,
        billingAddress: shipping,
      },
      options: { inventoryBehaviour: "DECREMENT_IGNORING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false },
    });

    const { userErrors, order } = data.orderCreate;
    if (userErrors.length > 0 || order === null) {
      throw new VitrineeError(
        "AdapterError",
        `Shopify refused the order: ${userErrors.map((e) => e.message).join("; ") || "no order returned"}`,
        { details: { userErrors: userErrors.map((e) => ({ field: e.field ?? [], message: e.message })) } },
      );
    }

    const platformOrderId = numericId(order.id);
    return {
      platformOrderId,
      platform: this.name,
      status: "paid",
      reference: input.reference,
      productId: product.id,
      sku: product.sku,
      quantity: input.quantity,
      totalLocal,
      currency: this.currency,
      paymentRef: structuredClone(input.paymentRef),
      buyer: structuredClone(input.buyer),
      createdAt: order.createdAt ?? new Date().toISOString(),
      adminUrl: `https://admin.shopify.com/store/${this.client.handle}/orders/${platformOrderId}`,
    };
  }

  async getOrder(platformOrderId: string): Promise<PlatformOrder | null> {
    if (!/^\d+$/.test(platformOrderId)) return null;
    const { order } = await this.call<OrderResponse>(ORDER_QUERY, { id: orderGid(platformOrderId) });
    if (order === null) return null;
    const attrs = new Map((order.customAttributes ?? []).map((a) => [a.key, a.value ?? ""]));
    const line = order.lineItems?.nodes[0];
    const money = order.totalPriceSet?.shopMoney;
    const currency = money?.currencyCode ?? order.currencyCode ?? this.currency;
    return {
      platformOrderId,
      platform: this.name,
      status: order.cancelledAt ? "canceled" : order.displayFinancialStatus === "PAID" ? "paid" : "pending",
      reference: attrs.get("vitrinee_reference") ?? "",
      productId: line?.variant?.id === undefined ? "" : numericId(line.variant.id),
      sku: line?.sku ?? "",
      quantity: line?.quantity ?? 0,
      totalLocal: money === undefined ? "0" : exactDecimal(money.amount, currencyDecimals(currency), "total"),
      currency,
      paymentRef: {
        txHash: attrs.get("x402_tx") ?? "",
        network: attrs.get("x402_network") ?? "",
        asset: attrs.get("x402_asset") ?? "",
        amountUSDCAtomic: attrs.get("x402_amount_atomic") ?? "",
        payerAccount: attrs.get("x402_payer") ?? "",
      },
      buyer: { stellarAccount: attrs.get("x402_payer") ?? "" },
      createdAt: order.createdAt ?? "",
      adminUrl: `https://admin.shopify.com/store/${this.client.handle}/orders/${platformOrderId}`,
    };
  }

  private email(input: CreateOrderInput): string {
    return input.buyer.email ?? `${input.paymentRef.payerAccount.slice(0, 12).toLowerCase()}@agent.vitrinee.test`;
  }

  private toAddress(input: CreateOrderInput): Record<string, string> {
    const shipping = input.buyer.shipping;
    const [first, ...rest] = (shipping?.name ?? "Agente Vitrinee").split(" ");
    return {
      firstName: first ?? "Agente",
      lastName: rest.join(" ") || "Vitrinee",
      address1: shipping?.address ?? "-",
      city: shipping?.city ?? "-",
      ...(shipping?.region === undefined || shipping.region === "" ? {} : { province: shipping.region }),
      countryCode: shipping?.country ?? "CL",
    };
  }

  /** Refuses to price a store in a currency other than the one the gateway sells in. */
  private assertCurrency(shopCurrency: string): void {
    if (shopCurrency !== this.currency) {
      throw new VitrineeError(
        "AdapterError",
        `the Shopify store sells in ${shopCurrency} but this merchant is priced in ${this.currency}; change the store's currency in Shopify settings`,
        { details: { shopCurrency, expected: this.currency, credentialsRejected: false } },
      );
    }
  }

  /** Every call goes through here so Shopify's failures become Vitrinee's. */
  private async call<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.client.graphql<T>(query, variables);
    } catch (error) {
      if (error instanceof ShopifyHttpError) {
        // 400 on the token exchange is `invalid_client` or `shop_not_permitted`:
        // the id/secret pair, or the app and store not sharing an organization.
        const rejected = error.stage === "token" ? [400, 401, 403, 404].includes(error.status) : [401, 403].includes(error.status);
        throw new VitrineeError(
          "AdapterError",
          rejected
            ? `Shopify rejected the app credentials (${error.apiMessage}). Check the client id and secret, and that the app and the store are in the same organization.`
            : error.message,
          { details: { path: error.path, status: error.status, credentialsRejected: rejected } },
        );
      }
      if (error instanceof ShopifyGraphqlError) {
        if (error.codes.includes("ACCESS_DENIED")) {
          throw new VitrineeError(
            "AdapterError",
            "the Shopify app lacks a permission it needs; give it read_products and write_orders in the Dev Dashboard and release a new version",
            { details: { credentialsRejected: true, codes: error.codes } },
          );
        }
        if (error.codes.includes("THROTTLED")) {
          throw new VitrineeError("AdapterError", "Shopify is throttling this store; try again in a minute", { details: { throttled: true } });
        }
        throw new VitrineeError("AdapterError", error.message, { details: { codes: error.codes } });
      }
      throw error;
    }
  }
}
