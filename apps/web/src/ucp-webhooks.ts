/**
 * `POST /ucp/webhooks/orders`: where Vitrinee stores tell AgentPey, the
 * platform that bought, what happened to an order (T147). AgentPey's platform
 * profiles name this URL as their order `webhook_url`.
 *
 * A delivery is accepted only when it verifies the way UCP says a platform
 * must verify it: the `UCP-Agent` header names the store's own profile, the
 * key its `keyid` names is in that profile, the RFC 9421 signature covers the
 * target, the body and the event's identity and holds under that key, and the
 * order inside belongs to that store (its permalink is on the same origin).
 *
 * The profile URL comes from the request, so only stores AgentPey runs are
 * read: `https://<name>.vitrinee.agentpey.com/.well-known/ucp`, nothing else.
 * The same `Webhook-Id` twice is acknowledged once. What arrived is kept in
 * memory (the last {@link MAX_KEPT}), without bodies, and listed by
 * `GET /ucp/webhooks/orders`.
 */
import { verifyHttpMessageSignature, type EcPublicJwk } from "@vitrinee/core";

/** Deliveries kept for the listing. */
export const MAX_KEPT = 50;
/** UCP: a profile size limit "SHOULD be no lower than 128 KiB"; a webhook body is an order, far smaller. */
export const MAX_BODY_BYTES = 256 * 1024;
const PROFILE_MAX_BYTES = 128 * 1024;
const PROFILE_TIMEOUT_MS = 3_000;
const PROFILE_CACHE_MS = 5 * 60_000;
/** Ids remembered to acknowledge a retry of something already received. */
const SEEN_MAX = 2_000;

/** A store AgentPey runs: Vitrinee's own origin or one of its storefronts. */
export function isAgentPeyStoreHost(host: string): boolean {
  return host === "vitrinee.agentpey.com" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vitrinee\.agentpey\.com$/.test(host);
}

export interface ReceivedWebhook {
  webhookId: string;
  store: string;
  orderId: string;
  /** `created`, or the type of the order's newest fulfillment event. */
  event: string;
  occurredAt: string;
  receivedAt: string;
}

export type WebhookAnswer = { status: number; body: Record<string, unknown> };

export interface OrderWebhookReceiverOptions {
  /** Reads a store's profile; tests inject one. Defaults to a bounded HTTPS fetch. */
  fetchProfile?: (url: string) => Promise<unknown>;
  now?: () => Date;
  log?: (message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>) => void;
}

