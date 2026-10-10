import { AgentPassError } from "@agentpass/core";

/**
 * The page of `pnpm run arbiter:console` (T155, `R-34`): the arbiter's four
 * steps in the look of agentpey.com, in Spanish, with no terminal in sight.
 *
 * Every value that comes from a command is set with `textContent`, never as
 * HTML, and the page talks only to the server that served it.
 */

const LOGO =
  '<svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><g fill="none" stroke="#171A1F" stroke-width="60"><path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g><path d="M378 112l54 54" fill="none" stroke="#176BFF" stroke-width="60"/></svg>';

const STYLE = `
  :root { color-scheme: light; --paper:#fbfaf8; --paper-2:#f2f0ea; --ink:#0f1211; --ink-2:#434946; --ink-3:#7d8481; --rule:#e3e0d9;
    --accent:#0a7a56; --accent-soft:#e3f3ec; --bad:#b3261e; --bad-soft:#fbeceb; --warn:#9a5b00; --warn-soft:#fbf0dc;
    --serif:"Instrument Serif", ui-serif, Georgia, "Times New Roman", serif; --sans:"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans); font-size:16px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { width:100%; max-width:860px; margin:0 auto; padding:0 clamp(16px,4vw,40px); }
  a { color:var(--accent); }
  .top { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px 20px; padding:22px 0 0; }
  .brand { display:inline-flex; align-items:center; gap:9px; color:var(--ink); font-size:15.5px; font-weight:600; }
  .brand .logo { width:24px; height:24px; }
  .utils { display:flex; align-items:center; gap:8px 18px; font-size:13px; }
  .utils a { color:var(--ink-3); text-decoration:none; } .utils a:hover { color:var(--ink); }
  .pill { font-size:11.5px; font-weight:500; letter-spacing:.1em; text-transform:uppercase; background:var(--warn-soft); color:var(--warn); border-radius:999px; padding:2px 10px; }
  .hero { padding:clamp(24px,4vw,40px) 0 6px; }
  .eyebrow { font-size:11.5px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); margin:0; display:flex; align-items:center; gap:8px; }
  .eyebrow i { width:8px; height:8px; border-radius:50%; background:var(--accent); }
  h1 { font-family:var(--serif); font-weight:400; font-size:clamp(2.2rem,6vw,3.4rem); line-height:1.06; letter-spacing:-.016em; margin:14px 0 0; }
  .sub { margin:14px 0 0; color:var(--ink-2); max-width:62ch; }
  .steps { display:grid; gap:14px; margin:26px 0 48px; }
  .step { background:#fff; border:1px solid var(--rule); border-radius:12px; padding:18px 20px; }
  .step.locked { opacity:.55; }
  .step h2 { margin:0; font-size:17px; font-weight:600; display:flex; align-items:center; gap:12px; }
  .num { flex:none; width:28px; height:28px; border-radius:50%; display:grid; place-items:center; font-size:14px; font-weight:600; background:var(--paper-2); color:var(--ink-2); }
  .step.done .num { background:var(--accent); color:#fff; }
  .hint { margin:8px 0 14px 40px; color:var(--ink-2); font-size:14.5px; }
  .body { margin-left:40px; }
  textarea, input[type=text] { width:100%; font:13px/1.4 var(--mono); border:1px solid var(--rule); border-radius:8px; padding:10px 12px; background:var(--paper); color:var(--ink); }
  textarea { min-height:96px; resize:vertical; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:12px; }
  button, .btn { font:600 14.5px var(--sans); border:0; border-radius:9px; padding:10px 16px; background:var(--ink); color:#fff; cursor:pointer; text-decoration:none; display:inline-block; }
  button.secondary, .btn.secondary { background:#fff; color:var(--ink); border:1px solid var(--rule); }
  button:disabled { background:var(--rule); color:var(--ink-3); cursor:not-allowed; }
  .status { font-size:14px; color:var(--ink-2); }
  .status.err { color:var(--bad); font-weight:500; }
  .out { margin-top:16px; border-top:1px solid var(--rule); padding-top:14px; }
  .out h3 { margin:14px 0 6px; font-size:12px; font-weight:500; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
  .out h3:first-child { margin-top:0; }
  .kv { display:grid; grid-template-columns:minmax(90px,150px) 1fr; gap:4px 14px; font-size:14px; margin:0; }
  .kv dt { color:var(--ink-3); } .kv dd { margin:0; font-family:var(--mono); font-size:12.5px; overflow-wrap:anywhere; }
  .check { display:flex; gap:10px; align-items:baseline; font-size:14px; margin:4px 0; }
  .tick { flex:none; width:20px; height:20px; border-radius:50%; display:inline-grid; place-items:center; font-size:12px; font-weight:700; color:#fff; background:var(--accent); }
  .check.bad .tick { background:var(--bad); }
  .check b { font-weight:600; } .check span.v { color:var(--ink-2); overflow-wrap:anywhere; }
  .text { font-size:14.5px; margin:6px 0; color:var(--ink-2); }
  .verdict { background:var(--accent-soft); border:1px solid color-mix(in srgb, var(--accent) 35%, var(--rule)); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .verdict .big { font-family:var(--serif); font-size:1.9rem; line-height:1.1; }
  .verdict .refund { color:var(--ink-2); font-size:14px; margin-top:4px; }
  .reason p { margin:8px 0; font-size:15px; }
  .hash { font-family:var(--mono); font-size:12.5px; background:var(--paper-2); border-radius:8px; padding:8px 10px; overflow-wrap:anywhere; }
  .links { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:12px; font-size:13.5px; }
  details { margin-top:12px; font-size:13px; color:var(--ink-3); } details pre { white-space:pre-wrap; font:12px/1.4 var(--mono); }
  footer { padding:22px 0 40px; border-top:1px solid var(--rule); font-size:12.5px; color:var(--ink-3); }
`;

