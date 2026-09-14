/**
 * The human-facing catalogue.
 *
 * The brief asks for a merchant with a visible catalogue, not just a machine
 * feed, and the reason is worth stating: a person about to authorise an agent
 * to spend money at SignalDesk should be able to open SignalDesk and read what
 * it sells, at what price, before anything signs anything.
 *
 * It renders from the same `PRODUCTS` table the `ServiceCard` feed and the
 * `402` challenge read, so the page cannot quote a price the network would not
 * charge.
 */
import { ARTIFACT_RETENTION_DAYS, PRODUCTS, SIGNALDESK_SLUG } from "./catalog.js";

export interface PageInput {
  /** The account SignalDesk is paid at — published, because it is also its venue identity. */
  readonly payTo: string;
  readonly discoveryPath: string;
}

/**
 * The pilot's one visual identity (T86, decided by the user): AgentPey's paper,
 * ink, green accent and Instrument Serif + Inter. Copied rather than imported —
 * SignalDesk shares no code with AgentPey, only a look.
 *
 * Only the catalogue uses it. The delivered artefacts in `artifacts.ts` keep
 * their own markup on purpose: they render deterministically and their hash is
 * inside the signed receipt, so restyling them would make every past delivery
 * stop matching its receipt.
 */
export const SIGNALDESK_STYLE = `
  :root {
    color-scheme: light;
    --paper: #fbfaf8; --paper-2: #f2f0ea; --card: #ffffff;
    --ink: #0f1211; --ink-2: #434946; --ink-3: #707875; --rule: #e3e0d9; --accent: #0a7a56;
    --serif: "Instrument Serif", ui-serif, Georgia, "Times New Roman", serif;
    --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 16px;
         line-height: 1.55; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  main { width: 100%; max-width: 760px; margin: 0 auto; padding: 0 24px 72px; }
  a { color: var(--accent); }
  .top { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 6px 20px; padding: 28px 0 0; }
  .mark { color: var(--ink); text-decoration: none; font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em; }
  .mark .tagline { color: var(--ink-3); font-size: 12.5px; font-weight: 400; margin-left: 4px; }
  .network { color: var(--ink-3); font-size: 13px; }
  .hero { padding: clamp(30px, 6vw, 54px) 0 28px; }
  .eyebrow { margin: 0; color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 12px 0 0; font-family: var(--serif); font-weight: 400; font-size: clamp(2.25rem, 7vw, 3.1rem);
       line-height: 1.05; letter-spacing: -0.02em; }
  h2 { margin: 32px 0 10px; font-family: var(--serif); font-weight: 400; font-size: 1.6rem; line-height: 1.15; letter-spacing: -0.015em; }
  .lede { max-width: 60ch; margin: 14px 0 0; color: var(--ink-2); }
  .product { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 22px 24px; margin-bottom: 14px; }
  .product-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .product h2 { margin: 0 0 8px; }
  .price { font-family: var(--mono); font-size: 15px; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .price small { color: var(--ink-3); font-size: 12px; }
  .product p { margin: 0 0 12px; color: var(--ink-2); }
  .product p:last-child { margin-bottom: 0; }
  code { font-family: var(--mono); background: var(--paper-2); padding: 2px 6px; border-radius: 5px; font-size: 12.5px; word-break: break-all; }
  .meta { color: var(--ink-3); font-size: 13px; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--rule); color: var(--ink-3); font-size: 13.5px; }
  footer p { margin: 0 0 10px; }
  footer strong { color: var(--ink-2); font-weight: 600; }
  @media (max-width: 520px) { main { padding: 0 20px 56px; } .product { padding: 18px; } }
`;

export function renderCatalogPage(input: PageInput): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SignalDesk · comercio x402</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${SIGNALDESK_STYLE}</style>
</head>
<body>
<main>
  <div class="top">
    <span class="mark">SignalDesk <span class="tagline">· comercio x402</span></span>
    <span class="network">Stellar Testnet</span>
  </div>

  <header class="hero">
    <p class="eyebrow">Catálogo</p>
    <h1>Lo que vende SignalDesk</h1>
    <p class="lede">Un comercio x402 sobre Stellar testnet. Cobra en USDC de prueba y entrega al liquidar, no antes.</p>
  </header>

  ${PRODUCTS.map(
    (product) => `<article class="product">
    <div class="product-head">
      <h2>${product.name}</h2>
      <span class="price">${product.price} USDC</span>
    </div>
    <p>${product.description}</p>
    <p class="meta">
      <code>${product.id}</code><br>
      Ruta paga: <code>${product.routeTemplate}</code>
    </p>
  </article>`,
  ).join("\n  ")}

  <footer>
    <p><strong>Datos sinteticos.</strong> El informe de mercado lo genera SignalDesk. No usa ni reproduce datos de mercado reales, y no es asesoramiento financiero.</p>
    <p><strong>Los creditos no son transferibles.</strong> Son un saldo ligado a una direccion dentro de SignalDesk, no un token Stellar. Este servicio no expone ninguna operacion para moverlos.</p>
    <p><strong>Retencion.</strong> Los artefactos entregados se conservan ${ARTIFACT_RETENTION_DAYS} dias. Despues quedan el recibo firmado y su hash, no el archivo.</p>
    <p><strong>Cada entrega lleva recibo firmado por SignalDesk</strong>, verificable con su clave publica <code>${input.payTo}</code> sin intervencion de nadie mas. Identidad de comercio: <code>${SIGNALDESK_SLUG}:${input.payTo}</code>.</p>
    <p>Catalogo para agentes: <code>${input.discoveryPath}</code></p>
  </footer>
</main>
</body>
</html>
`;
}
