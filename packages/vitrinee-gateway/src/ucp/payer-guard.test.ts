import { MockStoreAdapter } from "@vitrinee/adapters";
import { STELLAR_X402_HANDLER, UCP_REST_PREFIX } from "@vitrinee/core";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { fakeFacilitator, type FakeFacilitator } from "../test/fake-facilitator.js";
import { fakePlatformProfiles, fakeRegistry, testConfig } from "../test/fixtures.js";
import { listen } from "../test/listen.js";
import { ucpErrors } from "../test/ucp-schemas.js";
import { MemoryCheckoutSessions } from "./sessions.js";

// The tests' transactions are not real envelopes, so who signed one is written in it: `payer:<account>:<nonce>`.
vi.mock("../payer.js", () => ({
  payerFromTransactionXdr: (xdr: string) => {
    const [tag, account] = xdr.split(":");
    return tag === "payer" ? account : undefined;
  },
}));

const CHECKOUT_SCHEMA = "https://ucp.dev/schemas/shopping/fulfillment.json#/$defs/dev.ucp.shopping.checkout";
// The accounts of the 2026-10-19 incident (testnet): the first three are blocked in the first test, the last is not.
const BLOCKED = "GD7O7GEOP4Y3YG4JHSGOH5FOBZGLZUZWRMADELTRNPC3IYYQ4H7CINQ7";
const OTHER = "GBJDXLBZAZ3KCANJSPED6JJ7CQJ55FBNNJDRIOCBSS57JOKWVOSQVOUF";

const DESTINATION = { first_name: "Ana", last_name: "Rojas", street_address: "Av. Providencia 1234", address_locality: "Santiago", address_region: "RM", address_country: "CL" };
const READY = { line_items: [{ item: { id: "gorro-andes" }, quantity: 1 }], buyer: { email: "ana@example.com" }, fulfillment: { methods: [{ type: "shipping", destinations: [DESTINATION] }] } };

interface Checkout {
  id: string;
  status: string;
  messages: Array<{ code: string; severity: string; path?: string }>;
  ucp: { payment_handlers: Record<string, Array<{ config: { payment_requirements?: Record<string, unknown> } }>> };
  order?: { id: string };
}

let nonce = 0;
const payment = (accepted: unknown, payer: string) => ({
  payment: {
    instruments: [
      {
        id: "instr_1",
        handler_id: "stellar_x402",
        type: "stellar_x402",
        selected: true,
        credential: { type: "x402_payment_payload", x402_version: 2, accepted, payload: { transaction: `payer:${payer}:${(nonce += 1)}` } },
      },
    ],
  },
});

/** A store with the brake set as `env` says, a facilitator that settles unless `refuse` is raised, and a clock to move. */
async function store(env: Record<string, string>) {
  const clock = { now: new Date("2026-10-22T12:00:00.000Z") };
  const base = fakeFacilitator();
  const control = { refuse: false, refuseWithHash: false, fail: false };
  let n = 0;
  const facilitator: FakeFacilitator = {
    ...base,
    async settle(payload, requirements) {
      base.settleCalls.push({ payload, requirements });
      if (control.fail) throw new Error("connect ETIMEDOUT");
      if (control.refuseWithHash) return { success: false, transaction: "ab".repeat(32), network: "stellar:testnet", errorReason: "settle_exact_stellar_transaction_failed" };
      if (control.refuse) return { success: false, transaction: "", network: "stellar:testnet", errorReason: "invalid_exact_stellar_payload_simulation_failed" };
      n += 1;
      return { success: true, transaction: n.toString(16).padStart(64, "0"), network: "stellar:testnet", payer: OTHER };
    },
  };
  const registry = fakeRegistry();
  const app = createApp({
    platformProfiles: fakePlatformProfiles(),
    config: testConfig(env),
    adapter: new MockStoreAdapter(),
    facilitator,
    anchorer: registry.anchorer,
    registry: registry.registry,
    sessions: new MemoryCheckoutSessions(),
    anchorRetryDelaysMs: [1],
    now: () => clock.now,
  });
  const { url, close } = await listen(app);
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${UCP_REST_PREFIX}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "UCP-Agent": 'profile="https://agentpey.com/ucp/platform/agentpey.json"' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Checkout;
  };
  /** Opens a checkout and tries to complete it as `payer`. */
  const buy = async (payer: string) => {
    const created = await call("/checkout-sessions", READY);
    const accepted = created.ucp.payment_handlers[STELLAR_X402_HANDLER]?.[0]?.config.payment_requirements;
    return call(`/checkout-sessions/${created.id}/complete`, payment(accepted, payer));
  };
  /** The x402 door that predates UCP: a 402, then the payment signed for what it asked. */
  const buyDirect = async (payer: string) => {
    const path = `${url}/checkout/gorro-andes`;
    const body = JSON.stringify({ buyer: { name: "Ana Rojas", email: "ana@example.com", address: "Av. Providencia 1234, Santiago", country: "CL" } });
    const post = (headers: Record<string, string> = {}) => fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const challenge = await post();
    const required = decodePaymentRequiredHeader(challenge.headers.get("payment-required") ?? "");
    return post({
      "payment-signature": encodePaymentSignatureHeader({
        x402Version: required.x402Version,
        resource: required.resource,
        accepted: required.accepts[0]!,
        payload: { transaction: `payer:${payer}:${(nonce += 1)}` },
      }),
    });
  };
  return { buy, buyDirect, facilitator, control, clock, close };
}

