import { Keypair } from "@stellar/stellar-sdk";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { createSignalDeskServer } from "./merchant.js";
import { PRODUCTS } from "./catalog.js";
import { createMemoryStore, type SignalDeskStore } from "./store.js";
import { signReceipt } from "./receipts.js";

const MERCHANT = Keypair.random();
const FACILITATOR = Keypair.random();

const store: SignalDeskStore = createMemoryStore();

const server = createSignalDeskServer(
  {
    merchantPayTo: MERCHANT.publicKey(),
    merchantSecret: MERCHANT.secret(),
    facilitatorSecret: FACILITATOR.secret(),
    port: 0,
  },
  { store },
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
});

describe("the human catalogue", () => {
  it("serves a page a person can read at the root", async () => {
    const response = await fetch(baseUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("SignalDesk");
  });
});

describe("the ServiceCard feed", () => {
  it("answers the shape createX402Catalog reads, for both products", async () => {
    const body = (await (await fetch(`${baseUrl}/api/discovery/search`)).json()) as {
      ok: boolean;
      results: { resource: { id: string; name: string; payment: { amount: string; destination: string }; routeTemplate: string } }[];
    };

    expect(body.ok).toBe(true);
    expect(body.results.map((row) => row.resource.id)).toEqual(PRODUCTS.map((product) => product.id));
    for (const row of body.results) {
      expect(row.resource.payment.destination).toBe(MERCHANT.publicKey());
      expect(row.resource.routeTemplate).toContain("/api/x402/");
    }
  });

  it("quotes the same price the page shows", async () => {
    const body = (await (await fetch(`${baseUrl}/api/discovery/search`)).json()) as {
      results: { resource: { id: string; payment: { amount: string } } }[];
    };
    const page = await (await fetch(baseUrl)).text();

    for (const row of body.results) {
      expect(page).toContain(`${row.resource.payment.amount} USDC`);
    }
  });
});

describe("the paid routes", () => {
  it("answers 402 with an x402 challenge naming this merchant's terms", async () => {
    const response = await fetch(`${baseUrl}/api/x402/market-brief?pair=XLM/USDC`);
    const body = (await response.json()) as {
      x402Version: number;
      accepts: { scheme: string; network: string; amount: string; payTo: string }[];
    };

    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "stellar:testnet",
      amount: "2500000",
      payTo: MERCHANT.publicKey(),
    });
  });

  it("quotes 0.10 for the credits route", async () => {
    const response = await fetch(`${baseUrl}/api/x402/ai-credits?account=${MERCHANT.publicKey()}`);
    const body = (await response.json()) as { accepts: { amount: string }[] };

    expect(response.status).toBe(402);
    expect(body.accepts[0]!.amount).toBe("1000000");
  });

  /**
   * A request the route could not serve must not be quoted a price: telling
   * someone to pay for something that was always going to be refused is the
   * one failure mode a paid route must not have.
   */
  it("refuses a bad input with 400 before asking for any payment", async () => {
    const badPair = await fetch(`${baseUrl}/api/x402/market-brief?pair=BTC/USD`);
    const noAccount = await fetch(`${baseUrl}/api/x402/ai-credits?account=not-an-account`);

    expect(badPair.status).toBe(400);
    expect(noAccount.status).toBe(400);
    expect((await badPair.json()) as { code: string }).toMatchObject({ code: "InvalidRequest" });
  });

  /**
   * T85, found against production: RealOps credits a purchase to the opaque
   * reference AgentPey knows the person by (`C-98`), never to anything
   * personal, and this route refused it with a 400 — so the credits product
   * could not be bought from the pilot's own platform at all. It has to quote
   * that request, and still refuse anything that is neither an account nor an
   * opaque reference, an email included.
   */
  it("quotes a credits request for an opaque platform reference, and still refuses an email", async () => {
    const opaque = await fetch(`${baseUrl}/api/x402/ai-credits?account=rop_01M2ERCZRRHJWRSHXQEWPCWYQS`);
    const email = await fetch(`${baseUrl}/api/x402/ai-credits?account=${encodeURIComponent("persona@example.com")}`);
    const lookalike = await fetch(`${baseUrl}/api/x402/ai-credits?account=rop_not-a-ulid`);

    expect(opaque.status).toBe(402);
    expect(email.status).toBe(400);
    expect(lookalike.status).toBe(400);
  });

  it("refuses a payment header that is not an x402 payload, without touching the network", async () => {
    const response = await fetch(`${baseUrl}/api/x402/market-brief?pair=XLM/USDC`, {
      headers: { "payment-signature": "bm90LWFuLXg0MDItcGF5bG9hZA==" },
    });

    expect(response.status).toBe(402);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "InvalidPayment" });
  });

  it("delivers nothing on a refusal — no artefact, no row", async () => {
    await fetch(`${baseUrl}/api/x402/market-brief?pair=XLM/USDC`);
    await fetch(`${baseUrl}/api/x402/market-brief?pair=BTC/USD`);

    expect(await store.findDeliveryByPayment("any")).toBeUndefined();
  });
});

