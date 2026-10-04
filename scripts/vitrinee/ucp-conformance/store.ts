/**
 * The UCP conformance store (T131, R-3): a Vitrinee storefront that only ever
 * runs on this machine, so the official UCP conformance suite can drive a
 * checkout to `completed`.
 *
 * The suite always pays with `mock_payment_handler` and a fixed token, and asks
 * for `POST /testing/simulate-shipping/{id}` behind a shared secret. A real
 * store has neither, and must not: a payment method that charges nothing, in a
 * deployed service, is an open authorization point (the same class of risk as
 * B-25). So none of it lives in the gateway. This file wraps the real
 * `createApp` from the outside:
 *
 * - The checkout code is untouched. A `complete` with the suite's instrument is
 *   rewritten, before the gateway sees it, into a `stellar_x402` credential for
 *   the session's own stored requirements, whose "transaction" is the suite's
 *   token. Only this store's fake facilitator settles it: `success_token`
 *   settles, anything else is refused. The gateway then runs the same
 *   `complete` as in production.
 * - The merchant account and the receipt-signing key are random per run and
 *   thrown away on exit, and anchors land in an in-memory registry. Nothing
 *   this store signs can verify against a real merchant or reach the network.
 * - It listens on 127.0.0.1 only, and refuses to start where a deployed store
 *   would (`assertLocalOnly`).
 */
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type { AnchorInput, AnchorResult, AnchoredRecord } from "../../../packages/vitrinee-anchor/src/index.js";
import { MockStoreAdapter, MOCK_CATALOG, type Product } from "../../../packages/vitrinee-adapters/src/index.js";
import { UCP_REST_PREFIX, VitrineeError } from "../../../packages/vitrinee-core/src/index.js";
import { createApp, type AppDeps } from "../../../packages/vitrinee-gateway/src/app.js";
import { loadConfig } from "../../../packages/vitrinee-gateway/src/config.js";
import { OrderStore } from "../../../packages/vitrinee-gateway/src/orders.js";
import { MemoryCheckoutSessions } from "../../../packages/vitrinee-gateway/src/ucp/sessions.js";

/** The gateway's facilitator seam; typed through it, so this script needs no x402 dependency of its own. */
type FacilitatorClient = NonNullable<AppDeps["facilitator"]>;

/** The suite's test instrument, as it sends it in `complete`. */
export const MOCK_HANDLER_ID = "mock_payment_handler";
/** The only token this store's facilitator settles. Any other is refused, as the suite's `fail_token` must be. */
export const SUCCESS_TOKEN = "success_token";
/** A product the conformance data names as out of stock. */
export const OUT_OF_STOCK_ID = "agotado-cordillera";
/** The deployed receipt-registry id, only so the config parses: anchors go to memory and nothing calls it. */
const REGISTRY_ID = "CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5";
const FAKE_PAYER = "GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K";

/** The mock catalog plus one product with no stock, for the suite's out-of-stock tests. */
export const CONFORMANCE_CATALOG: readonly Product[] = [
  ...MOCK_CATALOG,
  {
    id: OUT_OF_STOCK_ID,
    sku: "AGOT-CORD",
    name: "Taza Cordillera (agotada)",
    description: "Una taza que ya no queda. Existe para probar el caso sin stock.",
    priceLocal: "7990",
    currency: "CLP",
    stock: 0,
    images: [],
  },
];

/**
 * Refuses to run anywhere a deployed store would: on Render, with the platform's
 * database or master key, or with a public base URL that is not loopback.
 */
export function assertLocalOnly(env: NodeJS.ProcessEnv): void {
  const refuse = (why: string): never => {
    throw new VitrineeError("ConfigError", `the UCP conformance store only runs on this machine: ${why}`);
  };
  if (env["RENDER"] !== undefined) refuse("RENDER is set");
  for (const key of ["DATABASE_URL", "MASTER_KEY", "VITRINEE_DATABASE_URL", "VITRINEE_MASTER_KEY"]) {
    if ((env[key] ?? "") !== "") refuse(`${key} is set`);
  }
  const base = env["PUBLIC_BASE_URL"] ?? "";
  if (base !== "") {
    let host: string;
    try {
      host = new URL(base).hostname;
    } catch {
      return refuse("PUBLIC_BASE_URL is not a URL");
    }
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") refuse(`PUBLIC_BASE_URL is not loopback (${host})`);
  }
}

