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

export const engineName = (e: string) => (e === "chatgpt" ? "ChatGPT" : e === "claude" ? "Claude" : e);

/** The two or three most valuable fixes, in plain words: the catalogue's weakest checks first, then what the answers show. */
export function improvements(r: StoreResult): string[] {
  const out = r.weakest.filter((w) => w.pass < 0.8).map((w) => `${FIX[w.key] ?? w.label} Hoy lo cumple el ${Math.round(w.pass * 100)}% de tus productos.`);
  if (r.products === 0) out.unshift("Tu catálogo no se pudo leer de forma automática, y si un programa no lo lee, una IA tampoco. Hay que publicarlo en un formato que los asistentes entiendan (un feed de productos).");
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
  const readNote = run === undefined || run.count === 0
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
${r.example ? `<div style="font-size:13px;color:#444;background:#fafaf7;border-left:3px solid #c9c4b5;padding:8px 10px;margin-bottom:12px">Ejemplo: a la pregunta <i>“${esc(r.example.question.slice(0, 180))}”</i>, ${esc(engineName(r.example.engine))} recomendó ${r.example.instead.map(esc).join(", ")}.</div>` : ""}
<div style="font-size:14px;font-weight:700;margin:6px 0">Lo primero que arreglaría</div>
<ol style="margin:0 0 12px 18px;padding:0;font-size:13px;line-height:1.45">${fixes.map((f) => `<li style="margin-bottom:4px">${esc(f)}</li>`).join("") || "<li>Tu catálogo cumple lo básico; el siguiente paso es medirlo cada semana.</li>"}</ol>
<div style="font-size:11px;color:#888;line-height:1.4;border-top:1px solid #eee;padding-top:8px">${esc(readNote)} Muestra de ${r.answers} respuestas de IA (${esc(period)}). Las respuestas de la IA cambian de una vez a otra: esto es una muestra con fecha, no un ranking. AgentPey · vicente@agentpey.com</div>
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
  const score = r.score === undefined ? "" : ` Tu catálogo público saca ${r.score} de 100 en legibilidad para una IA${r.rubroAvgScore === undefined ? "" : ` (promedio de ${r.rubro}: ${r.rubroAvgScore})`}.`;
  return `PARA: ${to ? `${to.email}  (fuente: ${to.page})` : "(sin correo público de la tienda: no enviar)"}
ASUNTO: ${r.example ? `¿${engine} recomienda ${r.name}?` : `¿Las IAs recomiendan ${r.name}?`}
ESTADO: BORRADOR, no enviado. Vicente debe aprobar texto y lista.

Hola, equipo de ${r.name}:

${opening}${score}

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
  lines.push(`En total: ${totalMentioned} de ${totalAnswers} respuestas nombraron a la tienda por la que se preguntó (${totalAnswers ? Math.round((100 * totalMentioned) / totalAnswers) : 0}%).`, ``);
  const byEngine = new Map<string, { a: number; m: number }>();
  for (const r of diag) for (const [e, v] of Object.entries(r.byEngine)) { const x = byEngine.get(e) ?? { a: 0, m: 0 }; x.a += v.answers; x.m += v.mentioned; byEngine.set(e, x); }
  for (const [e, v] of byEngine) lines.push(`- ${e}: nombra a la tienda en ${v.m} de ${v.a} respuestas`);
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
    lines.push(`### ${rubro}`, ``, `${rs.length} tiendas · puntaje promedio ${avg ?? "sin datos"} · nombradas en ${men} de ${ans} respuestas · dominios que aparecen en su lugar: ${top || "—"}`, ``);
    lines.push(`| Tienda | Plataforma | Productos | Puntaje | Aparece |`, `|---|---|---|---|---|`);
    for (const r of [...rs].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) lines.push(`| ${r.name} | ${r.platform} | ${r.products} | ${r.score ?? "sin leer"} | ${r.answers ? `${r.mentioned}/${r.answers}` : "sin diagnóstico"} |`);
    lines.push(``);
    if (ans > 0 && men === 0) opp.push(`**${rubro}**: nadie del rubro aparece (0 de ${ans} respuestas). Territorio abierto.`);
    const big = [...compete.entries()].filter(([d]) => isBigMarket(d)).reduce((a, [, c]) => a + c, 0);
    const all = [...compete.values()].reduce((a, b) => a + b, 0);
    if (all >= 5 && big / all >= 0.5) opp.push(`**${rubro}**: ${Math.round((100 * big) / all)}% de lo que aparece en su lugar son grandes tiendas y marketplaces.`);
  }
  const good = diag.filter((r) => (r.score ?? 0) >= 70 && r.mentioned === 0);
  if (good.length > 0) opp.push(`Buen catálogo (70+) que igual no aparece: ${good.map((r) => `${r.name} (${r.score})`).join(", ")}.`);
  const bad = diag.filter((r) => r.score !== undefined && r.score < 50 && r.mentioned > 0);
  if (bad.length > 0) opp.push(`Catálogo flojo (<50) pero que sí aparece: ${bad.map((r) => `${r.name} (${r.score}, ${r.mentioned}/${r.answers})`).join(", ")}.`);
  const unread = results.filter((r) => r.products === 0);
  if (unread.length > 0) opp.push(`Catálogo ilegible para un robot (${unread.length}): ${unread.map((r) => r.name).join(", ")}.`);
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
  void runs;
  return lines.join("\n");
}