describe("a store's brake on who may pay (T172, VT-49)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("changes nothing when neither switch is set", async () => {
    const s = await store({});
    close = s.close;
    for (let i = 0; i < 4; i += 1) expect((await s.buy(BLOCKED)).status).toBe("completed");
  });

  it("refuses a blocked payer before anything settles, with a UCP message of its own, and lets another payer buy", async () => {
    const s = await store({ BLOCKED_PAYERS: BLOCKED });
    close = s.close;

    const refused = await s.buy(BLOCKED);
    expect(refused.status).toBe("ready_for_complete");
    expect(refused.messages).toEqual([expect.objectContaining({ code: "payer_blocked", severity: "unrecoverable", path: "$.payment" })]);
    expect(ucpErrors(CHECKOUT_SCHEMA, refused)).toEqual([]);
    // No money moved and no order exists.
    expect(refused.order).toBeUndefined();
    expect(s.facilitator.settleCalls).toHaveLength(0);

    const allowed = await s.buy(OTHER);
    expect(allowed.status).toBe("completed");
    expect(s.facilitator.settleCalls).toHaveLength(1);
  });

  it("limits each payer to the window, and lets it buy again when the window passes", async () => {
    const s = await store({ PAYER_LIMIT: "2/3600" });
    close = s.close;

    expect((await s.buy(OTHER)).status).toBe("completed");
    expect((await s.buy(OTHER)).status).toBe("completed");

    const third = await s.buy(OTHER);
    expect(third.status).toBe("ready_for_complete");
    expect(third.messages).toEqual([expect.objectContaining({ code: "payer_rate_limited", severity: "recoverable" })]);
    expect(ucpErrors(CHECKOUT_SCHEMA, third)).toEqual([]);
    expect(s.facilitator.settleCalls).toHaveLength(2);

    // Another payer is not affected by it.
    expect((await s.buy(BLOCKED)).status).toBe("completed");

    s.clock.now = new Date(s.clock.now.getTime() + 3_601_000);
    expect((await s.buy(OTHER)).status).toBe("completed");
  });

  it("does not count a payment the facilitator refused", async () => {
    const s = await store({ PAYER_LIMIT: "1/3600" });
    close = s.close;

    s.control.refuse = true;
    const failed = await s.buy(OTHER);
    expect(failed.messages).toEqual([expect.objectContaining({ code: "payment_failed" })]);

    s.control.refuse = false;
    expect((await s.buy(OTHER)).status).toBe("completed");
    // And now that one has been bought, the next is over the limit.
    expect((await s.buy(OTHER)).messages).toEqual([expect.objectContaining({ code: "payer_rate_limited" })]);
  });

  it("counts two purchases that arrive together once each, so neither slips under the limit", async () => {
    const s = await store({ PAYER_LIMIT: "1/3600" });
    close = s.close;

    const results = await Promise.all([s.buy(OTHER), s.buy(OTHER)]);
    expect(results.map((r) => r.status).sort()).toEqual(["completed", "ready_for_complete"]);
    expect(s.facilitator.settleCalls).toHaveLength(1);
  });

  it("keeps the place of a payment nobody knows the outcome of: it may have settled", async () => {
    const s = await store({ PAYER_LIMIT: "1/3600" });
    close = s.close;

    // The facilitator names a transaction while refusing: it may have gone through.
    s.control.refuseWithHash = true;
    await s.buy(OTHER);
    s.control.refuseWithHash = false;
    expect((await s.buy(OTHER)).messages).toEqual([expect.objectContaining({ code: "payer_rate_limited" })]);
  });

  it("keeps the place of a payment whose request failed on the way, for the same reason", async () => {
    const s = await store({ PAYER_LIMIT: "1/3600" });
    close = s.close;

    s.control.fail = true;
    await s.buy(OTHER);
    s.control.fail = false;
    expect((await s.buy(OTHER)).messages).toEqual([expect.objectContaining({ code: "payer_rate_limited" })]);
  });
});

describe("the same brake at the x402 door that predates UCP (T172, VT-49)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("refuses a blocked payer before the facilitator is asked, and lets another one buy", async () => {
    const s = await store({ BLOCKED_PAYERS: BLOCKED });
    close = s.close;

    const refused = await s.buyDirect(BLOCKED);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(s.facilitator.settleCalls).toHaveLength(0);

    const allowed = await s.buyDirect(OTHER);
    expect(allowed.status).toBe(200);
    expect(s.facilitator.settleCalls).toHaveLength(1);
  });

  it("limits a payer at both doors together: one purchase through UCP uses the place of the next at this door", async () => {
    const s = await store({ PAYER_LIMIT: "1/3600" });
    close = s.close;

    expect((await s.buy(OTHER)).status).toBe("completed");
    const refused = await s.buyDirect(OTHER);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(s.facilitator.settleCalls).toHaveLength(1);
  });
});
