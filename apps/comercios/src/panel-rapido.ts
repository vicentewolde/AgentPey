/**
 * Pages of the public quick diagnosis: the form ("pon tu URL"), the wait while
 * it runs, and the result, which has its own link so it can be sent by email.
 */
import { esc, page } from "./panel.js";
import type { QuickResult } from "./rapido.js";

const ENGINE: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };
const engineName = (e: string) => ENGINE[e] ?? e;
const CONTACT = "vicente@agentpey.com";

export function quickFormPage(engines: readonly string[]): string {
  const names = engines.map(engineName);
  const body = `
<section class="ap-stack">
  <span class="ap-eyebrow">AgentPey · diagnóstico gratis</span>
  <h1>¿La IA recomienda tu tienda?</h1>
  <p class="ap-muted">Cada vez más gente le pregunta a una IA dónde comprar. Escribe tu tienda y lo que vendes: le hacemos a ${esc(names.join(", "))} tres preguntas de compra reales, sin nombrar tu tienda, y te mostramos si apareces y quién aparece en tu lugar. También revisamos si tu catálogo está listo para que una IA lo entienda.</p>
</section>
<form class="ap-card ap-stack" id="f">
  <label class="ap-stack"><b>Dirección de tu tienda</b><input class="ap-field" name="url" placeholder="mitienda.cl" required autocomplete="url" inputmode="url"></label>
  <label class="ap-stack"><b>¿Qué vendes?</b><input class="ap-field" name="rubro" placeholder="Ej: alimento y accesorios para mascotas" required maxlength="120"></label>
  <label class="ap-stack"><b>Tu correo <span class="ap-muted">(opcional)</span></b><input class="ap-field" name="email" type="email" placeholder="tu@tienda.cl" maxlength="200" autocomplete="email">
  <span class="ap-small ap-muted">Solo para mandarte el resultado y, si quieres, el diagnóstico completo. No lo compartimos.</span></label>
  <button class="ap-btn" id="b">Ver mi diagnóstico</button>
  <p class="ap-small ap-muted" id="msg" aria-live="polite">Tarda de 1 a 3 minutos. Leemos solo páginas públicas de tu tienda.</p>
</form>
<p class="ap-small ap-muted">Las respuestas de las IAs cambian de una vez a otra: esto es una muestra con fecha, no un ranking. <a href="/">Ver tiendas de ejemplo</a></p>
<script>
const f = document.getElementById("f"), b = document.getElementById("b"), msg = document.getElementById("msg");
f.addEventListener("submit", async (e) => {
  e.preventDefault(); b.disabled = true; msg.textContent = "Empezando…";
  try {
    const r = await fetch("/api/diagnostico", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(f))) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "No se pudo empezar");
    location.href = "/diagnostico/" + d.id;
  } catch (err) { msg.textContent = err.message; b.disabled = false; }
});
</script>`;
  return page("Diagnóstico gratis · AgentPey", body);
}

export function quickWaitPage(id: string, step: string): string {
  const body = `
<section class="ap-stack"><span class="ap-eyebrow">AgentPey · diagnóstico gratis</span><h1>Preguntándole a las IAs…</h1>
<p class="ap-muted" id="s">${esc(step)}</p><div class="bar"><i id="p" style="width:10%"></i></div>
<p class="ap-small ap-muted">Tarda de 1 a 3 minutos. Puedes dejar esta página abierta; se actualiza sola.</p></section>
<script>
let n = 0;
async function tick() {
  n++; document.getElementById("p").style.width = Math.min(95, 10 + n * 4) + "%";
  try {
    const r = await fetch("/api/diagnostico/${esc(id)}"); const d = await r.json();
    if (d.estado === "listo" || d.estado === "error") return location.reload();
    if (d.paso) document.getElementById("s").textContent = d.paso;
  } catch {}
  setTimeout(tick, 4000);
}
setTimeout(tick, 3000);
</script>`;
  return page("Diagnóstico en curso · AgentPey", body);
}

export function quickErrorPage(message: string): string {
  return page("Diagnóstico · AgentPey", `<section class="ap-stack"><span class="ap-eyebrow">AgentPey · diagnóstico gratis</span><h1>No pudimos terminar el diagnóstico</h1>
<p class="ap-muted">${esc(message)}</p><p><a href="/diagnostico">Intentar de nuevo</a> · o escríbenos a <a href="mailto:${CONTACT}">${CONTACT}</a></p></section>`);
}

