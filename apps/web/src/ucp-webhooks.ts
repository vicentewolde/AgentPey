/**
 * `POST /ucp/webhooks/orders`: where Vitrinee stores tell AgentPey, the
 * platform that bought, what happened to an order (T147). AgentPey's platform
 * profiles name this URL as their order `webhook_url`.
 *
 * A delivery is accepted only when it verifies the way UCP says a platform
 * must verify it, and a little more:
 *
 * - `UCP-Agent` names a store AgentPey runs, at its well-known profile;
 * - the `keyid` is that store's webhook key (`…#ucp-p256`, `VT-44`), never
 *   another key of its profile, such as the AP2 one;
 * - the RFC 9421 signature covers the target, the body and the event's
 *   identity (`webhook-id`, `webhook-timestamp`), holds under that key, and
 *   was made in the last five minutes (each retry is signed afresh, so a
 *   captured delivery cannot be replayed later);
 * - the order inside belongs to that store (its permalink is on that origin).
 *
 * Reading a store's profile is bounded: only `https://<name>.vitrinee.agentpey.com/.well-known/ucp`,
 * one read per profile at a time, failures remembered for a minute, and a few
 * reads at once at a steady rate. The same `Webhook-Id` is acknowledged once.
 * What arrived is kept in memory (the last {@link MAX_KEPT}) and listed by
 * `GET /ucp/webhooks/orders` without bodies and without the order id itself.
 */
import { createHash } from "node:crypto";

import { AgentPassError } from "@agentpass/core";
import { verifyHttpMessageSignature, type EcPublicJwk } from "@vitrinee/core";
import { z } from "zod";

/** Deliveries kept for the listing. */
export const MAX_KEPT = 50;
/** An order webhook is an order, far smaller than this. */
export const MAX_BODY_BYTES = 256 * 1024;
/** How old a delivery's signature may be. */
export const SIGNATURE_MAX_AGE_SECONDS = 300;
const PROFILE_MAX_BYTES = 128 * 1024;
const PROFILE_TIMEOUT_MS = 3_000;
const PROFILE_CACHE_MS = 5 * 60_000;
const PROFILE_FAIL_CACHE_MS = 60_000;
const MAX_CONCURRENT_PROFILE_READS = 4;
const PROFILE_READ_BURST = 10;
const PROFILE_READS_PER_SECOND = 2;
const PROFILES_KEPT = 200;
/** Ids remembered to acknowledge a retry of something already received. */
const SEEN_MAX = 2_000;
/** What the signature must cover for this receiver to trust the event's identity. */
const REQUIRED_COMPONENTS = ["content-digest", "content-type", "ucp-agent", "webhook-id", "webhook-timestamp"] as const;

/** A store AgentPey runs: Vitrinee's own origin or one of its storefronts. */
export function isAgentPeyStoreHost(host: string): boolean {
  return host === "vitrinee.agentpey.com" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vitrinee\.agentpey\.com$/.test(host);
}

/** A store's webhook key, as its profile publishes it (`VT-44`). */
const webhookKeySchema = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().max(300).regex(/#ucp-p256$/),
  use: z.literal("sig").optional(),
});
/** The parts of a UCP profile that hold keys: `signing_keys` (2026-04-08) and `keys` (2026-08-25). */
const profileKeysSchema = z.looseObject({ keys: z.array(z.unknown()).max(50).optional(), signing_keys: z.array(z.unknown()).max(50).optional() });
/** What this receiver reads of the order in a delivery. */
const deliveredOrderSchema = z.looseObject({
  id: z.string().min(1).max(200),
  permalink_url: z.string().max(2_048),
  ucp: z.looseObject({ version: z.string().max(20).optional() }).optional(),
  fulfillment: z.looseObject({ events: z.array(z.looseObject({ type: z.string().max(50) })).max(100).optional() }).optional(),
});

type WebhookKey = EcPublicJwk & { kid: string };

