import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { UcpStellarError } from "./errors.js";
import { DEFAULT_PLATFORM_PROFILE, pay, quote, readStoreProfile, type UcpStellarQuote } from "./checkout.js";

const STORE = "https://store.example";
const ENDPOINT = `${STORE}/ucp/v1`;
const PAY_TO = "GD2MCESI2DMMOU4F2SI6ZHDZDDCN5LA7PMKUVZSKTKVGU5RLTCNIK5GN";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OTHER_ACCOUNT = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";
const DESTINATION = { street_address: "Av. Providencia 1234", address_locality: "Santiago", address_country: "CL" };

interface StoreState {
  network: string;
  payTo: string;
  amount: string;
  lines: Array<{ id: string; quantity: number }>;
  status: string;
  spec: string;
  completed: number;
  completeBodies: unknown[];
  requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;
  failComplete: boolean;
  /** Open every checkout for these lines, whatever was asked. */
  openAs?: Array<{ id: string; quantity: number }>;
}

function profileOf(state: StoreState) {
  return {
    ucp: {
      version: "2026-04-08",
      services: { "dev.ucp.shopping": [{ version: "2026-04-08", transport: "rest", endpoint: ENDPOINT }] },
      payment_handlers: {
        "com.agentpey.stellar_x402": [
          {
            id: "stellar_x402_1",
            version: "2026-04-08",
            spec: state.spec,
            schema: "https://agentpey.com/ucp/handlers/stellar_x402/schema.json",
            config: { x402_version: 2, scheme: "exact", network: state.network, asset: { code: "USDC", contract: USDC, decimals: 7 }, pay_to: PAY_TO },
          },
        ],
      },
    },
  };
}

function checkoutOf(state: StoreState, id = "chk_1") {
  return {
    ucp: {
      payment_handlers: {
        "com.agentpey.stellar_x402": [
          {
            id: "stellar_x402_1",
            config: {
              payment_requirements: { scheme: "exact", network: state.network, asset: USDC, amount: state.amount, payTo: state.payTo, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } },
              binding: { checkout_id: id },
            },
          },
        ],
      },
    },
    id,
    status: state.status,
    currency: "USD",
    line_items: state.lines.map((line) => ({ item: { id: line.id, title: line.id }, quantity: line.quantity })),
    totals: [{ type: "total", amount: 157 }],
  };
}

/** A UCP store with the Stellar x402 handler, in memory. */
function fakeStore(overrides: Partial<StoreState> = {}) {
  const state: StoreState = {
    network: "stellar:testnet",
    payTo: PAY_TO,
    amount: "15684211",
    lines: [{ id: "iman", quantity: 1 }],
    status: "ready_for_complete",
    spec: "https://agentpey.com/ucp/handlers/stellar_x402",
    completed: 0,
    completeBodies: [],
    requests: [],
    failComplete: false,
    ...overrides,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    state.requests.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    if (url === `${STORE}/.well-known/ucp`) return json(200, profileOf(state));
    if (url === `${ENDPOINT}/checkout-sessions` && init?.method === "POST") {
      const asked = (body as { line_items: Array<{ item: { id: string }; quantity: number }> }).line_items;
      state.lines = state.openAs ?? asked.map((line) => ({ id: line.item.id, quantity: line.quantity }));
      return json(201, checkoutOf(state));
    }
    if (url === `${ENDPOINT}/checkout-sessions/chk_1` && (init?.method ?? "GET") !== "POST") return json(200, checkoutOf(state));
    if (url === `${ENDPOINT}/checkout-sessions/chk_1/complete`) {
      if (state.failComplete) throw new TypeError("socket hang up");
      state.completed += 1;
      state.completeBodies.push(body);
      return json(200, {
        ...checkoutOf(state),
        status: "completed",
        order: { id: "ord_1", permalink_url: `${STORE}/orders/ord_1` },
        receipt: { jws: "x.y.z", hash: "h", settlement_tx_hash: "abc123", verify_url: `${STORE}/verify`, anchor: { status: "anchored", registry: "CREG" } },
      });
    }
    return json(404, { messages: [{ type: "error", code: "not_found" }] });
  };
  return { state, fetchImpl };
}

/** A payer that records what it was asked to sign. */
function fakePayer(fail?: unknown): SchemeNetworkClient & { calls: PaymentRequirements[] } {
  const calls: PaymentRequirements[] = [];
  return {
    scheme: "exact",
    calls,
    async createPaymentPayload(_version: number, requirements: PaymentRequirements) {
      if (fail !== undefined) throw fail;
      calls.push(requirements);
      return { x402Version: 2, payload: { transaction: "AAAAsigned" } };
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; paymentSent: boolean; details: Readonly<Record<string, unknown>> }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UcpStellarError);
  const typed = error as UcpStellarError;
  return { code: typed.code, paymentSent: typed.paymentSent, details: typed.details };
}