/** A facilitator that settles the conformance token and refuses everything else. No network. */
function conformanceFacilitator(): FacilitatorClient {
  let n = 0;
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }],
        extensions: [],
        signers: { "stellar:testnet": [FAKE_PAYER] },
      };
    },
    async verify(payload) {
      const ok = (payload.payload as { transaction?: unknown }).transaction === SUCCESS_TOKEN;
      return ok ? { isValid: true, payer: FAKE_PAYER } : { isValid: false, invalidReason: "invalid_payload", payer: FAKE_PAYER };
    },
    async settle(payload) {
      if ((payload.payload as { transaction?: unknown }).transaction !== SUCCESS_TOKEN) {
        return { success: false, errorReason: "invalid_payload", transaction: "", network: "stellar:testnet", payer: FAKE_PAYER };
      }
      n += 1;
      return { success: true, transaction: `c0f0${n.toString(16).padStart(60, "0")}`, network: "stellar:testnet", payer: FAKE_PAYER };
    },
  };
}

/** Receipt anchors in memory, so the receipt path runs without Soroban. */
function memoryRegistry(merchant: string) {
  const records = new Map<string, AnchoredRecord>();
  let ledger = 1;
  return {
    anchorer: {
      async anchor(input: AnchorInput): Promise<AnchorResult> {
        ledger += 1;
        records.set(input.hash, { merchant, amount: input.amount, orderRef: input.orderRef, ledger, timestamp: Math.floor(Date.now() / 1000) });
        return { txHash: ledger.toString(16).padStart(64, "a"), ledger, alreadyAnchored: false };
      },
    },
    registry: { contractId: REGISTRY_ID, get: async (hash: string) => records.get(hash) ?? null },
  };
}

/** Schema-valid requirements for a session with none yet; the gateway stops at "not ready" before settling. */
const NOT_READY_REQUIREMENTS = { scheme: "exact", network: "stellar:testnet", asset: "none", amount: "0", payTo: "none", maxTimeoutSeconds: 1 } as const;

const mockInstrumentSchema = z.looseObject({
  handler_id: z.literal(MOCK_HANDLER_ID),
  credential: z.looseObject({ token: z.string().max(200).optional() }).optional(),
});

function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ConformanceStore {
  url: string;
  /** The merchant account of this run, random and never funded. */
  merchant: string;
  close(): Promise<void>;
}

