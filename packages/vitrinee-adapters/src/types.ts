/**
 * The seam between Vitrinee and a store platform. Everything the gateway
 * needs from Jumpseller, WooCommerce or the mock goes through these four
 * calls; nothing platform-specific leaks past this file.
 */

export interface Product {
  /** Stable id inside the platform (Jumpseller's numeric id, stringified). */
  id: string;
  sku: string;
  name: string;
  description: string;
  /** Decimal string in `currency`, with that currency's decimals ("34990" for CLP). */
  priceLocal: string;
  currency: string;
  /** `null` when the platform does not track stock for this product. */
  stock: number | null;
  images: string[];
}

export interface ShippingAddress {
  name?: string;
  address?: string;
  city?: string;
  region?: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  notes?: string;
}

export interface Buyer {
  /** The Stellar account that paid: the only identity an x402 client must have. */
  stellarAccount: string;
  email?: string;
  shipping?: ShippingAddress;
}

export interface PaymentRef {
  /** Settlement transaction hash on Stellar, lowercase hex. */
  txHash: string;
  network: string;
  /** SEP-41 contract of the asset paid. */
  asset: string;
  amountUSDCAtomic: string;
  payerAccount: string;
}

/** One line of a purchase: a product and how many of it (T148). */
export interface OrderLineInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  /**
   * What was paid for, one entry per line and in the buyer's order (T148). The
   * same product may appear in two lines; its stock is checked for their sum.
   */
  lines: OrderLineInput[];
  buyer: Buyer;
  paymentRef: PaymentRef;
  /** Vitrinee's own order id, stored on the platform order so both sides link. */
  reference: string;
}

export type PlatformOrderStatus = "paid" | "pending" | "canceled";

export interface PlatformOrder {
  platformOrderId: string;
  platform: string;
  status: PlatformOrderStatus;
  reference: string;
  /** The order's lines as the platform holds them (T148). */
  lines: PlatformOrderLine[];
  /** Order total in the store's currency, decimal string. */
  totalLocal: string;
  currency: string;
  paymentRef: PaymentRef;
  buyer: Buyer;
  createdAt: string;
  /** Link into the platform's admin panel, when the platform has one. */
  adminUrl?: string;
  /**
   * The parcels the platform says left the store (T147), oldest first. Absent
   * when the adapter cannot tell; empty when nothing shipped yet.
   */
  shipments?: PlatformShipment[];
  /** Whether everything left (T147): the store stops asking once it is `fulfilled`. Absent when the adapter cannot tell. */
  fulfillmentStatus?: "unfulfilled" | "partial" | "fulfilled";
}

/** One line of an order on the platform (T148). */
export interface PlatformOrderLine {
  productId: string;
  sku: string;
  quantity: number;
}

/** One shipment, as the store's platform records it (T147). */
export interface PlatformShipment {
  /** The platform's own id for it, so it is recorded once. */
  id: string;
  shippedAt: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
  /**
   * Which products, and how many of each, went in this parcel (T148). Absent
   * when the platform does not say: the store then never guesses which lines
   * a partial shipment carried.
   */
  lines?: { productId: string; quantity: number }[];
}

export interface StoreAdapter {
  readonly name: string;
  /** Whether `getOrder` reports `shipments` (T147): only then does the store watch its orders for them. */
  readonly reportsShipments?: boolean;
  listProducts(): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  /** Creates a *paid* order. Must decrement stock or fail with `OutOfStock`. */
  createOrder(input: CreateOrderInput): Promise<PlatformOrder>;
  getOrder(platformOrderId: string): Promise<PlatformOrder | null>;
}
