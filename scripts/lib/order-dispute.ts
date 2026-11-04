/**
 * A dispute's documents as a store keeps them next to its order (T163, X-29): the claim the buyer opened the escrow
 * dispute with, and the merchant's answer. The arbiter reads them from there instead of receiving files. Nothing here
 * is trusted: the caller hashes the claim and the answer again against the escrow on chain.
 */
import { AgentPassError } from "@agentpass/core";
import { z } from "zod";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const disputeDocumentsSchema = z.looseObject({
  order_id: z.string().min(1),
  escrow: z.string().min(1),
  claim_jws: z.string().min(1).nullable(),
  response: z.looseObject({ document: z.record(z.string(), z.unknown()), hash: hex64, transaction: hex64 }).nullable(),
});
export type OrderDisputeDocuments = z.infer<typeof disputeDocumentsSchema>;

/**
 * Where a store keeps one order's dispute: `<store origin>/orders/<id>/dispute`, from the order's own URL
 * (`https://agentcommerce.vitrinee.agentpey.com/orders/ord_…`, with or without the scheme). HTTPS only, except a
 * local store under test.
 */
export function orderDisputeUrl(order: string): URL {
  const text = /^https?:\/\//.test(order) ? order : `https://${order}`;
  const url = URL.canParse(text) ? new URL(text) : null;
  const match = url === null ? null : /^\/(?:ucp\/v1\/)?orders\/([^/]+)\/?$/.exec(url.pathname);
  const local = url !== null && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url === null || match?.[1] === undefined || (url.protocol !== "https:" && !local)) {
    throw new AgentPassError("InvalidArguments", "give the order as <store host>/orders/<order id>, e.g. agentcommerce.vitrinee.agentpey.com/orders/ord_…", { details: { order } });
  }
  return new URL(`/orders/${match[1]}/dispute`, url.origin);
}

export async function readOrderDispute(order: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<OrderDisputeDocuments> {
  const url = orderDisputeUrl(order);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new AgentPassError("NetworkError", "could not reach the store", { cause: error, details: { url: url.toString() } });
  }
  const parsed = disputeDocumentsSchema.safeParse(await res.json().catch(() => undefined));
  if (!res.ok || !parsed.success) {
    throw new AgentPassError("ResolveReceiptInvalid", "the store does not keep a dispute for this order", { details: { url: url.toString(), status: res.status } });
  }
  return parsed.data;
}