const SCRIPT = `
(function () {
  var KEY = document.querySelector('meta[name="console-key"]').getAttribute('content');
  var state = { verdictHash: null };
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function safeUrl(v) { try { var u = new URL(v); return u.protocol === 'https:' ? u.href : null; } catch (e) { return null; } }

  function call(path, body) {
    return fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-console-key': KEY }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, message: 'No pude hablar con la consola. ¿Sigue abierta la ventana donde la iniciaste?' }; });
  }

  function renderSections(into, sections) {
    sections.forEach(function (s) {
      if (s.heading) into.appendChild(el('h3', '', s.heading.replace(/^\\[(.+?)\\] /, '$1: ')));
      var kv = null;
      s.rows.forEach(function (r) {
        if (r.tone !== 'plain') {
          kv = null;
          var c = el('div', 'check' + (r.tone === 'bad' ? ' bad' : ''));
          c.appendChild(el('span', 'tick', r.tone === 'bad' ? '\\u2715' : '\\u2713'));
          c.appendChild(el('b', '', r.label));
          c.appendChild(el('span', 'v', r.value));
          into.appendChild(c);
        } else if (r.label) {
          if (!kv) { kv = el('dl', 'kv'); into.appendChild(kv); }
          kv.appendChild(el('dt', '', r.label));
          var dd = el('dd'); var u = safeUrl(r.value);
          if (u) { var a = el('a', '', 'Ver en Stellar \\u2197'); a.href = u; a.target = '_blank'; a.rel = 'noopener'; dd.appendChild(a); } else { dd.textContent = r.value; }
          kv.appendChild(dd);
        } else { kv = null; into.appendChild(el('p', 'text', r.value)); }
      });
    });
  }

  function links(into, items) {
    var box = el('div', 'links');
    items.forEach(function (i) { if (!i.href) return; var a = el('a', '', i.text); a.href = i.href; a.target = '_blank'; a.rel = 'noopener'; box.appendChild(a); });
    if (box.childNodes.length) into.appendChild(box);
  }

  function setStatus(id, text, err) { var s = $(id); s.textContent = text; s.className = 'status' + (err ? ' err' : ''); }
  function detail(into, text) { if (!text) return; var d = el('details'); d.appendChild(el('summary', '', 'Lo que dijo el sistema')); d.appendChild(el('pre', '', text)); into.appendChild(d); }
  function unlock(n) { var s = $('step' + n); s.classList.remove('locked'); }
  function finish(n) { $('step' + n).classList.add('done'); }

  function run(button, statusId, waiting, work) {
    button.disabled = true; setStatus(statusId, waiting, false);
    return work().then(function () { button.disabled = false; });
  }

  // 1 · the claim
  $('open').addEventListener('click', function () {
    var b = $('open'); var out = $('out1'); out.replaceChildren();
    run(b, 'st1', 'El árbitro está revisando el recibo y abriendo la disputa en la red (15 a 30 s)...', function () {
      return call('/api/open', { claim: $('claim').value }).then(function (r) {
        if (!r.ok) { setStatus('st1', r.message || 'No se pudo abrir la disputa.', true); var o = el('div', 'out'); if (r.sections) renderSections(o, r.sections); detail(o, r.detail); out.appendChild(o); return; }
        setStatus('st1', 'Disputa abierta en Stellar.', false); finish(1); unlock(2);
        var o2 = el('div', 'out'); renderSections(o2, r.sections); links(o2, [{ href: r.explorerUrl, text: 'Ver la transacción en Stellar \\u2197' }, { href: 'https://agentpey.com/en-vivo', text: 'Verla en vivo \\u2197' }]); out.appendChild(o2);
      });
    });
  });

  // 2 · the merchant's answer
  function sendResponse(payload) {
    var b1 = $('latest'); var out = $('out2'); out.replaceChildren(); b1.disabled = true;
    setStatus('st2', 'Revisando la firma de la tienda...', false);
    return call('/api/response', payload).then(function (r) {
      b1.disabled = false;
      if (!r.ok) { setStatus('st2', r.message || 'No se pudo leer la respuesta.', true); var o = el('div', 'out'); if (r.sections) renderSections(o, r.sections); detail(o, r.detail); out.appendChild(o); return; }
      setStatus('st2', 'Respuesta de la tienda verificada.', false); finish(2); unlock(3);
      var o2 = el('div', 'out'); renderSections(o2, r.sections); out.appendChild(o2);
    });
  }
  $('latest').addEventListener('click', function () { sendResponse({ useLatest: true }); });
  $('file').addEventListener('change', function () {
    var f = $('file').files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { sendResponse({ text: String(reader.result) }); };
    reader.readAsText(f);
  });

  // 3 · the verdict
  $('decide').addEventListener('click', function () {
    var b = $('decide'); var out = $('out3'); out.replaceChildren();
    run(b, 'st3', 'El árbitro de IA está leyendo el reclamo y la respuesta de la tienda (30 a 90 s)...', function () {
      return call('/api/decide', {}).then(function (r) {
        if (!r.ok) { setStatus('st3', r.message || 'El árbitro no pudo decidir.', true); var o = el('div', 'out'); detail(o, r.detail); out.appendChild(o); return; }
        setStatus('st3', 'El árbitro propuso un veredicto. Todavía no se pagó nada.', false); finish(3); unlock(4);
        state.verdictHash = r.verdict.hash;
        var o2 = el('div', 'out'); var v = el('div', 'verdict');
        v.appendChild(el('div', 'big', r.verdict.label)); v.appendChild(el('div', 'refund', 'Reembolso: ' + r.verdict.refund)); o2.appendChild(v);
        o2.appendChild(el('h3', '', 'Razonamiento del árbitro')); var rs = el('div', 'reason');
        r.verdict.reasoning.split('\\n\\n').forEach(function (p) { rs.appendChild(el('p', '', p)); }); o2.appendChild(rs);
        o2.appendChild(el('h3', '', 'Hash del veredicto')); var h = el('div', 'hash', r.verdict.hash); o2.appendChild(h);
        var row = el('div', 'row'); var cp = el('button', 'secondary', 'Copiar el hash'); cp.type = 'button';
        cp.addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(r.verdict.hash).then(function () { cp.textContent = 'Copiado'; }); });
        row.appendChild(cp); o2.appendChild(row); out.appendChild(o2);
      });
    });
  });

  // 4 · confirm and pay
  $('typed').addEventListener('input', function () { $('pay').disabled = !(state.verdictHash && $('typed').value.trim() === state.verdictHash); });
  $('pay').addEventListener('click', function () {
    var b = $('pay'); var out = $('out4'); out.replaceChildren();
    run(b, 'st4', 'El contrato está devolviendo el dinero (15 a 30 s)...', function () {
      return call('/api/execute', { hash: $('typed').value.trim() }).then(function (r) {
        if (!r.ok) { setStatus('st4', r.message || 'No se pudo pagar.', true); var o = el('div', 'out'); detail(o, r.detail); out.appendChild(o); b.disabled = false; return; }
        setStatus('st4', 'Reembolso pagado. La disputa quedó resuelta en Stellar.', false); finish(4); b.disabled = true;
        var o2 = el('div', 'out'); renderSections(o2, r.sections);
        if (r.verified) { o2.appendChild(el('h3', '', 'Comprobación en la red')); renderSections(o2, r.verified); }
        links(o2, [{ href: r.explorerUrl, text: 'Ver el reembolso en Stellar \\u2197' }, { href: 'https://agentpey.com/en-vivo', text: 'Verlo en vivo \\u2197' }]); out.appendChild(o2);
      });
    });
  });
})();
`;

