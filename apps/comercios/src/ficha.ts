/**
 * The one-screen sheet per store (HTML with inline styles, safe for email
 * clients), the draft email, the by-rubro summary and the CSV index. Pure
 * functions: nothing is read or written here. Nothing is ever sent.
 *
 * Honesty rules: AI answers change from one run to the next, so everything is
 * shown as a dated sample, never as a ranking; a catalogue that could not be
 * read or an engine that did not answer is said so, not filled in.
 */
import type { StoreResult, Tienda } from "./base.js";
import { isBigMarket, mailableEmail } from "./base.js";

type Run = { at: string; method: string; count: number; notes: string[] } | undefined;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FIX: Record<string, string> = {
  precio: "Que cada producto muestre su precio en el código de la página, no solo en la imagen.",
  stock: "Indicar en cada producto si hay stock, para que la IA no recomiende algo agotado.",
  marca: "Poner la marca de cada producto: la IA busca por marca.",
  imagen: "Que todos los productos tengan al menos una imagen.",
  descripcion: "Escribir descripciones de más de 150 caracteres: qué es, para quién, qué incluye.",
  atributos: "Agregar datos concretos (medidas, material, compatibilidad, cantidad): es lo que la IA compara.",
  categoria: "Asignar una categoría a cada producto.",
  gtin: "Cargar el código de barras (GTIN/EAN) de cada producto: así la IA lo reconoce entre tiendas.",
  condicion: "Revisar los productos cuyo título y descripción se contradicen (nuevo/usado).",
  titulo: "Reescribir títulos de 20 a 150 caracteres, con marca, modelo y característica clave.",
};

/** Shortens at a word boundary, with an ellipsis. */
export const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, s.lastIndexOf(" ", max))}…`);

export const engineName = (e: string) => (e === "chatgpt" ? "ChatGPT" : e === "claude" ? "Claude" : e);

/** The two or three most valuable fixes, in plain words: the catalogue's weakest checks first, then what the answers show. */
export function improvements(r: StoreResult): string[] {
  const out = r.weakest.filter((w) => w.pass < 0.8).map((w) => `${FIX[w.key] ?? w.label} Hoy lo cumple el ${Math.round(w.pass * 100)}% de tus productos.`);
  if (r.products === 0) out.unshift("No encontramos en tu sitio datos de producto legibles por máquina (nombre, precio, stock). Los asistentes de IA usan esos datos para recomendar productos: hay que publicarlos (datos estructurados en cada ficha, o un feed de productos).");
  if (r.answers > 0 && r.mentioned < r.answers / 2) {
    if (r.sources.length > 0) out.push(`Estar en los sitios que la IA usó como fuente en tu rubro: ${r.sources.slice(0, 3).map((x) => x.domain).join(", ")}.`);
    out.push("Enviar tu catálogo a ChatGPT como feed de productos (OpenAI ya recibe feeds de tiendas) para que pueda mostrar tus productos con precio y stock.");
    out.push("Páginas de producto que respondan lo que pregunta el comprador (despacho a regiones, garantía, cuotas), que la IA pueda citar.");
  }
  if (r.brandOnly > 0) out.unshift(`La IA conoce tu marca, pero en ${r.brandOnly} respuestas mandó a comprarla a otro sitio: tu tienda propia necesita fichas de producto que la IA pueda leer y citar con precio, stock y despacho.`);
  if (out.length < 2) out.push("Medir esto cada semana: las respuestas cambian, y lo que no se mide no se puede mejorar.");
  return out.slice(0, 3);
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${a} de ${b}`);

