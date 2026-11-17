/**
 * The report a store receives: what AI assistants say about it today, what is
 * in the way, what AgentPey would do in 90 days, and how it was measured. Plain
 * and printable (light theme, one column), built from the same data as the
 * panel. No sample or simulated numbers appear here.
 */
import type { Analysis } from "./entender.js";
import { openAiFeed } from "./feeds.js";
import type { Product, Store } from "./model.js";
import { esc } from "./panel.js";
import type { Policy } from "./politicas.js";
import type { Readiness } from "./readiness.js";

export interface ReportData {
  readonly store: Store;
  readonly products: readonly Product[];
  readonly readiness: Readiness;
  readonly analyses: readonly { productId: string; data: Analysis }[];
  readonly policy: Policy | undefined;
  readonly answers: readonly { engine: string; question: string; mentioned: boolean; cited: boolean; others: readonly string[]; at: string }[];
  readonly date: string;
}

const ENGINE: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini" };

export function report(d: ReportData, css: string): string {
  const s = d.store;
  const byId = new Map(d.products.map((p) => [p.id, p]));
  const engines = [...new Set(d.answers.map((a) => a.engine))];
  const questions = [...new Set(d.answers.map((a) => a.question))];
  const named = d.answers.filter((a) => a.mentioned).length;
  const read = d.answers.filter((a) => a.cited && !a.mentioned).length;
  const others = new Map<string, number>();
  for (const a of d.answers) for (const o of a.others.slice(0, 5)) others.set(o, (others.get(o) ?? 0) + 1);
  const top = [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const withContradiction = d.analyses.filter((a) => a.data.problemas.some((p) => p.tipo === "contradiccion"));
  const contradictions = d.analyses.flatMap((a) => a.data.problemas.filter((p) => p.tipo === "contradiccion").map((p) => ({ id: a.productId, t: p.detalle })));
  const avg = d.analyses.length === 0 ? undefined : d.analyses.reduce((a, x) => a + x.data.puntaje, 0) / d.analyses.length;
  const hidden = d.analyses.length === 0 ? 0 : d.analyses.reduce((a, x) => a + x.data.atributos_extraidos.length, 0) / d.analyses.length;
  const unanswered = d.analyses.flatMap((a) => a.data.preguntas_sin_respuesta).slice(0, 6);
  const feed = openAiFeed(s, d.products);
  const reasons = new Map<string, number>();
  for (const probs of feed.problems.values()) for (const p of probs) if (p.level === "rechazo") reasons.set(p.message, (reasons.get(p.message) ?? 0) + 1);
  const perEngine = engines.map((e) => {
    const xs = d.answers.filter((a) => a.engine === e);
    return `${ENGINE[e] ?? e}: ${xs.filter((a) => a.mentioned).length} de ${xs.length}`;
  });

  const days = [...new Set(d.answers.map((a) => a.at.slice(0, 10)))].sort();
  const dates = days.length === 0 ? "" : days.length === 1 ? `, el ${days[0]}` : `, entre el ${days[0]} y el ${days[days.length - 1]}`;
  const findings: string[] = [];
  if (d.answers.length > 0) {
    findings.push(`<b>Las IAs te recomiendan en ${named} de ${d.answers.length} respuestas</b> (${perEngine.join(" · ")}).${read > 0 ? ` En otras ${read}, la IA leyó tu sitio pero no te nombró: te ve, pero no te elige.` : ""}${top.length ? ` En tu lugar aparecen ${top.map(([h]) => esc(h)).join(", ")}.` : ""}`);
  }
  if (d.analyses.length > 0) {
    findings.push(`<b>${withContradiction.length} de ${d.analyses.length} fichas revisadas tienen datos que se contradicen</b>, y una IA no recomienda lo que no entiende. Por ejemplo, en “${esc(byId.get(contradictions[0]?.id ?? "")?.title ?? "")}”: ${esc((contradictions[0]?.t ?? "").slice(0, 260))}`);
    findings.push(`<b>Cada ficha tiene en promedio ${hidden.toFixed(0)} datos escondidos en el texto</b> (medidas, materiales, compatibilidad) que no están como dato estructurado. La IA los lee peor de lo que podría.`);
  }
  if (feed.rejected > 0) {
    findings.push(`<b>OpenAI rechazaría hoy ${feed.rejected.toLocaleString("es-CL")} de tus ${d.products.length.toLocaleString("es-CL")} productos.</b> Motivos: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${esc(m)} (${n.toLocaleString("es-CL")})`).join(", ")}.`);
  }
  if (d.policy !== undefined && d.policy.falta.length > 0) {
    findings.push(`<b>Tus páginas no dicen cosas que un comprador pregunta</b>: ${d.policy.falta.slice(0, 4).map(esc).join("; ")}. Si la IA no lo sabe, o lo inventa o te salta.`);
  }

  return `<!doctype html><html lang="es" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.name)} · cómo te ven las IAs · AgentPey</title>
