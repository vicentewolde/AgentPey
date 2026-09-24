/**
 * The pure parts of `pnpm run vitrinee:platform-setup` (T103), kept apart so
 * they are tested without a database.
 */
import { orderRecordSchema, type OrderRecord } from "../../../packages/vitrinee-gateway/src/orders.js";

export const VITRINEE_ROLE = "vitrinee";

/**
 * The connection string for Vitrinee's own role, built from the admin one.
 * Supabase's pooler names a role as `<role>.<project-ref>`; a plain Postgres
 * just `<role>`. Host, port, database and parameters are kept.
 */
export function roleConnectionString(adminUrl: string, password: string, role = VITRINEE_ROLE): string {
  const url = new URL(adminUrl);
  const dot = decodeURIComponent(url.username).indexOf(".");
  const ref = dot === -1 ? "" : decodeURIComponent(url.username).slice(dot);
  url.username = encodeURIComponent(`${role}${ref}`);
  url.password = encodeURIComponent(password);
  return url.toString();
}

export interface PublicOrderBackup {
  orderId: string;
  status: string;
  createdAt: string;
  product: { id: string; sku: string; name: string };
  quantity: number;
  amountUSDC: string;
  amountUSDCAtomic: string;
  totalLocal: string;
  currency: string;
  platform: string;
  platformOrderId: string | null;
  platformError: string | null;
  settlement: OrderRecord["settlement"];
  receipt: { jws: string; hash: string; verifyPath?: string } | null;
  anchor: OrderRecord["anchor"];
}

/**
 * Rebuilds a full order record from its public view (`GET /orders/:id`, which
 * leaves out the buyer) and the checkout URL AgentPey recorded for the same
 * payment (`delivery.resource_url`, VT-25), which carries the shipping
 * details the buyer typed. The receipt and the anchor are copied as they are:
 * they were signed and anchored at payment time and must not change (VT-26).
 *
 * @throws Error if the two sources disagree on the product, or the result is not a valid order record.
 */
export function rebuildOrder(backup: PublicOrderBackup, resourceUrl: string): OrderRecord {
  const url = new URL(resourceUrl);
  const productId = url.pathname.split("/").pop();
  if (productId !== backup.product.id) {
    throw new Error(`the recorded checkout URL is for product ${productId ?? "?"}, the backup for ${backup.product.id}`);
  }
  const q = url.searchParams;
  const quantity = BigInt(backup.quantity);
  const amount = BigInt(backup.amountUSDCAtomic);
  if (amount % quantity !== 0n) throw new Error("the amount does not divide evenly by the quantity");
  const optional = (key: string) => (q.get(key) ? { [key]: q.get(key) as string } : {});
  const receipt = backup.receipt === null ? null : { jws: backup.receipt.jws, hash: backup.receipt.hash };
  return orderRecordSchema.parse({
    orderId: backup.orderId,
    status: backup.status,
    createdAt: backup.createdAt,
    idempotencyKey: null,
    product: backup.product,
    quantity: backup.quantity,
    unitPriceUSDCAtomic: (amount / quantity).toString(),
    amountUSDCAtomic: backup.amountUSDCAtomic,
    amountUSDC: backup.amountUSDC,
    totalLocal: backup.totalLocal,
    currency: backup.currency,
    buyer: {
      stellarAccount: backup.settlement.payer,
      shipping: { ...optional("name"), ...optional("address"), ...optional("city"), ...optional("region"), country: q.get("country") || "CL" },
    },
    settlement: backup.settlement,
    platform: backup.platform,
    platformOrderId: backup.platformOrderId,
    platformError: backup.platformError,
    receipt,
    anchor: backup.anchor,
  }) as OrderRecord;
}
