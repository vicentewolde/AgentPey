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
 * It wears the look of agentpey.com (same tokens, fonts, header and footer) so the
 * receipt a store owner or a buyer opens does not feel like another product. The
 * links in the header are absolute: this page lives on a store's subdomain.
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

const SITE = "https://agentpey.com";

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
  eyebrow: { en: "Vitrinee · Stellar testnet", es: "Vitrinee · Stellar testnet" },
  home: { en: "Home", es: "Inicio" },
  live: { en: "Live", es: "En vivo" },
  stores: { en: "Stores", es: "Tiendas" },
} as const;

export function receiptPage(input: ReceiptPageInput): string {
  const { verification: v, lang } = input;
  const t = (key: keyof typeof COPY): string => escape(COPY[key][lang]);
  const r = v.receipt;

  const check = (ok: boolean, title: keyof typeof COPY, what: keyof typeof COPY, reason?: string): string => `
    <li class="check ${ok ? "ok" : "bad"}">
      <span class="tick" aria-hidden="true">${ok ? "✓" : "✕"}</span>
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
<meta name="robots" content="noindex">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cg fill='none' stroke='%23171A1F' stroke-width='60'%3E%3Cpath d='M72 416 196 96h86v320'/%3E%3Cpath d='M136 282h146'/%3E%3Cpath d='M282 112h96'/%3E%3Cpath d='M432 166v84l-48 48H282'/%3E%3C/g%3E%3Cpath d='M378 112l54 54' fill='none' stroke='%23176BFF' stroke-width='60'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --paper: #fbfaf8; --paper-2: #f2f0ea; --ink: #0f1211; --ink-2: #434946; --ink-3: #7d8481; --rule: #e3e0d9;
    --accent: #0a7a56; --accent-soft: #e3f3ec; --bad: #b3261e; --bad-soft: #fbeceb;
    --serif: "Instrument Serif", ui-serif, Georgia, "Times New Roman", serif;
    --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 16px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .wrap { width: 100%; max-width: 1180px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 56px); }
  .narrow { max-width: 760px; }
  a { color: var(--accent); }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }

  .top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 20px; padding: 22px 0 0; }
  .brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); text-decoration: none; font-size: 15.5px; font-weight: 600; }
  .brand .logo { width: 24px; height: 24px; flex: none; }
  .utils { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px; }
  .utils > a { font-size: 13px; color: var(--ink-3); text-decoration: none; }
  .utils > a:hover { color: var(--ink); }
  .lang { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; }
  .lang a { color: var(--ink-3); text-decoration: none; }
  .lang a[aria-current] { color: var(--ink); }
  .lang span { color: var(--rule); }

  .hero { padding: clamp(28px, 4vw, 48px) 0 8px; }
  .eyebrow { font-size: 11.5px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); margin: 0; display: flex; align-items: center; gap: 8px; }
  .eyebrow i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(2.2rem, 6vw, 3.4rem); line-height: 1.06; letter-spacing: -0.016em; margin: 16px 0 0; }
  .verdict { margin: 22px 0 18px; padding: 14px 18px; border-radius: 10px; border: 1px solid var(--rule); font-weight: 600; font-size: 1.02rem; }
  .verdict.ok { background: var(--accent-soft); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--rule)); }
  .verdict.bad { background: var(--bad-soft); color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, var(--rule)); }

  ul.checks { list-style: none; padding: 0; margin: 0 0 24px; display: grid; gap: 10px; }
  .check { display: flex; gap: 14px; background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
  .check p { margin: 4px 0 0; color: var(--ink-2); font-size: 14px; }
  .tick { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; color: #fff; }
  .ok .tick { background: var(--accent); } .bad .tick { background: var(--bad); }
  .state { font-size: 11.5px; font-weight: 500; text-transform: uppercase; letter-spacing: .1em; margin-left: 6px; }
  .ok .state { color: var(--accent); } .bad .state { color: var(--bad); }

  table { width: 100%; border-collapse: separate; border-spacing: 0; background: #fff; border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; font-size: 15px; }
  th, td { padding: 11px 16px; text-align: left; border-bottom: 1px solid var(--rule); }
  th { color: var(--ink-3); font-weight: 500; font-size: 12.5px; background: var(--paper-2); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-bottom: 0; }
  dl { display: grid; grid-template-columns: minmax(110px, 160px) 1fr; gap: 8px 16px; margin: 22px 0; font-size: 14px; }
  dt { color: var(--ink-3); } dd { margin: 0; font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
  .links { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 18px 0 36px; font-size: 13.5px; }
  .links a { font-weight: 500; }

  footer { padding: 26px 0 40px; font-size: 12.5px; color: var(--ink-3); border-top: 1px solid var(--rule); display: grid; gap: 8px; }
  footer a { color: var(--ink-3); }
  .hash { font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }
  @media (max-width: 560px) { dl { grid-template-columns: 1fr; gap: 2px; } dd { margin-bottom: 10px; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <a class="brand" href="${SITE}/">
      <svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><g fill="none" stroke="#171A1F" stroke-width="60"><path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g><path d="M378 112l54 54" fill="none" stroke="#176BFF" stroke-width="60"/></svg>
      <span>AgentPey</span>
    </a>
    <div class="utils">
      <a href="${SITE}/">${t("home")}</a>
      <a href="${SITE}/en-vivo">${t("live")}</a>
      <a href="${SITE}/tiendas">${t("stores")}</a>
      <span class="lang"><a href="?lang=en"${lang === "en" ? ' aria-current="true"' : ""}>EN</a><span aria-hidden="true">/</span><a href="?lang=es"${lang === "es" ? ' aria-current="true"' : ""}>ES</a></span>
      <a href="https://github.com/vicentewolde/AgentPey" rel="noopener">GitHub</a>
    </div>
  </div>

  <main class="narrow">
    <header class="hero">
      <p class="eyebrow"><i aria-hidden="true"></i>${t("eyebrow")}</p>
      <h1>${t("title")}</h1>
    </header>
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
  </main>

  <footer>
    <span>${t("testnet")}</span>
    <span class="hash">SHA-256 ${escape(v.hash)}</span>
  </footer>
</div>
</body>
</html>`;
}
