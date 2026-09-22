/**
 * The purchase, step by step, the way it will be narrated on screen:
 * read the storefront → pick the product → 402 → sign → pay → receipt →
 * anchor → verify. A standard x402 client (`@x402/core` + `@x402/stellar`);
 * nothing here is Vitrinee-specific except reading the manifest.
 */
import { randomUUID } from "node:crypto";

import type { ReceiptVerification } from "@vitrinee/anchor";
import {
  MANIFEST_PATH,
  VitrineeError,
  parseDecimal,
  stellarExpertTxUrl,
  storefrontManifestSchema,
  usdcAtomicToDecimal,
  type StorefrontManifest,
} from "@vitrinee/core";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

import { parseIntent, type PurchaseIntent } from "./matcher.js";
import { reportVerification } from "./report.js";

export interface BuyOptions {
  gatewayUrl: string;
  instruction: string;
  /** The buyer's Stellar secret. Undefined means dry run: stop at the 402. */
  signerSecret: string | undefined;
  /** Per-payment cap in USDC, the agent's own guard rail. */
  maxUsdc: string;
  dryRun?: boolean;
  /** Wait for the anchor and verify the receipt (default true). */
  verify?: boolean;
  anchorTimeoutMs?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

interface OrderView {
  orderId: string;
  status: string;
  platform: string;
  platformOrderId: string | null;
  amountUSDC: string;
  receipt: { jws: string; hash: string; verifyPath: string } | null;
  anchor: { status: "pending" | "anchored" | "failed"; ledger?: number; explorerUrl?: string; lastError?: string } | null;
}

export interface BuyResult {
  manifest: StorefrontManifest;
  intent: PurchaseIntent;
  requirements: PaymentRequirements;
  /** Undefined on a dry run. */
  order?: {
    orderId: string;
    status: string;
    platform: string;
    platformOrderId: string | null;
    amountUSDC: string;
    txHash: string;
    explorerUrl: string;
    receiptJws: string | null;
    receiptHash: string | null;
    anchor: OrderView["anchor"];
    raw: Record<string, unknown>;
  };
  verification?: ReceiptVerification & { orderId?: string };
  elapsedMs: number;
  timings: Record<string, number>;
}

const short = (account: string): string => `${account.slice(0, 4)}…${account.slice(-4)}`;
const clp = (value: string): string => Number(value).toLocaleString("es-CL");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function buy(options: BuyOptions): Promise<BuyResult> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = performance.now();
  const timings: Record<string, number> = {};
  const mark = (phase: string): void => {
    timings[phase] = Math.round(performance.now() - started);
  };
  const base = options.gatewayUrl.replace(/\/+$/, "");

  // 1. Read the storefront.
  const manifestResponse = await fetchImpl(`${base}${MANIFEST_PATH}`);
  if (!manifestResponse.ok) {
    throw new VitrineeError("NetworkError", `la tienda no respondió el manifest (HTTP ${manifestResponse.status})`, {
      details: { url: `${base}${MANIFEST_PATH}` },
    });
  }
  const manifest = storefrontManifestSchema.parse(await manifestResponse.json());
  log(`  tienda       ${manifest.merchant.name} · ${manifest.merchant.did}`);
  log(`  catálogo     ${manifest.products.length} productos en ${manifest.merchant.currency} · tasa demo ${manifest.fx.rate} ${manifest.fx.quote}/${manifest.fx.base}`);
  log(`  red          ${manifest.network} · facilitator ${manifest.settlement.facilitator}`);
  mark("manifest");

  // 2. Decide what to buy.
  const intent = parseIntent(manifest.products, options.instruction);
  const { product } = intent;
  const totalAtomic = BigInt(product.priceUSDCAtomic) * BigInt(intent.quantity);
  log(`  instrucción  "${options.instruction}"`);
  log(`  elegido      ${product.name} × ${intent.quantity} (${intent.reasons.join(", ")})`);
  log(`  precio       ${clp(product.priceLocal)} ${product.currency} c/u → ${usdcAtomicToDecimal(totalAtomic)} USDC en total`);
  log(`  envío        ${intent.shipping.city ?? "(sin ciudad)"}, ${intent.shipping.country}`);

  const capAtomic = parseDecimal(options.maxUsdc, 7);
  if (totalAtomic > capAtomic) {
    throw new VitrineeError("PaymentError", `el total (${usdcAtomicToDecimal(totalAtomic)} USDC) supera el tope del agente (${options.maxUsdc} USDC)`, {
      details: { totalUSDC: usdcAtomicToDecimal(totalAtomic), maxUsdc: options.maxUsdc },
    });
  }

  // 3. Ask to buy: the store answers 402 with the exact price. The same
  //    Idempotency-Key rides both requests, so a retry never buys twice.
  const checkoutUrl = `${base}${product.checkoutRoute}`;
  const body = JSON.stringify({ quantity: intent.quantity, buyer: { shipping: intent.shipping } });
  const headers = { "content-type": "application/json", "idempotency-key": `agent-${randomUUID()}` };
  log(`→ POST ${product.checkoutRoute}`);
  const challenge = await fetchImpl(checkoutUrl, { method: "POST", headers, body });
  if (challenge.status !== 402) {
    const text = await challenge.text();
    throw new VitrineeError("PaymentError", `la tienda respondió ${challenge.status} en vez de 402`, {
      details: { status: challenge.status, body: text.slice(0, 500) },
    });
  }

