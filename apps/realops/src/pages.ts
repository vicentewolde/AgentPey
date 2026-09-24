/**
 * RealOps' five screens.
 *
 * Server-rendered HTML with no build step and no client framework, for the same
 * reason `consent.html` is what it is: the thing an external tester has to
 * trust should be small enough to read. A page here is a function from data to
 * a string.
 *
 * **Everything variable is escaped.** An alias is text a person typed and an
 * instruction is text a person typed; both are displayed and neither is ever
 * interpreted. `escape` is the only way either reaches the page.
 *
 * **The chrome is in the layout, not in each page.** The top bar, the live
 * testnet badge and the language switch are impossible to leave out of a page,
 * because no page renders without `layout`.
 *
 * **Both languages ship in every page** (`copy.ts`). English shows by default;
 * the switch in the top bar shows Spanish instead, and remembers it across the
 * pilot's three domains.
 */
import { randomUUID } from "node:crypto";

import type { PurchaseResource, TenantActivity } from "./agentpey.js";
import type { AgentConfig, Account, AgentKind } from "./accounts.js";
import { bilingual, escape, tr, trHtml, type Bilingual } from "./copy.js";
import { FALLBACK_CHOICES, type InstructionProblem } from "./instruction.js";
import { QUANTITY_INPUT, type CatalogCard, type CatalogVenue } from "./catalog.js";
import type { ResourceAvailability, ResourceInput } from "./bazaar-catalog.js";
import { explainRefusal } from "./refusals.js";
import { VITRINEE_DEFAULT_PERMISSIONS, type ExplainedControl, type ProposedGrant } from "./permissions.js";

export { escape } from "./copy.js";

/**
 * The pilot's one visual identity (T86, decided by the user): the same paper,
 * ink, green accent, Instrument Serif + Inter, width and top bar as AgentPey's
 * landing (`apps/web/public/landing.html`), with the AgentPey icon next to the
 * name. Copied, not imported: the three apps share no code, only a look.
 */
const STYLE = `
  :root {
    color-scheme: light;
    --paper: #fbfaf8; --paper-2: #f2f0ea; --card: #ffffff;
    --ink: #0f1211; --ink-2: #434946; --ink-3: #707875; --rule: #e3e0d9;
    --accent: #0a7a56; --accent-wash: #e9f3ee; --danger: #b3261e; --danger-wash: #fbeceb;
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
  .nav { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 22px; }
  .nav a { font-size: 13px; color: var(--ink-3); text-decoration: none; }
  .nav a:hover { color: var(--ink); }
  .utils { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px; }
  .apps { display: flex; align-items: center; gap: 16px; }
  .apps a { font-size: 13px; font-weight: 500; color: var(--ink-2); text-decoration: none; }
  .apps a:hover { color: var(--accent); }
  .gh { display: flex; align-items: center; gap: 6px; color: var(--ink-3); text-decoration: none; font-size: 13px; }
  .gh:hover { color: var(--ink); }
  .lang { display: flex; align-items: center; gap: 8px; }
  .lang span { color: var(--rule); font-size: 11.5px; }
  .mark:focus-visible, .nav a:focus-visible, .apps a:focus-visible, .gh:focus-visible, .lang button:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }

  .page { padding: clamp(30px, 4.5vw, 52px) 0 64px; }
  .eyebrow.live { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 11.5px; font-weight: 500;
          letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: live-pulse 2s ease-out infinite; }
  @keyframes live-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 100% { box-shadow: 0 0 0 6px transparent; } }

  h1 { margin: 18px 0 0; font-family: var(--serif); font-weight: 400; font-size: clamp(2.4rem, 5.6vw, 3.7rem);
       line-height: 1.05; letter-spacing: -0.018em; max-width: 28ch; text-wrap: balance; }
  h2 { margin: 52px 0 16px; font-family: var(--serif); font-weight: 400; font-size: clamp(1.6rem, 3vw, 2.1rem);
       line-height: 1.12; letter-spacing: -0.014em; }
  h3 { margin: 0 0 8px; font-size: 1.02rem; font-weight: 600; letter-spacing: -0.005em; }
  .card h2 { margin: 0 0 12px; font-size: 1.6rem; }
  .lede { max-width: 80ch; margin: 18px 0 36px; color: var(--ink-2); font-size: clamp(1rem, 1.6vw, 1.12rem); }
  .meta { color: var(--ink-3); font-size: 13.5px; }

  /* Cards in a row share one width and one height, whatever each holds. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 16px; align-items: stretch; }
  .grid.pair { grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); }
  .split { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(min(300px, 100%), 1fr); gap: 16px; align-items: stretch; }
  .stack { display: flex; flex-direction: column; }
  .stack > * { margin: 0 0 10px; }
  .stack > :last-child { margin-bottom: 0; }
  .stack > .push { margin-top: auto; padding-top: 6px; }
  @media (max-width: 860px) { .split { grid-template-columns: minmax(0, 1fr); } }
  .card { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 24px 26px; min-width: 0; }
  .card + .card, .card + .grid, .grid + .card, .split + .card, .card + .split { margin-top: 16px; }
  /* Inside a row the gap does the spacing; a card's own margin would push it below its neighbours. */
  .grid > .card, .split > .card, .grid > *, .split > * { margin-top: 0; }
  .card > :first-child { margin-top: 0; }
  .card > :last-child { margin-bottom: 0; }
  .card ol { padding-left: 1.2em; }
  .card li + li { margin-top: 6px; }
  .error { border-left: 3px solid var(--danger); }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0 20px; }

  label { display: block; margin: 16px 0 6px; color: var(--ink-2); font-size: 14px; font-weight: 500; }
  input, textarea, select { width: 100%; padding: 10px 12px; font: inherit; font-size: 15px; color: var(--ink);
          background: var(--paper); border: 1px solid var(--rule); border-radius: 7px; }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }

  button, .button { appearance: none; display: inline-block; margin-top: 20px; padding: 11px 18px;
          font-family: var(--sans); font-size: 14px; font-weight: 500; color: var(--paper); background: var(--ink);
          border: 1px solid var(--ink); border-radius: 7px; cursor: pointer; text-decoration: none;
          transition: background .18s ease, border-color .18s ease, transform .18s ease; }
  button:hover, .button:hover { background: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
  button:focus-visible, .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .secondary, button.secondary, .button.secondary { background: transparent; color: var(--ink); border-color: var(--rule); }
  .secondary:hover, button.secondary:hover, .button.secondary:hover { background: var(--paper-2); border-color: var(--ink-3); }
  .lang button { appearance: none; background: none; border: 0; border-radius: 0; margin: 0; padding: 2px 1px;
          font-family: var(--sans); font-size: 11.5px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--ink-3); cursor: pointer; transition: none; }
  .lang button:hover { background: none; color: var(--ink-2); transform: none; }
  html[lang="en"] .lang button[data-set-lang="en"], html[lang="es"] .lang button[data-set-lang="es"] { color: var(--ink); }

  code, pre { font-family: var(--mono); background: var(--paper-2); border-radius: 5px; }
  code { padding: 2px 6px; font-size: 12.5px; overflow-wrap: anywhere; }
  pre { margin: 0; padding: 16px 18px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; border: 1px solid var(--rule); }

  .table-wrap { overflow-x: auto; padding: 8px 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 12px 10px; border-bottom: 1px dashed var(--rule); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { color: var(--ink-3); font-size: 11.5px; font-weight: 500; letter-spacing: .1em; text-transform: uppercase;
       border-bottom-style: solid; white-space: nowrap; }

  .tag { display: inline-block; padding: 2px 7px; border-radius: 5px; font-size: 11px; font-weight: 600;
         letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
  .tag-signed { background: var(--accent-wash); color: var(--accent); }
  .tag-onchain { background: #e8eef7; color: #1d3775; }
  .tag-realops { background: var(--paper-2); color: var(--ink-2); }
  .tag-refused { background: var(--danger-wash); color: var(--danger); }
  .signed { color: var(--accent); font-weight: 500; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
  .actions .button { margin-top: 0; }
  .head-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }

  footer { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 12px 40px;
           border-top: 1px solid var(--rule); padding: 26px 0 48px; color: var(--ink-3); font-size: 13.5px; }
  footer p { margin: 0; flex: 1 1 560px; }
  footer strong { color: var(--ink-2); font-weight: 600; }
  footer nav { display: flex; flex-wrap: wrap; gap: 6px 20px; }
  footer nav a { color: var(--ink-3); text-decoration: none; }
  footer nav a:hover { color: var(--ink); }

  @media (max-width: 560px) {
    .mark .tagline { display: none; }
    .card { padding: 18px; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/** Where the other two apps of the pilot live, for the top bar. */
const PILOT_LINKS = { agentpey: "https://agentpey.com", signalDesk: "https://signaldesk.agentpey.com" } as const;

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g fill="none" stroke="#171A1F" stroke-width="60">' +
  '<path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g>' +
  '<path d="M378 112l54 54" fill="none" stroke="#176BFF" stroke-width="60"/></svg>';

const LOGO = ICON_SVG.replace("<svg ", '<svg class="logo" aria-hidden="true" ');

/** `logo agentpey/agentpey-icon-32.png`, for browsers that do not take an SVG favicon. */
const ICON_PNG_32 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAACrElEQVRYhe2VXYhMcRjGf++Z2TXYVhpjxswwZ9lyJzdEsUkotNkrwuYjrlwoSimS0rpws4gr1JZLihTZomUj97j0scPZ2TlpsWHtLnNeF3bHObNnvraGC/vUuXif//O+z9P/vKcD0/jfIZUK5yeblok6t0qKHL1oD7y7UJMA0bh5AfRwKY0KQ6J8dg2/Wb+tr8MJMWJ1yne/HqMS8+bm5hmgu8vpRJkDpCYeJxSJjxp0j41xP3JIG6Yc4MvwzzYg7KI+IbwBBoo21TUia29uBFYItIhw1y9ERQFAD7orMWi3+9NLxJBdHpUwBKSBtKR2fKQhNS/fAy2GcDt5RGdWFSAWM01gvYvqz1rpbj+toXLezqRNO5M2s70nw8BZT0CYa4wQqioABvs9OqULyJXtA+zLckKEMwAy3D9odK95OXondayaAIai+1y1OoFcVyXmE8heklPyomNQe7aGddjag8pO93mwVHNkgbkJdJGL6vlgWa+qCQCgr658wbvEeZS8AUEPFFDXqjUvh6IBEolEWIRWFzUU4MftqdlooNhJ0Vfwg+BegRkuqscx6lfGkuafscryctbRRKoDZWHVAUTZW0C1qaNtJd1EF0fjizb8KWWzKkcLRM89ld+caMJcheqzkmZTw8M6I9dqWVb+v+C/Azpp+WpiDj43EI1GZxMIZYDGccWYqHQCIz5DTUULX9UkKNorudEttm1/KzybvAOB0I68+e/uG9lM33G/wbGkuQ7HsytPQZ54zZ3v9YZzzsrYvr9jvyX0XL9I5d++IA+ymb7TleqhYAfi8aalwGoX9Tbbn35UzcBq4Qng4BzEvRfKVUD/VoCgQrurzgUkeL2W5p4AyWSyEbgHfB2n7mcyr9/XOsCkzzASiTQYdbO2iyOvs9m+x7UOMI1p/HP8Ankn2KvA3l7BAAAAAElFTkSuQmCC";

const FAVICON =
  `<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,${ICON_PNG_32}">\n` +
  `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ICON_SVG)}">`;

