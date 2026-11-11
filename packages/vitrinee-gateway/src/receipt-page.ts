/**
 * The receipt, for a person (T108).
 *
 * `/receipts/{hash}/verify` answers JSON, which is right for an agent and
 * useless for the store owner who clicks "Receipt" in the portal: they saw a
 * black page of code. This renders the very same verification as a page. It
 * computes nothing of its own, so the page and the JSON can never disagree; the
 * JSON stays one link away for anyone who wants to check it.
 *
 * English by default with Spanish beside it, as every page of the pilot, and no
 * script: the language switch is two anchors that reload with `?lang=`.
 *
 * It wears AgentPey's one stylesheet (T207, Y-7): this gateway serves `/brand/agentpey.css` on every store's host
 * (`brand.ts`), so the receipt looks like agentpey.com and follows the system's light or dark theme. The links in
 * the header are absolute: this page lives on a store's subdomain.
 */
import type { ReceiptVerification } from "@vitrinee/anchor";
import { stellarExpertAddressUrl, stellarExpertTxUrl } from "@vitrinee/core";

export interface ReceiptPageInput {
  readonly orderId: string;
  readonly verification: ReceiptVerification;
  /** The anchoring transaction, when the order record has it. */
  readonly anchorTxHash?: string;
  readonly lang: "en" | "es";
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const SITE = "https://agentpey.com";

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

const COPY = {
  title: { en: "Sale receipt", es: "Recibo de venta" },
  valid: { en: "Valid receipt: all three checks pass", es: "Recibo válido: pasan las tres comprobaciones" },
  validHeld: { en: "Valid receipt: all four checks pass", es: "Recibo válido: pasan las cuatro comprobaciones" },
  invalid: { en: "This receipt does not pass every check", es: "Este recibo no pasa todas las comprobaciones" },
  signature: { en: "Signed by the store", es: "Firmado por la tienda" },
  signatureWhat: {
    en: "The receipt carries the signature of the key the store publishes in its did:stellar.",
    es: "El recibo lleva la firma de la llave que la tienda publica en su did:stellar.",
  },
  anchored: { en: "Anchored on Stellar", es: "Anclado en Stellar" },
  anchoredWhat: {
    en: "Its fingerprint is in the receipt-registry contract, for this store, this amount and this order.",
    es: "Su huella está en el contrato receipt-registry, para esta tienda, este monto y este pedido.",
  },
  settlement: { en: "Paid on the network", es: "Pagado en la red" },
  settlementWhat: {
    en: "The Stellar transaction really moved this USDC to the store.",
    es: "La transacción de Stellar de verdad movió estos USDC a la tienda.",
  },
  settlementHeldWhat: {
    en: "The Stellar transaction really moved this USDC into the store's escrow, which holds it until the order ships.",
    es: "La transacción de Stellar de verdad movió estos USDC al escrow de la tienda, que los retiene hasta el despacho.",
  },
  held: { en: "Held for this receipt", es: "Retenido para este recibo" },
  heldWhat: {
    en: "The store's escrow holds this payment for this receipt, this order, this payer and this amount. One payment, one receipt.",
    es: "El escrow de la tienda retiene este pago para este recibo, este pedido, este pagador y este monto. Un pago, un recibo.",
  },
  pass: { en: "valid", es: "válido" },
  fail: { en: "failed", es: "falló" },
  product: { en: "Product", es: "Producto" },
  quantity: { en: "Qty", es: "Cant." },
  total: { en: "Total", es: "Total" },
  order: { en: "Order", es: "Pedido" },
  issued: { en: "Issued", es: "Emitido" },
  store: { en: "Store account", es: "Cuenta de la tienda" },
  payer: { en: "Paid from", es: "Pagado desde" },
  payment: { en: "See the payment on Stellar ↗", es: "Ver el pago en Stellar ↗" },
  anchor: { en: "See the anchor on Stellar ↗", es: "Ver el ancla en Stellar ↗" },
  json: { en: "The same verification, as JSON", es: "La misma verificación, en JSON" },
  testnet: { en: "Stellar testnet. Test USDC, not real money.", es: "Stellar testnet. USDC de prueba, no dinero real." },
  eyebrow: { en: "Vitrinee · Stellar testnet", es: "Vitrinee · Stellar testnet" },
  live: { en: "Live", es: "En vivo" },
  stores: { en: "Stores", es: "Tiendas" },
} as const;

export function receiptPage(input: ReceiptPageInput): string {
  const { verification: v, lang } = input;
  const t = (key: keyof typeof COPY): string => escape(COPY[key][lang]);
  const r = v.receipt;

  // A verification from before T159 has no `held`: read as a receipt paid directly.
  const held = v.checks.held ?? null;
  const check = (ok: boolean, title: keyof typeof COPY, what: keyof typeof COPY, reason?: string): string => `
      <li class="check ${ok ? "ok" : "bad"}">
        <span class="rc-tick ${ok ? "ap-ok" : "ap-bad"}" aria-hidden="true">${ok ? "✓" : "✕"}</span>
        <div class="rc-check-body">
          <p class="rc-check-head"><strong>${t(title)}</strong> <span class="ap-pill ${ok ? "ap-ok" : "ap-bad"}">${ok ? t("pass") : t("fail")}</span></p>
          <p class="ap-muted ap-small">${t(what)}${ok || reason === undefined ? "" : ` <em class="rc-reason">${escape(reason)}</em>`}</p>
        </div>
      </li>`;

  const items =
    r === null
      ? ""
      : r.items
          .map(
            (item) =>
              `<tr><td>${escape(item.name)}</td><td class="ap-num">${String(item.quantity)}</td><td class="ap-num">${escape(item.unitPriceUSDC)}</td></tr>`,
          )
          .join("");

  const account = (address: string): string =>
    `<a class="ap-hash" href="${escape(stellarExpertAddressUrl(address))}" title="${escape(address)}">${escape(short(address))}</a>`;

  const links: string[] = [];
  if (r !== null) links.push(`<a href="${escape(stellarExpertTxUrl(r.settlementTxHash))}">${t("payment")}</a>`);
  if (input.anchorTxHash !== undefined) links.push(`<a href="${escape(stellarExpertTxUrl(input.anchorTxHash))}">${t("anchor")}</a>`);
  links.push(`<a href="${escape(`/receipts/${v.hash}/verify`)}">${t("json")}</a>`);

  const verdict = v.valid ? t(held === null ? "valid" : "validHeld") : t("invalid");

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t("title")} · ${escape(input.orderId)}</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="/brand/agentpey-favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/brand/agentpey.css">
<style>
  .rc-main { max-width: calc(var(--ap-read) + 32px); }
  .rc-head { display: grid; gap: 10px; }
  .verdict .ap-note { font-family: var(--ap-display); font-weight: 600; font-size: clamp(1.15rem, 2.6vw, 1.4rem); line-height: 1.25; letter-spacing: -0.016em; padding: 18px 22px; border-radius: var(--ap-radius); }
  ul.checks { list-style: none; margin: 0; padding: 0; display: grid; }
  .check { display: flex; gap: 14px; align-items: flex-start; padding-block: 14px; }
  .check:first-child { padding-top: 0; }
  .check:last-child { padding-bottom: 0; }
  .check + .check { border-top: 1px solid var(--ap-hair); }
  .rc-tick { flex: none; width: 28px; height: 28px; border-radius: var(--ap-pill); display: grid; place-items: center; font-weight: 600; font-size: 0.875rem; }
  .rc-tick.ap-ok { background: var(--ap-ok-soft); color: var(--ap-ok); }
  .rc-tick.ap-bad { background: var(--ap-bad-soft); color: var(--ap-bad); }
  .rc-check-body { display: grid; gap: 4px; min-width: 0; }
  .rc-check-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .rc-reason { color: var(--ap-bad); font-style: normal; overflow-wrap: anywhere; }
  .rc-table th.ap-num { text-align: right; }
  .rc-table tfoot td { font-weight: 600; }
  .rc-links { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 0.9375rem; }
  .ap-footer .ap-hash { background: transparent; padding: 0; color: var(--ap-ink-2); }
</style>
</head>
<body class="ap">
<header class="ap-header"><div class="ap-wrap">
  <a class="ap-brand" href="${SITE}/">
    <svg viewBox="0 0 512 512" aria-hidden="true"><defs><mask id="ap-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/><path d="M378 112l54 54" stroke="#000" stroke-width="60"/></mask></defs><g mask="url(#ap-cut)" fill="none" stroke="currentColor" stroke-width="60"><path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g></svg>
    AgentPey</a>
  <div class="ap-bar">
    <nav class="ap-nav" aria-label="AgentPey">
      <a class="ap-hide-sm" href="${SITE}/en-vivo">${t("live")}</a>
      <a class="ap-hide-sm" href="${SITE}/tiendas">${t("stores")}</a>
      <a href="https://github.com/vicentewolde/AgentPey" rel="noopener">GitHub</a>
    </nav>
    <span class="ap-lang"><a href="?lang=en" hreflang="en"${lang === "en" ? ' aria-current="true"' : ""}>EN</a><a href="?lang=es" hreflang="es"${lang === "es" ? ' aria-current="true"' : ""}>ES</a></span>
  </div>
</div></header>

<main class="ap-wrap ap-main rc-main">
  <div class="rc-head">
    <p class="ap-eyebrow">${t("eyebrow")}</p>
    <h1>${t("title")}</h1>
  </div>
  <div class="verdict ${v.valid ? "ok" : "bad"}"><p class="ap-note ${v.valid ? "ap-ok" : "ap-bad"}" role="status">${verdict}</p></div>
  <section class="ap-card">
    <ul class="checks">
      ${check(v.checks.signature.ok, "signature", "signatureWhat", v.checks.signature.reason)}
      ${check(v.checks.anchored.ok, "anchored", "anchoredWhat", v.checks.anchored.reason)}
      ${check(v.checks.settlement.ok, "settlement", held === null ? "settlementWhat" : "settlementHeldWhat", v.checks.settlement.reason)}
      ${held === null ? "" : check(held.ok, "held", "heldWhat", held.reason)}
    </ul>
  </section>
  ${
    r === null
      ? ""
      : `<div class="ap-table-wrap"><table class="ap-table rc-table">
    <thead><tr><th>${t("product")}</th><th class="ap-num">${t("quantity")}</th><th class="ap-num">USDC</th></tr></thead>
    <tbody>${items}</tbody>
    <tfoot><tr><td>${t("total")}</td><td></td><td class="ap-num">${escape(r.amountUSDC)} USDC</td></tr></tfoot>
  </table></div>
  <section class="ap-card">
    <dl class="ap-dl">
      <dt>${t("order")}</dt><dd>${escape(input.orderId)}</dd>
      <dt>${t("issued")}</dt><dd>${escape(r.issuedAt.replace("T", " ").slice(0, 16))} UTC</dd>
      <dt>${t("store")}</dt><dd>${account(r.merchantAccount)}</dd>
      <dt>${t("payer")}</dt><dd>${account(r.payerAccount)}</dd>
    </dl>
  </section>`
  }
  <p class="rc-links">${links.join("")}</p>
</main>

<footer class="ap-footer"><div class="ap-wrap">
  <span>${t("testnet")}</span>
  <span class="ap-hash">SHA-256 ${escape(v.hash)}</span>
  <span class="ap-row"><a href="${SITE}/en-vivo">${t("live")}</a><a href="${SITE}/tiendas">${t("stores")}</a></span>
</div></footer>
</body>
</html>`;
}
