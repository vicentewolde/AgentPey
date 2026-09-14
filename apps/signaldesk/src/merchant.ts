/**
 * SignalDesk's HTTP surface: a catalogue a person can read, a `ServiceCard`
 * feed an agent can read, two paid routes, and the artefacts and receipts that
 * come out of them.
 *
 * **Delivery happens after settlement, never before.** The order in
 * `handlePaidRoute` is the whole guarantee: require a payment header, check the
 * payload names *these* terms for *this* URL, verify against the network,
 * settle on the network, and only then render anything. A failure at any step
 * returns a refusal and no artefact, and no row is written.
 *
 * **The same settled transaction delivers once.** `recordDelivery` is keyed on
 * the payment transaction, so a client that retries after a timeout gets the
 * delivery it already paid for rather than a second artefact — which is
 * acceptance case 8, from the merchant's side of it.
 *
 * The transport — the `402` envelope, `PAYMENT-SIGNATURE` decoding, verify and
 * settle through `x402Facilitator` — is what `examples/reference-merchant`
 * (T54) already proved against testnet, carried over rather than reinvented.
 * What is new here is two products, real delivery, and signed receipts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AgentPassError, ulid } from "@agentpass/core";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { createEd25519Signer, STELLAR_TESTNET_CAIP2, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { z } from "zod";

import { artifactHash, renderCreditsStatement, renderMarketBrief } from "./artifacts.js";
import {
  CREDITS_PER_PURCHASE,
  PRODUCTS,
  SUPPORTED_PAIR,
  accountSchema,
  pairSchema,
  productForPath,
  type SignalDeskProduct,
} from "./catalog.js";
import { renderCatalogPage } from "./page.js";
import { signReceipt, type SignedReceipt } from "./receipts.js";
import { createMemoryStore, type DeliveryRecord, type SignalDeskStore } from "./store.js";

export const DISCOVERY_PATH = "/api/discovery/search";
export const ARTIFACT_PREFIX = "/deliveries/";
export const RECEIPT_SUFFIX = "/receipt";

const paymentHeaderSchema = z.string().min(1).max(32_768);

const paymentPayloadSchema = z.object({
  x402Version: z.number().int().positive(),
  resource: z
    .object({ url: z.url(), description: z.string().optional(), mimeType: z.string().optional() })
    .optional(),
  accepted: z.object({
    scheme: z.literal("exact"),
    network: z.literal(STELLAR_TESTNET_CAIP2),
    asset: z.string(),
    amount: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()),
  }),
  payload: z.record(z.string(), z.unknown()),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const signalDeskConfigSchema = z.object({
  /** The account SignalDesk is paid at — and, since T79, its venue identity. */
  merchantPayTo: accountSchema,
  /** Signs delivery receipts. The same account, so a verifier needs one public key, not two. */
  merchantSecret: z.string().regex(/^S[A-Z2-7]{55}$/, "expected a Stellar secret seed"),
  facilitatorSecret: z.string().regex(/^S[A-Z2-7]{55}$/, "expected a Stellar secret seed"),
  asset: z.string().regex(/^C[A-Z2-7]{55}$/, "expected a Stellar asset contract").default(USDC_TESTNET_ADDRESS),
  port: z.number().int().min(0).max(65_535).default(4030),
  /** Where this merchant is reachable from outside, for the URLs it publishes. */
  publicUrl: z.string().optional(),
});

export type SignalDeskConfig = z.input<typeof signalDeskConfigSchema>;
type ResolvedConfig = z.output<typeof signalDeskConfigSchema>;