const GITHUB_LINK =
  '<a class="gh" href="https://github.com/vicentewolde/AgentPey" target="_blank" rel="noopener">' +
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>' +
  "<span>GitHub</span></a>";

const LANG_BUTTONS =
  '<div class="lang"><button type="button" data-set-lang="en" aria-pressed="true">EN</button>' +
  '<span aria-hidden="true">/</span><button type="button" data-set-lang="es" aria-pressed="false">ES</button></div>';

const LIVE_BADGE = `<p class="eyebrow live"><span class="live-dot" aria-hidden="true"></span>${trHtml(
  "Stellar Testnet · live",
  "Stellar Testnet · en vivo",
)}</p>`;

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

/** The EN/ES switch. Attributes that cannot hold markup carry data-*-en / data-*-es. */
const LANG_SWITCH = String.raw`(function () {
  var root = document.documentElement;
  function apply(lang) {
    root.lang = lang;
    var title = root.getAttribute("data-title-" + lang);
    if (title) document.title = title;
    var buttons = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-set-lang") === lang));
    var texts = document.querySelectorAll("[data-text-en]");
    for (var j = 0; j < texts.length; j++) texts[j].textContent = texts[j].getAttribute("data-text-" + lang);
    var holders = document.querySelectorAll("[data-placeholder-en]");
    for (var k = 0; k < holders.length; k++) holders[k].setAttribute("placeholder", holders[k].getAttribute("data-placeholder-" + lang));
    var times = document.querySelectorAll("time[data-local]");
    for (var m = 0; m < times.length; m++) {
      var date = new Date(times[m].getAttribute("datetime"));
      if (!isNaN(date.getTime())) {
        // Explicit fields: Intl throws when a time zone name is combined with the date or time style shortcuts.
        times[m].textContent = date.toLocaleString(lang === "es" ? "es" : "en-US", {
          year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
        });
      }
    }
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

/** A form placeholder in both languages, English as the rendered default. */
function placeholder(text: Bilingual): string {
  return `placeholder="${escape(text.en)}" data-placeholder-en="${escape(text.en)}" data-placeholder-es="${escape(text.es)}"`;
}

/** An element that can only hold text (an `<option>`), in both languages. */
function textAttributes(text: Bilingual): string {
  return `data-text-en="${escape(text.en)}" data-text-es="${escape(text.es)}"`;
}

/**
 * A name a person typed, shown with a capital first letter. Display only: the
 * stored value, and anything sent to AgentPey, keep exactly what was typed.
 */
function displayName(value: string): string {
  return escape(value.charAt(0).toLocaleUpperCase() + value.slice(1));
}

export interface LayoutInput {
  readonly title: Bilingual;
  readonly body: string;
  readonly signedIn?: boolean;
}

export function layout(input: LayoutInput): string {
  const nav =
    input.signedIn === true
      ? `<a href="/agentes">${tr(bilingual("My agents", "Mis agentes"))}</a>` +
        `<a href="/catalogo">${tr(bilingual("Catalogue", "Catálogo"))}</a>` +
        `<a href="/servicios">${tr(bilingual("My services", "Mis servicios"))}</a>` +
        `<a href="/salir">${tr(bilingual("Sign out", "Salir"))}</a>`
      : "";

  return `<!doctype html>
<html lang="en" data-title-en="${escape(input.title.en)} · RealOps" data-title-es="${escape(input.title.es)} · RealOps">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.title.en)} · RealOps</title>
${FAVICON}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script>${LANG_BOOT}</script>
<style>${STYLE}</style>
</head>
<body>
<main class="wrap">
  <div class="top">
    <a class="mark" href="/">${LOGO}<span>RealOps</span><span class="tagline">${trHtml("Agent platform", "Plataforma de agentes")}</span></a>
    <nav class="nav">${nav}</nav>
    <div class="utils">
      <nav class="apps" aria-label="Pilot apps"><a href="${PILOT_LINKS.agentpey}">AgentPey</a><a href="${PILOT_LINKS.signalDesk}">SignalDesk</a></nav>
      ${LANG_BUTTONS}
      ${GITHUB_LINK}
    </div>
  </div>
  <div class="page">
  ${LIVE_BADGE}
  ${input.body}
  </div>
  <footer>
    <p>${trHtml(
      "<strong>RealOps does not authorize payments.</strong> It asks, and AgentPey decides. Your Mandate is always signed on AgentPey's domain, never here.",
      "<strong>RealOps no autoriza pagos.</strong> Pide, y AgentPey decide. Tu Mandato se firma siempre en el dominio de AgentPey, nunca aquí.",
    )}</p>
    <nav aria-label="Pilot"><a href="${PILOT_LINKS.agentpey}">AgentPey</a><a href="${PILOT_LINKS.signalDesk}">SignalDesk</a><a href="https://github.com/vicentewolde/AgentPey" target="_blank" rel="noopener">GitHub</a></nav>
  </footer>