export interface ReceivedWebhook {
  webhookId: string;
  store: string;
  /** A digest of the order id, not the id: with the id, anyone could read the order at the store. */
  orderRef: string;
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

/** @throws AgentPassError `NetworkError` for a profile that does not answer 200, is too large or is not JSON */
async function fetchProfileOverHttps(url: string): Promise<unknown> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (res.status !== 200) throw new AgentPassError("NetworkError", `the store's profile answered ${res.status}`, { details: { url, status: res.status } });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader?.read();
    if (next === undefined || next.done) break;
    size += next.value.byteLength;
    if (size > PROFILE_MAX_BYTES) {
      await reader?.cancel();
      throw new AgentPassError("NetworkError", "the store's profile is larger than a profile may be", { details: { url } });
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new AgentPassError("NetworkError", "the store's profile is not JSON", { details: { url }, cause: error });
  }
}

/** The store's webhook keys in a profile, whichever array holds them. */
function webhookKeys(profile: unknown): WebhookKey[] {
  const parsed = profileKeysSchema.safeParse(profile);
  if (!parsed.success) return [];
  return [...(parsed.data.signing_keys ?? []), ...(parsed.data.keys ?? [])].flatMap((raw) => {
    const key = webhookKeySchema.safeParse(raw);
    return key.success ? [{ kty: "EC" as const, crv: "P-256" as const, x: key.data.x, y: key.data.y, kid: key.data.kid }] : [];
  });
}