function facts(r: StoreResult): { rubroLine: string; scoreLine: string; verdict: string } {
  const scoreLine = r.score === undefined ? "No pudimos leer el catálogo" : `${r.score} / 100`;
  const best = r.rubroBest === undefined ? "" : r.rubroBest.name === r.name ? " Tienes el mejor puntaje del rubro." : ` Mejor del rubro: ${r.rubroBest.name}, ${r.rubroBest.score}.`;
  const rubroLine = r.rubroAvgScore === undefined ? "Aún sin datos comparables en el rubro." : `Promedio de ${r.rubro} (${r.rubroScored} tiendas leídas): ${r.rubroAvgScore}.${best}`;
  const verdict = r.answers === 0 ? "No pudimos obtener respuestas de las IAs para esta tienda en esta muestra." : r.mentioned === 0 ? `La IA no recomendó tu sitio en ninguna de ${r.answers} respuestas.` : `La IA recomendó tu sitio en ${r.mentioned} de ${r.answers} respuestas.`;
  return { rubroLine, scoreLine, verdict };
}

export function fichaHtml(r: StoreResult, t: Tienda, run: Run, period: string): string {
  const { rubroLine, scoreLine, verdict } = facts(r);
  const instead = r.instead.slice(0, 5);
  const fixes = improvements(r);
  const engines = Object.entries(r.byEngine).map(([e, v]) => `${esc(engineName(e))}: ${v.mentioned} de ${v.answers}`).join(" · ");
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#666;font-size:13px">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:15px">${v}</td></tr>`;
  const readNote = run === undefined
    ? "No alcanzamos a leer tu catálogo público en esta muestra."
    : run.count === 0
    ? `No se pudo leer el catálogo público${run?.notes[0] ? ` (${esc(run.notes[0].slice(0, 120))})` : ""}.`
    : `Leímos ${run.count} productos de tu sitio el ${esc(run.at.slice(0, 10))}.`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.name)} · cómo te ven las IAs</title></head>
<body style="margin:0;background:#f4f4f1;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#fff;border-radius:12px;padding:20px">
<tr><td>
<div style="font-size:12px;color:#888;letter-spacing:.04em;text-transform:uppercase">${esc(r.rubro)} · ${esc(r.domain)}</div>
<div style="font-size:22px;font-weight:700;margin:4px 0 12px">${esc(r.name)}</div>
<div style="background:#f1efe9;border-radius:10px;padding:12px 14px;margin-bottom:12px">
<div style="font-size:12px;color:#666">Qué tan legible es tu catálogo para una IA</div>
<div style="font-size:30px;font-weight:800">${esc(scoreLine)}</div>
<div style="font-size:12px;color:#555">${esc(rubroLine)}</div>
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin-bottom:12px">
${row("Te recomiendan con tu sitio", esc(pct(r.mentioned, r.answers)) + " respuestas")}
${r.brandOnly > 0 ? row("Nombran tu marca, pero mandan a comprar a otro sitio", esc(pct(r.brandOnly, r.answers))) : ""}
${row("Usan tu sitio como fuente", esc(pct(r.cited, r.answers)))}
</table>
<div style="font-size:14px;margin-bottom:6px"><b>${esc(verdict)}</b>${engines ? ` <span style="color:#777;font-size:12px">(${engines})</span>` : ""}</div>
${instead.length > 0 ? `<div style="font-size:13px;color:#444;margin-bottom:12px">En tu lugar aparecieron: ${instead.map((i) => `${esc(i.domain)} (${i.count})`).join(", ")}.</div>` : ""}
${r.example ? `<div style="font-size:13px;color:#444;background:#fafaf7;border-left:3px solid #c9c4b5;padding:8px 10px;margin-bottom:12px">Ejemplo: a la pregunta <i>“${esc(cut(r.example.question, 220))}”</i>, ${esc(engineName(r.example.engine))} recomendó ${r.example.instead.map(esc).join(", ")}.</div>` : ""}
<div style="font-size:14px;font-weight:700;margin:6px 0">Lo primero que arreglaría</div>
<ol style="margin:0 0 12px 18px;padding:0;font-size:13px;line-height:1.45">${fixes.map((f) => `<li style="margin-bottom:4px">${esc(f)}</li>`).join("") || "<li>Tu catálogo cumple lo básico; el siguiente paso es medirlo cada semana.</li>"}</ol>
<div style="font-size:11px;color:#888;line-height:1.4;border-top:1px solid #eee;padding-top:8px">${esc(readNote)} Muestra de ${r.answers} respuestas de IA (${esc(period)}).${r.repeated > 0 ? ` Repetimos ${r.repeated} preguntas a otra hora: en ${r.changed} cambió el resultado.` : ""} Las respuestas de la IA cambian de una vez a otra: esto es una muestra con fecha, no un ranking. ChatGPT: modelo de OpenAI con búsqueda web (vía Codex), no la app; Claude: con búsqueda web. AgentPey · vicente@agentpey.com</div>
</td></tr></table></td></tr></table></body></html>`;
}

/** Draft only. The first line comes from this store's real sample; with none, it says so instead of inventing one. */
export function correoTexto(r: StoreResult, t: Tienda, period: string): string {
  const to = mailableEmail(t.emails, t.domain);
  const engine = r.example ? engineName(r.example.engine) : "ChatGPT";
  const opening = r.brandOnly > 0 && r.mentioned === 0 && r.brandExample
    ? `Le pregunté a ${engineName(r.brandExample.engine)}: "${r.brandExample.question}". Nombró ${r.name}, pero mandó a comprar a ${r.brandExample.instead.join(", ")}, no a ${r.domain}.`
    : r.example
    ? `Le hice a ${engine} esta pregunta de compra: "${r.example.question}". Recomendó ${r.example.instead.join(", ")}. ${r.name} no apareció.`
    : r.answers > 0 && r.mentioned > 0
      ? `Les hice preguntas de compra de ${r.rubro} a ChatGPT y a Claude: ${r.name} apareció en ${r.mentioned} de ${r.answers} respuestas.`
      : `Revisé cómo ven las IAs de compra (ChatGPT, Claude) a ${r.name}.`;
  const brand = r.brandOnly > 0 && !(r.mentioned === 0 && r.brandExample) ? ` En otras ${r.brandOnly} respuestas nombró tu marca, pero mandó a comprarla a otro sitio.` : "";
  const score = r.score === undefined ? "" : ` Tu catálogo público saca ${r.score} de 100 en legibilidad para una IA${r.rubroAvgScore === undefined ? "" : ` (promedio de ${r.rubro}: ${r.rubroAvgScore})`}.`;
  return `PARA: ${to ? `${to.email}  (fuente: ${to.page})` : "(sin correo público de la tienda: no enviar)"}