</main>
<script>${LANG_SWITCH}</script>
</body>
</html>
`;
}

export function homePage(signalDeskUrl: string): string {
  const signalDesk = `<a href="${escape(signalDeskUrl)}">SignalDesk</a>`;
  return layout({
    title: bilingual("Home", "Inicio"),
    body: `
  <h1>${tr(bilingual("Hire an agent. Decide exactly what it can spend.", "Contrata un agente. Decide exactamente qué puede gastar."))}</h1>
  <p class="lede">${tr(
    bilingual(
      "Every purchase, and every refusal, comes with its proof.",
      "Cada compra, y cada rechazo, viene con su prueba.",
    ),
  )}</p>

  <div class="grid pair">
    <div class="card">
      <h2>${tr(bilingual("How it works", "Cómo funciona"))}</h2>
      <ol>
        <li>${tr(bilingual("Sign in with your email. No password.", "Entras con tu correo. Sin contraseña."))}</li>
        <li>${tr(bilingual("Choose an agent and set its limits.", "Eliges un agente y defines sus límites."))}</li>
        <li>${trHtml(
          "Sign its permission with your wallet, <strong>on AgentPey's site</strong>, not here.",
          "Firmas su permiso con tu wallet, <strong>en el sitio de AgentPey</strong>, no aquí.",
        )}</li>
        <li>${tr(
          bilingual(
            "Give it an instruction. AgentPey decides whether it goes through, then pays or refuses.",
            "Le das una instrucción. AgentPey decide si la deja pasar, y paga o rechaza.",
          ),
        )}</li>
      </ol>
      <a class="button" href="/entrar">${tr(bilingual("Sign in", "Entrar"))}</a>
    </div>

    <div class="card">
      <h2>${tr(bilingual("The pilot's merchant", "El comercio del piloto"))}</h2>
      <p>${trHtml(
        `Agents buy from ${signalDesk}, an x402 merchant that runs separately and can be opened on its own. It is linked here precisely so you can check that the two services are different.`,
        `Los agentes compran en ${signalDesk}, un comercio x402 que funciona aparte y se puede abrir por separado. Está enlazado aquí justamente para que compruebes que los dos servicios son distintos.`,
      )}</p>
      <p class="meta">${tr(
        bilingual(
          "RealOps never holds a key that can pay. It asks AgentPey, and AgentPey checks the request against the Mandate you signed.",
          "RealOps nunca tiene una clave que pueda pagar. Le pide a AgentPey, y AgentPey revisa el pedido contra el Mandato que firmaste.",
        ),
      )}</p>
    </div>
  </div>
`,
  });
}

export interface SignInOptions {
  readonly error?: Bilingual;
  /** `true` when there is no email provider and the form signs the person straight in (C-119). */
  readonly direct?: boolean;
}

export function signInPage(options: SignInOptions = {}): string {
  const direct = options.direct === true;
  return layout({
    title: bilingual("Sign in", "Entrar"),
    body: `
  <h1>${tr(bilingual("Sign in", "Entrar"))}</h1>
  <p class="lede">${tr(
    direct
      ? bilingual(
          "Type your email and a name. For now you go straight in: the pilot does not confirm the email yet.",
          "Escribe tu correo y un nombre. Por ahora entras directo: el piloto todavía no confirma el correo.",
        )
      : bilingual("We send you a one-time link. It lasts 15 minutes.", "Te enviamos un enlace de un solo uso. Dura 15 minutos."),
  )}</p>
  ${options.error === undefined ? "" : `<p class="card error">${tr(options.error)}</p>`}
  <div class="split">
    <form class="card" method="post" action="/entrar">
      <label for="email">${tr(bilingual("Your email", "Tu correo"))}</label>
      <input id="email" name="email" type="email" required autocomplete="email" ${placeholder(bilingual("you@example.com", "tu@ejemplo.com"))}>
      <label for="alias">${tr(bilingual("What should we call you", "Cómo quieres que te llamemos"))}</label>
      <input id="alias" name="alias" required autocomplete="nickname" placeholder="Alex" maxlength="60">
      <button type="submit">${tr(direct ? bilingual("Enter", "Entrar") : bilingual("Send me the link", "Envíame el enlace"))}</button>
    </form>
    <div class="card">
      <h3>${tr(bilingual("Your email stays here", "Tu correo se queda aquí"))}</h3>
      <p class="meta">${tr(
        bilingual(
          "Your email is stored only on RealOps. AgentPey never receives it: it identifies you with a random code that says nothing about you.",
          "Tu correo se guarda solo en RealOps. AgentPey nunca lo recibe: te identifica con un código aleatorio que no dice nada de ti.",
        ),
      )}</p>
    </div>
  </div>
`,
  });
}

/** Only when an email provider is configured: without one, signing in goes straight in (C-119). */
export function linkSentPage(): string {
  return layout({
    title: bilingual("Check your email", "Revisa tu correo"),
    body: `
  <h1>${tr(bilingual("Check your email", "Revisa tu correo"))}</h1>
  <p class="lede">${tr(
    bilingual(
      "If that address has an account, or we just created one, the link is on its way. It lasts 15 minutes and works only once.",
      "Si esa dirección tiene cuenta o la acabamos de crear, ahí va el enlace. Dura 15 minutos y sirve una sola vez.",
    ),
  )}</p>