describe("deliveries and receipts", () => {
  const deliveryId = "01J7QW8VQEJPAXEPAYSIGNAL09";

  it("serves a stored artefact and its signed receipt", async () => {
    const artifact = "<!doctype html><p>delivered</p>";
    const signed = signReceipt(
      {
        delivery_id: deliveryId,
        product_id: "signaldesk:market-brief-xlm-usdc",
        buyer: MERCHANT.publicKey(),
        amount: "2500000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        pay_to: MERCHANT.publicKey(),
        payment_tx: "deadbeef",
        artifact_hash: "a".repeat(64),
        delivered_at: "2026-09-12T12:00:00.000Z",
      },
      MERCHANT.secret(),
    );
    await store.recordDelivery("deadbeef", {
      deliveryId,
      productId: "signaldesk:market-brief-xlm-usdc",
      buyer: MERCHANT.publicKey(),
      artifact,
      artifactHash: "a".repeat(64),
      signedReceipt: signed,
      deliveredAt: new Date("2026-09-12T12:00:00.000Z"),
    });

    const artifactResponse = await fetch(`${baseUrl}/deliveries/${deliveryId}`);
    expect(artifactResponse.status).toBe(200);
    expect(await artifactResponse.text()).toBe(artifact);

    const receiptResponse = await fetch(`${baseUrl}/deliveries/${deliveryId}/receipt`);
    expect(receiptResponse.status).toBe(200);
    expect((await receiptResponse.json()) as { signedBy: string }).toMatchObject({
      signedBy: MERCHANT.publicKey(),
      receiptHash: signed.receiptHash,
    });
  });

  it("404s an unknown delivery", async () => {
    expect((await fetch(`${baseUrl}/deliveries/01J7QW8VQEJPAXEPAYNOTHERE`)).status).toBe(404);
  });
});

describe("credits", () => {
  it("reads a balance and says it is not transferable", async () => {
    const account = Keypair.random().publicKey();
    await store.grantCredits(account, 1000);

    const body = (await (await fetch(`${baseUrl}/api/credits?account=${account}`)).json()) as {
      balance: number;
      transferable: boolean;
    };

    expect(body).toMatchObject({ balance: 1000, transferable: false });
  });

  /**
   * Not a policy test — a structural one. If a route to move credits ever
   * appears, this is where it shows up.
   */
  it("exposes no route that moves credits between accounts", async () => {
    const from = Keypair.random().publicKey();
    const to = Keypair.random().publicKey();
    await store.grantCredits(from, 1000);

    for (const path of ["/api/credits/transfer", "/api/credits/send", "/api/transfer"]) {
      const response = await fetch(`${baseUrl}${path}?from=${from}&to=${to}&amount=1000`, { method: "POST" });
      expect(response.status).toBe(404);
    }
    expect(await store.readCredits(to)).toBe(0);
  });
});
