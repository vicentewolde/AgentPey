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
 * **The pilot notice is in the layout, not in each page.** `PILOTO-F9.md` § 1.3
 * asks for it on every page, and the way to guarantee "every" is to make it
 * impossible to render a page without it.
 */
import { randomUUID } from "node:crypto";

import type { PurchaseResource, TenantActivity } from "./agentpey.js";
import type { AgentConfig, Account, AgentKind } from "./accounts.js";
import { FALLBACK_CHOICES } from "./instruction.js";
import { explainRefusal } from "./refusals.js";
import type { ExplainedControl, ProposedGrant } from "./permissions.js";

export function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
          --bg: #fbfbf9; --fg: #1c1c1a; --muted: #6b6b63; --line: #e2e2dd; --card: #fff;
          --accent: #2a5bd7; --warn: #8a5a00; --warnbg: #fdf3e0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16161a; --fg: #f2f2ef; --muted: #a3a39b; --line: #2e2e34; --card: #1e1e23;
            --accent: #7aa2f7; --warn: #e0b062; --warnbg: #2a2313; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--fg); line-height: 1.6; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin: 0 0 .3rem; letter-spacing: -.01em; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; }
  .lede { color: var(--muted); margin: 0 0 2rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: .75rem;
          padding: 1.25rem 1.35rem; margin-bottom: 1rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .3rem; font-size: .92rem; }
  input, textarea, select { width: 100%; padding: .6rem .7rem; font: inherit; color: inherit;
          background: var(--bg); border: 1px solid var(--line); border-radius: .4rem; }
  button, .button { display: inline-block; margin-top: 1.25rem; padding: .65rem 1.15rem; font: inherit;
          font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: .4rem;
          cursor: pointer; text-decoration: none; }
  .secondary { background: transparent; color: var(--accent); border: 1px solid var(--line); }
  code, pre { background: color-mix(in srgb, var(--line) 55%, transparent); border-radius: .3rem; }
  code { padding: .1rem .35rem; font-size: .85em; word-break: break-all; }
  pre { padding: 1rem; overflow-x: auto; font-size: .82rem; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .tag { display: inline-block; padding: .1rem .45rem; border-radius: .3rem; font-size: .72rem;
         font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .tag-signed { background: #dceadd; color: #1d5228; }
  .tag-onchain { background: #dae1f5; color: #1d3775; }
  .tag-realops { background: #ece8e0; color: #5c5347; }
  @media (prefers-color-scheme: dark) {
    .tag-signed { background: #1d3a24; color: #9ed8ab; }
    .tag-onchain { background: #1b2647; color: #a9bff0; }
    .tag-realops { background: #2e2a22; color: #cbbfa8; }
  }
  .notice { background: var(--warnbg); color: var(--warn); border-radius: .5rem;
            padding: .85rem 1.1rem; font-size: .88rem; margin-bottom: 2rem; }
  .error { border-left: 3px solid #c0392b; padding-left: .9rem; }
  footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
           font-size: .85rem; color: var(--muted); }
  nav a { color: var(--accent); margin-right: 1rem; font-size: .9rem; }
`;

/** The notice every page carries, by construction. */
const PILOT_NOTICE =
  "Piloto sobre Stellar <strong>testnet</strong>. No hay dinero real en juego, los datos son de prueba, " +
  "y el proyecto puede borrarlos.";

export interface LayoutInput {
  readonly title: string;
  readonly body: string;
  readonly signedIn?: boolean;
  readonly signalDeskUrl?: string;
}

export function layout(input: LayoutInput): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.title)} · RealOps</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <nav>
    <a href="/">RealOps</a>
    ${input.signedIn === true ? '<a href="/agentes">Mis agentes</a><a href="/servicios">Mis servicios</a><a href="/salir">Salir</a>' : ""}
    ${input.signalDeskUrl === undefined ? "" : `<a href="${escape(input.signalDeskUrl)}">SignalDesk</a>`}
  </nav>
  <p class="notice">${PILOT_NOTICE}</p>
  ${input.body}
  <footer>
    <p>RealOps es la plataforma de agentes del piloto. <strong>No autoriza pagos</strong>: pide, y AgentPey decide.
    Tu Mandato se firma siempre en el dominio de AgentPey, nunca aquí.</p>
  </footer>
</main>
</body>
</html>
`;
}

export function homePage(signalDeskUrl: string): string {
  return layout({
    title: "Inicio",
    signalDeskUrl,
    body: `
  <h1>RealOps</h1>
  <p class="lede">Contratá un agente, decidí exactamente qué puede gastar, y mirá cada compra —
  y cada rechazo— con su prueba.</p>

  <div class="card">
    <h2 style="margin-top:0">Cómo funciona</h2>
    <ol>
      <li>Entrás con tu correo. Sin contraseña.</li>
      <li>Elegís un agente y ponés sus límites.</li>
      <li>Firmás el permiso con tu wallet, <strong>en el sitio de AgentPey</strong>, no acá.</li>
      <li>Le das una instrucción. AgentPey decide si la deja pasar, y paga o rechaza.</li>
    </ol>
    <a class="button" href="/entrar">Entrar</a>
  </div>

  <div class="card">
    <h2 style="margin-top:0">El comercio del piloto</h2>
    <p>Los agentes compran en <a href="${escape(signalDeskUrl)}">SignalDesk</a>, un comercio x402 que existe
    aparte y se puede abrir por su cuenta. Está enlazado acá justamente para que compruebes que los dos
    servicios son distintos.</p>
  </div>
`,
  });
}

export function signInPage(options: { readonly error?: string } = {}): string {
  return layout({
    title: "Entrar",
    body: `
  <h1>Entrar</h1>
  <p class="lede">Te mandamos un enlace de un solo uso. Dura 15 minutos.</p>
  ${options.error === undefined ? "" : `<p class="card error">${escape(options.error)}</p>`}
  <form class="card" method="post" action="/entrar">
    <label for="email">Tu correo</label>
    <input id="email" name="email" type="email" required autocomplete="email" placeholder="vos@ejemplo.cl">
    <label for="alias">Cómo querés que te llamemos</label>
    <input id="alias" name="alias" required autocomplete="nickname" placeholder="Vicente" maxlength="60">
    <button type="submit">Mandame el enlace</button>
  </form>
  <p style="font-size:.88rem;color:var(--muted)">Tu correo se guarda solo acá. AgentPey nunca lo recibe:
  te identifica con un código aleatorio que no dice nada de vos.</p>
`,
  });
}

export function linkSentPage(options: { readonly onScreenLink?: string }): string {
  return layout({
    title: "Revisá tu correo",
    body: `
  <h1>Revisá tu correo</h1>
  <p class="lede">Si esa dirección tiene cuenta o la acabamos de crear, ahí va el enlace. Dura 15 minutos
  y sirve una sola vez.</p>
  ${
    options.onScreenLink === undefined
      ? ""
      : `<div class="card">
    <p><strong>Modo piloto sin correo configurado.</strong> Todavía no hay proveedor de email, así que
    el enlace se muestra acá. Esto significa que <em>no se está verificando</em> que el correo sea tuyo —
    cuando el envío esté configurado, sí se verifica.</p>
    <p><a class="button" href="${escape(options.onScreenLink)}">Entrar con el enlace</a></p>
  </div>`
  }
`,
  });
}

const AGENT_COPY: Readonly<Record<AgentKind, { readonly name: string; readonly what: string }>> = {
  market_brief: {
    name: "Agente de informes de mercado",
    what: "Compra el informe XLM/USDC en SignalDesk cuando se lo pedís. El informe es de datos sintéticos.",
  },
  ai_credits: {
    name: "Agente de créditos de IA",
    what: "Compra paquetes de 1000 créditos de producto en SignalDesk. Los créditos no son transferibles.",
  },
};

export function agentsPage(account: Account, agents: readonly AgentConfig[]): string {
  const rows =
    agents.length === 0
      ? '<p class="card">Todavía no contrataste ningún agente.</p>'
      : agents
          .map(
            (agent) => `<div class="card">
    <h2 style="margin-top:0">${escape(agent.label)}</h2>
    <p style="color:var(--muted);margin:0 0 .5rem">${escape(AGENT_COPY[agent.kind].name)}</p>
    <p style="margin:0">Máximo por compra <strong>${escape(agent.permissions.perTx)} USDC</strong> ·
    por día <strong>${escape(agent.permissions.perDay)} USDC</strong> ·
    vigencia <strong>${agent.permissions.validForDays} días</strong></p>
    <p style="margin:.75rem 0 0"><a href="/agentes/${escape(agent.id)}">Ver y firmar</a></p>
  </div>`,
          )
          .join("\n  ");

  return layout({
    title: "Mis agentes",
    signedIn: true,
    body: `
  <h1>Hola, ${escape(account.alias)}</h1>
  <p class="lede">Un agente no puede hacer nada hasta que firmes su permiso con tu wallet.</p>
  ${rows}

  <h2>Contratar uno nuevo</h2>
  <form class="card" method="post" action="/agentes">
    <label for="kind">Qué agente</label>
    <select id="kind" name="kind">
      ${Object.entries(AGENT_COPY)
        .map(([kind, copy]) => `<option value="${escape(kind)}">${escape(copy.name)}</option>`)
        .join("\n      ")}
    </select>
    <label for="label">Cómo lo querés llamar</label>
    <input id="label" name="label" required maxlength="60" placeholder="Mi agente de informes">
    <label for="perTx">Máximo por compra (USDC)</label>
    <input id="perTx" name="perTx" required value="0.30" inputmode="decimal">
    <label for="perDay">Máximo por día (USDC)</label>
    <input id="perDay" name="perDay" required value="0.60" inputmode="decimal">
    <label for="validForDays">Vigencia (días)</label>
    <input id="validForDays" name="validForDays" required value="30" inputmode="numeric">
    <button type="submit">Configurar</button>
  </form>
`,
  });
}

const ENFORCER_COPY: Readonly<Record<ExplainedControl["enforcedBy"], { readonly tag: string; readonly cls: string }>> = {
  signed: { tag: "firmado", cls: "tag-signed" },
  onchain: { tag: "on-chain", cls: "tag-onchain" },
  realops: { tag: "RealOps", cls: "tag-realops" },
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
    title: "Revisar el permiso",
    signedIn: true,
    body: `
  <h1>${escape(agent.label)}</h1>
  <p class="lede">Esto es exactamente lo que vas a firmar. La etiqueta de la derecha dice quién lo hace
  cumplir: <strong>firmado</strong> lo verifica AgentPey contra tu Mandato, <strong>on-chain</strong> lo
  revalida además el contrato en Stellar, y <strong>RealOps</strong> es solo de esta plataforma.</p>

  <table class="card" style="padding:.4rem .6rem">
    <thead><tr><th>Permiso</th><th>Valor</th><th>Quién lo hace cumplir</th></tr></thead>
    <tbody>
      ${controls
        .map(
          (control) => `<tr>
        <td><strong>${escape(control.label)}</strong><br><span style="color:var(--muted);font-size:.85rem">${escape(control.explanation)}</span></td>
        <td><code>${escape(control.value)}</code></td>
        <td><span class="tag ${ENFORCER_COPY[control.enforcedBy].cls}">${escape(ENFORCER_COPY[control.enforcedBy].tag)}</span></td>
      </tr>`,
        )
        .join("\n      ")}
    </tbody>
  </table>

  <h2>El permiso, literal</h2>
  <p style="color:var(--muted);font-size:.9rem">Este es el objeto que se manda a AgentPey y que tu wallet
  te va a mostrar antes de firmar. No hay nada más.</p>
  <pre>${escape(JSON.stringify(grant, null, 2))}</pre>

  <div class="card">
    <p><strong>La firma ocurre en el sitio de AgentPey, no acá.</strong> Si alguna vez ves una pantalla
    pidiéndote firmar un Mandato en el dominio de RealOps, no es nuestra.</p>
    ${signState(agent, revokeBaseUrl)}
  </div>
`,
  });
}

/** What the review card offers, given how far this agent has got. */
function signState(agent: AgentConfig, revokeBaseUrl: string): string {
  if (agent.mandateId !== null) {
    return `<p>✓ Firmado. Mandato <code>${escape(agent.mandateId)}</code>.</p>
    <p><a href="/servicios">Ir a Mis servicios</a></p>
    <p style="margin-top:1.25rem"><a class="button secondary" href="${escape(revokeBaseUrl)}/revocar/${escape(agent.mandateId)}?volver=/agentes/${escape(agent.id)}">Revocar este permiso</a></p>
    <p style="color:var(--muted);font-size:.88rem">Revocar corta la autorización <strong>desde afuera del
    agente</strong>: no importa qué le digan después, sin Mandato válido no puede pagar nada. Se hace en el
    sitio de AgentPey y lo firmás con tu wallet — RealOps no puede revocar por vos, ni aunque quisiera.</p>`;
  }
  if (agent.consentSessionId !== null) {
    return `<p>Ya empezaste a firmar este permiso y no terminaste, o la invitación venció.</p>
    <form method="post" action="/agentes/${escape(agent.id)}/firmar"><button type="submit">Reintentar la firma</button></form>`;
  }
  return `<form method="post" action="/agentes/${escape(agent.id)}/firmar">
      <button type="submit">Firmar en AgentPey</button>
    </form>
    <p style="color:var(--muted);font-size:.88rem">Te vamos a llevar al sitio de AgentPey para que conectes
    tu wallet y firmes. Cuando termines, volvés acá.</p>`;
}

export interface ServicesInput {
  readonly account: Account;
  /** `null` when this instance has no AgentPey behind it, or the call failed. */
  readonly activity: TenantActivity | null;
  /** Why the activity is missing, if it is. */
  readonly activityError?: string;
  readonly agents: readonly AgentConfig[];
}

/** One purchase, settled — what the person actually got. */
function deliveryCard(purchase: PurchaseResource): string {
  const links: string[] = [];
  if (purchase.delivery?.artifact_url != null) {
    links.push(`<a class="button" href="${escape(purchase.delivery.artifact_url)}">Ver lo que compraste</a>`);
  }
  if (purchase.explorer_url !== null) {
    links.push(`<a href="${escape(purchase.explorer_url)}">Ver el pago en Stellar</a>`);
  }

  return `<div class="card">
    <span class="tag tag-signed">entregado</span>
    <h3 style="margin:.5rem 0 .25rem">${escape(purchase.product_id)}</h3>
    <p style="margin:0 0 .5rem">${escape(purchase.total ?? "?")} ${escape((purchase.asset ?? "").split(":")[0] ?? "")} · ${escape(purchase.created_at)}</p>
    <p class="meta" style="font-size:.85rem;color:var(--muted);margin:0 0 .75rem">
      ${purchase.delivery?.delivery_id == null ? "" : `Entrega <code>${escape(purchase.delivery.delivery_id)}</code><br>`}
      ${purchase.delivery?.receipt_hash == null ? "" : `Recibo <code>${escape(purchase.delivery.receipt_hash)}</code>`}
    </p>
    ${links.join(" ")}
  </div>`;
}

/** One purchase, refused — said in words the person can act on. */
function refusalCard(purchase: PurchaseResource): string {
  const explained = explainRefusal(purchase.code ?? "unknown", purchase.reason);
  return `<div class="card error">
    <span class="tag tag-realops">rechazado</span>
    <h3 style="margin:.5rem 0 .25rem">${escape(purchase.product_id)}</h3>
    <p style="margin:0 0 .35rem"><strong>${escape(explained.what)}</strong></p>
    ${explained.next === "" ? "" : `<p style="margin:0 0 .5rem">${escape(explained.next)}</p>`}
    <p style="font-size:.85rem;color:var(--muted);margin:0">
      ${escape(purchase.created_at)} · código <code>${escape(purchase.code ?? "unknown")}</code>
    </p>
  </div>`;
}

function spendingCard(activity: TenantActivity): string {
  if (activity.per_day === null && activity.rail === null) return "";
  const perDay =
    activity.per_day === null
      ? ""
      : `<p style="margin:0 0 .35rem">Hoy llevás gastado <strong>${escape(activity.per_day.spent_today)}</strong> de
      <strong>${escape(activity.per_day.limit)} ${escape(activity.per_day.currency)}</strong>.
      ${activity.per_day.near_limit ? "<strong>Estás cerca del tope.</strong>" : `Te quedan ${escape(activity.per_day.remaining)}.`}</p>`;
  const rail =
    activity.rail === null
      ? ""
      : `<p style="margin:0;font-size:.9rem;color:var(--muted)">Saldo del contrato que paga:
      <strong>${escape(activity.rail.balance)} ${escape(activity.rail.asset)}</strong>.
      ${activity.rail.sponsored ? "Es crédito de prueba que pone el piloto, no dinero tuyo." : ""}</p>`;

  return `<div class="card">${perDay}${rail}</div>`;
}

export function servicesPage(input: ServicesInput): string {
  const { account, activity } = input;
  const settled = (activity?.purchases ?? []).filter((purchase) => purchase.outcome === "settled");
  const refused = (activity?.purchases ?? []).filter((purchase) => purchase.outcome === "refused");
  const signable = input.agents.filter((agent) => agent.mandateId !== null);

  return layout({
    title: "Mis servicios",
    signedIn: true,
    body: `
  <h1>Mis servicios</h1>
  <p class="lede">Todo lo que tu agente compró —y todo lo que intentó y le rechazaron— con su prueba.</p>

  ${input.activityError === undefined ? "" : `<p class="card error">${escape(input.activityError)}</p>`}
  ${activity === null ? "" : spendingCard(activity)}

  ${
    signable.length === 0
      ? '<p class="card">Todavía no tenés ningún agente con permiso firmado. <a href="/agentes">Empezá por ahí</a>.</p>'
      : `<form class="card" method="post" action="/instruccion">
    <input type="hidden" name="request_key" value="${randomUUID()}">
    <label for="instruction">Decile qué comprar</label>
    <input id="instruction" name="instruction" required maxlength="500" placeholder="compra el informe XLM/USDC">
    <button type="submit">Pedirlo</button>
    <p style="font-size:.88rem;color:var(--muted);margin:.75rem 0 0">RealOps interpreta la frase. Después
    <strong>AgentPey decide</strong>: vuelve a resolver el comercio, pide él mismo la factura, y compara todo
    contra lo que firmaste antes de pagar.</p>
  </form>`
  }

  <h2>Entregas</h2>
  ${settled.length === 0 ? '<p class="card">Todavía no compraste nada.</p>' : settled.map(deliveryCard).join("\n  ")}

  <h2>Rechazos</h2>
  ${
    refused.length === 0
      ? '<p class="card">Ningún intento rechazado.</p>'
      : `<p style="color:var(--muted);font-size:.9rem">Un rechazo no es una ausencia: queda guardado igual que
      una compra, para que "¿por qué mi agente no compró esto?" tenga respuesta.</p>
  ${refused.map(refusalCard).join("\n  ")}`
  }

  <h2>Tu cuenta</h2>
  <div class="card">
    <p>Te identificamos ante AgentPey como <code>${escape(account.externalRef)}</code>. Ese código es
    aleatorio: no se calcula a partir de tu correo, así que no se puede revertir.</p>
    <form method="post" action="/cuenta/borrar" onsubmit="return confirm('¿Borrar tu correo y cerrar todas tus sesiones?')">
      <button class="secondary" type="submit">Borrar mi cuenta</button>
    </form>
    <p style="color:var(--muted);font-size:.88rem">Borra tu correo, tu alias y tus sesiones de RealOps.
    <strong>No borra tu Mandato ni el registro de lo que pasó</strong>: son evidencia firmada y anclada en
    una cadena pública, y borrarlos rompería la cadena de hashes que es el producto entero. Lo decimos
    así, con todas las letras, porque es una tensión real y esconderla sería peor.</p>
  </div>
`,
  });
}

export function notRecognisedPage(reason: string, instruction: string): string {
  return layout({
    title: "No entendí",
    signedIn: true,
    body: `
  <h1>No entendí la instrucción</h1>
  <p class="lede">${escape(reason)}. Leí esto: <code>${escape(instruction)}</code></p>
  <div class="card">
    <p><strong>No adivinamos.</strong> Un agente con permiso de gastar que adivina, compra lo que no le
    pediste. Elegí una de las dos:</p>
    ${FALLBACK_CHOICES.map(
      (choice) =>
        `<form method="post" action="/instruccion" style="display:inline"><input type="hidden" name="request_key" value="${randomUUID()}"><input type="hidden" name="kind" value="${escape(choice.kind)}"><button type="submit">${escape(choice.label)}</button></form>`,
    ).join("\n    ")}
  </div>
`,
  });
}

export function errorPage(status: number, message: string): string {
  return layout({
    title: `Error ${status}`,
    body: `
  <h1>${status}</h1>
  <p class="lede">${escape(message)}</p>
  <p><a href="/">Volver al inicio</a></p>
`,
  });
}