`,
  });
}

const AGENT_COPY: Readonly<Record<AgentKind, { readonly name: Bilingual; readonly what: Bilingual }>> = {
  market_brief: {
    name: bilingual("Market report agent", "Agente de informes de mercado"),
    what: bilingual(
      "Buys the XLM/USDC report from SignalDesk when you ask. The report uses synthetic data.",
      "Compra el informe XLM/USDC en SignalDesk cuando se lo pides. El informe usa datos sintéticos.",
    ),
  },
  ai_credits: {
    name: bilingual("AI credits agent", "Agente de créditos de IA"),
    what: bilingual(
      "Buys packs of 1000 product credits from SignalDesk. The credits are not transferable.",
      "Compra paquetes de 1000 créditos de producto en SignalDesk. Los créditos no son transferibles.",
    ),
  },
  bazaar_shopper: {
    name: bilingual("Bazaar Shopper", "Comprador del Bazaar"),
    what: bilingual(
      "Buys at the Stellar Bazaar, a merchant that is not ours. Its permission names that merchant and those products, and nothing of SignalDesk.",
      "Compra en el Stellar Bazaar, un comercio que no es nuestro. Su permiso nombra ese comercio y esos productos, y nada de SignalDesk.",
    ),
  },
  vitrinee_shopper: {
    name: bilingual("Store Shopper", "Comprador de la tienda"),
    what: bilingual(
      "Buys physical products from a real store connected through Vitrinee, shipped to the address you give. Its permission names that store and its products only.",
      "Compra productos físicos en una tienda real conectada por Vitrinee, enviados a la dirección que indiques. Su permiso nombra solo esa tienda y sus productos.",
    ),
  },
};

/** A store the person can hire a shopper for: what the hire form needs of it, nothing else. */
export interface HireableStore {
  readonly slug: string;
  readonly name: string;
}

/**
 * The card that hires a store shopper from this page (`C-147`).
 *
 * A shopper buys at exactly one store, so the store is chosen here, from the
 * directory, instead of being implied by a catalogue card. Its limits start at
 * the store defaults (`C-137`), not at the 0.30/0.60 of the other agents: the
 * cheapest real product costs 1.04 USDC, so a shopper born with 0.30 could not
 * buy anything.
 */
function storeShopperCard(stores: readonly HireableStore[] | undefined): string {
  if (stores === undefined) {
    return `<p class="card">${tr(
      bilingual(
        "The store directory is not answering right now. Try again in a minute, or hire a store shopper from a product card in the catalogue.",
        "El directorio de tiendas no responde ahora. Inténtalo en un minuto, o contrata un comprador de tienda desde la tarjeta de un producto del catálogo.",
      ),
    )}</p>`;
  }
  if (stores.length === 0) {
    return `<p class="card">${tr(bilingual("No store is connected yet.", "Todavía no hay ninguna tienda conectada."))}</p>`;
  }
  const { perTx, perDay, validForDays } = VITRINEE_DEFAULT_PERMISSIONS;
  return `<form class="card" method="post" action="/agentes">
    <input type="hidden" name="kind" value="vitrinee_shopper">
    <div class="fields">
      <div>
        <label for="comercio">${tr(bilingual("Which store", "En qué tienda"))}</label>
        <select id="comercio" name="comercio">
          ${stores.map((store) => `<option value="${escape(store.slug)}">${escape(store.name)}</option>`).join("\n          ")}
        </select>
      </div>
    </div>
    <div class="fields">
      <div>
        <label for="store-perTx">${tr(bilingual("Max per purchase (USDC)", "Máximo por compra (USDC)"))}</label>
        <input id="store-perTx" name="perTx" required value="${escape(perTx)}" inputmode="decimal">
      </div>
      <div>
        <label for="store-perDay">${tr(bilingual("Max per day (USDC)", "Máximo por día (USDC)"))}</label>
        <input id="store-perDay" name="perDay" required value="${escape(perDay)}" inputmode="decimal">
      </div>
      <div>
        <label for="store-validForDays">${tr(bilingual("Validity (days)", "Vigencia (días)"))}</label>
        <input id="store-validForDays" name="validForDays" required value="${String(validForDays)}" inputmode="numeric">
      </div>
    </div>
    <button type="submit">${tr(bilingual("Set up", "Configurar"))}</button>
  </form>`;
}

export function agentsPage(account: Account, agents: readonly AgentConfig[], stores?: readonly HireableStore[]): string {
  const alias = displayName(account.alias);
  const rows =
    agents.length === 0
      ? `<p class="card">${tr(bilingual("You have not hired any agent yet.", "Todavía no has contratado ningún agente."))}</p>`
      : `<div class="grid">
    ${agents
      .map((agent) => {
        const days = String(agent.permissions.validForDays);
        const perTx = formatAmount(agent.permissions.perTx);
        const perDay = formatAmount(agent.permissions.perDay);
        const status =
          agent.mandateId === null
            ? `<span class="tag tag-realops">${tr(bilingual("not signed", "sin firmar"))}</span>`
            : `<span class="tag tag-signed">${tr(bilingual("signed", "firmado"))}</span>`;
        return `<div class="card stack">
      <div class="head-row"><h3>${displayName(agent.label)}</h3>${status}</div>
      <p class="meta">${tr(AGENT_COPY[agent.kind].name)}</p>
      <p>${trHtml(
        `Max per purchase <strong>${perTx} USDC</strong> · per day <strong>${perDay} USDC</strong> · valid for <strong>${days} days</strong>`,
        `Máximo por compra <strong>${perTx} USDC</strong> · por día <strong>${perDay} USDC</strong> · vigencia <strong>${days} días</strong>`,
      )}</p>
      <p class="push"><a href="/agentes/${escape(agent.id)}">${tr(bilingual("View and sign →", "Ver y firmar →"))}</a></p>
    </div>`;
      })
      .join("\n    ")}
  </div>`;

  return layout({
    title: bilingual("My agents", "Mis agentes"),
    signedIn: true,
    body: `
  <h1>${trHtml(`Hi, ${alias}`, `Hola, ${alias}`)}</h1>
  <p class="lede">${tr(
    bilingual(
      "An agent cannot do anything until you sign its permission with your wallet.",
      "Un agente no puede hacer nada hasta que firmes su permiso con tu wallet.",
    ),
  )}</p>
  ${rows}

  <h2>${tr(bilingual("Hire a new one", "Contratar uno nuevo"))}</h2>
  <form class="card" method="post" action="/agentes">
    <div class="fields">
      <div>
        <label for="kind">${tr(bilingual("Which agent", "Qué agente"))}</label>
        <select id="kind" name="kind">
          ${Object.entries(AGENT_COPY)
            // A store shopper needs a store and different limits, so it has its
            // own card below (`C-147`).
            .filter(([kind]) => kind !== "vitrinee_shopper")
            .map(
              ([kind, copy]) =>
                `<option value="${escape(kind)}" ${textAttributes(copy.name)}>${escape(copy.name.en)}</option>`,
            )
            .join("\n          ")}
        </select>
      </div>
      <div>
        <label for="label">${tr(bilingual("What to call it", "Cómo quieres llamarlo"))}</label>
        <input id="label" name="label" required maxlength="60" ${placeholder(bilingual("My report agent", "Mi agente de informes"))}>
      </div>
    </div>
    <div class="fields">
      <div>
        <label for="perTx">${tr(bilingual("Max per purchase (USDC)", "Máximo por compra (USDC)"))}</label>
        <input id="perTx" name="perTx" required value="0.30" inputmode="decimal">
      </div>
      <div>
        <label for="perDay">${tr(bilingual("Max per day (USDC)", "Máximo por día (USDC)"))}</label>
        <input id="perDay" name="perDay" required value="0.60" inputmode="decimal">
      </div>
      <div>
        <label for="validForDays">${tr(bilingual("Validity (days)", "Vigencia (días)"))}</label>
        <input id="validForDays" name="validForDays" required value="30" inputmode="numeric">
      </div>
    </div>
    <button type="submit">${tr(bilingual("Set up", "Configurar"))}</button>
  </form>

  <h2>${tr(bilingual("Hire a store shopper", "Contratar un comprador de tienda"))}</h2>
  <p class="lede">${tr(AGENT_COPY.vitrinee_shopper.what)}</p>
  ${storeShopperCard(stores)}
`,
  });
}

const ENFORCER_COPY: Readonly<Record<ExplainedControl["enforcedBy"], { readonly tag: Bilingual; readonly cls: string }>> = {
  signed: { tag: bilingual("signed", "firmado"), cls: "tag-signed" },
  onchain: { tag: bilingual("on-chain", "on-chain"), cls: "tag-onchain" },
  realops: { tag: bilingual("RealOps", "RealOps"), cls: "tag-realops" },
};

/**
 * The review screen. It shows the literal grant, not a summary of it, because
 * the person is about to sign that exact object and anything else would be a
 * paraphrase of what they authorised.
 */
export function reviewPage(
  agent: AgentConfig,
  grant: ProposedGrant,
  controls: readonly ExplainedControl[],
  revokeBaseUrl: string,
): string {
  return layout({
    title: bilingual("Review the permission", "Revisar el permiso"),
    signedIn: true,
    body: `
  <h1>${displayName(agent.label)}</h1>
  <p class="lede">${trHtml(
    "This is exactly what you are about to sign. The tag on the right says who enforces each item: <strong>signed</strong> is checked by AgentPey against your Mandate, <strong>on-chain</strong> is also revalidated by the contract on Stellar, and <strong>RealOps</strong> belongs to this platform only.",
    "Esto es exactamente lo que vas a firmar. La etiqueta de la derecha dice quién lo hace cumplir: <strong>firmado</strong> lo verifica AgentPey contra tu Mandato, <strong>on-chain</strong> además lo revalida el contrato en Stellar, y <strong>RealOps</strong> es solo de esta plataforma.",
  )}</p>

  <div class="card table-wrap">
    <table>
      <thead><tr><th>${tr(bilingual("Permission", "Permiso"))}</th><th>${tr(bilingual("Value", "Valor"))}</th><th>${tr(bilingual("Enforced by", "Quién lo hace cumplir"))}</th></tr></thead>
      <tbody>
        ${controls
          .map(
            (control) => `<tr>
          <td><strong>${tr(control.label)}</strong><br><span class="meta">${tr(control.explanation)}</span></td>
          <td>${control.field === "validUntil" ? localTime(control.value) : `<code>${escape(control.value)}</code>`}</td>
          <td><span class="tag ${ENFORCER_COPY[control.enforcedBy].cls}">${tr(ENFORCER_COPY[control.enforcedBy].tag)}</span></td>
        </tr>`,
          )
          .join("\n        ")}
      </tbody>
    </table>
  </div>

  <h2>${tr(bilingual("The permission, literally", "El permiso, literal"))}</h2>
  <div class="split">
    <div>
      <p class="meta" style="margin-top:0">${tr(
        bilingual(
          "This is the object sent to AgentPey, and the one your wallet shows you before signing. There is nothing else.",
          "Este es el objeto que se envía a AgentPey y el que tu wallet te muestra antes de firmar. No hay nada más.",
        ),
      )}</p>
      <pre>${escape(JSON.stringify(grant, null, 2))}</pre>
    </div>
    <div class="card">
      <p>${trHtml(
        "<strong>Signing happens on AgentPey's site, not here.</strong> If you ever see a screen asking you to sign a Mandate on RealOps' domain, it is not ours.",
        "<strong>La firma ocurre en el sitio de AgentPey, no aquí.</strong> Si alguna vez ves una pantalla que te pide firmar un Mandato en el dominio de RealOps, no es nuestra.",
      )}</p>
      ${signState(agent, revokeBaseUrl)}
    </div>
  </div>
