/**
 * The human-facing catalogue.
 *
 * The brief asks for a merchant with a visible catalogue, not just a machine
 * feed, and the reason is worth stating: a person about to authorise an agent
 * to spend money at SignalDesk should be able to open SignalDesk and read what
 * it sells, at what price, before anything signs anything.
 *
 * It renders its prices from the same `PRODUCTS` table the `ServiceCard` feed
 * and the `402` challenge read, so the page cannot quote a price the network
 * would not charge. The words around them are this page's own, in English and
 * Spanish: the feed and the challenge keep the catalogue's machine text.
 */
import { ARTIFACT_RETENTION_DAYS, PRODUCTS, SIGNALDESK_SLUG, type ProductId } from "./catalog.js";

export interface PageInput {
  /** The account SignalDesk is paid at — published, because it is also its venue identity. */
  readonly payTo: string;
  readonly discoveryPath: string;
}

interface Bilingual {
  readonly en: string;
  readonly es: string;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Trusted markup in both languages; only the active one is displayed. */
function tr(en: string, es: string): string {
  return `<span data-tr="en">${en}</span><span data-tr="es">${es}</span>`;
}

interface ProductCopy {
  readonly name: Bilingual;
  readonly description: Bilingual;
}

/**
 * What a person reads about a product. A product added to the catalogue
 * without copy here still shows, in the catalogue's own words, rather than
 * breaking the page.
 */
export function productCopy(product: { readonly id: ProductId; readonly name: string; readonly description: string }): ProductCopy {
  return (
    PRODUCT_COPY[product.id] ?? {
      name: { en: product.name, es: product.name },
      description: { en: product.description, es: product.description },
    }
  );
}

/** What a person reads about each product, in both languages. */
const PRODUCT_COPY: Readonly<Record<ProductId, ProductCopy>> = {
  "signaldesk:market-brief-xlm-usdc": {
    name: { en: "XLM/USDC market report", es: "Informe de mercado XLM/USDC" },
    description: {
      en: "A demo report on the XLM/USDC pair, built from SignalDesk's own synthetic data. It is not advice and not real market data.",
      es: "Un informe de demostración del par XLM/USDC, generado con datos sintéticos propios de SignalDesk. No es asesoría ni datos de mercado reales.",
    },
  },
  "signaldesk:ai-credits-1000": {
    name: { en: "1000 AI credits", es: "1000 créditos de IA" },
    description: {
      en: "A thousand product credits added to the buyer: a Stellar address, or the opaque reference their platform knows them by. Not a token, not transferable, and only usable inside SignalDesk.",
      es: "Mil créditos de producto acreditados a quien compra: una dirección de Stellar o la referencia opaca con la que su plataforma lo identifica. No es un token, no es transferible y solo sirve dentro de SignalDesk.",
    },
  },
};

/**
 * The pilot's one visual identity (T86, decided by the user): AgentPey's paper,
 * ink, green accent, Instrument Serif + Inter, width and top bar, with the
 * AgentPey icon next to the name. Copied rather than imported — SignalDesk
 * shares no code with AgentPey, only a look.
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
  html[lang="en"] [data-tr="es"], html[lang="es"] [data-tr="en"] { display: none; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 16px;
         line-height: 1.55; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  a { color: var(--accent); }
  .wrap { width: 100%; max-width: 1320px; margin: 0 auto; padding: 0 clamp(20px, 4vw, 56px); }

  .top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 20px; padding: 22px 0 0; }
  .mark { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); text-decoration: none; font-size: 15.5px;
          font-weight: 600; letter-spacing: -0.01em; }
  .mark .logo { width: 24px; height: 24px; flex: none; }
  .mark .tagline { font-weight: 400; color: var(--ink-3); font-size: 12.5px; letter-spacing: 0;
          border-left: 1px solid var(--rule); padding-left: 10px; margin-left: 2px; }
  .utils { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px; }
  .apps { display: flex; align-items: center; gap: 16px; }
  .apps a { font-size: 13px; font-weight: 500; color: var(--ink-2); text-decoration: none; }
  .apps a:hover { color: var(--accent); }
  .gh { display: flex; align-items: center; gap: 6px; color: var(--ink-3); text-decoration: none; font-size: 13px; }
  .gh:hover { color: var(--ink); }
  .lang { display: flex; align-items: center; gap: 8px; }
  .lang button { appearance: none; background: none; border: 0; margin: 0; padding: 2px 1px; font-family: var(--sans);
          font-size: 11.5px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); cursor: pointer; }
  .lang span { color: var(--rule); font-size: 11.5px; }
  .lang button:hover { color: var(--ink-2); }
  html[lang="en"] .lang button[data-set-lang="en"], html[lang="es"] .lang button[data-set-lang="es"] { color: var(--ink); }
  .mark:focus-visible, .apps a:focus-visible, .gh:focus-visible, .lang button:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }

  .hero { padding: clamp(30px, 4.5vw, 52px) 0 36px; }
  .eyebrow.live { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 11.5px; font-weight: 500;
          letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: live-pulse 2s ease-out infinite; }
  @keyframes live-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 100% { box-shadow: 0 0 0 6px transparent; } }
  h1 { margin: 18px 0 0; font-family: var(--serif); font-weight: 400; font-size: clamp(2.4rem, 5.6vw, 3.7rem);
       line-height: 1.05; letter-spacing: -0.018em; }
  h2 { margin: 0 0 10px; font-family: var(--serif); font-weight: 400; font-size: 1.7rem; line-height: 1.15; letter-spacing: -0.015em; }
  .lede { max-width: 80ch; margin: 18px 0 0; color: var(--ink-2); font-size: clamp(1rem, 1.6vw, 1.12rem); }

  /* Every product card has the same width and height, with its ids lined up at the bottom. */
  .products { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 16px; align-items: stretch; }
  .product { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--rule); border-radius: 10px;
             padding: 24px 26px; min-width: 0; }
  .product .meta { margin-top: auto; padding-top: 4px; }
  .product-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  .price { font-family: var(--mono); font-size: 15px; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .product p { margin: 0 0 12px; color: var(--ink-2); }
  .product p:last-child { margin-bottom: 0; }
  code { font-family: var(--mono); background: var(--paper-2); padding: 2px 6px; border-radius: 5px; font-size: 12.5px; overflow-wrap: anywhere; }
  .meta { color: var(--ink-3); font-size: 13px; }

  /* One row per note, label on the left and the text across the rest of the width. */
  .notes { margin: 56px 0 0; padding: 0 0 48px; border-top: 1px solid var(--rule); font-size: 14px; }
  .note { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 4px 40px; padding: 16px 0;
          border-bottom: 1px dashed var(--rule); }
  .note dt { color: var(--ink-2); font-weight: 600; }
  .note dd { margin: 0; color: var(--ink-3); }
  @media (max-width: 720px) { .note { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 560px) { .mark .tagline { display: none; } .product { padding: 18px; } }
  @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }
`;

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g fill="none" stroke="#171A1F" stroke-width="60">' +
  '<path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g>' +
  '<path d="M378 112l54 54" fill="none" stroke="#176BFF" stroke-width="60"/></svg>';

/** `logo agentpey/agentpey-icon-32.png`, for browsers that do not take an SVG favicon. */
const ICON_PNG_32 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAACrElEQVRYhe2VXYhMcRjGf++Z2TXYVhpjxswwZ9lyJzdEsUkotNkrwuYjrlwoSimS0rpws4gr1JZLihTZomUj97j0scPZ2TlpsWHtLnNeF3bHObNnvraGC/vUuXif//O+z9P/vKcD0/jfIZUK5yeblok6t0qKHL1oD7y7UJMA0bh5AfRwKY0KQ6J8dg2/Wb+tr8MJMWJ1yne/HqMS8+bm5hmgu8vpRJkDpCYeJxSJjxp0j41xP3JIG6Yc4MvwzzYg7KI+IbwBBoo21TUia29uBFYItIhw1y9ERQFAD7orMWi3+9NLxJBdHpUwBKSBtKR2fKQhNS/fAy2GcDt5RGdWFSAWM01gvYvqz1rpbj+toXLezqRNO5M2s70nw8BZT0CYa4wQqioABvs9OqULyJXtA+zLckKEMwAy3D9odK95OXondayaAIai+1y1OoFcVyXmE8heklPyomNQe7aGddjag8pO93mwVHNkgbkJdJGL6vlgWa+qCQCgr658wbvEeZS8AUEPFFDXqjUvh6IBEolEWIRWFzUU4MftqdlooNhJ0Vfwg+BegRkuqscx6lfGkuafscryctbRRKoDZWHVAUTZW0C1qaNtJd1EF0fjizb8KWWzKkcLRM89ld+caMJcheqzkmZTw8M6I9dqWVb+v+C/Azpp+WpiDj43EI1GZxMIZYDGccWYqHQCIz5DTUULX9UkKNorudEttm1/KzybvAOB0I68+e/uG9lM33G/wbGkuQ7HsytPQZ54zZ3v9YZzzsrYvr9jvyX0XL9I5d++IA+ymb7TleqhYAfi8aalwGoX9Tbbn35UzcBq4Qng4BzEvRfKVUD/VoCgQrurzgUkeL2W5p4AyWSyEbgHfB2n7mcyr9/XOsCkzzASiTQYdbO2iyOvs9m+x7UOMI1p/HP8Ankn2KvA3l7BAAAAAElFTkSuQmCC";

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/** Before paint: English unless the visitor chose Spanish on any of the pilot's domains. */
const LANG_BOOT = String.raw`(function () {
  var lang = "en";
  try {
    var match = document.cookie.match(/(?:^|; *)agentpey_lang=(en|es)/);
    if (match) lang = match[1];
    else if (localStorage.getItem("agentpay-lang") === "es") lang = "es";
  } catch (e) {}
  document.documentElement.lang = lang;
})();`;

const LANG_SWITCH = String.raw`(function () {
  var root = document.documentElement;
  function apply(lang) {
    root.lang = lang;
    var title = root.getAttribute("data-title-" + lang);
    if (title) document.title = title;
    var buttons = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-set-lang") === lang));
  }
  var buttons = document.querySelectorAll("[data-set-lang]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      var lang = this.getAttribute("data-set-lang");
      var domain = /(^|\.)agentpey\.com$/.test(location.hostname) ? "; domain=agentpey.com" : "";
      try { document.cookie = "agentpey_lang=" + lang + "; path=/; max-age=31536000; samesite=lax" + domain; } catch (e) {}
      try { localStorage.setItem("agentpay-lang", lang); } catch (e) {}
      apply(lang);
    });
  }
  apply(root.lang === "es" ? "es" : "en");
})();`;

export function renderCatalogPage(input: PageInput): string {
  const payTo = escape(input.payTo);
  const identity = `<code>${escape(SIGNALDESK_SLUG)}:${payTo}</code>`;
  const days = String(ARTIFACT_RETENTION_DAYS);
  return `<!doctype html>
