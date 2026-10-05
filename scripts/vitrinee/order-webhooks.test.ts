/**
 * A Vitrinee store tells AgentPey what happened to an order, end to end and
 * without a network (T147): the store's real event service signs each
 * delivery with its webhook key, and AgentPey's real receiver (apps/web)
 * verifies it against the key the store publishes in its own profile.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOrderWebhookReceiver } from "../../apps/web/src/ucp-webhooks.js";
import { AGENTPEY_PLATFORM_PROFILE_2026_08_25 } from "../../apps/agent/src/payment/ucp.js";
import { MockStoreAdapter } from "../../packages/vitrinee-adapters/src/index.js";
import { STELLAR_X402_HANDLER, UCP_REST_PREFIX } from "../../packages/vitrinee-core/src/index.js";
import { createApp, type VitrineeApp } from "../../packages/vitrinee-gateway/src/app.js";
import { OrderStore } from "../../packages/vitrinee-gateway/src/orders.js";
import { fakeFacilitator } from "../../packages/vitrinee-gateway/src/test/fake-facilitator.js";
import { fakePlatformProfiles, fakeRegistry, testConfig } from "../../packages/vitrinee-gateway/src/test/fixtures.js";
import { listen } from "../../packages/vitrinee-gateway/src/test/listen.js";
import type { PlatformSender } from "../../packages/vitrinee-gateway/src/ucp/platform-profile.js";

/** What the store calls itself: one of AgentPey's storefront hosts, which is all the receiver reads profiles from. */
const STORE = "https://teststore.vitrinee.agentpey.com";
const HOOKS = "https://agentpey.com/ucp/webhooks/orders";
const DESTINATION = { first_name: "Ana", street_address: "Av. Providencia 1234", address_locality: "Santiago", address_region: "RM", address_country: "CL" };

describe("a Vitrinee store's order webhooks, verified by AgentPey's receiver (T147)", () => {
  let app: VitrineeApp;
  let local = "";
  let close: () => Promise<void> = async () => {};
  const adapter = new MockStoreAdapter();
  const orders = new OrderStore();
  // The receiver reads the store's profile; here, from the store itself, listening locally.
  const receiver = createOrderWebhookReceiver({ fetchProfile: async (url) => (await fetch(url.replace(STORE, local))).json() });
  const answers: number[] = [];
  const sender: PlatformSender = {
    async send(url, request) {
      const answer = await receiver.receive(url, request.headers, Buffer.from(request.body));
      answers.push(answer.status);
      return { ok: true, status: answer.status };
    },
  };

  beforeAll(async () => {
    const registry = fakeRegistry();
    app = createApp({
      config: testConfig({ PUBLIC_BASE_URL: STORE }),
      adapter,
      orders,
      facilitator: fakeFacilitator(),
      anchorer: registry.anchorer,
      registry: registry.registry,
      platformProfiles: fakePlatformProfiles({
        [AGENTPEY_PLATFORM_PROFILE_2026_08_25]: { ucp: { version: "2026-08-25", capabilities: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.order"] }, keys: [], orderWebhookUrl: HOOKS },
      }),
      webhookSender: sender,
      anchorRetryDelaysMs: [1],
    });
    ({ url: local, close } = await listen(app));
  });
  afterAll(async () => {
    app.orderEvents.stop();
    app.anchors.stop();
    await close();
  });

  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${local}${UCP_REST_PREFIX}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "UCP-Agent": `profile="${AGENTPEY_PLATFORM_PROFILE_2026_08_25}"` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { id: string; ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements: unknown } }>> }; order?: { id: string } };
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 300 && !done(); i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  it("accepts the 'created' and 'shipped' deliveries of a real checkout, and nothing a store did not sign", async () => {
    const created = await call("/checkout-sessions", { line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }], buyer: { email: "ana@example.com" }, fulfillment: { methods: [{ type: "shipping", destinations: [DESTINATION] }] } });
    const accepted = created.ucp.payment_handlers[STELLAR_X402_HANDLER]![0]!.config.payment_requirements;
    const done = await call(`/checkout-sessions/${created.id}/complete`, {
      payment: { instruments: [{ id: "i1", handler_id: "stellar_x402", type: "stellar_x402", credential: { type: "x402_payment_payload", x402_version: 2, accepted, payload: { transaction: Buffer.from("tx").toString("base64") } } }] },
    });
    const orderId = done.order!.id;
    await until(() => receiver.recent().length === 1);
    const orderRef = createHash("sha256").update(orderId).digest("hex").slice(0, 16);
    expect(receiver.recent()).toEqual([expect.objectContaining({ store: STORE, orderRef, event: "created" })]);

    await adapter.markShipped(orders.get(orderId)!.platformOrderId!, { shippedAt: "2026-10-05T12:00:00.000Z", trackingNumber: "CX123" });
    await app.orderEvents.checkShipment(orderId, { force: true });
    await until(() => receiver.recent().length === 2);
    expect(receiver.recent()[0]).toMatchObject({ orderRef, event: "shipped" });
    expect(answers).toEqual([200, 200]);
    expect(orders.get(orderId)?.webhook?.deliveries.map((d) => d.status)).toEqual(["delivered", "delivered"]);
  });
});