`,
  });
}

/** What the review card offers, given how far this agent has got. */
function signState(agent: AgentConfig, revokeBaseUrl: string): string {
  if (agent.mandateId !== null) {
    return `<p class="signed">✓ ${tr(bilingual("Signed.", "Firmado."))} ${tr(bilingual("Mandate", "Mandato"))} <code data-mandate-id>${escape(agent.mandateId)}</code></p>
    <p><a href="/servicios">${tr(bilingual("Go to My services →", "Ir a Mis servicios →"))}</a></p>
    <p><a class="button secondary" href="${escape(revokeBaseUrl)}/revocar/${escape(agent.mandateId)}?volver=/agentes/${escape(agent.id)}">${tr(bilingual("Revoke this permission", "Revocar este permiso"))}</a></p>
    <p class="meta">${trHtml(
      "Revoking cuts the authorization <strong>from outside the agent</strong>: whatever it is told afterwards, without a valid Mandate it cannot pay for anything. It happens on AgentPey's site and you sign it with your wallet. RealOps cannot revoke for you, even if it wanted to.",
      "Revocar corta la autorización <strong>desde fuera del agente</strong>: no importa qué le digan después, sin un Mandato válido no puede pagar nada. Se hace en el sitio de AgentPey y lo firmas con tu wallet. RealOps no puede revocar por ti, aunque quisiera.",
    )}</p>`;
  }
  if (agent.consentSessionId !== null) {
    return `<p>${tr(
      bilingual(
        "You started signing this permission and did not finish, or the invitation expired.",
        "Empezaste a firmar este permiso y no terminaste, o la invitación venció.",
      ),
    )}</p>
    <form method="post" action="/agentes/${escape(agent.id)}/firmar"><button type="submit">${tr(bilingual("Retry signing", "Reintentar la firma"))}</button></form>`;
  }
  return `<form method="post" action="/agentes/${escape(agent.id)}/firmar">
      <button type="submit">${tr(bilingual("Sign on AgentPey", "Firmar en AgentPey"))}</button>
    </form>
    <p class="meta">${tr(
      bilingual(
        "We take you to AgentPey's site to connect your wallet and sign. When you finish, you come back here.",
        "Te llevamos al sitio de AgentPey para que conectes tu wallet y firmes. Cuando termines, vuelves aquí.",
      ),
    )}</p>`;
}

export interface ServicesInput {
  readonly account: Account;
  /** `null` when this instance has no AgentPey behind it, or the call failed. */
  readonly activity: TenantActivity | null;
  /** Why the activity is missing, if it is. */
  readonly activityError?: Bilingual;
  readonly agents: readonly AgentConfig[];
}

/**
 * An amount for a person to read: at most three decimals, and at least two, so
 * `0.5000000` reads `0.50` and `0.1234567` reads `0.123`. Display only; what
 * AgentPey stores and checks keeps all seven decimals.
 */
export function formatAmount(value: string | null): string {
  if (value === null) return "?";
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number)) return escape(value);
  const fixed = number.toFixed(3);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}

/**
 * A moment, shown in the visitor's own time zone. The server does not know
 * where the visitor is, so it writes UTC and the page's script rewrites it with
 * the browser's zone; without JavaScript the UTC time stays, labelled as such.
 */
export function localTime(iso: string): string {
  const fallback = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso;
  return `<time datetime="${escape(iso)}" data-local>${escape(fallback)}</time>`;
}

/**
 * Which of this account's agents a purchase went through, read from the Mandate
 * AgentPey says it used (T90). Empty when it cannot tell, for instance for a
 * purchase made before AgentPey recorded the Mandate.
 */
function agentLine(purchase: PurchaseResource, agents: readonly AgentConfig[]): string {
  const agent = purchase.mandate_id == null ? undefined : agents.find((candidate) => candidate.mandateId === purchase.mandate_id);
  if (agent === undefined) return "";
  const name = displayName(agent.label);
  return `<p class="meta">${trHtml(`Agent: ${name}`, `Agente: ${name}`)}</p>`;
}

/** One purchase, settled — what the person actually got. */
function deliveryCard(purchase: PurchaseResource, agents: readonly AgentConfig[]): string {
  const links: string[] = [];
  if (purchase.delivery?.artifact_url != null) {
    links.push(`<a class="button" href="${escape(purchase.delivery.artifact_url)}">${tr(bilingual("See what you bought", "Ver lo que compraste"))}</a>`);
  }
  if (purchase.explorer_url !== null) {
    links.push(`<a href="${escape(purchase.explorer_url)}">${tr(bilingual("See the payment on Stellar ↗", "Ver el pago en Stellar ↗"))}</a>`);
  }

  return `<div class="card stack">
    <div><span class="tag tag-signed">${tr(bilingual("delivered", "entregado"))}</span></div>
    <h3>${escape(purchase.product_id)}</h3>
    ${agentLine(purchase, agents)}
    <p>${formatAmount(purchase.total)} ${escape((purchase.asset ?? "").split(":")[0] ?? "")} · ${localTime(purchase.created_at)}</p>
    <p class="meta">
      ${purchase.delivery?.delivery_id == null ? "" : `${tr(bilingual("Delivery", "Entrega"))} <code>${escape(purchase.delivery.delivery_id)}</code><br>`}
      ${purchase.delivery?.receipt_hash == null ? "" : `${tr(bilingual("Receipt", "Recibo"))} <code>${escape(purchase.delivery.receipt_hash)}</code>`}
    </p>
    ${links.length === 0 ? "" : `<p class="push actions">${links.join(" ")}</p>`}
  </div>`;
}

/** One purchase, refused — said in words the person can act on. */
function refusalCard(purchase: PurchaseResource, agents: readonly AgentConfig[]): string {
  const explained = explainRefusal(purchase.code ?? "unknown", purchase.reason);
  return `<div class="card error stack">
    <div><span class="tag tag-refused">${tr(bilingual("refused", "rechazado"))}</span></div>
    <h3>${escape(purchase.product_id)}</h3>
    ${agentLine(purchase, agents)}
    <p><strong>${tr(explained.what)}</strong></p>
    <p>${tr(explained.next)}</p>
    <p class="meta push">
      ${localTime(purchase.created_at)} · ${tr(bilingual("technical code", "código técnico"))} <code>${escape(purchase.code ?? "unknown")}</code>
    </p>
  </div>`;
}

function spendingCard(activity: TenantActivity): string {
  if (activity.per_day === null && activity.rail === null) return "";
  let perDay = "";
  if (activity.per_day !== null) {
    const spent = formatAmount(activity.per_day.spent_today);
    const limit = `${formatAmount(activity.per_day.limit)} ${escape(activity.per_day.currency)}`;
    const remaining = `${formatAmount(activity.per_day.remaining)} ${escape(activity.per_day.currency)}`;
    perDay = `<p>${trHtml(
      `Spent today: <strong>${spent}</strong> of <strong>${limit}</strong>.`,
      `Hoy llevas gastado <strong>${spent}</strong> de <strong>${limit}</strong>.`,
    )}
      ${
        activity.per_day.near_limit
          ? `<strong>${tr(bilingual("You are close to the limit.", "Estás cerca del tope."))}</strong>`
          : trHtml(`You have ${remaining} left.`, `Te quedan ${remaining}.`)
      }</p>`;
  }
  let rail = "";
  if (activity.rail !== null) {
    const balance = `${formatAmount(activity.rail.balance)} ${escape(activity.rail.asset)}`;
    rail = `<p class="meta">${trHtml(
      `Balance of the contract that pays: <strong>${balance}</strong>.`,
      `Saldo del contrato que paga: <strong>${balance}</strong>.`,
    )}
      ${
        activity.rail.sponsored
          ? tr(bilingual("It is test credit provided by the pilot, not your money.", "Es crédito de prueba que pone el piloto, no dinero tuyo."))
          : ""
      }</p>`;
  }

  return `<div class="card"><h3>${tr(bilingual("Daily limit", "Límite diario"))}</h3>${perDay}${rail}</div>`;
}

export function servicesPage(input: ServicesInput): string {
  const { account, activity } = input;
  const settled = (activity?.purchases ?? []).filter((purchase) => purchase.outcome === "settled");
  const refused = (activity?.purchases ?? []).filter((purchase) => purchase.outcome === "refused");
  const signable = input.agents.filter((agent) => agent.mandateId !== null);

  const ask =
    signable.length === 0
      ? `<p class="card">${trHtml(
          'You do not have any agent with a signed permission yet. <a href="/agentes">Start there</a>.',
          'Todavía no tienes ningún agente con permiso firmado. <a href="/agentes">Empieza por ahí</a>.',
        )}</p>`
      : `<form class="card" method="post" action="/instruccion">
    <input type="hidden" name="request_key" value="${randomUUID()}">
    <label for="instruction" style="margin-top:0">${tr(bilingual("Tell it what to buy", "Dile qué comprar"))}</label>
    <input id="instruction" name="instruction" required maxlength="500" ${placeholder(bilingual("buy the XLM/USDC market report", "compra el informe XLM/USDC"))}>
    <button type="submit">${tr(bilingual("Ask for it", "Pedirlo"))}</button>
    <p class="meta" style="margin:14px 0 0">${trHtml(
      "RealOps interprets the sentence. Then <strong>AgentPey decides</strong>: it resolves the merchant again, requests the invoice itself, and checks everything against what you signed before paying.",
      "RealOps interpreta la frase. Después <strong>AgentPey decide</strong>: vuelve a resolver el comercio, pide él mismo la factura y compara todo contra lo que firmaste antes de pagar.",
    )}</p>
  </form>`;

  const spending = activity === null ? "" : spendingCard(activity);

  return layout({
    title: bilingual("My services", "Mis servicios"),
    signedIn: true,
    body: `
  <h1>${tr(bilingual("My services", "Mis servicios"))}</h1>
  <p class="lede">${tr(
    bilingual(
      "Everything your agent bought, and everything it tried and was refused, with its proof.",
      "Todo lo que tu agente compró, y todo lo que intentó y le rechazaron, con su prueba.",
    ),
  )}</p>

  ${input.activityError === undefined ? "" : `<p class="card error">${tr(input.activityError)}</p>`}
  ${spending === "" ? ask : `<div class="split">${ask}${spending}</div>`}

  <h2>${tr(bilingual("Deliveries", "Entregas"))}</h2>
  ${
    settled.length === 0
      ? `<p class="card">${tr(bilingual("You have not bought anything yet.", "Todavía no has comprado nada."))}</p>`
      : `<div class="grid">${settled.map((purchase) => deliveryCard(purchase, input.agents)).join("\n  ")}</div>`
  }

  <h2>${tr(bilingual("Refusals", "Rechazos"))}</h2>
  ${
    refused.length === 0
      ? `<p class="card">${tr(bilingual("No refused attempts.", "Ningún intento rechazado."))}</p>`
      : `<p class="meta">${tr(
          bilingual(
            'A refusal is not an absence: it is stored just like a purchase, so "why did my agent not buy this?" has an answer.',
            'Un rechazo no es una ausencia: queda guardado igual que una compra, para que "¿por qué mi agente no compró esto?" tenga respuesta.',
          ),
        )}</p>
  <div class="grid">${refused.map((purchase) => refusalCard(purchase, input.agents)).join("\n  ")}</div>`
  }

  <h2>${tr(bilingual("Your account", "Tu cuenta"))}</h2>
  <div class="card">
    <p>${trHtml(
      `AgentPey knows you as <code>${escape(account.externalRef)}</code>. That code is random: it is not derived from your email, so it cannot be reversed.`,
      `Ante AgentPey te identificamos como <code>${escape(account.externalRef)}</code>. Ese código es aleatorio: no se calcula a partir de tu correo, así que no se puede revertir.`,
    )}</p>
    <form method="post" action="/cuenta/borrar" onsubmit="return confirm(document.documentElement.lang === 'es' ? '¿Borrar tu correo y cerrar todas tus sesiones?' : 'Delete your email and close all your sessions?')">
      <button class="secondary" type="submit">${tr(bilingual("Delete my account", "Borrar mi cuenta"))}</button>
    </form>
    <p class="meta">${trHtml(
      "Deletes your email, your name and your RealOps sessions. <strong>It does not delete your Mandate or the record of what happened</strong>: they are signed evidence anchored on a public chain, and deleting them would break the hash chain that is the whole product. We say it plainly, because it is a real tension and hiding it would be worse.",
      "Borra tu correo, tu alias y tus sesiones de RealOps. <strong>No borra tu Mandato ni el registro de lo que pasó</strong>: son evidencia firmada y anclada en una cadena pública, y borrarlos rompería la cadena de hashes que es todo el producto. Lo decimos así, con todas sus letras, porque es una tensión real y esconderla sería peor.",
    )}</p>
  </div>
