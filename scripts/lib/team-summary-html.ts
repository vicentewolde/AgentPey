/**
 * The team's month as a page (T153): `pnpm run team:summary -- --html` writes
 * it next to the vault and opens it. Pure: it takes what `summarizeMonth` and
 * the rail reads already computed and returns HTML, so it is tested without a
 * network or a browser. Local on purpose: the team's vault is local.
 *
 * Every value that comes from the vault or the network is escaped; the only
 * links are to Stellar Expert, built from hashes checked to be hex. A payment
 * the vault counted but never anchored to a transaction (`M-15`: a failed
 * payment is not released) is shown as such, never as paid on Stellar.
 */
import { fromUnits, toUnits, type MonthSummary } from "./team-summary.js";

export interface RailReading {
  readonly contractId: string;
  readonly perTx: string;
  readonly perDay: string;
  readonly spentToday: string;
}

export interface SummaryPageInput {
  readonly month: string;
  readonly summary: MonthSummary;
  readonly teamPerTx: string;
  readonly teamPerDay: string;
  readonly records: number;
  /** `null` when the rail could not be read from the network. */
  readonly rail: RailReading | null;
  /** Why the rail could not be read, shown when `rail` is `null`. */
  readonly railError?: string;
  readonly generatedAt: Date;
}

export interface DayRow {
  readonly day: string;
  readonly spent: string;
  readonly payments: number;
  readonly refusals: number;
  /** Spent over the team's daily budget, in percent. Above 100 only if the vault holds more than the budget let through. */
  readonly percent: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A seven-decimal amount for reading: trailing zeros off, at least two decimals ("0.6000000" reads "0.60"). */
export function displayAmount(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function hasTx(hash: string | null): hash is string {
  return hash !== null && HEX64.test(hash);
}

function txLink(hash: string | null): string {
  if (!hasTx(hash)) return `<span class="muted">${tr("no anchored transaction", "sin transacción anclada")}</span>`;
  return `<a href="https://stellar.expert/explorer/testnet/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 8)}…${hash.slice(-4)}</a>`;
}

/** Each UTC day with a payment or a refusal: what was spent against the team's daily budget. */
export function dayRows(summary: MonthSummary, teamPerDay: string): DayRow[] {
  const days = new Map<string, { spent: bigint; payments: number; refusals: number }>();
  const at = (day: string) => {
    const row = days.get(day) ?? { spent: 0n, payments: 0, refusals: 0 };
    days.set(day, row);
    return row;
  };
  for (const p of summary.payments) {
    if (p.released) continue;
    const row = at(p.at.slice(0, 10));
    row.spent += toUnits(p.amount);
    row.payments += 1;
  }
  for (const r of summary.refusals) at(r.at.slice(0, 10)).refusals += 1;
  const cap = toUnits(teamPerDay);
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, row]) => ({
      day,
      spent: fromUnits(row.spent),
      payments: row.payments,
      refusals: row.refusals,
      percent: cap === 0n ? 0 : Number((row.spent * 10_000n) / cap) / 100,
    }));
}

function tr(en: string, es: string): string {
  return `<span data-tr="en">${en}</span><span data-tr="es">${es}</span>`;
}

