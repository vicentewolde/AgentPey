/**
 * The store's panel: one server-rendered page with the six modules. Everything
 * that is simulated or sample data says so on the page.
 */
import type { Analysis } from "./entender.js";
import { openAiFeed } from "./feeds.js";
import type { Summary } from "./medir.js";
import type { Product, Store } from "./model.js";
import type { Policy } from "./politicas.js";
import type { PromoteRow } from "./promover.js";
import type { Readiness } from "./readiness.js";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clp = (n: number | undefined) => (n === undefined ? "—" : `$${Math.round(n).toLocaleString("es-CL")}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function page(title: string, body: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="es" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/brand/agentpey.css">
<style>
  .k { font-family: var(--ap-display); font-size: clamp(2rem, 5vw, 3rem); font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
  .bar { height: 8px; border-radius: 99px; background: var(--ap-hair); overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--ap-accent); }
  .tag { display: inline-block; font-size: .75rem; font-weight: 600; padding: 2px 10px; border-radius: 99px; background: var(--ap-accent-soft); color: var(--ap-link); }
  .tag.warn { background: #3a2a10; color: #ffb547; }
  .tag.ok { background: var(--ap-ok-soft); color: var(--ap-ok); }
  .tag.bad { background: var(--ap-bad-soft); color: var(--ap-bad); }
  .demo { border: 1px dashed #ffb547; border-radius: var(--ap-radius-sm); padding: 10px 14px; color: #ffb547; font-size: .9rem; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--ap-hair); vertical-align: top; }
  th { color: var(--ap-ink-2); font-weight: 600; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--ap-surface-2); padding: 12px; border-radius: var(--ap-radius-sm); font-size: .78rem; max-height: 220px; overflow: auto; }
  .yes { color: var(--ap-ok); font-weight: 600; } .no { color: var(--ap-ink-2); }
  details summary { cursor: pointer; font-weight: 600; }
  .before { color: var(--ap-ink-2); text-decoration: line-through; }
</style>
${extraHead}
</head>
<body class="ap"><main class="ap-main ap-wrap">${body}</main></body></html>`;
}

export interface PanelData {
  readonly store: Store;
  readonly products: readonly Product[];
  readonly readiness: Readiness;
  readonly analyses: readonly { productId: string; data: Analysis }[];
  readonly policy: { data: Policy; pages: readonly string[]; status: string } | undefined;
  readonly answers: readonly { engine: string; question: string; mentioned: boolean; cited: boolean; others: readonly string[] }[];
  readonly measure: Summary;
  readonly promote: readonly PromoteRow[];
  readonly snippetUrl: string;
  readonly mcpUrl: string;
}

const SOURCE_NAME: Record<string, string> = {
  chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude", copilot: "Copilot", meta: "Meta AI", otra_ia: "Otra IA", agentpey: "Agentes (AgentPey)", sin_ia: "Sin IA",
};