`,
  });
}

export interface ChooseAgentInput {
  /** This account's agents that could buy what was asked. More than one, or there is nothing to choose. */
  readonly agents: readonly AgentConfig[];
  readonly kind: AgentKind;
  /** The sentence as typed, sent again with the choice and read the same way (C-94). */
  readonly instruction?: string;
  /** Set instead of `instruction` when the person pressed a product button. */
  readonly chosenKind?: AgentKind;
  /** The key of the form that asked. Every choice sends it, so choosing stays one request. */
  readonly requestKey: string;
  /**
   * The product and the parameters the person already filled in, carried
   * through the choice so choosing an agent does not lose them (T96).
   *
   * Before the catalogue there was nothing to carry: a kind named exactly one
   * product and the parameters were RealOps' own. A bazaar card carries both,
   * and dropping them here would silently buy something else.
   */
  readonly productId?: string;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * "Which agent buys it?" (T90, decided by the user).
 *
 * Shown only when more than one signed agent of this account can buy what was
 * asked. Each button sends the same request again, with the same key, plus the
 * agent chosen; AgentPey then goes through that agent's Mandate and no other.
 */
export function chooseAgentPage(input: ChooseAgentInput): string {
  const what =
    input.productId !== undefined
      ? `<input type="hidden" name="product_id" value="${escape(input.productId)}">` +
        Object.entries(input.params ?? {})
          .map(([name, value]) => `<input type="hidden" name="param_${escape(name)}" value="${escape(value)}">`)
          .join("")
      : input.chosenKind !== undefined
        ? `<input type="hidden" name="kind" value="${escape(input.chosenKind)}">`
        : `<input type="hidden" name="instruction" value="${escape(input.instruction ?? "")}">`;
  const carried = `<input type="hidden" name="request_key" value="${escape(input.requestKey)}">${what}`;

  const cards = input.agents
    .map((agent) => {
      const perTx = formatAmount(agent.permissions.perTx);
      const perDay = formatAmount(agent.permissions.perDay);
      const hired = localTime(agent.createdAt.toISOString());
      return `<form class="card stack" method="post" action="/instruccion">
      ${carried}
      <input type="hidden" name="agent_id" value="${escape(agent.id)}">
      <div class="head-row"><h3>${displayName(agent.label)}</h3><span class="tag tag-signed">${tr(bilingual("signed", "firmado"))}</span></div>
      <p>${trHtml(
        `Max per purchase <strong>${perTx} USDC</strong> · per day <strong>${perDay} USDC</strong>`,
        `Máximo por compra <strong>${perTx} USDC</strong> · por día <strong>${perDay} USDC</strong>`,
      )}</p>
      <p class="meta">${trHtml(`Hired ${hired}`, `Contratado ${hired}`)}</p>
      <p class="push"><button type="submit">${tr(bilingual("Buy with this agent", "Comprar con este agente"))}</button></p>
    </form>`;
    })
    .join("\n    ");

  return layout({
    title: bilingual("Which agent buys it?", "¿Qué agente lo compra?"),
    signedIn: true,
    body: `
  <h1>${tr(bilingual("Which agent buys it?", "¿Qué agente lo compra?"))}</h1>
  <p class="lede">${tr(
    bilingual(
      `You have more than one ${AGENT_COPY[input.kind].name.en.toLowerCase()} with a signed permission. AgentPey will use exactly the permission of the one you choose.`,
      `Tienes más de un ${AGENT_COPY[input.kind].name.es.toLowerCase()} con permiso firmado. AgentPey usará exactamente el permiso del que elijas.`,
    ),
  )}</p>
  <p class="meta">${tr(
    bilingual(
      "Spending today adds up across your agents: the daily limit of the one you choose is checked against everything your agents spent today.",
      "El gasto del día se suma entre tus agentes: el límite diario del que elijas se compara con todo lo que tus agentes gastaron hoy.",
    ),
  )}</p>
  <div class="grid">
    ${cards}
  </div>
  <p><a href="/servicios">${tr(bilingual("← Back to My services", "← Volver a Mis servicios"))}</a></p>
`,
  });
}

const PROBLEM_COPY: Readonly<Record<InstructionProblem, Bilingual>> = {
  empty: bilingual("You did not write an instruction", "No escribiste ninguna instrucción"),
  too_long: bilingual("The instruction is too long", "La instrucción es demasiado larga"),
  both_products: bilingual("The instruction asks for more than one product at once", "La instrucción pide más de un producto a la vez"),
  no_product: bilingual("I did not recognize any product in the instruction", "No reconocí ningún producto en la instrucción"),
  unknown_pair: bilingual("I only know XLM/USDC. Name the pair explicitly", "Solo conozco XLM/USDC. Indica el par explícitamente"),
};

export function notRecognisedPage(problem: InstructionProblem, instruction: string): string {
  const read = `<code>${escape(instruction)}</code>`;
  const reason = PROBLEM_COPY[problem];
  return layout({
    title: bilingual("Not understood", "No entendí"),
    signedIn: true,
    body: `
  <h1>${tr(bilingual("I did not understand the instruction", "No entendí la instrucción"))}</h1>
  <p class="lede">${trHtml(`${escape(reason.en)}. I read this: ${read}`, `${escape(reason.es)}. Leí esto: ${read}`)}</p>
  <div class="card">
    <p>${trHtml(
      "<strong>We do not guess.</strong> An agent with permission to spend that guesses buys what you did not ask for. Pick one of the two:",
      "<strong>No adivinamos.</strong> Un agente con permiso para gastar que adivina, compra lo que no le pediste. Elige una de las dos:",
    )}</p>
    ${FALLBACK_CHOICES.map(
      (choice) =>
        `<form method="post" action="/instruccion" style="display:inline-block;margin-right:10px"><input type="hidden" name="request_key" value="${randomUUID()}"><input type="hidden" name="kind" value="${escape(choice.kind)}"><button type="submit">${tr(choice.label)}</button></form>`,
    ).join("\n    ")}
  </div>
