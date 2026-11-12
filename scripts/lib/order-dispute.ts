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

/** Hands a claim to the store that keeps the order (T184): the store keeps it once it hashes to the escrow's `claim_hash`. */
export async function sendClaimToStore(order: string, claimJws: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = new URL(`${orderDisputeUrl(order).pathname}/claim`, orderDisputeUrl(order).origin);
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim_jws: claimJws }), signal: AbortSignal.timeout(20_000) }).catch((error: unknown) => {
    throw new AgentPassError("NetworkError", "could not reach the store", { cause: error, details: { url: url.toString() } });
  });
  if (!res.ok) throw new AgentPassError("ResolveClaimInvalid", "the store did not keep the claim", { details: { url: url.toString(), status: res.status, body: (await res.text()).slice(0, 300) } });
}

/** Uploads one of the claim's files (T184). The store keeps it only if the claim it holds names this file. */
export async function sendEvidenceToStore(order: string, bytes: Uint8Array, mediaType: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const base = orderDisputeUrl(order);
  const url = new URL(`${base.pathname}/evidence`, base.origin);
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": mediaType }, body: Buffer.from(bytes), signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
    throw new AgentPassError("NetworkError", "could not reach the store", { cause: error, details: { url: url.toString() } });
  });
  if (!res.ok) throw new AgentPassError("ResolveClaimInvalid", "the store did not keep the file", { details: { url: url.toString(), status: res.status, body: (await res.text()).slice(0, 300) } });
}

/**
 * Reads one of the claim's files on a link the reader signs (T184). `null` when the store does not have it. The caller
 * hashes what comes back: the store is not trusted for the bytes.
 */
export async function readEvidenceFromStore(order: string, query: URLSearchParams, sha256: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  const base = orderDisputeUrl(order);
  const url = new URL(`${base.pathname}/evidence/${sha256}?${query.toString()}`, base.origin);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) }).catch((error: unknown) => {
    throw new AgentPassError("NetworkError", "could not reach the store", { cause: error, details: { url: `${base.origin}${base.pathname}/evidence/${sha256}` } });
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new AgentPassError("ResolveClaimInvalid", "the store refused to hand over the file", { details: { sha256, status: res.status } });
  return Buffer.from(await res.arrayBuffer());
}