describe("readStoreProfile", () => {
  it("reads the handler, the endpoint and the whole profile", async () => {
    const { fetchImpl } = fakeStore();
    const profile = await readStoreProfile(`${STORE}/some/path`, { fetch: fetchImpl });
    expect(profile).toMatchObject({ storeUrl: STORE, endpoint: ENDPOINT, handlerId: "stellar_x402_1", handler: { pay_to: PAY_TO, network: "stellar:testnet" } });
  });

  it("refuses a handler whose spec is not on agentpey.com", async () => {
    const { fetchImpl } = fakeStore({ spec: "https://agentpey.com.evil.example/ucp/handlers/stellar_x402" });
    expect((await codeOf(readStoreProfile(STORE, { fetch: fetchImpl }))).code).toBe("MerchantRejectedRequest");
  });

  it("refuses a store on mainnet: this package pays on testnet only", async () => {
    const { fetchImpl } = fakeStore({ network: "stellar:pubnet" });
    expect((await codeOf(readStoreProfile(STORE, { fetch: fetchImpl }))).code).toBe("UnsupportedNetwork");
  });

  it("refuses plain http outside localhost", async () => {
    expect((await codeOf(readStoreProfile("http://store.example"))).code).toBe("InvalidArguments");
  });

  it("sends AgentPey's public platform profile unless told otherwise", async () => {
    const store = fakeStore();
    await readStoreProfile(STORE, { fetch: store.fetchImpl });
    expect(store.state.requests[0]!.headers["UCP-Agent"]).toBe(`profile="${DEFAULT_PLATFORM_PROFILE}"`);
    await readStoreProfile(STORE, { fetch: store.fetchImpl, platformProfile: "https://me.example/profile.json" });
    expect(store.state.requests[1]!.headers["UCP-Agent"]).toBe('profile="https://me.example/profile.json"');
  });
});

describe("quote", () => {
  it("opens a checkout for one product and reads back what it would cost, signing nothing", async () => {
    const { state, fetchImpl } = fakeStore();
    const quoted = await quote({ storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION }, { fetch: fetchImpl });
    expect(quoted).toMatchObject({
      storeUrl: STORE,
      checkoutId: "chk_1",
      lines: [{ productId: "iman", quantity: 1 }],
      requirements: { amount: "15684211", payTo: PAY_TO, asset: USDC, network: "stellar:testnet" },
      asset: { code: "USDC", decimals: 7 },
      total: { amount: 157, currency: "USD" },
    });
    expect(state.completed).toBe(0);
  });

  it("opens a cart of several lines", async () => {
    const { fetchImpl } = fakeStore();
    const quoted = await quote({ storeUrl: STORE, lines: [{ productId: "iman", quantity: 2 }, { productId: "taza", quantity: 1 }], destination: DESTINATION }, { fetch: fetchImpl });
    expect(quoted.lines).toEqual([{ productId: "iman", quantity: 2 }, { productId: "taza", quantity: 1 }]);
  });

  it("sends the buyer's consent in an update after the create", async () => {
    const store = fakeStore();
    await quote(
      { storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION, buyer: { email: "buyer@example.com", consent: { marketing: true } } },
      { fetch: store.fetchImpl },
    );
    const [create, update] = store.state.requests.filter((request) => request.url.includes("checkout-sessions"));
    expect(create!.body).toMatchObject({ buyer: { email: "buyer@example.com" } });
    expect((create!.body as { buyer: Record<string, unknown> }).buyer).not.toHaveProperty("consent");
    expect(update).toMatchObject({ method: "PUT", body: { buyer: { consent: { marketing: true } } } });
  });

  it.each([
    ["no product and no lines", { destination: DESTINATION }],
    ["a product and lines at once", { productId: "iman", quantity: 1, lines: [{ productId: "taza", quantity: 1 }], destination: DESTINATION }],
    ["a quantity of zero", { productId: "iman", quantity: 0, destination: DESTINATION }],
    ["eleven lines", { lines: Array.from({ length: 11 }, (_, i) => ({ productId: `p${i}`, quantity: 1 })), destination: DESTINATION }],
    ["a country that is not ISO alpha-2", { productId: "iman", quantity: 1, destination: { ...DESTINATION, address_country: "Chile" } }],
  ])("refuses %s before calling the store", async (_what, input) => {
    const store = fakeStore();
    expect((await codeOf(quote({ storeUrl: STORE, ...input } as never, { fetch: store.fetchImpl }))).code).toBe("InvalidArguments");
    expect(store.state.requests).toEqual([]);
  });

  it("refuses a checkout that pays someone other than the declared handler", async () => {
    const { fetchImpl } = fakeStore({ payTo: OTHER_ACCOUNT });
    expect((await codeOf(quote({ storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION }, { fetch: fetchImpl }))).code).toBe("InvalidProduct");
  });

  it("refuses a checkout that is not ready to pay", async () => {
    const { fetchImpl } = fakeStore({ status: "incomplete" });
    expect((await codeOf(quote({ storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION }, { fetch: fetchImpl }))).code).toBe("MerchantRejectedRequest");
  });

  it("refuses a store that opened the checkout for other lines than asked", async () => {
    const { fetchImpl } = fakeStore({ openAs: [{ id: "taza", quantity: 1 }] });
    expect((await codeOf(quote({ storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION }, { fetch: fetchImpl }))).code).toBe("InvalidProduct");
  });

  it("names an unreachable store as a NetworkError", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await codeOf(quote({ storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION }, { fetch: down }))).toMatchObject({ code: "NetworkError", paymentSent: false });
  });
});