`,
  });
}

export function errorPage(status: number, message: Bilingual): string {
  return layout({
    title: bilingual(`Error ${status}`, `Error ${status}`),
    body: `
  <h1>${status}</h1>
  <p class="lede">${tr(message)}</p>
  <p><a href="/">${tr(bilingual("← Back to home", "← Volver al inicio"))}</a></p>
`,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The catalogue (T96)
 *
 * The screen the pilot was missing. It draws the whole shop — SignalDesk and
 * the ambassador's bazaar — and marks every item against the permission that
 * has actually been signed. An item the Mandate does not cover is not hidden
 * and not an error message: it is a link to the exact, literal permission that
 * would have to be signed for it, shown with the same `enforcedBy` marks the
 * review screen uses.
 *
 * What the copy here must never say is that a covered item *will* be bought.
 * RealOps asks; AgentPey decides, against the Mandate itself, at purchase
 * time. Every line below is written to keep that distinction visible.
 * ──────────────────────────────────────────────────────────────────────────── */

const AVAILABILITY_COPY: Readonly<Record<ResourceAvailability, Bilingual | null>> = {
  sellable: null,
  unavailable: bilingual(
    "The merchant lists this but is not charging for it right now, so it cannot be bought.",
    "El comercio lo publica pero no lo está cobrando ahora, así que no se puede comprar.",
  ),
  unknown: bilingual(
    "We could not reach the merchant to check whether this is on sale. Asking for it may fail.",
    "No pudimos contactar al comercio para saber si está a la venta. Pedirlo puede fallar.",
  ),
};

const VENUE_COPY: Readonly<Record<CatalogVenue, { readonly name: Bilingual; readonly note: Bilingual }>> = {
  signaldesk: {
    name: bilingual("SignalDesk", "SignalDesk"),
    note: bilingual(
      "The pilot's own merchant. Two fixed products, the ones RealOps has always offered.",
      "El comercio propio del piloto. Dos productos fijos, los que RealOps siempre ofreció.",
    ),
  },
  bazaar: {
    name: bilingual("Stellar Bazaar", "Stellar Bazaar"),
    note: bilingual(
      "An independent merchant, read live from its own catalogue. It can add or remove products without telling us, and what it lists is not what your agent may buy.",
      "Un comercio independiente, leído en vivo desde su propio catálogo. Puede agregar o quitar productos sin avisarnos, y lo que publica no es lo que tu agente puede comprar.",
    ),
  },
  vitrinee: {
    name: bilingual("Stores on Vitrinee", "Tiendas en Vitrinee"),
    note: bilingual(
      "Real stores that joined AgentPey through Vitrinee, each read live from its own catalogue. They ship physical products, so each purchase asks for a name and an address; the quantity you enter is the one the agent signs for. A store shopper buys at one store only. Prices are in USDC on Stellar testnet.",
      "Tiendas reales que se sumaron a AgentPey por Vitrinee, cada una leída en vivo desde su propio catálogo. Envían productos físicos, así que cada compra pide un nombre y una dirección; la cantidad que escribas es la que el agente firma. Un comprador de tienda compra en una sola tienda. Los precios están en USDC de Stellar testnet.",
    ),
  },
};

/** One input the merchant requires, as a form field. Never a money field: the price is the merchant's. */
function inputField(card: CatalogCard, input: ResourceInput, quantity = 1): string {
  const id = `${card.productId}-${input.name}`;
  const help =
    input.description === undefined
      ? ""
      : `<span class="meta">${escape(input.description)}</span>`;
  // The merchant's `quantity` is the purchase's own quantity (`C-132`): a
  // whole number of units, starting at one, that the agent signs for.
  if (input.name === QUANTITY_INPUT) {
    return `<label for="${escape(id)}">${tr(bilingual("Quantity", "Cantidad"))}</label>
      <input id="${escape(id)}" name="param_${escape(input.name)}" type="number" min="1" max="20" step="1" value="${quantity}" required
             autocomplete="off" inputmode="numeric">`;
  }
  const type = input.type.toLowerCase() === "number" ? "number" : "text";
  return `<label for="${escape(id)}">${escape(input.name)}${input.required ? " *" : ""}</label>
      ${help}
      <input id="${escape(id)}" name="param_${escape(input.name)}" type="${type}"${input.required ? " required" : ""}
             autocomplete="off" inputmode="${type === "number" ? "decimal" : "text"}">`;
}

/** What a card offers, given how it stands against the signed permission. */
function cardAction(card: CatalogCard, requestKey: string, quantity = 1): string {
  if (card.coverage.state === "outside") {
    return `<p class="push"><a class="button secondary" href="/catalogo/permiso?producto=${encodeURIComponent(card.productId)}">${tr(
      bilingual("See the permission this needs →", "Ver el permiso que esto necesita →"),
    )}</a></p>`;
  }
  if (card.coverage.state === "unsigned") {
    return `<p class="push"><a class="button secondary" href="/agentes/${escape(card.coverage.agentId)}">${tr(
      bilingual("Finish signing this permission →", "Terminar de firmar este permiso →"),
    )}</a></p>`;
  }
  if (card.availability === "unavailable") {
    return `<p class="push meta">${tr(
      bilingual(
        "Your agent's permission covers this, but the merchant is not selling it.",
        "El permiso de tu agente lo cubre, pero el comercio no lo está vendiendo.",
      ),
    )}</p>`;
  }
  // Inputs RealOps fills itself are not drawn. A field a browser could edit is
  // a value a browser controls, and the credits route's `account` is precisely
  // the value that must stay RealOps'.
  const fields = card.inputs.filter((input) => !card.serverFilled.includes(input.name));
  return `<form class="push" method="post" action="/instruccion">
      <input type="hidden" name="product_id" value="${escape(card.productId)}">
      <input type="hidden" name="request_key" value="${escape(requestKey)}">
      ${fields.map((input) => inputField(card, input, quantity)).join("\n      ")}
      <button type="submit">${tr(bilingual("Ask the agent to buy it", "Pedirle al agente que lo compre"))}</button>
    </form>`;
}

function coverageTag(card: CatalogCard): string {
  if (card.coverage.state === "covered") {
    return `<span class="tag tag-signed">${tr(bilingual("in the grant", "dentro del permiso"))}</span>`;
  }
  if (card.coverage.state === "unsigned") {
    return `<span class="tag tag-realops">${tr(bilingual("not signed yet", "sin firmar todavía"))}</span>`;
  }
  return `<span class="tag tag-refused">${tr(bilingual("outside the grant", "fuera del permiso"))}</span>`;
}

function catalogCardHtml(card: CatalogCard, requestKey: string, quantity = 1): string {
  const availability = AVAILABILITY_COPY[card.availability];
  // The id is the anchor a typed sentence lands on (`/catalogo#<product id>`).
  return `<div class="card stack" id="${escape(card.productId)}">
      <div class="head-row"><h3>${tr(card.title)}</h3>${coverageTag(card)}</div>
      <p class="meta"><code>${escape(card.productId)}</code></p>
      <p>${tr(card.description)}</p>
      <p class="meta">${trHtml(
        `Merchant's listed price <strong>${escape(card.declaredAmount)} ${escape(card.declaredAsset)}</strong>. AgentPey ignores it and pays the merchant's own invoice, checked against your Mandate.`,
        `Precio publicado por el comercio <strong>${escape(card.declaredAmount)} ${escape(card.declaredAsset)}</strong>. AgentPey lo ignora y paga la factura del propio comercio, verificada contra tu Mandato.`,
      )}</p>
      ${availability === null ? "" : `<p class="meta">${tr(availability)}</p>`}
      ${cardAction(card, requestKey, quantity)}
    </div>`;
}

