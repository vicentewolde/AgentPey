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
 */
import type { ReceiptVerification } from "@vitrinee/anchor";
import { stellarExpertTxUrl } from "@vitrinee/core";

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

function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

const COPY = {
  title: { en: "Sale receipt", es: "Recibo de venta" },
  valid: { en: "Valid receipt: all three checks pass", es: "Recibo válido: pasan las tres comprobaciones" },
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
} as const;

export function receiptPage(input: ReceiptPageInput): string {
  const { verification: v, lang } = input;
  const t = (key: keyof typeof COPY): string => escape(COPY[key][lang]);
  const r = v.receipt;

  const check = (ok: boolean, title: keyof typeof COPY, what: keyof typeof COPY, reason?: string): string => `
    <li class="check ${ok ? "ok" : "bad"}">
      <span class="mark" aria-hidden="true">${ok ? "✓" : "✕"}</span>
      <div><strong>${t(title)}</strong> <span class="state">${ok ? t("pass") : t("fail")}</span>
      <p>${t(what)}${ok || reason === undefined ? "" : ` <em>${escape(reason)}</em>`}</p></div>
    </li>`;

  const items =
    r === null
      ? ""
      : r.items
          .map(
            (item) =>
              `<tr><td>${escape(item.name)}</td><td class="num">${String(item.quantity)}</td><td class="num">${escape(item.unitPriceUSDC)}</td></tr>`,
          )
          .join("");

  const links: string[] = [];
  if (r !== null) links.push(`<a href="${escape(stellarExpertTxUrl(r.settlementTxHash))}">${t("payment")}</a>`);
  if (input.anchorTxHash !== undefined) links.push(`<a href="${escape(stellarExpertTxUrl(input.anchorTxHash))}">${t("anchor")}</a>`);
  links.push(`<a href="${escape(`/receipts/${v.hash}/verify`)}">${t("json")}</a>`);

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t("title")} · ${escape(input.orderId)}</title>
<style>
  :root { --ink:#171a1f; --ink-2:#3d434c; --ink-3:#6b717a; --paper:#fbfaf7; --card:#fff; --rule:#e3e0d8; --ok:#0a7a56; --ok-wash:#e9f3ee; --bad:#b3261e; --bad-wash:#fbeceb; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 56px; }
  .top { display: flex; justify-content: space-between; align-items: center; color: var(--ink-3); font-size: 13px; }
  .top a { color: var(--ink-3); text-decoration: none; margin-left: 10px; }
  .top a[aria-current] { color: var(--ink); font-weight: 600; }
  h1 { font: 400 clamp(2rem, 6vw, 2.8rem)/1.1 Georgia, serif; margin: 22px 0 6px; }
  .verdict { margin: 18px 0 24px; padding: 16px 18px; border-radius: 10px; font-weight: 600; font-size: 1.05rem; }
  .verdict.ok { background: var(--ok-wash); color: var(--ok); border-left: 4px solid var(--ok); }
  .verdict.bad { background: var(--bad-wash); color: var(--bad); border-left: 4px solid var(--bad); }
  ul.checks { list-style: none; padding: 0; margin: 0 0 28px; display: grid; gap: 12px; }
  .check { display: flex; gap: 14px; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
  .check p { margin: 4px 0 0; color: var(--ink-2); font-size: 14px; }
  .mark { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; color: #fff; }
  .ok .mark { background: var(--ok); } .bad .mark { background: var(--bad); }
  .state { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-left: 6px; }
  .ok .state { color: var(--ok); } .bad .state { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--rule); }
  th { color: var(--ink-3); font-weight: 500; font-size: 13px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; border-bottom: 0; }
  dl { display: grid; grid-template-columns: minmax(120px, 170px) 1fr; gap: 6px 16px; margin: 20px 0; font-size: 14px; }
  dt { color: var(--ink-3); } dd { margin: 0; font-family: ui-monospace, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
  .links { display: flex; flex-wrap: wrap; gap: 10px 20px; margin: 18px 0; }
  .links a { color: var(--ok); font-weight: 500; }
  .foot { color: var(--ink-3); font-size: 12.5px; margin-top: 28px; }
</style>
</head>
<body>
<main>
  <div class="top"><span>Vitrinee · AgentPey</span><span><a href="?lang=en"${lang === "en" ? ' aria-current="true"' : ""}>EN</a><a href="?lang=es"${lang === "es" ? ' aria-current="true"' : ""}>ES</a></span></div>
  <h1>${t("title")}</h1>
  <p class="verdict ${v.valid ? "ok" : "bad"}">${v.valid ? t("valid") : t("invalid")}</p>
  <ul class="checks">
    ${check(v.checks.signature.ok, "signature", "signatureWhat", v.checks.signature.reason)}
    ${check(v.checks.anchored.ok, "anchored", "anchoredWhat", v.checks.anchored.reason)}
    ${check(v.checks.settlement.ok, "settlement", "settlementWhat", v.checks.settlement.reason)}
  </ul>
  ${
    r === null
      ? ""
      : `<table>
    <thead><tr><th>${t("product")}</th><th class="num">${t("quantity")}</th><th class="num">USDC</th></tr></thead>
    <tbody>${items}</tbody>
    <tfoot><tr><td>${t("total")}</td><td></td><td class="num">${escape(r.amountUSDC)} USDC</td></tr></tfoot>
  </table>
  <dl>
    <dt>${t("order")}</dt><dd>${escape(input.orderId)}</dd>
    <dt>${t("issued")}</dt><dd>${escape(r.issuedAt.replace("T", " ").slice(0, 16))} UTC</dd>
    <dt>${t("store")}</dt><dd title="${escape(r.merchantAccount)}">${escape(short(r.merchantAccount))}</dd>
    <dt>${t("payer")}</dt><dd title="${escape(r.payerAccount)}">${escape(short(r.payerAccount))}</dd>
  </dl>`
  }
  <p class="links">${links.join("")}</p>
  <p class="foot">${t("testnet")} SHA-256 ${escape(v.hash)}</p>
</main>
</body>
</html>`;
}