ASUNTO: ${r.example ? `¿${engine} recomienda ${r.name}?` : `¿Las IAs recomiendan ${r.name}?`}
ESTADO: BORRADOR, no enviado. Vicente debe aprobar texto y lista.

Hola, equipo de ${r.name}:

${opening}${brand}${score}

Armé una ficha de una pantalla con la comparación frente a tu rubro, quién aparece en tu lugar y las mejoras más importantes. Son respuestas de una muestra del ${period}; cambian de una vez a otra, así que no son un ranking.

Si quieres, te la envío o te preparo el diagnóstico completo, gratis. Solo responde "sí".

Vicente Wolde
AgentPey · agentpey.com · vicente@agentpey.com

Si no quieres recibir más correos míos, respóndeme "no" y no te escribo más.
`;
}

export function csvIndex(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function resumenMd(results: readonly StoreResult[], tiendas: readonly Tienda[], runs: ReadonlyMap<string, Run>, period: string): string {
  const lines: string[] = [];
  const read = results.filter((r) => r.score !== undefined);
  const diag = results.filter((r) => r.answers > 0);
  lines.push(`# Base de tiendas chilenas: resumen`, ``, `Muestra de respuestas de IA: ${period}. Son muestras con fecha, no un ranking: las respuestas cambian de una vez a otra.`, ``);
  lines.push(`- Tiendas pyme con dominio en la base: ${results.length}`, `- Con catálogo leído: ${read.length}`, `- Con diagnóstico: ${diag.length}`, `- Con correo público: ${tiendas.filter((t) => (t.emails?.length ?? 0) > 0).length}`, ``);
  const totalAnswers = diag.reduce((a, r) => a + r.answers, 0);
  const totalMentioned = diag.reduce((a, r) => a + r.mentioned, 0);
  lines.push(`En total: ${totalMentioned} de ${totalAnswers} respuestas recomendaron el sitio de la tienda por la que se preguntó (${totalAnswers ? Math.round((100 * totalMentioned) / totalAnswers) : 0}%).`, ``);
  const byEngine = new Map<string, { a: number; m: number }>();
  for (const r of diag) for (const [e, v] of Object.entries(r.byEngine)) { const x = byEngine.get(e) ?? { a: 0, m: 0 }; x.a += v.answers; x.m += v.mentioned; byEngine.set(e, x); }
  for (const [e, v] of byEngine) lines.push(`- ${engineName(e)}: recomienda el sitio de la tienda en ${v.m} de ${v.a} respuestas`);
  const brandOnly = diag.reduce((a, r) => a + r.brandOnly, 0);
  lines.push(`- Además, en ${brandOnly} respuestas la IA nombró la tienda o su marca pero mandó a comprar a otro sitio.`);
  const repeated = diag.reduce((a, r) => a + r.repeated, 0);
  const changed = diag.reduce((a, r) => a + r.changed, 0);
  if (repeated > 0) lines.push(`- Estabilidad: de ${repeated} preguntas hechas dos veces al mismo motor (a horas distintas), en ${changed} (${Math.round((100 * changed) / repeated)}%) cambió si la tienda aparecía o no.`);
  lines.push(``);
  const rubros = [...new Set(results.map((r) => r.rubro))].sort();
  lines.push(`## Por rubro`, ``);
  const opp: string[] = [];
  for (const rubro of rubros) {
    const rs = results.filter((r) => r.rubro === rubro);
    const scored = rs.filter((r) => r.score !== undefined);
    const avg = scored.length ? Math.round(scored.reduce((a, r) => a + r.score!, 0) / scored.length) : undefined;
    const ans = rs.reduce((a, r) => a + r.answers, 0);
    const men = rs.reduce((a, r) => a + r.mentioned, 0);
    const compete = new Map<string, number>();
    for (const r of rs) for (const i of r.instead) compete.set(i.domain, (compete.get(i.domain) ?? 0) + i.count);
    const top = [...compete.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, c]) => `${d} (${c})`).join(", ");
    lines.push(`### ${rubro}`, ``, `${rs.length} tiendas · puntaje promedio ${avg ?? "sin datos"} · recomendadas con su sitio en ${men} de ${ans} respuestas · dominios que aparecen en su lugar: ${top || "—"}`, ``);
    lines.push(`| Tienda | Plataforma | Productos | Puntaje | Aparece |`, `|---|---|---|---|---|`);
    for (const r of [...rs].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) lines.push(`| ${r.name} | ${r.platform} | ${r.products} | ${r.score ?? "sin leer"} | ${r.answers ? `${r.mentioned}/${r.answers}` : "sin diagnóstico"} |`);
    lines.push(``);
    if (ans >= 20 && men === 0) opp.push(`**${rubro}**: nadie del rubro aparece (0 de ${ans} respuestas). Territorio abierto.`);
    const big = [...compete.entries()].filter(([d]) => isBigMarket(d)).reduce((a, [, c]) => a + c, 0);
    const all = [...compete.values()].reduce((a, b) => a + b, 0);
    if (all >= 5 && big / all >= 0.5) opp.push(`**${rubro}**: ${Math.round((100 * big) / all)}% de lo que aparece en su lugar son grandes tiendas y marketplaces.`);
  }
  const good = diag.filter((r) => (r.score ?? 0) >= 70 && r.mentioned === 0);
  if (good.length > 0) opp.push(`Buen catálogo (70+) que igual no aparece: ${good.map((r) => `${r.name} (${r.score})`).join(", ")}.`);
  const bad = diag.filter((r) => r.score !== undefined && r.score < 50 && r.mentioned > 0);
  if (bad.length > 0) opp.push(`Catálogo flojo (<50) pero que sí aparece: ${bad.map((r) => `${r.name} (${r.score}, ${r.mentioned}/${r.answers})`).join(", ")}.`);
  const failedRead = results.filter((r) => r.products === 0 && runs.get(r.id) !== undefined);
  const notYet = results.filter((r) => runs.get(r.id) === undefined);
  if (failedRead.length > 0) opp.push(`Sin datos de producto legibles por máquina (${failedRead.length}): ${failedRead.map((r) => r.name).join(", ")}.`);
  if (notYet.length > 0) opp.push(`Catálogo aún no leído (${notYet.length}).`);
  const corr = diag.filter((r) => r.score !== undefined);
  if (corr.length >= 8) {
    const hi = corr.filter((r) => r.score! >= 60), lo = corr.filter((r) => r.score! < 60);
    const rate = (xs: StoreResult[]) => (xs.reduce((a, r) => a + r.answers, 0) ? Math.round((100 * xs.reduce((a, r) => a + r.mentioned, 0)) / xs.reduce((a, r) => a + r.answers, 0)) : 0);
    opp.push(`Puntaje y aparición: tiendas con 60+ aparecen en ${rate(hi)}% de sus respuestas (${hi.length} tiendas); con menos de 60, en ${rate(lo)}% (${lo.length} tiendas).`);
  }
  const plat = new Map<string, number>();
  for (const r of results) plat.set(r.platform, (plat.get(r.platform) ?? 0) + 1);
  lines.push(`## Patrones y oportunidades`, ``, ...opp.map((o) => `- ${o}`), ``, `## Plataformas`, ``, [...plat.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}: ${n}`).join(" · "), ``);
  const failed = results.filter((r) => r.failed > 0);
  if (failed.length > 0) lines.push(`## Preguntas que un motor no pudo responder`, ``, failed.map((r) => `${r.name}: ${r.failed}`).join(" · "), ``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The one-page A4 report: for a meeting, or as a PDF attachment. Same data as the sheet, more of it.

const BAR_COLORS = { own: "#d9480f", avg: "#9a948a", best: "#2b2a27" };

function bars(rows: readonly { label: string; value: number; max: number; text: string; color: string }[]): string {
  return rows.map((b) => `<div class="bar"><span class="bl">${esc(b.label)}</span><span class="bt"><span style="width:${Math.max(2, Math.round((100 * b.value) / (b.max || 1)))}%;background:${b.color}"></span></span><span class="bv">${esc(b.text)}</span></div>`).join("");
}

const passColor = (p: number) => (p >= 0.9 ? "#2f7d32" : p >= 0.6 ? "#b7791f" : "#c0392b");

export function informeHtml(r: StoreResult, t: Tienda, run: Run, period: string): string {
  const rate = (x: number | undefined) => (x === undefined ? "—" : `${Math.round(100 * x)}%`);
  const instead = r.instead.slice(0, 5);
  const maxInstead = instead[0]?.count ?? 1;
  const headline = r.answers === 0
    ? `Aún no tenemos respuestas de IA para ${r.name} en esta muestra.`
    : r.mentioned === 0
      ? `Hicimos ${r.answers} preguntas de compra de ${r.rubro.toLowerCase()} a la IA. Ninguna respuesta envió al comprador a ${r.domain}.`
      : `Hicimos ${r.answers} preguntas de compra de ${r.rubro.toLowerCase()} a la IA. ${r.mentioned} ${r.mentioned === 1 ? "respuesta envió" : "respuestas enviaron"} al comprador a ${r.domain}.`;
  const insteadLine = instead.length === 0 ? "" : ` En su lugar aparecieron ${instead.slice(0, 3).map((i) => i.domain).join(", ")}.`;
  const brandLine = r.brandOnly > 0 ? ` En ${r.brandOnly} la IA nombró tu marca, pero mandó a comprarla a otro sitio.` : "";
  const scorePanel = r.score === undefined
    ? `<p class="muted">${run === undefined ? "No alcanzamos a leer tu catálogo público." : `No encontramos datos de producto legibles por máquina en tu sitio${run.notes[0] ? ` (${esc(cut(run.notes[0], 110))})` : ""}.`} Sin esos datos, una IA tiene poco para recomendar tus productos.</p>`
    : bars([
      { label: r.name, value: r.score, max: 100, text: String(r.score), color: BAR_COLORS.own },
      ...(r.rubroAvgScore === undefined ? [] : [{ label: "Promedio del rubro", value: r.rubroAvgScore, max: 100, text: String(r.rubroAvgScore), color: BAR_COLORS.avg }]),
      ...(r.rubroBest === undefined || r.rubroBest.name === r.name ? [] : [{ label: `Mejor: ${r.rubroBest.name}`, value: r.rubroBest.score, max: 100, text: String(r.rubroBest.score), color: BAR_COLORS.best }]),
    ]) + `<p class="muted">${r.rubroRank === undefined ? "" : `Puesto ${r.rubroRank} de ${r.rubroScored} tiendas del rubro con catálogo leído. `}${run && run.count > 0 ? `Leímos ${run.count} productos el ${esc(run.at.slice(0, 10))}.` : ""}</p>`;
  const maxRate = Math.max(r.mentionRate ?? 0, r.rubroAvgMentionRate ?? 0, r.rubroBestRate?.rate ?? 0, 0.01);
  const recPanel = r.answers === 0 ? `<p class="muted">Sin respuestas en esta muestra.</p>` : bars([
    { label: r.name, value: r.mentionRate ?? 0, max: maxRate, text: `${r.mentioned} de ${r.answers}`, color: BAR_COLORS.own },
    ...(r.rubroAvgMentionRate === undefined ? [] : [{ label: "Promedio del rubro", value: r.rubroAvgMentionRate, max: maxRate, text: rate(r.rubroAvgMentionRate), color: BAR_COLORS.avg }]),
    ...(r.rubroBestRate === undefined || r.rubroBestRate.name === r.name ? [] : [{ label: `Mejor: ${r.rubroBestRate.name}`, value: r.rubroBestRate.rate, max: maxRate, text: rate(r.rubroBestRate.rate), color: BAR_COLORS.best }]),
  ]) + `<p class="muted">Respuestas que mandaron al comprador a tu sitio. ${Object.entries(r.byEngine).map(([e, v]) => `${engineName(e)}: ${v.mentioned} de ${v.answers}`).join(" · ")}</p>`;
  const checks = r.checks.filter((c) => c.notVisible !== true);
  const fixes = improvements(r);
  const ex = r.mentioned === 0 && r.brandExample ? r.brandExample : r.example;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(r.name)} · visibilidad en IA · AgentPey</title><style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;font:11.5px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1d1d1b;background:#fff}
.page{max-width:186mm;margin:0 auto}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1d1d1b;padding-bottom:6px;margin-bottom:10px}
.brand{font-weight:800;letter-spacing:.02em}.brand span{color:${BAR_COLORS.own}}.date{color:#777;font-size:10.5px;text-align:right}
h1{font-size:24px;margin:0;line-height:1.1}.sub{color:#666;font-size:11px;margin-top:2px}.lead{font-size:14px;line-height:1.4;margin:8px 0 12px;font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.box{border:1px solid #e3e0d8;border-radius:8px;padding:9px 11px}.box h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#666;margin:0 0 6px}
.big{font-size:30px;font-weight:800;line-height:1}.bar{display:grid;grid-template-columns:38% 1fr 52px;align-items:center;gap:6px;margin:3px 0}.bl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt{background:#f1efe9;border-radius:3px;height:10px;display:block}.bt span{display:block;height:10px;border-radius:3px}.bv{text-align:right;font-weight:600}.muted{color:#777;font-size:10.5px;margin:5px 0 0}
.quote{background:#faf8f3;border-left:3px solid ${BAR_COLORS.own};padding:7px 10px;margin:10px 0;font-size:11px}table{width:100%;border-collapse:collapse}td{padding:2.5px 0;border-bottom:1px solid #f0eee8}
td.p{width:46px;text-align:right;font-weight:600}ol{margin:4px 0 0 16px;padding:0}li{margin-bottom:4px}.cta{background:#1d1d1b;color:#fff;border-radius:8px;padding:10px 12px;margin-top:10px;display:flex;justify-content:space-between;gap:12px;align-items:center}
.cta b{font-size:13px}.cta a{color:#fff}footer{color:#888;font-size:9.5px;margin-top:8px;line-height:1.35}
</style></head><body><div class="page">
<header><div><div class="brand">Agent<span>Pey</span> · Visibilidad en asistentes de IA</div></div><div class="date">Muestra del ${esc(period)}<br>${esc(r.domain)}</div></header>
<h1>${esc(r.name)}</h1><div class="sub">${esc(r.rubro)} · ${esc(r.platform)}</div>
<p class="lead">${esc(headline + insteadLine + brandLine)}</p>
<div class="grid">
<div class="box"><h2>Tu catálogo, legible para una IA</h2><div class="big">${r.score === undefined ? "—" : `${r.score}<span style="font-size:14px;color:#888"> / 100</span>`}</div>${scorePanel}</div>
<div class="box"><h2>¿La IA te recomienda?</h2><div class="big">${r.answers === 0 ? "—" : `${r.mentioned}<span style="font-size:14px;color:#888"> de ${r.answers}</span>`}</div>${recPanel}</div>
</div>
${ex ? `<div class="quote"><b>Una respuesta real.</b> Pregunta: “${esc(cut(ex.question, 230))}” ${esc(engineName(ex.engine))} recomendó: ${ex.instead.map(esc).join(", ")}.</div>` : ""}
<div class="grid">
<div class="box"><h2>Quién aparece en tu lugar</h2>${instead.length === 0 ? `<p class="muted">Sin datos en esta muestra.</p>` : bars(instead.map((x) => ({ label: x.domain, value: x.count, max: maxInstead, text: `${x.count} resp.`, color: BAR_COLORS.avg })))}${r.sources.length > 0 ? `<p class="muted">Sitios que la IA usó como fuente: ${r.sources.slice(0, 4).map((x) => esc(x.domain)).join(", ")}.</p>` : ""}</div>
<div class="box"><h2>Tu catálogo, punto por punto</h2>${checks.length === 0 ? `<p class="muted">Sin catálogo leído.</p>` : `<table>${checks.map((c) => `<tr><td>${esc(c.label)}</td><td class="p" style="color:${passColor(c.pass)}">${Math.round(100 * c.pass)}%</td></tr>`).join("")}</table><p class="muted">% de tus productos que cumple cada punto.</p>`}</div>
</div>
<div class="box" style="margin-top:10px"><h2>Lo primero que arreglaría</h2><ol>${fixes.map((f) => `<li>${esc(f)}</li>`).join("")}</ol></div>
<div class="cta"><div><b>¿Lo revisamos juntos en 15 minutos?</b><br>Te mostramos las respuestas completas, medimos cada semana y corregimos el catálogo contigo.</div><div style="text-align:right;white-space:nowrap">Vicente Wolde<br><a href="mailto:vicente@agentpey.com">vicente@agentpey.com</a><br>agentpey.com</div></div>
<footer>Cómo lo medimos: preguntas de compra que haría un comprador chileno de este rubro, hechas a asistentes de IA con búsqueda web (${Object.keys(r.byEngine).map(engineName).join(" y ") || "—"}) el ${esc(period)}. "Te recomienda" = la respuesta escribe tu dominio o enlaza una página de tu sitio. El puntaje del catálogo revisa tus productos públicos en 10 puntos. Las respuestas de la IA cambian de una vez a otra: es una muestra con fecha, no un ranking.${r.repeated > 0 ? ` Repetimos ${r.repeated} preguntas a otra hora: en ${r.changed} cambió el resultado.` : ""} Datos públicos de tu sitio; no usamos información privada.</footer>
</div></body></html>`;
}