export function panel(d: PanelData): string {
  const s = d.store;
  const byId = new Map(d.products.map((p) => [p.id, p]));
  const engines = [...new Set(d.answers.map((a) => a.engine))];
  const appear = d.answers.filter((a) => a.mentioned).length;
  const listingAvg = d.analyses.length === 0 ? undefined : d.analyses.reduce((a, x) => a + x.data.puntaje, 0) / d.analyses.length;
  const others = new Map<string, number>();
  for (const a of d.answers) for (const o of a.others.slice(0, 5)) others.set(o, (others.get(o) ?? 0) + 1);
  const topOthers = [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const contradictions = d.analyses.flatMap((a) => a.data.problemas.filter((p) => p.tipo === "contradiccion").map((p) => ({ id: a.productId, detalle: p.detalle })));
  const example = [...d.analyses].sort((a, b) => a.data.puntaje - b.data.puntaje)[0];
  const feed = openAiFeed(s, d.products);

  const header = `
<section class="ap-stack">
  <div class="ap-row"><span class="ap-eyebrow">AgentPey · panel del comercio</span>
    ${s.source === "piloto" ? `<span class="tag ok">Piloto</span>` : `<span class="tag warn">Diagnóstico con datos públicos</span>`}</div>
  <h1>${esc(s.name)}</h1>
  <p class="ap-muted">${esc(s.rubro)} · ${esc(s.platform)} · <a href="${esc(s.origin)}">${esc(s.origin.replace(/^https?:\/\//, ""))}</a> · ${d.products.length.toLocaleString("es-CL")} productos leídos</p>
</section>`;

  const kpis = `
<section class="ap-grid">
  <div class="ap-card"><div class="ap-eyebrow">Te recomiendan las IAs</div><div class="k">${d.answers.length === 0 ? "—" : `${appear}/${d.answers.length}`}</div><p class="ap-muted">respuestas donde apareces${engines.length ? ` · ${engines.map((e) => SOURCE_NAME[e] ?? e).join(", ")}` : ""}</p></div>
  <div class="ap-card"><div class="ap-eyebrow">La IA entiende tus fichas</div><div class="k">${listingAvg === undefined ? "—" : `${listingAvg.toFixed(1)}/10`}</div><p class="ap-muted">${d.analyses.length} fichas revisadas con IA</p></div>
  <div class="ap-card"><div class="ap-eyebrow">Catálogo listo para IA</div><div class="k">${d.readiness.score}/100</div><p class="ap-muted">${feed.rejected.toLocaleString("es-CL")} productos que OpenAI rechazaría hoy</p></div>
  <div class="ap-card"><div class="ap-eyebrow">Ventas desde IA${d.measure.demo ? " · prueba" : ""}</div><div class="k">${clp(d.measure.ia.ventas)}</div><p class="ap-muted">${pct(d.measure.ia.shareVentas)} de tus ventas · ${d.measure.ia.visitas.toLocaleString("es-CL")} visitas</p></div>
</section>`;

  const diag = `
<section class="ap-card ap-stack">
  <div class="ap-eyebrow">1 · Aparecer</div><h2>¿Te recomiendan las IAs?</h2>
  ${d.answers.length === 0 ? `<p class="ap-muted">Todavía sin diagnóstico.</p>` : `
  <p>Preguntas de compra reales, hechas sin nombrar tu tienda, con búsqueda en internet activada. Apareces en <b>${appear} de ${d.answers.length}</b> respuestas; tu sitio está entre las fuentes en <b>${d.answers.filter((a) => a.cited).length}</b>.</p>
  ${topOthers.length ? `<p class="ap-muted">En tu lugar aparecen: ${topOthers.map(([h, c]) => `${esc(h)} (${c})`).join(", ")}</p>` : ""}
  <table><thead><tr><th>Pregunta</th>${engines.map((e) => `<th>${esc(SOURCE_NAME[e] ?? e)}</th>`).join("")}</tr></thead><tbody>
  ${[...new Set(d.answers.map((a) => a.question))].map((q) => `<tr><td>${esc(q)}</td>${engines.map((e) => {
    const a = d.answers.find((x) => x.question === q && x.engine === e);
    return `<td>${a === undefined ? "·" : a.mentioned ? `<span class="yes">Te nombra</span>` : a.cited ? `<span class="tag">Te leyó, no te nombra</span>` : `<span class="no">No apareces</span>`}</td>`;
  }).join("")}</tr>`).join("")}
  </tbody></table>
  <p class="ap-small ap-muted">Las respuestas de las IAs cambian de una vez a otra: esto es una muestra con fecha, no un ranking.</p>`}
</section>`;

  const entender = `
<section class="ap-card ap-stack">
  <div class="ap-eyebrow">2 · Entender</div><h2>¿La IA entiende tu catálogo?</h2>
  <table><tbody>${d.readiness.checks.map((c) => `<tr><td>${esc(c.label)}</td><td style="width:40%"><div class="bar"><i style="width:${pct(c.pass)}"></i></div></td><td>${pct(c.pass)}</td></tr>`).join("")}</tbody></table>
  ${contradictions.length ? `<details open><summary>${contradictions.length} contradicciones en ${d.analyses.length} fichas revisadas</summary><ul>${contradictions.slice(0, 6).map((c) => `<li><b>${esc(byId.get(c.id)?.title ?? c.id)}</b>: ${esc(c.detalle)}</li>`).join("")}</ul></details>` : ""}
  ${example ? `<details><summary>Ejemplo: cómo queda una ficha (propuesta, tú apruebas)</summary>
    <p class="before">${esc(byId.get(example.productId)?.title ?? "")}</p><p><b>${esc(example.data.titulo_propuesto)}</b></p>
    <p>${esc(example.data.descripcion_propuesta)}</p>
    <p class="ap-muted">Lo que un comprador pregunta y la ficha no responde:</p><ul>${example.data.preguntas_sin_respuesta.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
    ${example.data.por_confirmar.length ? `<p class="ap-muted">Para que confirmes tú: ${example.data.por_confirmar.map((x) => esc(x.nombre)).join(", ")}</p>` : ""}
  </details>` : ""}
  <p class="ap-small"><a href="/feeds/${esc(s.id)}.jsonl">Feed para OpenAI</a> · <a href="/feeds/${esc(s.id)}/llms.txt">llms.txt</a></p>
</section>`;

  const pol = d.policy?.data;
  const politicas = `
<section class="ap-card ap-stack">
  <div class="ap-eyebrow">3 · Políticas</div><h2>Lo que la IA puede prometer por ti</h2>
  ${pol === undefined ? `<p class="ap-muted">Sin políticas leídas todavía.</p>` : `
  <p><span class="tag warn">Propuesta: falta tu aprobación</span></p>
  <dl class="ap-dl">
    <dt>Despacho</dt><dd>${esc(pol.despacho.cobertura || "No lo dice")}${pol.despacho.costo ? ` · ${esc(pol.despacho.costo)}` : ""}</dd>
    <dt>Plazos</dt><dd>${pol.despacho.plazos.map((p) => `${esc(p.zona)}: ${esc(p.plazo)}`).join("<br>") || "No lo dice"}</dd>
    <dt>Cambios y devoluciones</dt><dd>${esc(pol.cambios_y_devoluciones.acepta === "si" ? `Sí${pol.cambios_y_devoluciones.plazo_dias ? `, ${pol.cambios_y_devoluciones.plazo_dias} días` : ""}` : pol.cambios_y_devoluciones.acepta === "no" ? "No" : "No lo dice")}. ${esc(pol.cambios_y_devoluciones.condiciones)}</dd>
    <dt>Garantía</dt><dd>${esc(pol.garantia || "No lo dice")}</dd>
    <dt>Pago</dt><dd>${esc(pol.medios_de_pago.join(", ") || "No lo dice")}${pol.cuotas ? ` · ${esc(pol.cuotas)}` : ""}</dd>
  </dl>
  ${pol.falta.length ? `<p class="ap-muted">Lo que un comprador pregunta y tus páginas no dicen:</p><ul>${pol.falta.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
  <p class="ap-small ap-muted">${pol.citas.length} datos, cada uno con su cita textual de: ${d.policy!.pages.map((u) => esc(u.replace(/^https?:\/\/[^/]+/, "") || "/")).join(", ")}</p>`}
</section>`;

  const m = d.measure;
  const medir = `
<section class="ap-card ap-stack">
  <div class="ap-eyebrow">4 · Medir</div><h2>Visitas y ventas que te traen las IAs</h2>
  ${m.demo ? `<div class="demo">Datos de prueba: así se verá tu panel cuando instales el script o conectes Google Analytics. No son tus datos reales.</div>` : ""}
  <table><thead><tr><th>Origen</th><th>Visitas</th><th>Compras</th><th>Ventas</th><th>Conversión</th></tr></thead><tbody>
  ${m.rows.map((r) => `<tr><td>${esc(SOURCE_NAME[r.source] ?? r.source)}</td><td>${r.visitas.toLocaleString("es-CL")}</td><td>${r.compras}</td><td>${clp(r.ventas)}</td><td>${(r.conversion * 100).toFixed(1)}%</td></tr>`).join("") || `<tr><td colspan="5" class="ap-muted">Sin datos todavía.</td></tr>`}
  </tbody></table>
  <p><b>Grupo de control</b> (garantía de 90 días): ventas desde IA de la mitad optimizada ${clp(m.grupos.optimizada.ventas)} contra ${clp(m.grupos.control.ventas)} de la mitad sin cambios.</p>
  <details><summary>Instalar la medición en tu tienda</summary><p>Pega esta línea en el tema de tu tienda. No usa cookies ni datos personales.</p>
  <pre>&lt;script async src="${esc(d.snippetUrl)}"&gt;&lt;/script&gt;</pre><p class="ap-muted ap-small">O danos acceso de lectura a Google Analytics y lo leemos de ahí. Muchas visitas desde IA llegan sin origen; estas cifras son un piso.</p></details>
</section>`;

  const promover = `
<section class="ap-card ap-stack">
  <div class="ap-eyebrow">5 · Promover</div><h2>Qué productos impulsar primero</h2>
  <div class="demo">Simulación: los avisos dentro de las IAs todavía no existen en Chile. Este ranking usa stock, calidad de la ficha, precio y lo que la gente pregunta.</div>
  <table><thead><tr><th>Producto</th><th>Precio</th><th>Por qué</th></tr></thead><tbody>
  ${d.promote.map((r) => `<tr><td><a href="${esc(r.product.url)}">${esc(r.product.title)}</a></td><td>${clp(r.product.price)}</td><td class="ap-muted">${esc(r.reasons.join(" · ") || "buen candidato")}</td></tr>`).join("")}
  </tbody></table>
</section>`;

  const agentes = `
<section class="ap-card ap-stack">
  <div class="ap-eyebrow">6 · Vender por agentes · prototipo</div><h2>Tu catálogo, disponible para agentes de compra</h2>
  ${s.source === "piloto" ? `<p>Un agente (Claude, ChatGPT u otro con MCP) se conecta a <code>${esc(d.mcpUrl)}</code>, busca en tu catálogo y le entrega al comprador un enlace que pasa por AgentPey: la visita y la compra quedan atribuidas a este canal.</p>` : `<p class="ap-muted">Disponible para tiendas del piloto.</p>`}
  <p><a class="ap-btn" href="/tienda/${esc(s.id)}/vendedor">Probar el vendedor con IA de ${esc(s.name)}</a></p>
</section>`;

  return page(`${s.name} · AgentPey`, header + kpis + diag + entender + politicas + medir + promover + agentes);
}

export function sellerPage(store: Store): string {
  const body = `
<section class="ap-stack">
  <div class="ap-row"><span class="ap-eyebrow">AgentPey · vendedor con IA · demo</span><span class="tag warn">Página de prueba</span></div>
  <h1>Pregúntale a ${esc(store.name)}</h1>
  <p class="ap-muted">Responde solo con productos de ${esc(store.name)} y con sus políticas. Si no sabe algo, lo dice.</p>
</section>
<section class="ap-card ap-stack" id="chat" aria-live="polite"></section>
<form class="ap-row" id="f"><input class="ap-field" id="q" style="flex:1;min-width:0" placeholder="Ej: busco un rascador de 130 cm, hasta 50 mil, con despacho a regiones" autocomplete="off"><button class="ap-btn">Preguntar</button></form>
<p><a href="/tienda/${esc(store.id)}">← Volver al panel</a></p>
<script>
const chat = document.getElementById("chat"), f = document.getElementById("f"), q = document.getElementById("q");
const history = [];
function add(role, html) { const d = document.createElement("div"); d.className = "ap-stack"; d.innerHTML = '<div class="ap-eyebrow">' + (role === "cliente" ? "Tú" : ${JSON.stringify(esc(store.name))}) + '</div>' + html; chat.appendChild(d); d.scrollIntoView({ behavior: "smooth", block: "end" }); return d; }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
f.addEventListener("submit", async (e) => {
  e.preventDefault(); const text = q.value.trim(); if (!text) return; q.value = "";
  add("cliente", "<p>" + esc(text) + "</p>"); const wait = add("vendedor", '<p class="ap-muted">Buscando en el catálogo…</p>');
  try {
    const r = await fetch("/api/vender/${esc(store.id)}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pregunta: text, historial: history }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "error");
    let html = "<p>" + esc(d.respuesta) + "</p>";
    for (const p of d.productos) html += '<div class="ap-card" style="padding:14px"><b>' + esc(p.titulo) + '</b> · ' + esc(p.precio) + '<br><span class="ap-muted">' + esc(p.por_que) + '</span><br><a href="' + esc(p.enlace) + '" target="_blank" rel="noopener">Ver en la tienda →</a></div>';
    if (d.no_se.length) html += '<p class="ap-small ap-muted">No tengo información sobre: ' + d.no_se.map(esc).join("; ") + "</p>";
    wait.innerHTML = '<div class="ap-eyebrow">${esc(store.name)}</div>' + html;
    history.push({ role: "cliente", text }, { role: "vendedor", text: d.respuesta });
  } catch (err) { wait.innerHTML = '<p class="ap-muted">No pude responder ahora. Intenta de nuevo.</p>'; }
});
</script>`;
  return page(`Vendedor IA · ${store.name}`, body);
}

export function indexPage(rows: readonly { store: Store; products: number; score: number; appear: string }[]): string {
  const body = `
<section class="ap-stack"><span class="ap-eyebrow">AgentPey · comercios</span><h1>Tiendas en la demo</h1>
<p class="ap-muted">Piloto: aceptaron participar. Diagnóstico: tiendas de Black Friday 2026, solo con datos públicos.</p></section>
<section class="ap-card"><table><thead><tr><th>Tienda</th><th>Tipo</th><th>Productos</th><th>Catálogo listo</th><th>Aparece en IAs</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="/tienda/${esc(r.store.id)}">${esc(r.store.name)}</a></td><td>${r.store.source === "piloto" ? "Piloto" : "Diagnóstico"}</td><td>${r.products.toLocaleString("es-CL")}</td><td>${r.score}/100</td><td>${esc(r.appear)}</td></tr>`).join("")}
</tbody></table></section>`;
  return page("Comercios · AgentPey", body);
}