describe("pay", () => {
  async function quoted(overrides: Partial<StoreState> = {}): Promise<{ store: ReturnType<typeof fakeStore>; q: UcpStellarQuote }> {
    const store = fakeStore(overrides);
    const q = await quote({ storeUrl: STORE, productId: "iman", quantity: 1, destination: DESTINATION }, { fetch: store.fetchImpl });
    return { store, q };
  }

  it("signs exactly the quoted requirement and completes the checkout", async () => {
    const { store, q } = await quoted();
    const payer = fakePayer();
    const receipt = await pay(q, { payer, maxAmount: "2.00", fetch: store.fetchImpl, idempotencyKey: "k-1" });
    expect(payer.calls).toEqual([expect.objectContaining({ amount: "15684211", payTo: PAY_TO, asset: USDC })]);
    expect(receipt).toMatchObject({ orderId: "ord_1", transaction: "abc123", paid: { amount: "15684211", payTo: PAY_TO } });
    const complete = store.state.requests.find((request) => request.url.endsWith("/complete"))!;
    expect(complete.headers["Idempotency-Key"]).toBe("k-1");
    expect(complete.body).toMatchObject({ payment: { instruments: [{ handler_id: "stellar_x402_1", credential: { payload: { transaction: "AAAAsigned" } } }] } });
  });

  it("reads the store again by default, and refuses an amount that changed since the quote", async () => {
    const { store, q } = await quoted();
    store.state.amount = "15684212";
    const payer = fakePayer();
    expect(await codeOf(pay(q, { payer, maxAmount: "2.00", fetch: store.fetchImpl }))).toMatchObject({ code: "QuoteChanged", paymentSent: false });
    expect(payer.calls).toEqual([]);
  });

  it("refuses a recipient that changed in the profile and the checkout alike", async () => {
    const { store, q } = await quoted();
    store.state.payTo = OTHER_ACCOUNT;
    expect((await codeOf(pay(q, { payer: fakePayer(), maxAmount: "2.00", fetch: store.fetchImpl }))).code).toBe("QuoteChanged");
  });

  it("refuses lines that changed since the quote, at the same price", async () => {
    const { store, q } = await quoted();
    store.state.lines = [{ id: "taza", quantity: 1 }];
    expect(await codeOf(pay(q, { payer: fakePayer(), maxAmount: "2.00", fetch: store.fetchImpl }))).toMatchObject({ code: "InvalidProduct", details: { checkout: [["taza", 1]] } });
  });

  it("refuses a network that changed to mainnet since the quote", async () => {
    const { store, q } = await quoted();
    store.state.network = "stellar:pubnet";
    expect((await codeOf(pay(q, { payer: fakePayer(), maxAmount: "2.00", fetch: store.fetchImpl }))).code).toBe("QuoteChanged");
  });

  it("refuses a quote on mainnet even without reading the store again", async () => {
    const { store, q } = await quoted();
    const tampered = { ...q, requirements: { ...q.requirements, network: "stellar:pubnet" as const } };
    expect((await codeOf(pay(tampered, { payer: fakePayer(), maxAmount: "2.00", recheck: false, fetch: store.fetchImpl }))).code).toBe("UnsupportedNetwork");
  });

  it.each([
    ["a decimal", "1.5684210"],
    ["atomic units", 15684210n],
  ])("refuses an amount above maxAmount as %s, signing nothing", async (_what, maxAmount) => {
    const { store, q } = await quoted();
    const payer = fakePayer();
    expect(await codeOf(pay(q, { payer, maxAmount, fetch: store.fetchImpl }))).toMatchObject({ code: "AmountAboveLimit", paymentSent: false });
    expect(payer.calls).toEqual([]);
  });

  it("pays at exactly maxAmount", async () => {
    const { store, q } = await quoted();
    await expect(pay(q, { payer: fakePayer(), maxAmount: "1.5684211", fetch: store.fetchImpl })).resolves.toMatchObject({ orderId: "ord_1" });
  });

  it.each([
    ["a negative bigint", -1n],
    ["a malformed decimal", "1,50"],
    ["more places than the asset has", "1.00000001"],
  ])("refuses %s as maxAmount", async (_what, maxAmount) => {
    const { store, q } = await quoted();
    expect((await codeOf(pay(q, { payer: fakePayer(), maxAmount, fetch: store.fetchImpl }))).code).toBe("InvalidArguments");
  });

  it("refuses something that is not a quote", async () => {
    const { store } = await quoted();
    expect((await codeOf(pay({ storeUrl: STORE } as never, { payer: fakePayer(), maxAmount: "2.00", fetch: store.fetchImpl }))).code).toBe("InvalidArguments");
  });

  it("pays a quote kept as JSON and read back", async () => {
    const { store, q } = await quoted();
    const kept = JSON.parse(JSON.stringify(q)) as UcpStellarQuote;
    await expect(pay(kept, { payer: fakePayer(), maxAmount: "2.00", fetch: store.fetchImpl })).resolves.toMatchObject({ orderId: "ord_1" });
  });

  it("gives beforeSign the last word: its error reaches the caller as thrown, and nothing is signed", async () => {
    const { store, q } = await quoted();
    const payer = fakePayer();
    const mine = new RangeError("not today");
    await expect(pay(q, { payer, maxAmount: "2.00", fetch: store.fetchImpl, beforeSign: () => { throw mine; } })).rejects.toBe(mine);
    expect(payer.calls).toEqual([]);
    expect(store.state.completed).toBe(0);
  });

  it("adds the extension members beforeSign returns, next to the payment", async () => {
    const { store, q } = await quoted();
    let seen: unknown;
    await pay(q, {
      payer: fakePayer(),
      maxAmount: "2.00",
      fetch: store.fetchImpl,
      beforeSign: (context) => {
        seen = context;
        return { completeExtensions: { ap2: { checkout_mandate: "m" } } };
      },
    });
    expect(seen).toMatchObject({ requirements: { amount: "15684211" }, lines: [{ productId: "iman", quantity: 1 }], profile: { ucp: { version: "2026-04-08" } } });
    expect(store.state.completeBodies[0]).toMatchObject({ ap2: { checkout_mandate: "m" }, payment: { instruments: [{ id: "instr_1" }] } });
  });

  it("refuses an extension that would replace the payment", async () => {
    const { store, q } = await quoted();
    const payer = fakePayer();
    expect((await codeOf(pay(q, { payer, maxAmount: "2.00", fetch: store.fetchImpl, beforeSign: () => ({ completeExtensions: { payment: {} } }) }))).code).toBe("InvalidArguments");
    expect(payer.calls).toEqual([]);
  });

  it("lets the payer's own error through as thrown, with nothing sent", async () => {
    const { store, q } = await quoted();
    const mine = new TypeError("the wallet is locked");
    await expect(pay(q, { payer: fakePayer(mine), maxAmount: "2.00", fetch: store.fetchImpl })).rejects.toBe(mine);
    expect(store.state.completed).toBe(0);
  });

  it("stamps a package error from the payer as not sent", async () => {
    const { store, q } = await quoted();
    const typed = new UcpStellarError("RailInsufficientFunds", "empty", { paymentSent: true });
    expect(await codeOf(pay(q, { payer: fakePayer(typed), maxAmount: "2.00", fetch: store.fetchImpl }))).toMatchObject({ code: "RailInsufficientFunds", paymentSent: false });
  });

  it("refuses a payer that produced no transaction", async () => {
    const { store, q } = await quoted();
    const empty: SchemeNetworkClient = { scheme: "exact", createPaymentPayload: async (x402Version) => ({ x402Version, payload: {} }) };
    expect(await codeOf(pay(q, { payer: empty, maxAmount: "2.00", fetch: store.fetchImpl }))).toMatchObject({ code: "PaymentNotCreated", paymentSent: false });
  });

  it("says the payment may have been sent when completing fails", async () => {
    const { store, q } = await quoted();
    store.state.failComplete = true;
    expect(await codeOf(pay(q, { payer: fakePayer(), maxAmount: "2.00", fetch: store.fetchImpl }))).toMatchObject({ code: "NetworkError", paymentSent: true });
  });

  it("says the payment may have been sent when the store does not confirm the completion", async () => {
    const { store, q } = await quoted();
    const original = store.fetchImpl;
    const unconfirmed: typeof fetch = async (input, init) =>
      String(input).endsWith("/complete") ? new Response(JSON.stringify({ messages: [{ type: "error", code: "payment_failed" }] }), { status: 402 }) : original(input, init);
    expect(await codeOf(pay(q, { payer: fakePayer(), maxAmount: "2.00", fetch: unconfirmed }))).toMatchObject({ code: "NetworkError", paymentSent: true });
  });
});
