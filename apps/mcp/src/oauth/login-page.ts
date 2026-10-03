/**
 * The page a person sees when Claude or ChatGPT asks to connect to AgentPey's
 * MCP server (`R-7`): sign a message with the wallet that owns the spending
 * account, and only that wallet gets in. English by default, neutral Latin
 * American Spanish when the browser asks for it.
 *
 * Freighter's script is pinned by version and by integrity hash, so a
 * compromised CDN cannot swap the code that asks for the signature.
 */
export const FREIGHTER_SCRIPT = {
  src: "https://unpkg.com/@stellar/freighter-api@6.0.1/build/index.min.js",
  integrity: "sha384-PBwq0JVfqy16Z6jvKJPx93jpStXbwF2oWvsRTODkvE/3hOX5zmLvAuMiKgAaxe2b",
} as const;

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
<style>
  :root { --bg: #f7f7f5; --fg: #17171a; --muted: #5d5d66; --card: #ffffff; --line: #e3e3de; --accent: #2d5bff; --ok: #1d7a46; --err: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111114; --fg: #f1f1f3; --muted: #a2a2ad; --card: #1b1b20; --line: #2c2c33; --accent: #7a9bff; --ok: #5fd08f; --err: #ff8b80; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 460px; margin: 48px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 8px 0; color: var(--muted); }
  strong { color: var(--fg); }
  button { width: 100%; margin-top: 16px; padding: 12px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .deny { display: block; margin-top: 12px; text-align: center; color: var(--muted); }
  .status { min-height: 24px; margin-top: 12px; }
  .status.ok { color: var(--ok); }
  .status.error { color: var(--err); }
  .warn { color: var(--fg); border-left: 3px solid var(--err); padding-left: 10px; }
  code { word-break: break-all; }
</style>
<script src="${FREIGHTER_SCRIPT.src}" integrity="${FREIGHTER_SCRIPT.integrity}" crossorigin="anonymous"></script>
</head>
<body>
<main>
  <div class="card">
    <h1 data-t="title">Connect to AgentPey</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> <span data-t="asks">wants to search, quote and pay in AgentPey stores for you, from your spending account on Stellar testnet, within its limits.</span></p>
    <p><span data-t="returns">After you sign in you go back to</span> <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
    <p><span data-t="only">Only this wallet can sign in:</span> <code>${escapeHtml(input.walletHint)}</code></p>
    <p class="warn" data-t="yours">Continue only if you started this connection yourself, from your own Claude or ChatGPT. If someone sent you this link, close it.</p>
    ${input.loopback ? '<p class="warn" data-t="local">The app asking runs on this computer. Any program here could claim to be it.</p>' : ""}
    <button id="sign" type="button" data-t="sign">Sign in with Freighter</button>
    <a id="deny" class="deny" href="#" data-t="deny">Cancel</a>
    <div id="status" class="status" role="status"></div>
  </div>
</main>
<script nonce="${nonce}">
const DATA = ${data};
const TEXT = {
  en: { missing: "Freighter is not installed in this browser.", waiting: "Waiting for Freighter…", wrong: "That wallet cannot sign in here.", failed: "Sign-in failed. Try again.", done: "Signed in. Going back…" },
  es: { yours: "Continúa solo si tú iniciaste esta conexión, desde tu propio Claude o ChatGPT. Si alguien te mandó este enlace, ciérralo.", local: "La app que pide acceso corre en este computador. Cualquier programa aquí podría hacerse pasar por ella.", title: "Conectar con AgentPey", asks: "quiere buscar, cotizar y pagar por ti en las tiendas de AgentPey, desde tu cuenta de gastos en Stellar testnet y dentro de sus límites.", returns: "Después de iniciar sesión vuelves a", only: "Solo esta wallet puede iniciar sesión:", sign: "Iniciar sesión con Freighter", deny: "Cancelar", missing: "Freighter no está instalado en este navegador.", waiting: "Esperando a Freighter…", wrong: "Esa wallet no puede iniciar sesión aquí.", failed: "No se pudo iniciar sesión. Inténtalo de nuevo.", done: "Sesión iniciada. Volviendo…" },
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

function toBase64Signature(signed) {
  if (typeof signed === "string") return signed;
  if (signed === null || typeof signed !== "object") return "";
  let values;
  if (signed instanceof ArrayBuffer) values = new Uint8Array(signed);
  else if (ArrayBuffer.isView(signed)) values = new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength);
  else if (Array.isArray(signed.data)) values = signed.data;
  else values = Object.values(signed);
  if (!values.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return "";
  let binary = "";
  for (const byte of values) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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
  if (typeof freighterApi === "undefined") { say("error", "missing"); return; }
  button.disabled = true;
  say("", "waiting");
  try {
    const access = await freighterApi.requestAccess();
    if (access && access.error) throw new Error(access.error);
    const account = access.address || access;
    const { message, challenge } = await post("/authorize/challenge", { request: DATA.request, account });
    const signed = await freighterApi.signMessage(message, { address: account });
    if (signed && signed.error) throw new Error(signed.error);
    const signature = toBase64Signature(signed && signed.signedMessage !== undefined ? signed.signedMessage : signed);
    const { redirect } = await post("/authorize/approve", { request: DATA.request, account, challenge, signature });
    say("ok", "done");
    window.location.assign(redirect);
  } catch (error) {
    say("error", error && error.code === "access_denied" ? "wrong" : "failed");
    button.disabled = false;
  }
});
</script>
</body>
</html>`;
}