export function createOrderWebhookReceiver(options: OrderWebhookReceiverOptions = {}) {
  const fetchProfile = options.fetchProfile ?? fetchProfileOverHttps;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const kept: ReceivedWebhook[] = [];
  const seen = new Set<string>();
  /** Ids being received right now: a concurrent copy waits for the first one's outcome instead of racing it. */
  const receiving = new Set<string>();
  const profiles = new Map<string, { at: number; keys: WebhookKey[] } | { at: number; failed: true }>();
  const reading = new Map<string, Promise<WebhookKey[]>>();
  let readsRunning = 0;
  let tokens = PROFILE_READ_BURST;
  let refilledAt = now().getTime();

  function takeToken(): boolean {
    const t = now().getTime();
    tokens = Math.min(PROFILE_READ_BURST, tokens + ((t - refilledAt) / 1000) * PROFILE_READS_PER_SECOND);
    refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function remember(profileUrl: string, entry: { at: number; keys: WebhookKey[] } | { at: number; failed: true }): void {
    if (profiles.size >= PROFILES_KEPT && !profiles.has(profileUrl)) profiles.delete(profiles.keys().next().value!);
    profiles.set(profileUrl, entry);
  }

  /** @throws AgentPassError `NetworkError` when the profile cannot be read now (busy, failed recently, or failing) */
  async function keysOf(profileUrl: string): Promise<WebhookKey[]> {
    const hit = profiles.get(profileUrl);
    const age = hit === undefined ? Infinity : now().getTime() - hit.at;
    if (hit !== undefined && "keys" in hit && age < PROFILE_CACHE_MS) return hit.keys;
    if (hit !== undefined && "failed" in hit && age < PROFILE_FAIL_CACHE_MS) throw new AgentPassError("NetworkError", "the store's profile failed to read a moment ago", { details: { profileUrl } });
    const pending = reading.get(profileUrl);
    if (pending !== undefined) return pending;
    if (readsRunning >= MAX_CONCURRENT_PROFILE_READS || !takeToken()) throw new AgentPassError("NetworkError", "too many profile reads right now", { details: { profileUrl } });
    readsRunning += 1;
    const work = fetchProfile(profileUrl)
      .then((profile) => {
        const keys = webhookKeys(profile);
        remember(profileUrl, { at: now().getTime(), keys });
        return keys;
      })
      .catch((error: unknown) => {
        remember(profileUrl, { at: now().getTime(), failed: true });
        throw error instanceof AgentPassError ? error : new AgentPassError("NetworkError", "the store's profile could not be read", { details: { profileUrl }, cause: error });
      })
      .finally(() => {
        readsRunning -= 1;
        reading.delete(profileUrl);
      });
    reading.set(profileUrl, work);
    return work;
  }

  const refuse = (status: number, code: string, message: string): WebhookAnswer => ({ status, body: { ok: false, code, message } });

  async function verifyAndKeep(url: string, headers: Readonly<Record<string, string | undefined>>, body: Buffer, webhookId: string, timestamp: string, profile: URL): Promise<WebhookAnswer> {
    let keys: WebhookKey[];
    try {
      keys = await keysOf(profile.href);
    } catch (error) {
      log("order webhook: store profile unreadable", { store: profile.origin, error: error instanceof Error ? error.message : String(error) });
      // The store retries a 5xx; the profile may answer next time.
      return refuse(503, "ProfileUnavailable", "the store's profile could not be read");
    }
    const at = Math.floor(now().getTime() / 1000);
    const check = verifyHttpMessageSignature({ method: "POST", url, headers, body, keyFor: (keyid) => keys.find((k) => k.kid === keyid), requiredComponents: REQUIRED_COMPONENTS, now: at });
    if (!check.ok) {
      log("order webhook refused", { store: profile.origin, webhookId, reason: check.reason });
      return refuse(401, "SignatureInvalid", `the delivery does not verify: ${check.reason}`);
    }
    if (check.created === null || Math.abs(at - check.created) > SIGNATURE_MAX_AGE_SECONDS) {
      log("order webhook refused", { store: profile.origin, webhookId, reason: "stale" });
      return refuse(401, "SignatureStale", "the delivery was not signed in the last five minutes");
    }

    let json: unknown;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      return refuse(400, "BadBody", "the body is not a UCP order");
    }
    const order = deliveredOrderSchema.safeParse(json);
    if (!order.success) return refuse(400, "BadBody", "the body is not a UCP order");
    // UCP: the signer must be authorized for the order it reports, here the store whose permalink it is.
    if (!URL.canParse(order.data.permalink_url) || new URL(order.data.permalink_url).origin !== profile.origin) {
      return refuse(403, "NotYourOrder", "the order in the body is not this store's");
    }
    const last = order.data.fulfillment?.events?.at(-1)?.type;
    const received: ReceivedWebhook = {
      webhookId,
      store: profile.origin,
      orderRef: createHash("sha256").update(order.data.id).digest("hex").slice(0, 16),
      event: last ?? "created",
      occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
      receivedAt: now().toISOString(),
    };
    seen.add(webhookId);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    kept.unshift(received);
    kept.splice(MAX_KEPT);
    log("order webhook received", { ...received, orderId: order.data.id });
    const version = order.data.ucp?.version;
    return { status: 200, body: { ucp: { ...(version === undefined ? {} : { version }), status: "success" } } };
  }

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
      if (profileUrl === undefined || !URL.canParse(profileUrl)) return refuse(400, "BadHeaders", "UCP-Agent must name the store's profile");
      const profile = new URL(profileUrl);
      if (profile.protocol !== "https:" || profile.port !== "" || profile.pathname !== "/.well-known/ucp" || profile.search !== "" || !isAgentPeyStoreHost(profile.hostname)) {
        return refuse(403, "UnknownStore", "only stores AgentPey runs deliver here");
      }
      if (seen.has(webhookId)) return { status: 200, body: { ucp: { status: "success" }, duplicate: true } };
      // A copy arriving while the first is being checked: try again shortly (a 5xx is retried), never accept twice.
      if (receiving.has(webhookId)) return refuse(503, "InProgress", "this delivery is being received right now");
      receiving.add(webhookId);
      try {
        return await verifyAndKeep(url, headers, body, webhookId, timestamp, profile);
      } finally {
        receiving.delete(webhookId);
      }
    },

    /** What arrived, newest first. */
    recent(): ReceivedWebhook[] {
      return kept.map((r) => ({ ...r }));
    },
  };
}

export type OrderWebhookReceiver = ReturnType<typeof createOrderWebhookReceiver>;