export function quickResultPage(r: QuickResult): string {
  const answered = r.questions.flatMap((q) => q.answers).filter((a) => a.error === undefined);
  const named = answered.filter((a) => a.mentioned).length;
  const cited = answered.filter((a) => a.cited).length;
  const date = new Date(r.at).toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Santiago" });
  const cell = (a: QuickResult["questions"][number]["answers"][number]) =>
    a.error !== undefined ? `<span class="ap-muted">No respondió</span>`
      : a.mentioned ? `<span class="yes">Te nombra</span>`
        : a.cited ? `<span class="tag warn">Usa tu sitio, sin nombrarte</span>`
          : `<span class="no">No apareces</span>`;
  const missing = ["chatgpt", "gemini"].filter((e) => !r.engines.includes(e)).map(engineName);
  const verdict = answered.length === 0 ? "Las IAs no respondieron esta vez."
    : named === 0 ? `No apareces en ninguna de las ${answered.length} respuestas.`
      : `Apareces en ${named} de ${answered.length} respuestas.`;
  const subject = encodeURIComponent(`Diagnóstico completo para ${r.domain}`);
  const mailBody = encodeURIComponent(`Hola Vicente, vi el diagnóstico gratis de ${r.domain} y quiero el completo.`);
  const body = `
<section class="ap-stack">
  <span class="ap-eyebrow">AgentPey · diagnóstico gratis · ${esc(date)}</span>
  <h1>¿La IA recomienda ${esc(r.name)}?</h1>
  <p class="ap-muted">${esc(r.domain)} · ${esc(r.rubro)}</p>
</section>
<section class="ap-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
  <div class="ap-card"><div class="ap-eyebrow">Te recomiendan las IAs</div><div class="k">${named}/${answered.length}</div><p class="ap-muted">${esc(verdict)}${cited > named ? ` En ${cited - named} más usaron tu sitio como fuente, pero no te nombraron.` : ""}</p></div>
  <div class="ap-card"><div class="ap-eyebrow">Catálogo listo para IA</div><div class="k">${r.score === undefined ? "—" : `${r.score}/100`}</div><p class="ap-muted">${r.products > 0 ? `${r.products} productos leídos de tu sitio` : "No pudimos leer tu catálogo desde afuera. Eso también le pasa a las IAs."}</p></div>
</section>
${r.instead.length > 0 ? `<section class="ap-card ap-stack"><h2>En tu lugar aparecen</h2><p>${r.instead.map((o) => `<b>${esc(o.domain)}</b> (${o.count})`).join(" · ")}</p><p class="ap-small ap-muted">Sitios que las IAs usaron como fuente al responder.</p></section>` : ""}
<section class="ap-card ap-stack"><h2>Las preguntas</h2>
<p class="ap-muted">Preguntas de compra que haría un cliente, sin nombrar tu tienda, con búsqueda en internet activada.</p>
<div class="ap-table-wrap"><table><thead><tr><th>Pregunta</th>${r.engines.map((e) => `<th>${esc(engineName(e))}</th>`).join("")}</tr></thead><tbody>
${r.questions.map((q) => `<tr><td>${esc(q.question)}</td>${q.answers.map((a) => `<td>${cell(a)}</td>`).join("")}</tr>`).join("")}
</tbody></table></div>
${missing.length > 0 ? `<p class="ap-small ap-muted">Este diagnóstico rápido consultó ${esc(r.engines.map(engineName).join(", "))}. ${esc(missing.join(" y "))} van en el diagnóstico completo.</p>` : ""}
</section>
${r.checks.length > 0 ? `<section class="ap-card ap-stack"><h2>¿La IA entiende tu catálogo?</h2>
<table><tbody>${r.checks.map((c) => `<tr><td>${esc(c.label)}</td><td style="width:40%"><div class="bar"><i style="width:${Math.round(c.pass * 100)}%"></i></div></td><td>${Math.round(c.pass * 100)}%</td></tr>`).join("")}</tbody></table>
<p class="ap-small ap-muted">Porcentaje de productos que cumplen cada punto, en los ${r.products} que leímos.</p></section>` : ""}
<section class="ap-card ap-stack"><h2>¿Y ahora?</h2>
<p>El diagnóstico completo hace 24 preguntas en ChatGPT, Gemini y Claude, revisa tus fichas una por una con IA y te dice qué corregir para que te recomienden. Después medimos las visitas y ventas que te llegan desde la IA.</p>
<p><a class="ap-btn" href="mailto:${CONTACT}?subject=${subject}&body=${mailBody}">Quiero el diagnóstico completo</a></p>
<p class="ap-small ap-muted">Las respuestas de las IAs cambian de una vez a otra: esto es una muestra con fecha, no un ranking ni una promesa. <a href="/diagnostico">Hacer otro diagnóstico</a></p>
</section>`;
  return page(`¿La IA recomienda ${r.name}? · AgentPey`, body);
}