export interface CatalogInput {
  readonly cards: readonly CatalogCard[];
  /** Why the bazaar section is missing, if it is. A failed read is not an empty shop. */
  readonly bazaarError?: Bilingual;
  /** Why no Vitrinee store is shown at all, if none is: the directory could not be read (T104). */
  readonly vitrineeError?: Bilingual;
  /** Stores the directory names whose own catalogue could not be read (T104). */
  readonly storeErrors?: readonly { readonly slug: string; readonly name: string; readonly error: Bilingual }[];
  /** The product and quantity a typed sentence named, to open its card already filled in. */
  readonly prefill?: { readonly productId: string; readonly quantity: number };
}

export function catalogPage(input: CatalogInput): string {
  // One key per rendered page, shared by every form on it (C-98, T84): sending
  // the same form twice replays the purchase AgentPey already made instead of
  // paying again.
  const requestKey = randomUUID();

  const readError = (venue: CatalogVenue): Bilingual | undefined =>
    venue === "bazaar" ? input.bazaarError : venue === "vitrinee" ? input.vitrineeError : undefined;

  const grid = (cards: readonly CatalogCard[]): string => `<div class="grid">
    ${cards
      .map((card) => catalogCardHtml(card, requestKey, input.prefill?.productId === card.productId ? input.prefill.quantity : 1))
      .join("\n    ")}
  </div>`;

  /**
   * One section per Vitrinee store the directory names (T104, `C-141`): the
   * stores are the list the person chooses from, and a store shopper is hired
   * from its own store's cards.
   */
  const storeSections = (): string => {
    const copy = VENUE_COPY.vitrinee;
    const cards = input.cards.filter((card) => card.venue === "vitrinee");
    const slugs = [...new Set(cards.map((card) => card.store?.slug).filter((slug): slug is string => slug !== undefined))];
    const failed = (input.storeErrors ?? []).filter((store) => !slugs.includes(store.slug));
    const intro = `<h2>${tr(copy.name)}</h2>
  <p class="lede">${tr(copy.note)}</p>`;
    if (slugs.length === 0 && failed.length === 0) {
      const error = input.vitrineeError;
      return `${intro}
  <p class="card">${tr(error ?? bilingual("No store on Vitrinee is selling right now.", "Ninguna tienda en Vitrinee está vendiendo ahora mismo."))}</p>`;
    }
    const stores = slugs.map((slug) => {
      const ofStore = cards.filter((card) => card.store?.slug === slug);
      const name = ofStore[0]?.store?.name ?? slug;
      return `<h3>${escape(name)}</h3>
  ${grid(ofStore)}`;
    });
    const unreadable = failed.map((store) => `<h3>${escape(store.name)}</h3>
  <p class="card">${tr(store.error)}</p>`);
    return `${intro}
  ${[...stores, ...unreadable].join("\n  ")}`;
  };

  const section = (venue: CatalogVenue): string => {
    const cards = input.cards.filter((card) => card.venue === venue);
    const copy = VENUE_COPY[venue];
    const error = readError(venue);
    const body =
      cards.length === 0
        ? `<p class="card">${
            error !== undefined
              ? tr(error)
              : tr(bilingual("Nothing on offer here right now.", "No hay nada a la venta aquí ahora mismo."))
          }</p>`
        : `<div class="grid">
    ${cards
      .map((card) => catalogCardHtml(card, requestKey, input.prefill?.productId === card.productId ? input.prefill.quantity : 1))
      .join("\n    ")}
  </div>`;
    return `<h2>${tr(copy.name)}</h2>
  <p class="lede">${tr(copy.note)}</p>
  ${body}`;
  };

  return layout({
    title: bilingual("Catalogue", "Catálogo"),
    signedIn: true,
    body: `
  <h1>${tr(bilingual("Catalogue", "Catálogo"))}</h1>
  <p class="lede">${trHtml(
    "Everything on sale, and what your agents may actually buy. An item marked <strong>outside the grant</strong> is not broken: no permission you signed covers it, so AgentPey would refuse it. Open it to see exactly how much more power you would be granting.",
    "Todo lo que está a la venta, y lo que tus agentes realmente pueden comprar. Un ítem marcado <strong>fuera del permiso</strong> no está roto: ningún permiso que firmaste lo cubre, así que AgentPey lo rechazaría. Ábrelo para ver exactamente cuánto poder nuevo le estarías dando.",
  )}</p>
  <p class="meta">${tr(
    bilingual(
      "In the grant means the permission you signed names this merchant and this product. It is not a promise the purchase will go through: AgentPey decides at that moment, against your Mandate, and still refuses an expired or revoked permission, a day's limit already spent, or an invoice that does not match.",
      "Dentro del permiso significa que el permiso que firmaste nombra este comercio y este producto. No es una promesa de que la compra se hará: AgentPey decide en ese momento, contra tu Mandato, y igual rechaza un permiso vencido o revocado, un límite diario ya gastado, o una factura que no cuadra.",
    ),
  )}</p>

  ${section("signaldesk")}
  ${section("bazaar")}
  ${storeSections()}
`,
  });
}

export interface GrantDiffInput {
  readonly card: CatalogCard;
  readonly agentName: Bilingual;
  readonly grant: ProposedGrant;
  readonly controls: readonly ExplainedControl[];
}

/**
 * The permission an item outside the grant would need — the point of the whole
 * screen.
 *
 * It renders the same literal object `reviewPage` does, from the same
 * `translatePermissions`, because the person should see the thing that would be
 * signed and not a description of it. Nothing is signed from here: this page
 * only offers to create the agent, and signing still happens on AgentPey's
 * domain with the person's own wallet.
 */
export function grantDiffPage(input: GrantDiffInput): string {
  return layout({
    title: bilingual("The permission this needs", "El permiso que esto necesita"),
    signedIn: true,
    body: `
  <h1>${tr(input.card.title)}</h1>
  <p class="lede">${trHtml(
    "None of your signed permissions covers this. To buy it you would hire a <strong>new agent</strong>, with its own permission, and sign it. Your existing agents are not touched and nothing you already signed is changed or re-signed.",
    "Ninguno de tus permisos firmados cubre esto. Para comprarlo contratarías un <strong>agente nuevo</strong>, con su propio permiso, y lo firmarías. Tus agentes actuales no se tocan y nada de lo que ya firmaste cambia ni se vuelve a firmar.",
  )}</p>

  <div class="card table-wrap">
    <table>
      <thead><tr><th>${tr(bilingual("New permission", "Permiso nuevo"))}</th><th>${tr(bilingual("Value", "Valor"))}</th><th>${tr(bilingual("Enforced by", "Quién lo hace cumplir"))}</th></tr></thead>
      <tbody>
        ${input.controls
          .map(
            (control) => `<tr>
          <td><strong>${tr(control.label)}</strong><br><span class="meta">${tr(control.explanation)}</span></td>
          <td>${control.field === "validUntil" ? localTime(control.value) : `<code>${escape(control.value)}</code>`}</td>
          <td><span class="tag ${ENFORCER_COPY[control.enforcedBy].cls}">${tr(ENFORCER_COPY[control.enforcedBy].tag)}</span></td>
        </tr>`,
          )
          .join("\n        ")}
      </tbody>
    </table>
  </div>

  <h2>${tr(bilingual("The permission, literally", "El permiso, literal"))}</h2>
  <div class="split">
    <div>
      <p class="meta" style="margin-top:0">${tr(
        bilingual(
          "This is the object that would be sent to AgentPey, and the one your wallet would show you before signing. There is nothing else.",
          "Este es el objeto que se enviaría a AgentPey y el que tu wallet te mostraría antes de firmar. No hay nada más.",
        ),
      )}</p>
      <pre>${escape(JSON.stringify(input.grant, null, 2))}</pre>
    </div>
    <div class="card stack">
      <p>${trHtml(
        `<strong>${escape(input.agentName.en)}</strong> would be a separate agent. It could buy at that merchant, those products, up to those limits, and nothing else.`,
        `<strong>${escape(input.agentName.es)}</strong> sería un agente aparte. Podría comprar en ese comercio, esos productos, hasta esos límites, y nada más.`,
      )}</p>
      <form method="post" action="/catalogo/permiso">
        <input type="hidden" name="product_id" value="${escape(input.card.productId)}">
        <button type="submit">${tr(bilingual("Set up this agent", "Configurar este agente"))}</button>
      </form>
      <p class="meta push">${tr(
        bilingual(
          "Setting it up does not authorize anything. You review it again and sign it on AgentPey's site with your wallet.",
          "Configurarlo no autoriza nada. Lo revisas otra vez y lo firmas en el sitio de AgentPey con tu wallet.",
        ),
      )}</p>
    </div>
  </div>
`,
  });
}