class MerchantError extends Error {
  constructor(
    readonly code: "InvalidRequest" | "InvalidPayment" | "PaymentProcessingFailed" | "NotFound",
    readonly status: number,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

function requirements(config: ResolvedConfig, product: SignalDeskProduct): PaymentRequirements {
  return {
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    asset: config.asset,
    amount: product.priceAtomic,
    payTo: config.merchantPayTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

function paymentRequired(config: ResolvedConfig, product: SignalDeskProduct, resourceUrl: string): PaymentRequired {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resourceUrl, description: product.description, mimeType: "text/html" },
    accepts: [requirements(config, product)],
  };
}

function sameRequirements(left: PaymentRequirements, right: PaymentRequirements): boolean {
  return (
    left.scheme === right.scheme &&
    left.network === right.network &&
    left.asset === right.asset &&
    left.amount === right.amount &&
    left.payTo === right.payTo &&
    left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
    JSON.stringify(left.extra) === JSON.stringify(right.extra)
  );
}

function send(response: ServerResponse, status: number, body: string, contentType: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": contentType, ...headers });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8", headers);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  send(response, status, body, "text/html; charset=utf-8");
}

function requestUrl(request: IncomingMessage, config: ResolvedConfig): URL {
  const host = request.headers.host;
  if (host === undefined) throw new MerchantError("InvalidRequest", 400, "Host header is required");
  try {
    return new URL(request.url ?? "/", config.publicUrl ?? `http://${host}`);
  } catch (error) {
    throw new MerchantError("InvalidRequest", 400, "Request URL is invalid", error);
  }
}

/** The `ServiceCard` feed — the shape `createX402Catalog` reads, from the same table the page renders. */
function discovery(config: ResolvedConfig) {
  return {
    ok: true,
    results: PRODUCTS.map((product) => ({
      resource: {
        id: product.id,
        name: product.name,
        description: product.description,
        payment: { asset: "USDC", amount: product.price, destination: config.merchantPayTo },
        routeTemplate: product.routeTemplate,
        input: product.input,
      },
    })),
  };
}

interface Delivered {
  readonly artifact: string;
  readonly buyer: string;
  readonly body: Record<string, unknown>;
}

/**
 * Renders what was bought. Called only after settlement, and never with a
 * product or an input that was not validated — a route that could not read its
 * own inputs refused before any payment was asked for.
 */
async function deliver(
  product: SignalDeskProduct,
  url: URL,
  deliveryId: string,
  deliveredAt: Date,
  store: SignalDeskStore,
  settled: SettleResponse,
): Promise<Delivered> {
  if (product.path === "/api/x402/market-brief") {
    const pair = pairSchema.parse(url.searchParams.get("pair"));
    const artifact = renderMarketBrief({ deliveryId, pair, deliveredAt });
    return {
      artifact,
      buyer: settled.payer ?? "unknown",
      body: { pair, synthetic: true },
    };
  }

  const account = accountSchema.parse(url.searchParams.get("account"));
  const balance = await store.grantCredits(account, CREDITS_PER_PURCHASE);
  const artifact = renderCreditsStatement({
    deliveryId,
    account,
    granted: CREDITS_PER_PURCHASE,
    balance,
    deliveredAt,
  });
  return {
    artifact,
    buyer: account,
    body: { account, granted: CREDITS_PER_PURCHASE, balance, transferable: false },
  };
}

/** The public shape of a delivery: what the buyer gets back, and what a verifier needs. */
function deliveryBody(record: DeliveryRecord, baseUrl: string, extra: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    delivery_id: record.deliveryId,
    product_id: record.productId,
    artifact_url: `${baseUrl}${ARTIFACT_PREFIX}${record.deliveryId}`,
    artifact_hash: record.artifactHash,
    receipt_hash: record.signedReceipt.receiptHash,
    receipt_url: `${baseUrl}${ARTIFACT_PREFIX}${record.deliveryId}${RECEIPT_SUFFIX}`,
    delivered_at: record.deliveredAt.toISOString(),
    ...extra,
  };
}

async function handlePaidRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedConfig,
  store: SignalDeskStore,
  facilitator: x402Facilitator,
  product: SignalDeskProduct,
  url: URL,
): Promise<void> {
  // Inputs first, before a price is ever quoted: a request this route cannot
  // serve must not be told to pay for it.
  if (product.path === "/api/x402/market-brief") {
    if (url.searchParams.get("pair") !== SUPPORTED_PAIR) {
      throw new MerchantError("InvalidRequest", 400, `pair must be ${SUPPORTED_PAIR}`);
    }
  } else if (!accountSchema.safeParse(url.searchParams.get("account")).success) {
    throw new MerchantError("InvalidRequest", 400, "account must be a Stellar classic account or an opaque platform reference");
  }

  const signature = paymentHeaderSchema.safeParse(request.headers["payment-signature"]);
  if (!signature.success) {
    const challenge = paymentRequired(config, product, url.toString());
    sendJson(response, 402, challenge, { "payment-required": encodePaymentRequiredHeader(challenge) });
    return;
  }

  let payload: PaymentPayload;
  try {
    payload = paymentPayloadSchema.parse(decodePaymentSignatureHeader(signature.data)) as PaymentPayload;
  } catch (error) {
    throw new MerchantError("InvalidPayment", 402, "PAYMENT-SIGNATURE is not a valid x402 payment payload", error);
  }

  const expected = requirements(config, product);
  if (!sameRequirements(payload.accepted, expected) || payload.resource?.url !== url.toString()) {
    throw new MerchantError("InvalidPayment", 402, "payment payload does not match this resource's terms");
  }

  let verified;
  try {
    verified = await facilitator.verify(payload, expected);
  } catch (error) {
    throw new MerchantError("PaymentProcessingFailed", 502, "could not verify the payment against Stellar testnet", error);
  }
  if (!verified.isValid) {
    throw new MerchantError("InvalidPayment", 402, verified.invalidMessage ?? verified.invalidReason ?? "payment verification failed");
  }

  let settled: SettleResponse;
  try {
    settled = await facilitator.settle(payload, expected);
  } catch (error) {
    throw new MerchantError("PaymentProcessingFailed", 502, "could not settle the payment on Stellar testnet", error);
  }
  if (!settled.success) {
    throw new MerchantError("PaymentProcessingFailed", 502, settled.errorMessage ?? settled.errorReason ?? "payment settlement failed");
  }

  const paymentTx = settled.transaction ?? "";
  if (paymentTx === "") {
    throw new MerchantError("PaymentProcessingFailed", 502, "settlement reported success without a transaction");
  }

  // Settled once, delivered once. A retry of a transaction already delivered
  // against returns that delivery instead of minting a second artefact.
  const already = await store.findDeliveryByPayment(paymentTx);
  const baseUrl = `${url.protocol}//${url.host}`;
  if (already !== undefined) {
    sendJson(response, 200, deliveryBody(already, baseUrl, { replayed: true }), {
      "payment-response": encodePaymentResponseHeader(settled),
    });
    return;
  }

  const deliveryId = ulid();
  const deliveredAt = new Date();
  const delivered = await deliver(product, url, deliveryId, deliveredAt, store, settled);
  const hash = artifactHash(delivered.artifact);

  const signedReceipt: SignedReceipt = signReceipt(
    {
      delivery_id: deliveryId,
      product_id: product.id,
      buyer: delivered.buyer,
      amount: settled.amount ?? expected.amount,
      asset: expected.asset,
      pay_to: expected.payTo,
      payment_tx: paymentTx,
      artifact_hash: hash,
      delivered_at: deliveredAt.toISOString(),
    },
    config.merchantSecret,
  );

  const record = await store.recordDelivery(paymentTx, {
    deliveryId,
    productId: product.id,
    buyer: delivered.buyer,
    artifact: delivered.artifact,
    artifactHash: hash,
    signedReceipt,
    deliveredAt,
  });

  sendJson(response, 200, deliveryBody(record, baseUrl, delivered.body), {
    "payment-response": encodePaymentResponseHeader(settled),
  });
}