<style>${css}
  html, body, body.ap { background: #fff !important; } .ap-main { max-width: 760px; min-height: 0 !important; background: #fff; }
  h1 { font-size: 2rem; } h2 { font-size: 1.2rem; margin-top: 8px; }
  .nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .nums div { background: var(--ap-bg); border-radius: 14px; padding: 14px; }
  .nums b { display: block; font-family: var(--ap-display); font-size: 1.8rem; }
  li { margin: 6px 0; } .small { font-size: .8rem; color: var(--ap-ink-2); }
  @media print { .ap-main { padding: 0; } a { color: inherit; } }
</style></head><body class="ap"><main class="ap-main ap-wrap ap-stack">
<span class="ap-eyebrow">AgentPey · informe para ${esc(s.name)} · ${esc(d.date)}</span>
<h1>Cómo te ven las IAs</h1>
<p>Cada vez más gente le pregunta a ChatGPT, Gemini o Claude dónde comprar antes de entrar a una tienda. Revisamos qué responden sobre ${esc(s.rubro)} en Chile y cómo leen tu catálogo.</p>
<div class="nums">
  <div><b>${d.answers.length === 0 ? "—" : `${named}/${d.answers.length}`}</b>respuestas de IA donde te recomiendan</div>
  <div><b>${avg === undefined ? "—" : `${avg.toFixed(1)}/10`}</b>qué tan bien entiende la IA tus fichas</div>
  <div><b>${d.readiness.score}/100</b>tu catálogo, listo para IA</div>
</div>
<h2>Lo que encontramos</h2>
<ol>${findings.map((f) => `<li>${f}</li>`).join("")}</ol>
${unanswered.length ? `<h2>Preguntas reales que tus fichas no responden</h2><ul>${unanswered.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
${questions.length ? `<h2>Las preguntas que hicimos</h2><ul class="small">${questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
<h2>Qué haríamos en 90 días</h2>
<ol>
  <li><b>Semanas 1–4: medir.</b> Instalamos la medición (una línea de código o acceso de lectura a Google Analytics) y dejamos la línea base: visitas y ventas que te traen hoy las IAs, y en cuántas respuestas apareces.</li>
  <li><b>Semanas 5–8: corregir.</b> Arreglamos con IA las fichas de la mitad de tu catálogo (tú apruebas cada cambio), publicamos tus políticas para que las IAs no prometan nada falso y dejamos tu catálogo en los formatos que leen ChatGPT, Gemini y los agentes de compra.</li>
  <li><b>Semanas 9–12: comparar.</b> La mitad corregida contra la mitad sin cambios: visibilidad en las IAs, visitas y ventas.</li>
</ol>
<p><b>Garantía:</b> si al final la mitad corregida no mejora su visibilidad en las IAs frente a la otra mitad, no pagas el plan de esos meses.</p>
<h2>Cómo lo medimos</h2>
<p class="small">Preguntas de compra escritas a partir de tu catálogo, sin nombrar tu tienda, hechas a ${engines.map((e) => ENGINE[e] ?? e).join(", ") || "las IAs"} con búsqueda en internet activada${dates}.${engines.includes("chatgpt") ? " ChatGPT se consultó a través de Codex, que usa los modelos de OpenAI pero no es la app de ChatGPT." : ""} Las respuestas de las IAs cambian de una vez a otra: es una muestra con fecha, no un ranking. La revisión de fichas es una muestra de ${d.analyses.length} productos. El catálogo y las políticas se leyeron desde tu sitio público; no tuvimos acceso a tu panel ni a tus ventas.</p>
<p class="small">AgentPey · agentpey.com · vicente@agentpey.com</p>
</main></body></html>`;
}
