import { describe, expect, it } from "vitest";

import { DELIVERABLE_WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_TYPES } from "../webhooks.js";
import { createWebhookEndpointRequestSchema, webhookEndpointResourceSchema } from "./webhook-endpoints.js";

describe("createWebhookEndpointRequestSchema", () => {
  const valid = { url: "https://partner.example/hooks", events: ["payment.settled"] };

  it("accepts a subscription to something that actually fires", () => {
    expect(createWebhookEndpointRequestSchema.parse(valid)).toEqual(valid);
  });

  it("accepts every deliverable event type", () => {
    expect(
      createWebhookEndpointRequestSchema.parse({ ...valid, events: [...DELIVERABLE_WEBHOOK_EVENT_TYPES] }).events,
    ).toEqual([...DELIVERABLE_WEBHOOK_EVENT_TYPES]);
  });

  it("refuses the frozen names nothing emits, rather than looking wired", () => {
    // None of the three has code that fires it: two need machinery that does
    // not exist, and `payment.authorized` would announce purchases that the
    // merchant's invoice can still get refused. A partner building a renewal
    // reminder on `mandate.expiring` would wait forever.
    const undeliverable = WEBHOOK_EVENT_TYPES.filter(
      (type) => !(DELIVERABLE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type),
    );
    expect(undeliverable).toEqual(["mandate.expiring", "payment.authorized", "agent.retired"]);
    for (const type of undeliverable) {
      expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, events: [type] }).success, type).toBe(false);
    }
  });

  it("refuses an endpoint subscribed to nothing", () => {
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, events: [] }).success).toBe(false);
  });

  it("refuses a field it does not know, rather than dropping it", () => {
    expect(createWebhookEndpointRequestSchema.safeParse({ ...valid, secret: "mine" }).success).toBe(false);
  });
});

describe("webhookEndpointResourceSchema", () => {
  const base = {
    id: "whe_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    url: "https://partner.example/hooks",
    events: ["payment.settled"],
    created_at: "2026-09-20T00:00:00.000Z",
  };

  it("carries the secret on the response that mints it", () => {
    expect(webhookEndpointResourceSchema.parse({ ...base, secret: "whsec_x" }).secret).toBe("whsec_x");
  });

  it("carries null on every later read — required, not omitted", () => {
    // Required-and-nullable so an integrator reads an explicit "there is none
    // here" rather than an absent key they might treat as a bug.
    expect(webhookEndpointResourceSchema.parse({ ...base, secret: null }).secret).toBeNull();
    expect(webhookEndpointResourceSchema.safeParse(base).success).toBe(false);
  });
});