export interface SignalDeskServer {
  readonly server: Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface StartOptions {
  readonly store?: SignalDeskStore;
}

export function createSignalDeskServer(input: SignalDeskConfig, options: StartOptions = {}): Server {
  const config = signalDeskConfigSchema.parse(input);
  const store = options.store ?? createMemoryStore();
  const facilitator = new x402Facilitator().register(
    STELLAR_TESTNET_CAIP2,
    new ExactStellarScheme([createEd25519Signer(config.facilitatorSecret, STELLAR_TESTNET_CAIP2)]),
  );

  return createServer((request, response) => {
    void (async () => {
      try {
        const url = requestUrl(request, config);
        const { pathname } = url;

        if (request.method === "GET" && pathname === "/") {
          sendHtml(response, 200, renderCatalogPage({ payTo: config.merchantPayTo, discoveryPath: DISCOVERY_PATH }));
          return;
        }

        if (request.method === "GET" && pathname === DISCOVERY_PATH) {
          sendJson(response, 200, discovery(config));
          return;
        }

        if (request.method === "GET" && pathname.startsWith(ARTIFACT_PREFIX)) {
          const rest = pathname.slice(ARTIFACT_PREFIX.length);
          const wantsReceipt = rest.endsWith(RECEIPT_SUFFIX);
          const deliveryId = wantsReceipt ? rest.slice(0, -RECEIPT_SUFFIX.length) : rest;
          const record = await store.findDelivery(deliveryId);
          if (record === undefined) throw new MerchantError("NotFound", 404, "no such delivery");

          if (wantsReceipt) {
            sendJson(response, 200, { ok: true, ...record.signedReceipt });
          } else {
            sendHtml(response, 200, record.artifact);
          }
          return;
        }

        if (request.method === "GET" && pathname === "/api/credits") {
          const account = accountSchema.safeParse(url.searchParams.get("account"));
          if (!account.success) throw new MerchantError("InvalidRequest", 400, "account must be a Stellar classic account or an opaque platform reference");
          // Read-only, on purpose: there is no route on this service that moves
          // a balance from one account to another, because there is no such
          // operation to expose.
          sendJson(response, 200, { ok: true, account: account.data, balance: await store.readCredits(account.data), transferable: false });
          return;
        }

        const product = request.method === "GET" ? productForPath(pathname) : undefined;
        if (product !== undefined) {
          await handlePaidRoute(request, response, config, store, facilitator, product, url);
          return;
        }

        sendJson(response, 404, { ok: false, code: "NotFound" });
      } catch (error) {
        if (error instanceof MerchantError) {
          sendJson(response, error.status, { ok: false, code: error.code, error: error.message });
          return;
        }
        if (error instanceof AgentPassError) {
          sendJson(response, 400, { ok: false, code: error.code, error: error.message });
          return;
        }
        sendJson(response, 500, { ok: false, code: "InternalError", error: "unexpected merchant error" });
      }
    })();
  });
}

export async function startSignalDesk(input: SignalDeskConfig, options: StartOptions = {}): Promise<SignalDeskServer> {
  const config = signalDeskConfigSchema.parse(input);
  const server = createSignalDeskServer(input, options);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new AgentPassError("CommandFailed", "SignalDesk did not bind a TCP port");
  }

  return {
    server,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
  };
}