async function fetchProfileOverHttps(url: string): Promise<unknown> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (res.status !== 200) throw new Error(`profile answered ${res.status}`);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader?.read();
    if (next === undefined || next.done) break;
    size += next.value.byteLength;
    if (size > PROFILE_MAX_BYTES) {
      await reader?.cancel();
      throw new Error("profile too large");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** The ES256 keys a UCP profile publishes, in `signing_keys` (2026-04-08) and `keys` (2026-08-25). */
function p256Keys(profile: unknown): Array<EcPublicJwk & { kid: string }> {
  const document = profile as { keys?: unknown; signing_keys?: unknown } | null;
  const all = [...(Array.isArray(document?.signing_keys) ? document.signing_keys : []), ...(Array.isArray(document?.keys) ? document.keys : [])] as unknown[];
  return all.flatMap((raw) => {
    const k = raw as Partial<EcPublicJwk> & { kid?: unknown; use?: unknown };
    const ok = k?.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" && typeof k.kid === "string" && (k.use === undefined || k.use === "sig");
    return ok ? [{ kty: "EC" as const, crv: "P-256" as const, x: k.x!, y: k.y!, kid: k.kid as string }] : [];
  });
}

export function createOrderWebhookReceiver(options: OrderWebhookReceiverOptions = {}) {
  const fetchProfile = options.fetchProfile ?? fetchProfileOverHttps;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const kept: ReceivedWebhook[] = [];
  const seen = new Set<string>();
  const profiles = new Map<string, { at: number; keys: Array<EcPublicJwk & { kid: string }> }>();

  async function keysOf(profileUrl: string): Promise<Array<EcPublicJwk & { kid: string }>> {
    const hit = profiles.get(profileUrl);
    if (hit !== undefined && now().getTime() - hit.at < PROFILE_CACHE_MS) return hit.keys;
    const keys = p256Keys(await fetchProfile(profileUrl));
    if (profiles.size >= 200) profiles.delete(profiles.keys().next().value!);
    profiles.set(profileUrl, { at: now().getTime(), keys });
    return keys;
  }

  const refuse = (status: number, code: string, message: string): WebhookAnswer => ({ status, body: { ok: false, code, message } });

  return {
    /**
     * One delivery, as received: the URL it was sent to (scheme, host and
     * path, as the store signed them), its headers with lowercased names, and
     * the raw body bytes.
     */
    async receive(url: string, headers: Readonly<Record<string, string | undefined>>, body: Buffer): Promise<WebhookAnswer> {
      if (body.byteLength > MAX_BODY_BYTES) return refuse(413, "TooLarge", "an order webhook is far smaller than this");
      const webhookId = headers["webhook-id"]?.trim() ?? "";
      const timestamp = headers["webhook-timestamp"]?.trim() ?? "";
      if (!/^[A-Za-z0-9-]{8,64}$/.test(webhookId) || !/^\d{9,11}$/.test(timestamp)) return refuse(400, "BadHeaders", "Webhook-Id and Webhook-Timestamp are required");
      const profileUrl = /^profile="([^"]+)"$/.exec(headers["ucp-agent"]?.trim() ?? "")?.[1];
      let profile: URL;
      try {
        profile = new URL(profileUrl ?? "");
      } catch {
        return refuse(400, "BadHeaders", "UCP-Agent must name the store's profile");
      }
      if (profile.protocol !== "https:" || profile.port !== "" || profile.pathname !== "/.well-known/ucp" || profile.search !== "" || !isAgentPeyStoreHost(profile.hostname)) {
        return refuse(403, "UnknownStore", "only stores AgentPey runs deliver here");
      }
      if (seen.has(webhookId)) return { status: 200, body: { ucp: { status: "success" }, duplicate: true } };

      let keys: Array<EcPublicJwk & { kid: string }>;
      try {
        keys = await keysOf(profile.href);
      } catch (error) {
        log("order webhook: store profile unreadable", { store: profile.origin, error: error instanceof Error ? error.message : String(error) });
        // The store retries a 5xx; the profile may answer next time.
        return refuse(503, "ProfileUnavailable", "the store's profile could not be read");
      }
      const check = verifyHttpMessageSignature({ method: "POST", url, headers, body, keyFor: (keyid) => keys.find((k) => k.kid === keyid) });
      if (!check.ok) {
        log("order webhook refused", { store: profile.origin, webhookId, reason: check.reason });
        return refuse(401, "SignatureInvalid", `the delivery does not verify: ${check.reason}`);
      }

      let order: { id?: unknown; permalink_url?: unknown; ucp?: { version?: unknown }; fulfillment?: { events?: Array<{ type?: unknown }> } };
      try {
        order = JSON.parse(body.toString("utf8")) as typeof order;
      } catch {
        return refuse(400, "BadBody", "the body is not a UCP order");
      }
      // UCP: the signer must be authorized for the order it reports, here the store whose permalink it is.
      if (typeof order.id !== "string" || typeof order.permalink_url !== "string" || !URL.canParse(order.permalink_url) || new URL(order.permalink_url).origin !== profile.origin) {
        return refuse(403, "NotYourOrder", "the order in the body is not this store's");
      }
      const events = Array.isArray(order.fulfillment?.events) ? order.fulfillment.events : [];
      const last = events.at(-1)?.type;
      const received: ReceivedWebhook = {
        webhookId,
        store: profile.origin,
        orderId: order.id,
        event: typeof last === "string" ? last : "created",
        occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
        receivedAt: now().toISOString(),
      };
      seen.add(webhookId);
      if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
      kept.unshift(received);
      kept.splice(MAX_KEPT);
      log("order webhook received", { ...received });
      const version = typeof order.ucp?.version === "string" ? order.ucp.version : undefined;
      return { status: 200, body: { ucp: { ...(version === undefined ? {} : { version }), status: "success" } } };
    },

    /** What arrived, newest first. */
    recent(): ReceivedWebhook[] {
      return kept.map((r) => ({ ...r }));
    },
  };
}

export type OrderWebhookReceiver = ReturnType<typeof createOrderWebhookReceiver>;