export function renderConsolePage(key: string): string {
  if (!/^[0-9a-f]{32,}$/.test(key)) throw new AgentPassError("ConfigError", "the console key must be hexadecimal");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="console-key" content="${key}">
<title>AgentPey · pantalla del árbitro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <span class="brand">${LOGO}<span>AgentPey</span></span>
    <div class="utils"><span class="pill">Pantalla del árbitro · solo en este computador</span><a href="https://agentpey.com/en-vivo" target="_blank" rel="noopener">En vivo ↗</a></div>
  </div>
  <header class="hero">
    <p class="eyebrow"><i aria-hidden="true"></i>Stellar testnet · AgentResolve</p>
    <h1>Una disputa, paso a paso.</h1>
    <p class="sub">El árbitro revisa el reclamo, deja que la tienda responda, pide un veredicto y, con tu confirmación, el contrato devuelve el dinero. Nada se paga sin que confirmes el veredicto.</p>
  </header>

  <div class="steps">
    <section class="step" id="step1">
      <h2><span class="num">1</span>El reclamo del comprador</h2>
      <p class="hint">Pega lo que te dio Claude: el texto largo que empieza con <code>eyJ</code>. El árbitro comprueba que el recibo sea válido, que quien reclama sea quien pagó y que esté a tiempo.</p>
      <div class="body">
        <textarea id="claim" spellcheck="false" placeholder="eyJhbGciOiJFZERTQSIs..."></textarea>
        <div class="row"><button id="open" type="button">Abrir la disputa</button><span class="status" id="st1"></span></div>
        <div id="out1"></div>
      </div>
    </section>

    <section class="step locked" id="step2">
      <h2><span class="num">2</span>La respuesta de la tienda</h2>
      <p class="hint">La tienda lee el reclamo en su página, firma con su wallet y descarga un archivo. El árbitro lo recibe aquí y comprueba la firma.</p>
      <div class="body">
        <div class="row">
          <a class="btn secondary" href="https://agentpey.com/resolve/responder" target="_blank" rel="noopener">Abrir la página de la tienda ↗</a>
          <button id="latest" type="button" class="secondary">Usar la última descarga</button>
          <label class="status">o elige el archivo: <input id="file" type="file" accept=".json,application/json"></label>
        </div>
        <div class="row"><span class="status" id="st2"></span></div>
        <div id="out2"></div>
      </div>
    </section>

    <section class="step locked" id="step3">
      <h2><span class="num">3</span>El veredicto</h2>
      <p class="hint">Un árbitro de IA lee el reclamo, el recibo y la respuesta de la tienda, y propone una decisión con sus razones. No mueve dinero.</p>
      <div class="body">
        <div class="row"><button id="decide" type="button">Pedir el veredicto</button><span class="status" id="st3"></span></div>
        <div id="out3"></div>
      </div>
    </section>

    <section class="step locked" id="step4">
      <h2><span class="num">4</span>Confirmar y pagar</h2>
      <p class="hint">Una persona confirma el veredicto escribiendo su hash. Recién entonces el contrato devuelve el dinero desde la garantía de la tienda.</p>
      <div class="body">
        <input id="typed" type="text" spellcheck="false" autocomplete="off" placeholder="Escribe o pega aquí el hash del veredicto">
        <div class="row"><button id="pay" type="button" disabled>Confirmar y pagar el reembolso</button><span class="status" id="st4"></span></div>
        <div id="out4"></div>
      </div>
    </section>
  </div>
  <footer>Stellar testnet. USDC de prueba, no dinero real. Esta pantalla corre en tu computador y usa la llave del árbitro que está en tu <code>.env.local</code>.</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}
