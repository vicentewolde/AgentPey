/**
 * The purchase, step by step, the way it will be narrated on screen:
 * read the storefront → pick the product → 402 → sign → pay → proof.
 * A standard x402 client (`@x402/core` + `@x402/stellar`); nothing here is
 * Vitrinee-specific except reading the manifest.
 */
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

export interface BuyOptions {
  gatewayUrl: string;
  instruction: string;
  /** The buyer's Stellar secret. Undefined means dry run: stop at the 402. */
  signerSecret: string | undefined;
  /** Per-payment cap in USDC, the agent's own guard rail. */
  maxUsdc: string;
  dryRun?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
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
    raw: Record<string, unknown>;
  };
  elapsedMs: number;
}

const short = (account: string): string => `${account.slice(0, 4)}…${account.slice(-4)}`;
const clp = (value: string): string => Number(value).toLocaleString("es-CL");

export async function buy(options: BuyOptions): Promise<BuyResult> {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = performance.now();
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

  // 3. Ask to buy: the store answers 402 with the exact price.
  const checkoutUrl = `${base}${product.checkoutRoute}`;
  const body = JSON.stringify({ quantity: intent.quantity, buyer: { shipping: intent.shipping } });
  const headers = { "content-type": "application/json" };
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
  if (requirements.amount !== totalAtomic.toString()) {
    throw new VitrineeError("PaymentError", "el precio del 402 no coincide con el del manifest", {
      details: { manifest: totalAtomic.toString(), challenge: requirements.amount },
    });
  }

  if (options.dryRun || options.signerSecret === undefined) {
    log("  (dry run: no se firma ni se paga)");
    return { manifest, intent, requirements, elapsedMs: performance.now() - started };
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
  const paymentHeaders = http.encodePaymentSignatureHeader(payload);
  log(`→ POST ${product.checkoutRoute} + PAYMENT-SIGNATURE`);
  const paid = await fetchImpl(checkoutUrl, { method: "POST", headers: { ...headers, ...paymentHeaders }, body });
  const raw = (await paid.json()) as Record<string, unknown>;
  if (!paid.ok) {
    throw new VitrineeError("PaymentError", `el pago fue rechazado (HTTP ${paid.status})`, {
      details: { status: paid.status, body: raw },
    });
  }

  // 5. Proof.
  const settlement = http.getPaymentSettleResponse((name) => paid.headers.get(name));
  const txHash = settlement.transaction;
  const order = {
    orderId: String(raw["orderId"]),
    status: String(raw["status"]),
    platform: String(raw["platform"]),
    platformOrderId: raw["platformOrderId"] === null ? null : String(raw["platformOrderId"]),
    amountUSDC: String(raw["amountUSDC"]),
    txHash,
    explorerUrl: stellarExpertTxUrl(txHash),
    raw,
  };
  const elapsedMs = performance.now() - started;
  log(`← ${paid.status} pagado y ordenado`);
  log(`  pedido       ${order.orderId} · ${order.platform} ${order.platformOrderId ?? "(sin id de plataforma)"} · ${order.status}`);
  log(`  tx           ${order.explorerUrl}`);
  log(`  tiempo       ${(elapsedMs / 1000).toFixed(1)} s`);
  return { manifest, intent, requirements, order, elapsedMs };
}