export function renderSummaryHtml(input: SummaryPageInput): string {
  const { summary } = input;
  const settled = summary.payments.filter((p) => !p.released);
  const onChain = settled.filter((p) => hasTx(p.paymentTx));
  const unanchored = settled.length - onChain.length;
  const released = summary.payments.length - settled.length;
  const days = dayRows(summary, input.teamPerDay);
  const e = escapeHtml;

  const dayHtml =
    days.length === 0
      ? `<p class="muted">${tr("No spending this month.", "Sin gastos este mes.")}</p>`
      : days
          .map(
            (d) => `
      <div class="day">
        <div class="day-head"><b>${e(d.day)}</b><span title="${e(d.spent)} USDC">${e(displayAmount(d.spent))} / ${e(input.teamPerDay)} USDC</span></div>
        <div class="bar" role="img" aria-label="${e(d.spent)} of ${e(input.teamPerDay)} USDC"><div class="fill${d.percent > 100 ? " over" : d.percent === 100 ? " full" : ""}" style="width:${Math.min(100, d.percent).toFixed(2)}%"></div></div>
        <div class="day-foot">${d.payments} ${tr(d.payments === 1 ? "payment" : "payments", d.payments === 1 ? "pago" : "pagos")}${
          d.refusals > 0 ? ` · <span class="refused">${d.refusals} ${tr("refused", d.refusals === 1 ? "rechazada" : "rechazadas")}</span>` : ""
        }${d.percent > 100 ? ` · <span class="refused">${tr("over the budget", "sobre el presupuesto")}</span>` : ""}</div>
      </div>`,
          )
          .join("");

  const paymentRows =
    settled.length === 0
      ? `<tr><td colspan="3" class="muted">${tr("None this month.", "Ninguno este mes.")}</td></tr>`
      : settled
          .map((p) => `<tr><td>${e(p.at.slice(0, 16).replace("T", " "))} UTC</td><td class="num" title="${e(p.amount)}">${e(displayAmount(p.amount))} ${e(p.currency)}</td><td>${txLink(p.paymentTx)}</td></tr>`)
          .join("");

  const refusalRows =
    summary.refusals.length === 0
      ? `<tr><td colspan="2" class="muted">${tr("None this month.", "Ninguno este mes.")}</td></tr>`
      : summary.refusals
          .map((r) => `<tr class="refusal"><td>${e(r.at.slice(0, 16).replace("T", " "))} UTC</td><td><code>${e(r.code)}</code> ${e(r.reason)}</td></tr>`)
          .join("");

  const rail =
    input.rail === null
      ? `<p class="muted">${tr("The rail could not be read from the network right now.", "No se pudo leer el rail de la red ahora.")}${
          input.railError === undefined ? "" : ` <code>${e(input.railError)}</code>`
        }</p>`
      : `<dl class="kv">
        <dt>${tr("Contract", "Contrato")}</dt><dd><a href="https://stellar.expert/explorer/testnet/contract/${e(input.rail.contractId)}" target="_blank" rel="noopener">${e(input.rail.contractId.slice(0, 8))}…${e(input.rail.contractId.slice(-6))}</a></dd>
        <dt>${tr("Per payment", "Por pago")}</dt><dd>${e(input.rail.perTx)} USDC</dd>
        <dt>${tr("Per day", "Por día")}</dt><dd>${e(input.rail.perDay)} USDC</dd>
        <dt>${tr("Spent today by the rail", "Gastado hoy por el rail")}</dt><dd>${e(input.rail.spentToday)} USDC</dd>
      </dl>
      <p class="muted">${tr(
        "Read from the contract itself. The rail also pays other purchases, so its day can be above the team's.",
        "Leído del contrato mismo. El rail paga también otras compras, así que su día puede superar al del equipo.",
      )}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPey · team budget · ${e(input.month)}</title>
<style>
  :root { --paper:#fbfaf8; --paper-2:#f2f0ea; --ink:#0f1211; --ink-2:#434946; --ink-3:#7d8481; --rule:#e3e0d9; --accent:#0a7a56; --accent-soft:#e3f3ec; --bad:#a23b2a; --bad-soft:#fbe9e5;
    --serif:"Instrument Serif",ui-serif,Georgia,serif; --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; --mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace; }
  * { box-sizing: border-box; }
  html[lang="en"] [data-tr="es"], html[lang="es"] [data-tr="en"] { display: none; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 16px; line-height: 1.5; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 24px clamp(16px, 4vw, 48px) 48px; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; color: var(--ink-3); }
  .top b { color: var(--ink); font-size: 15px; }
  .lang button { background: none; border: 0; font: inherit; font-size: 12px; letter-spacing: .1em; color: var(--ink-3); cursor: pointer; }
  html[lang="en"] .lang [data-set-lang="en"], html[lang="es"] .lang [data-set-lang="es"] { color: var(--ink); }
  h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(2.2rem, 5.5vw, 3.4rem); line-height: 1.05; margin: 28px 0 8px; }
  h1 em { color: var(--accent); }
  h2 { font-family: var(--serif); font-weight: 400; font-size: 1.7rem; margin: 40px 0 12px; }
  .lead { color: var(--ink-2); max-width: 72ch; margin: 0; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 12px; margin-top: 24px; }
  .stat { background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
  .stat b { display: block; font-family: var(--serif); font-weight: 400; font-size: 2.4rem; line-height: 1.05; }
  .stat span { font-size: 12.5px; color: var(--ink-3); }
  .stat.bad b { color: var(--bad); }
  .day { background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
  .day-head { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  .day-head span { font-family: var(--mono); font-size: 13px; }
  .bar { height: 14px; background: var(--paper-2); border-radius: 999px; margin: 10px 0 8px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); border-radius: 999px; }
  .fill.full { background: linear-gradient(90deg, var(--accent), #0d9468); }
  .fill.over { background: var(--bad); }
  .day-foot { font-size: 13px; color: var(--ink-3); }
  .refused { color: var(--bad); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; font-size: 14px; }
  td { padding: 10px 14px; border-top: 1px solid var(--rule); vertical-align: top; }
  tr:first-child td { border-top: 0; }
  td.num { font-family: var(--mono); white-space: nowrap; }
  tr.refusal td { background: var(--bad-soft); color: var(--bad); }
  code { font-family: var(--mono); font-size: 12.5px; }
  a { color: var(--accent); }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; margin: 0; font-size: 14px; }
  .kv dt { color: var(--ink-3); } .kv dd { margin: 0; font-family: var(--mono); font-size: 13px; }
  .muted { color: var(--ink-3); font-size: 13.5px; }
  .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 0 28px; }
  .two > div { min-width: 0; }
  td a { overflow-wrap: anywhere; }
  td:first-child { white-space: nowrap; }
  footer { margin-top: 40px; font-size: 12.5px; color: var(--ink-3); border-top: 1px solid var(--rule); padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <span><b>AgentPey</b> · ${tr("team budget", "presupuesto de equipo")} · Stellar testnet</span>
    <span class="lang"><button type="button" data-set-lang="en">EN</button> / <button type="button" data-set-lang="es">ES</button></span>
  </div>

  <h1>${tr(`The team gave its agent <em>${e(input.teamPerDay)} USDC</em> a day.`, `El equipo le dio a su agente <em>${e(input.teamPerDay)} USDC</em> al día.`)}</h1>
  <p class="lead">${tr(
    `Up to ${e(input.teamPerTx)} USDC per purchase of AI credits, checked by AgentPey before anything is signed; the rail that pays keeps its own limits on-chain. ${e(input.month)}, read from the team's hash-chained vault (${input.records} records, chain verified).`,
    `Hasta ${e(input.teamPerTx)} USDC por compra de créditos de IA, revisado por AgentPey antes de firmar nada; el rail que paga mantiene sus propios topes en la red. ${e(input.month)}, leído del registro encadenado del equipo (${input.records} registros, cadena verificada).`,
  )}</p>

  <div class="stats">
    <div class="stat"><b title="${e(summary.spent)} USDC">${e(displayAmount(summary.spent))}</b><span>${
      unanchored > 0 ? tr("USDC counted by the budget this month", "USDC contados por el presupuesto este mes") : tr("USDC spent this month", "USDC gastados este mes")
    }</span></div>
    <div class="stat"><b>${onChain.length}</b><span>${tr("purchases paid on Stellar", "compras pagadas en Stellar")}</span></div>${
      unanchored > 0
        ? `\n    <div class="stat"><b>${unanchored}</b><span>${tr("counted by the budget, no anchored transaction", "contadas por el presupuesto, sin transacción anclada")}</span></div>`
        : ""
    }
    <div class="stat bad"><b>${summary.refusals.length}</b><span>${tr("refused by the budget, nothing signed", "rechazadas por el presupuesto, sin firmar nada")}</span></div>
    <div class="stat"><b>${summary.activeDays}</b><span>${tr("days with spending", "días con gasto")}</span></div>
  </div>

  <h2>${tr("Each day against the budget", "Cada día frente al presupuesto")}</h2>
  ${dayHtml}

  <div class="two">
    <div>
      <h2>${tr("Payments", "Pagos")}</h2>
      <table>${paymentRows}</table>${
        released > 0
          ? `\n      <p class="muted">${released} ${tr(released === 1 ? "released: it never reached the network and is not counted." : "released: they never reached the network and are not counted.", released === 1 ? "liberado: nunca llegó a la red y no cuenta." : "liberados: nunca llegaron a la red y no cuentan.")}</p>`
          : ""
      }
    </div>
    <div>
      <h2>${tr("Refusals", "Rechazos")}</h2>
      <table>${refusalRows}</table>
    </div>
  </div>

  <h2>${tr("The rail's own limits, on-chain", "Los topes del rail, en la red")}</h2>
  ${rail}

  <footer>${tr(
    `Generated ${e(input.generatedAt.toISOString())} by pnpm run team:summary -- --html. Every payment with an anchored transaction links to it on Stellar Expert.`,
    `Generado ${e(input.generatedAt.toISOString())} con pnpm run team:summary -- --html. Cada pago con transacción anclada enlaza a ella en Stellar Expert.`,
  )}</footer>
</div>
<script>
  (function () {
    var root = document.documentElement;
    try { if (localStorage.getItem("agentpay-lang") === "es") root.lang = "es"; } catch (e) {}
    var b = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < b.length; i++) b[i].addEventListener("click", function () {
      root.lang = this.getAttribute("data-set-lang");
      try { localStorage.setItem("agentpay-lang", root.lang); } catch (e) {}
    });
  })();
</script>
</body>
</html>
`;
}