  const client = new x402Client();
  if (options.signerSecret !== undefined) {
    const signer = createEd25519Signer(options.signerSecret, "stellar:testnet");
    client.register("stellar:*", new ExactStellarScheme(signer));
    // The SDK caps unattended payments at $1 by default. This agent raises its
    // own cap explicitly — the number is the principal's decision, not the SDK's.
    client.setSpendControls({ maxAmountPerPayment: `$${options.maxUsdc}` });
  }
  const http = new x402HTTPClient(client);
  const paymentRequired = http.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json());
  const requirements = paymentRequired.accepts[0];
  if (requirements === undefined) {
    throw new VitrineeError("PaymentError", "el 402 no trae opciones de pago", { details: { paymentRequired } });
  }
  const sponsored = (requirements.extra as { areFeesSponsored?: boolean } | undefined)?.areFeesSponsored === true;
  log(`← 402 Pago requerido`);
  log(`  cobro        ${usdcAtomicToDecimal(BigInt(requirements.amount))} USDC (${requirements.amount} stroops) → ${short(requirements.payTo)}${sponsored ? " · fees patrocinados por el facilitator" : ""}`);
  mark("challenge");
  if (requirements.amount !== totalAtomic.toString()) {
    throw new VitrineeError("PaymentError", "el precio del 402 no coincide con el del manifest", {
      details: { manifest: totalAtomic.toString(), challenge: requirements.amount },
    });
  }

  if (options.dryRun || options.signerSecret === undefined) {
    log("  (dry run: no se firma ni se paga)");
    return { manifest, intent, requirements, elapsedMs: performance.now() - started, timings };
  }

  // 4. Sign the Soroban authorization entry and retry with the payment header.
  const payerAccount = createEd25519Signer(options.signerSecret, "stellar:testnet").address;
  log(`→ firmando auth entry con ${short(payerAccount)}`);
  let payload;
  try {
    payload = await client.createPaymentPayload(paymentRequired);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("resulting balance is not within the allowed range")) {
      throw new VitrineeError("PaymentError", `saldo USDC insuficiente en ${payerAccount}. Fondéala en https://faucet.circle.com`, {
        details: { payerAccount },
        cause: error,
      });
    }
    throw error;
  }
  mark("signed");
  const paymentHeaders = http.encodePaymentSignatureHeader(payload);
  log(`→ POST ${product.checkoutRoute} + PAYMENT-SIGNATURE`);
  const paid = await fetchImpl(checkoutUrl, { method: "POST", headers: { ...headers, ...paymentHeaders }, body });
  const raw = (await paid.json()) as Record<string, unknown>;
  if (!paid.ok) {
    throw new VitrineeError("PaymentError", `el pago fue rechazado (HTTP ${paid.status})`, { details: { status: paid.status, body: raw } });
  }
  mark("paid");

  // 5. Proof: settlement, order, receipt.
  const view = raw as unknown as OrderView;
  const settlement = http.getPaymentSettleResponse((name) => paid.headers.get(name));
  const txHash = settlement.transaction;
  log(`← ${paid.status} pagado y ordenado`);
  log(`  pedido       ${view.orderId} · ${view.platform} ${view.platformOrderId ?? "(sin id de plataforma)"} · ${view.status}`);
  log(`  pago         ${stellarExpertTxUrl(txHash)}`);
  log(`  recibo       JWS firmado · sha256 ${view.receipt?.hash ?? "(sin recibo)"}`);

  let anchor = view.anchor;
  let verification: BuyResult["verification"];
  if (options.verify !== false && view.receipt !== null) {
    // 6. Wait for the anchor (it runs after the response, V-5), then verify.
    const deadline = Date.now() + (options.anchorTimeoutMs ?? 60_000);
    while (anchor?.status === "pending" && Date.now() < deadline) {
      await sleep(1_000);
      anchor = ((await (await fetchImpl(`${base}/orders/${view.orderId}`)).json()) as OrderView).anchor;
    }
    mark("anchored");
    if (anchor?.status === "anchored") {
      log(`  anclaje      ledger ${anchor.ledger ?? "?"}${anchor.explorerUrl === undefined ? "" : ` · ${anchor.explorerUrl}`}`);
    } else {
      log(`  anclaje      ${anchor?.status ?? "?"}${anchor?.lastError === undefined ? "" : ` (${anchor.lastError})`}`);
    }
    log(`→ GET ${view.receipt.verifyPath}`);
    verification = (await (await fetchImpl(`${base}${view.receipt.verifyPath}`)).json()) as BuyResult["verification"];
    reportVerification(verification!, log);
    mark("verified");
  }

  const elapsedMs = performance.now() - started;
  log(`  tiempo       ${(elapsedMs / 1000).toFixed(1)} s (pago ${((timings["paid"] ?? 0) / 1000).toFixed(1)} s)`);
  return {
    manifest,
    intent,
    requirements,
    order: {
      orderId: view.orderId,
      status: view.status,
      platform: view.platform,
      platformOrderId: view.platformOrderId,
      amountUSDC: view.amountUSDC,
      txHash,
      explorerUrl: stellarExpertTxUrl(txHash),
      receiptJws: view.receipt?.jws ?? null,
      receiptHash: view.receipt?.hash ?? null,
      anchor,
      raw,
    },
    ...(verification === undefined ? {} : { verification }),
    elapsedMs,
    timings,
  };
}
