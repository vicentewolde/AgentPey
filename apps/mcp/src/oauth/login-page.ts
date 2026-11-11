/**
 * The page a person sees when Claude, ChatGPT or Grok asks to connect to AgentPey's
 * MCP server (`R-7`): sign a message with the wallet that owns the spending
 * account, and only that wallet gets in. English by default, neutral Latin
 * American Spanish when the browser asks for it.
 *
 * The wallet layer (T143) is this server's own file, `/wallet-kit.js`, pinned by the integrity hash of the exact
 * bundle it serves: no CDN can swap the code that asks for the signature. Any wallet that signs messages can be
 * used, but only the configured wallet gets in: the server checks the account, not the wallet's brand.
 */

export interface LoginPageInput {
  /** The signed authorization request, handed back on every call from the page. */
  readonly request: string;
  readonly clientName: string;
  /** Where the person goes back to: shown, so they know which app asked. */
  readonly redirectHost: string;
  /** Whether the app asking is a local one (a loopback redirect): any local process could be it. */
  readonly loopback: boolean;
  /** The one wallet that can sign in, shortened for display. */
  readonly walletHint: string;
  /** The `integrity` of `/wallet-kit.js` (`walletKitIntegrity()`). */
  readonly walletKitIntegrity: string;
  /** Where the page loads it from: `/wallet-kit.js?v=<fingerprint>`, so a new bundle is never matched with a cached old one. */
  readonly walletKitSrc: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export function loginPage(input: LoginPageInput, nonce: string): string {
  const data = JSON.stringify(input).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to AgentPey</title>
<!-- the favicon of every AgentPey page (apps/web/public/brand/agentpey-favicon.svg), inline: the CSP allows data: images only -->
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 512 512%22%3E%3Crect width=%22512%22 height=%22512%22 rx=%22112%22 fill=%22%23176bff%22/%3E%3Cg transform=%22translate(79 77) scale(.7)%22 fill=%22none%22 stroke-width=%2260%22%3E%3Cg stroke=%22%23fff%22%3E%3Cpath d=%22M72 416 196 96h86v320%22/%3E%3Cpath d=%22M136 282h146%22/%3E%3Cpath d=%22M282 112h96%22/%3E%3Cpath d=%22M432 166v84l-48 48H282%22/%3E%3C/g%3E%3Cpath d=%22M378 112l54 54%22 stroke=%22%23176bff%22/%3E%3C/g%3E%3C/svg%3E">
<style>
  /* AgentPey's design system (T207, Y-7), the subset this page uses, inline: this page's CSP allows inline styles
     only and no external font, so these are apps/web/public/brand/agentpey.css's tokens with the system font. */
  :root {
    --ap-bg: #f5f5f7; --ap-surface: #ffffff; --ap-ink: #1d1d1f; --ap-ink-2: #6e6e73; --ap-hair: #d2d2d7;
    --ap-accent: #176bff; --ap-accent-ink: #ffffff; --ap-link: #0a5bd9;
    --ap-ok: #1a7f45; --ap-ok-soft: #e8f6ee; --ap-bad: #c4122f; --ap-bad-soft: #fdecee; --ap-warn: #a35200; --ap-warn-soft: #fff3e0;
    --ap-text: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --ap-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --ap-radius: 18px; --ap-radius-sm: 12px; --ap-pill: 980px;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ap-bg: #000000; --ap-surface: #1c1c1e; --ap-ink: #f5f5f7; --ap-ink-2: #86868b; --ap-hair: #38383a;
      --ap-accent: #2997ff; --ap-accent-ink: #000000; --ap-link: #2997ff;
      --ap-ok: #30d158; --ap-ok-soft: #0f2a19; --ap-bad: #ff6961; --ap-bad-soft: #3a1414; --ap-warn: #ffb340; --ap-warn-soft: #3a2a0c;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body.ap { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--ap-bg); color: var(--ap-ink); font: 17px/1.47 var(--ap-text); letter-spacing: -0.012em; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 440px; padding: 40px 16px; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 0 0 24px; font-weight: 600; font-size: 1.1875rem; letter-spacing: -0.02em; }
  .brand svg { width: 26px; height: 26px; flex: none; }
  .card { background: var(--ap-surface); border-radius: var(--ap-radius); padding: clamp(24px, 6vw, 36px); display: grid; gap: 14px; }
  h1 { margin: 0 0 4px; text-align: center; font-size: 1.75rem; line-height: 1.12; font-weight: 600; letter-spacing: -0.022em; text-wrap: balance; }
  p { margin: 0; color: var(--ap-ink-2); font-size: 0.9375rem; }
  strong { color: var(--ap-ink); font-weight: 600; }
  code { font-family: var(--ap-mono); font-size: 0.8125rem; color: var(--ap-ink); background: var(--ap-bg); border-radius: 8px; padding: 2px 8px; overflow-wrap: anywhere; }
  .warn { border-radius: var(--ap-radius-sm); padding: 12px 16px; background: var(--ap-warn-soft); color: var(--ap-warn); font-size: 0.875rem; }
  button { width: 100%; min-height: 48px; margin-top: 8px; padding: 12px 22px; border: 0; border-radius: var(--ap-pill); background: var(--ap-accent); color: var(--ap-accent-ink); font: 500 1.0625rem/1.2 var(--ap-text); letter-spacing: -0.012em; cursor: pointer; transition: filter .15s ease; }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .4; cursor: not-allowed; filter: none; }
  .deny { display: block; justify-self: center; padding: 6px 12px; color: var(--ap-link); text-decoration: none; font-size: 0.9375rem; }
  .deny:hover { text-decoration: underline; text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--ap-accent); outline-offset: 3px; border-radius: 6px; }
  button:focus-visible { border-radius: var(--ap-pill); }
  .status { min-height: 24px; text-align: center; font-size: 0.9375rem; color: var(--ap-ink-2); }
  .status:empty { display: none; }
  .status.ok, .status.error { border-radius: var(--ap-radius-sm); padding: 10px 14px; }
  .status.ok { background: var(--ap-ok-soft); color: var(--ap-ok); }
  .status.error { background: var(--ap-bad-soft); color: var(--ap-bad); }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
<script nonce="${nonce}" src="${escapeHtml(input.walletKitSrc)}" data-needs="message" integrity="${escapeHtml(input.walletKitIntegrity)}" crossorigin="anonymous"></script>
</head>
<body class="ap">
<main>
  <div class="brand"><svg viewBox="0 0 512 512" aria-hidden="true"><defs><mask id="ap-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/><path d="M378 112l54 54" stroke="#000" stroke-width="60"/></mask></defs><g mask="url(#ap-cut)" fill="none" stroke="currentColor" stroke-width="60"><path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g></svg>AgentPey</div>
  <div class="card">
    <h1 data-t="title">Connect to AgentPey</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> <span data-t="asks">wants to search, quote and pay in AgentPey stores for you, from your spending account on Stellar testnet, within its limits.</span></p>
    <p><span data-t="returns">After you sign in you go back to</span> <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
    <p><span data-t="only">Only this wallet can sign in:</span> <code>${escapeHtml(input.walletHint)}</code></p>
    <p class="warn" data-t="yours">Continue only if you started this connection yourself, from your own Claude, ChatGPT or Grok. If someone sent you this link, close it.</p>
    ${input.loopback ? '<p class="warn" data-t="local">The app asking runs on this computer. Any program here could claim to be it.</p>' : ""}
    <button id="sign" type="button" data-t="sign">Sign in with your wallet</button>
    <a id="deny" class="deny" href="#" data-t="deny">Cancel</a>
    <div id="status" class="status" role="status"></div>
  </div>
</main>
<script nonce="${nonce}">
const DATA = ${data};
const TEXT = {
  en: { missing: "The wallet connection did not load. Reload the page.", waiting: "Choose your wallet and sign…", wrong: "That wallet cannot sign in here.", failed: "Sign-in failed. Try again.", done: "Signed in. Going back…" },
  es: { yours: "Continúa solo si tú iniciaste esta conexión, desde tu propio Claude, ChatGPT o Grok. Si alguien te mandó este enlace, ciérralo.", local: "La app que pide acceso corre en este computador. Cualquier programa aquí podría hacerse pasar por ella.", title: "Conectar con AgentPey", asks: "quiere buscar, cotizar y pagar por ti en las tiendas de AgentPey, desde tu cuenta de gastos en Stellar testnet y dentro de sus límites.", returns: "Después de iniciar sesión vuelves a", only: "Solo esta wallet puede iniciar sesión:", sign: "Iniciar sesión con tu wallet", deny: "Cancelar", missing: "No se cargó la conexión con las wallets. Vuelve a cargar la página.", waiting: "Elige tu wallet y firma…", wrong: "Esa wallet no puede iniciar sesión aquí.", failed: "No se pudo iniciar sesión. Inténtalo de nuevo.", done: "Sesión iniciada. Volviendo…" },
};
const lang = (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
const t = (key) => (TEXT[lang] && TEXT[lang][key]) || TEXT.en[key] || key;
if (lang === "es") {
  document.documentElement.lang = "es";
  document.title = TEXT.es.title;
  for (const node of document.querySelectorAll("[data-t]")) if (TEXT.es[node.dataset.t]) node.textContent = TEXT.es[node.dataset.t];
}
const status = document.getElementById("status");
const say = (kind, key) => { status.className = "status " + kind; status.textContent = t(key); };
const sayText = (kind, text) => { status.className = "status " + kind; status.textContent = text; };

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error_description || json.error || "failed"), { code: json.error });
  return json;
}

document.getElementById("deny").addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const { redirect } = await post("/authorize/deny", { request: DATA.request });
    window.location.assign(redirect);
  } catch { say("error", "failed"); }
});

document.getElementById("sign").addEventListener("click", async () => {
  const button = document.getElementById("sign");
  if (typeof AgentpeyWallet === "undefined") { say("error", "missing"); return; }
  button.disabled = true;
  say("", "waiting");
  try {
    const account = (await AgentpeyWallet.connect()).address;
    const { message, challenge } = await post("/authorize/challenge", { request: DATA.request, account });
    const signature = (await AgentpeyWallet.signMessage(message, account)).signature;
    const { redirect } = await post("/authorize/approve", { request: DATA.request, account, challenge, signature });
    say("ok", "done");
    window.location.assign(redirect);
  } catch (error) {
    const walletSays = AgentpeyWallet.describe(error, lang);
    if (walletSays !== undefined) sayText("error", walletSays);
    else say("error", error && error.code === "access_denied" ? "wrong" : "failed");
    button.disabled = false;
  }
});
</script>
</body>
</html>`;
}