<html lang="en" data-title-en="SignalDesk · x402 merchant" data-title-es="SignalDesk · comercio x402">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SignalDesk · x402 merchant</title>
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,${ICON_PNG_32}">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ICON_SVG)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script>${LANG_BOOT}</script>
<style>${SIGNALDESK_STYLE}</style>
</head>
<body>
<main class="wrap">
  <div class="top">
    <a class="mark" href="/">${ICON_SVG.replace("<svg ", '<svg class="logo" aria-hidden="true" ')}<span>SignalDesk</span><span class="tagline">${tr("x402 merchant", "Comercio x402")}</span></a>
    <div class="utils">
      <nav class="apps" aria-label="Pilot apps"><a href="https://agentpey.com">AgentPey</a><a href="https://realops.agentpey.com">RealOps</a></nav>
      <div class="lang"><button type="button" data-set-lang="en" aria-pressed="true">EN</button><span aria-hidden="true">/</span><button type="button" data-set-lang="es" aria-pressed="false">ES</button></div>
      <a class="gh" href="https://github.com/vicentewolde/AgentPey" target="_blank" rel="noopener">${GITHUB_ICON}<span>GitHub</span></a>
    </div>
  </div>

  <header class="hero">
    <p class="eyebrow live"><span class="live-dot" aria-hidden="true"></span>${tr("Stellar Testnet · live", "Stellar Testnet · en vivo")}</p>
    <h1>${tr("What SignalDesk sells", "Lo que vende SignalDesk")}</h1>
    <p class="lede">${tr(
      "An x402 merchant on Stellar testnet. It charges in test USDC and delivers once the payment settles, not before.",
      "Un comercio x402 sobre Stellar testnet. Cobra en USDC de prueba y entrega cuando el pago se liquida, no antes.",
    )}</p>
  </header>

  <div class="products">
  ${PRODUCTS.map((product) => {
    const copy = productCopy(product);
    return `<article class="product">
    <div class="product-head">
      <h2>${tr(escape(copy.name.en), escape(copy.name.es))}</h2>
      <span class="price">${escape(product.price)} USDC</span>
    </div>
    <p>${tr(escape(copy.description.en), escape(copy.description.es))}</p>
    <p class="meta">
      <code>${escape(product.id)}</code><br>
      ${tr("Paid route", "Ruta de pago")}: <code>${escape(product.routeTemplate)}</code>
    </p>
  </article>`;
  }).join("\n  ")}
  </div>

  <footer>
    <dl class="notes">
      <div class="note"><dt>${tr("Synthetic data", "Datos sintéticos")}</dt><dd>${tr(
        "The market report is generated by SignalDesk. It does not use or reproduce real market data, and it is not financial advice.",
        "El informe de mercado lo genera SignalDesk. No usa ni reproduce datos de mercado reales, y no es asesoría financiera.",
      )}</dd></div>
      <div class="note"><dt>${tr("Credits are not transferable", "Los créditos no son transferibles")}</dt><dd>${tr(
        "They are a balance tied to a holder inside SignalDesk, not a Stellar token. This service exposes no operation to move them.",
        "Son un saldo ligado a un titular dentro de SignalDesk, no un token de Stellar. Este servicio no expone ninguna operación para moverlos.",
      )}</dd></div>
      <div class="note"><dt>${tr("Retention", "Retención")}</dt><dd>${tr(
        `Delivered artifacts are kept for ${days} days. After that, the signed receipt and its hash remain, not the file.`,
        `Los artefactos entregados se conservan ${days} días. Después quedan el recibo firmado y su hash, no el archivo.`,
      )}</dd></div>
      <div class="note"><dt>${tr("Signed receipts", "Recibos firmados")}</dt><dd>${tr(
        `Every delivery carries a receipt signed by SignalDesk, verifiable with its public key <code>${payTo}</code> without anyone else involved.`,
        `Cada entrega lleva un recibo firmado por SignalDesk, verificable con su clave pública <code>${payTo}</code> sin intervención de nadie más.`,
      )}</dd></div>
      <div class="note"><dt>${tr("Merchant identity", "Identidad de comercio")}</dt><dd>${identity}</dd></div>
      <div class="note"><dt>${tr("Catalog for agents", "Catálogo para agentes")}</dt><dd><code>${escape(input.discoveryPath)}</code></dd></div>
    </dl>
  </footer>
</main>
<script>${LANG_SWITCH}</script>
</body>
</html>
`;
}