export async function startConformanceStore(options: { port?: number; simulationSecret: string; env?: NodeJS.ProcessEnv }): Promise<ConformanceStore> {
  assertLocalOnly(options.env ?? process.env);
  if (options.simulationSecret.length < 16) throw new VitrineeError("ConfigError", "the simulation secret must be at least 16 characters");

  const merchant = Keypair.random().publicKey();
  const signer = Keypair.random();
  const port = options.port ?? 0;
  const dir = mkdtempSync(join(tmpdir(), "vitrinee-ucp-conformance-"));
  const memory = memoryRegistry(signer.publicKey());
  const sessions = new MemoryCheckoutSessions();
  const orders = new OrderStore(join(dir, "orders.json"));

  // The env is built here, never read from the shell: nothing of a real store leaks in.
  const config = loadConfig({
    // Not where it listens (port 0 picks a free one below); the config only needs a valid number.
    PORT: String(port === 0 ? 4999 : port),
    ADAPTER: "mock",
    MERCHANT_NAME: "Bazar Cordillera (conformidad UCP, local)",
    MERCHANT_STELLAR_ACCOUNT: merchant,
    MERCHANT_SIGNING_SECRET: signer.secret(),
    RECEIPT_REGISTRY_ID: REGISTRY_ID,
    FX_RATE_CLP_USD: "950",
    // The suite's addresses are in the US and Canada.
    SHIPPING_COUNTRIES: "CL,US,CA",
    ORDERS_FILE: join(dir, "orders.json"),
  });
  const inner = createApp({
    config,
    adapter: new MockStoreAdapter({ catalog: CONFORMANCE_CATALOG }),
    facilitator: conformanceFacilitator(),
    orders,
    sessions,
    anchorer: memory.anchorer,
    registry: memory.registry,
    disputes: null,
    syncFacilitatorOnStart: false,
    anchorRetryDelaysMs: [10],
  });

  const app = express();
  app.disable("x-powered-by");
  // Parsed here, so the rewrite below sees the body; the inner app's parser then skips it.
  app.use(express.json({ limit: "64kb" }));

  // A bug in the suite, not in the store (reported as
  // Universal-Commerce-Protocol/conformance#116): its create helper sends a destination's
  // locality and region as `locality` and `region`
  // (integration_test_utils.py, `ShippingDestinationCreateRequest(locality=…,
  // region=…)`), while UCP's postal_address says `address_locality` and
  // `address_region`. Renamed here, only for this local store, so the store sees
  // the address the suite meant; a real store keeps reading the standard names.
  app.use(`${UCP_REST_PREFIX}/checkout-sessions`, (req: Request, _res: Response, next: NextFunction) => {
    const methods = (req.body as { fulfillment?: { methods?: unknown } } | undefined)?.fulfillment?.methods;
    if (Array.isArray(methods)) {
      for (const method of methods as Array<{ destinations?: unknown }>) {
        if (!Array.isArray(method?.destinations)) continue;
        for (const dest of method.destinations as Array<Record<string, unknown>>) {
          for (const [from, to] of [["locality", "address_locality"], ["region", "address_region"]] as const) {
            if (dest[from] !== undefined && dest[to] === undefined) {
              dest[to] = dest[from];
              delete dest[from];
            }
          }
        }
      }
    }
    next();
  });

  // The suite's test instrument becomes a stellar_x402 credential for exactly the
  // session's stored requirements. The token travels as the "transaction": only
  // this store's facilitator knows what it means. A session that is not ready has
  // no requirements yet: the placeholder lets the gateway answer what is missing,
  // which it does before anything is settled.
  app.post(`${UCP_REST_PREFIX}/checkout-sessions/:id/complete`, async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const body = req.body as { payment?: { instruments?: unknown[] } } | undefined;
      const instruments = body?.payment?.instruments;
      if (Array.isArray(instruments)) {
        const session = await sessions.get(String(req.params.id));
        body!.payment!.instruments = instruments.map((raw) => {
          const parsed = mockInstrumentSchema.safeParse(raw);
          if (!parsed.success) return raw;
          return {
            ...(raw as object),
            handler_id: "stellar_x402",
            type: "stellar_x402",
            selected: true,
            credential: {
              type: "x402_payment_payload",
              x402_version: 2,
              accepted: session?.requirements ?? NOT_READY_REQUIREMENTS,
              payload: { transaction: parsed.data.credential?.token ?? "" },
            },
          };
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  // The suite's shipping simulation, behind its shared secret. Order events and
  // webhooks arrive with T147; until then this only answers for an order that exists.
  app.post("/testing/simulate-shipping/:orderId", (req: Request, res: Response) => {
    if (!secretMatches(req.header("simulation-secret"), options.simulationSecret)) {
      res.status(403).json({ error: "Forbidden", message: "missing or wrong Simulation-Secret" });
      return;
    }
    const orderId = String(req.params.orderId);
    if (orders.get(orderId) === undefined) {
      res.status(404).json({ error: "NotFound", message: `no order with id "${orderId}"` });
      return;
    }
    res.json({ order_id: orderId, status: "shipped" });
  });

  app.use(inner);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}`,
    merchant,
    close: async () => {
      await inner.anchors.idle();
      inner.anchors.stop();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
