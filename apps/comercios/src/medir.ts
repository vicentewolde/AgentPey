/**
 * Problem 4b, "¿cuánto me venden las IAs?": classify each visit by the AI it
 * came from, remember that source in the browser for an attribution window,
 * and credit purchases to it. Plus the control group behind the 90-day
 * guarantee: half of the catalogue is optimised, half is left alone, and the
 * two halves are compared.
 *
 * Sources: the referrer host (chatgpt.com, perplexity.ai…), `utm_source` (ChatGPT
 * adds utm_source=chatgpt.com to its links) and AgentPey's own `ap_click`
 * parameter (links handed to agents). Many AI visits arrive with no referrer at
 * all, so these numbers are a floor, not the full count; reports must say so.
 */
import { createHash } from "node:crypto";

export const AI_SOURCES = ["chatgpt", "perplexity", "gemini", "claude", "copilot", "meta", "otra_ia", "agentpey"] as const;
export type AiSource = (typeof AI_SOURCES)[number];
export type Source = AiSource | "sin_ia";

const HOSTS: readonly [RegExp, AiSource][] = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)openai\.com$/, "chatgpt"],
  [/(^|\.)perplexity\.ai$/, "perplexity"],
  [/(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/, "gemini"],
  [/(^|\.)claude\.ai$/, "claude"],
  [/(^|\.)copilot\.microsoft\.com$|(^|\.)copilot\.cloud\.microsoft$/, "copilot"],
  [/(^|\.)meta\.ai$/, "meta"],
  [/(^|\.)(you\.com|poe\.com|phind\.com|kagi\.com|deepseek\.com|chat\.deepseek\.com|grok\.com|x\.ai|mistral\.ai)$/, "otra_ia"],
];

const UTM: readonly [RegExp, AiSource][] = [
  [/chatgpt|openai/, "chatgpt"],
  [/perplexity/, "perplexity"],
  [/gemini|bard/, "gemini"],
  [/claude|anthropic/, "claude"],
  [/copilot/, "copilot"],
  [/meta\.ai|metaai/, "meta"],
];

/** Which AI a visit came from, from its landing URL and referrer. */
export function classifyVisit(landingUrl: string, referrer: string | undefined): Source {
  let params: URLSearchParams | undefined;
  try {
    params = new URL(landingUrl).searchParams;
  } catch {
    params = undefined;
  }
  if (params?.get("ap_click")) return "agentpey";
  const utm = (params?.get("utm_source") ?? "").toLowerCase();
  for (const [re, src] of UTM) if (utm !== "" && re.test(utm)) return src;
  if (referrer !== undefined && referrer !== "") {
    try {
      const host = new URL(referrer).host.toLowerCase().replace(/^www\./, "");
      for (const [re, src] of HOSTS) if (re.test(host)) return src;
    } catch {
      /* not a URL */
    }
  }
  return "sin_ia";
}

/** Stable 50/50 split of a store's products: "optimizada" gets AgentPey's changes, "control" is left as is. */
export function grupo(storeId: string, productId: string): "optimizada" | "control" {
  const h = createHash("sha256").update(`${storeId}:${productId}`).digest();
  return h[0]! % 2 === 0 ? "optimizada" : "control";
}

export interface MeasureEvent {
  readonly storeId: string;
  readonly kind: "visita" | "compra";
  readonly source: Source;
  readonly at: string;
  /** Purchase total in CLP. */
  readonly total?: number;
  readonly orderId?: string;
  readonly productIds?: readonly string[];
  /** True for generated sample data; reports label it. */
  readonly demo?: boolean;
}

export interface SourceRow {
  readonly source: Source;
  readonly visitas: number;
  readonly compras: number;
  readonly ventas: number;
  /** compras / visitas, 0–1. */
  readonly conversion: number;
}

export interface Summary {
  readonly rows: readonly SourceRow[];
  readonly ia: { visitas: number; compras: number; ventas: number; shareVisitas: number; shareVentas: number };
  readonly grupos: { optimizada: { compras: number; ventas: number }; control: { compras: number; ventas: number } };
  readonly demo: boolean;
}

export function summarize(storeId: string, events: readonly MeasureEvent[]): Summary {
  const by = new Map<Source, { visitas: number; compras: number; ventas: number }>();
  const grupos = { optimizada: { compras: 0, ventas: 0 }, control: { compras: 0, ventas: 0 } };
  const orders = new Set<string>();
  for (const e of events) {
    if (e.storeId !== storeId) continue;
    if (e.kind === "compra" && e.orderId !== undefined) {
      if (orders.has(e.orderId)) continue; // a reloaded thank-you page counts once
      orders.add(e.orderId);
    }
    const row = by.get(e.source) ?? { visitas: 0, compras: 0, ventas: 0 };
    if (e.kind === "visita") row.visitas++;
    else {
      row.compras++;
      row.ventas += e.total ?? 0;
      if (e.source !== "sin_ia") {
        const ids = e.productIds ?? [];
        const share = ids.length === 0 ? 0 : (e.total ?? 0) / ids.length;
        for (const id of ids) {
          const g = grupos[grupo(storeId, id)];
          g.compras += 1 / ids.length;
          g.ventas += share;
        }
      }
    }
    by.set(e.source, row);
  }
  const rows = [...by.entries()]
    .map(([source, r]) => ({ source, ...r, conversion: r.visitas === 0 ? 0 : r.compras / r.visitas }))
    .sort((a, b) => b.ventas - a.ventas || b.visitas - a.visitas);
  const ai = rows.filter((r) => r.source !== "sin_ia");
  const tot = (k: "visitas" | "compras" | "ventas", rs: readonly SourceRow[]) => rs.reduce((a, r) => a + r[k], 0);
  const allV = tot("visitas", rows);
  const allS = tot("ventas", rows);
  return {
    rows,
    ia: {
      visitas: tot("visitas", ai), compras: tot("compras", ai), ventas: tot("ventas", ai),
      shareVisitas: allV === 0 ? 0 : tot("visitas", ai) / allV,
      shareVentas: allS === 0 ? 0 : tot("ventas", ai) / allS,
    },
    grupos: {
      optimizada: { compras: Math.round(grupos.optimizada.compras * 10) / 10, ventas: Math.round(grupos.optimizada.ventas) },
      control: { compras: Math.round(grupos.control.compras * 10) / 10, ventas: Math.round(grupos.control.ventas) },
    },
    demo: events.some((e) => e.storeId === storeId && e.demo === true),
  };
}

/**
 * The script a store pastes in its theme (or that a Shopify app injects). On
 * every page it classifies the visit; an AI source is kept for 30 days in
 * localStorage and sent with the purchase. On Shopify's order status page it
 * reads the order from `Shopify.checkout`; other platforms call
 * `AgentPey.compra({ id, total, productos })` on their thank-you page.
 * No cookies, no personal data: source, time, order id, total, product ids.
 */
export function snippet(storeId: string, endpoint: string): string {
  const hosts = HOSTS.map(([re, src]) => `[${re.toString()},"${src}"]`).join(",");
  const utm = UTM.map(([re, src]) => `[${re.toString()},"${src}"]`).join(",");
  return `(function(){var T=${JSON.stringify(storeId)},E=${JSON.stringify(endpoint)},K="agentpey_src",W=30*864e5;
var H=[${hosts}],U=[${utm}];
function cls(){try{var u=new URL(location.href),p=u.searchParams;if(p.get("ap_click"))return"agentpey";var s=(p.get("utm_source")||"").toLowerCase();for(var i=0;i<U.length;i++)if(s&&U[i][0].test(s))return U[i][1];if(document.referrer){var h=new URL(document.referrer).host.toLowerCase().replace(/^www\\./,"");for(var j=0;j<H.length;j++)if(H[j][0].test(h))return H[j][1];}}catch(e){}return null}
function send(b){b.tienda=T;b.at=new Date().toISOString();try{navigator.sendBeacon(E,JSON.stringify(b))}catch(e){}}
function stored(){try{var v=JSON.parse(localStorage.getItem(K)||"null");if(v&&Date.now()-v.t<W)return v.s}catch(e){}return null}
var s=cls();if(s){try{localStorage.setItem(K,JSON.stringify({s:s,t:Date.now()}))}catch(e){}send({tipo:"visita",fuente:s})}
window.AgentPey={compra:function(o){send({tipo:"compra",fuente:stored()||"sin_ia",pedido:String(o.id),total:Number(o.total)||0,productos:(o.productos||[]).map(String)})}};
try{var c=window.Shopify&&window.Shopify.checkout;if(c&&c.order_id){window.AgentPey.compra({id:c.order_id,total:c.total_price,productos:(c.line_items||[]).map(function(l){return l.product_id})})}}catch(e){}
})();`;
}

/** Sample events for the demo panel, labelled `demo: true`. Deterministic per store. */
export function demoEvents(storeId: string, productIds: readonly string[], days = 28): MeasureEvent[] {
  let seed = createHash("sha256").update(storeId).digest().readUInt32BE(0);
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  // About 1% of visits from AI assistants, converting somewhat better than the rest: a plausible start, not a forecast.
  const weights: [Source, number, number][] = [["sin_ia", 900, 0.012], ["chatgpt", 6, 0.02], ["gemini", 2, 0.018], ["perplexity", 1, 0.025], ["copilot", 0.6, 0.015], ["claude", 0.4, 0.025]];
  const out: MeasureEvent[] = [];
  const start = Date.UTC(2026, 9, 14);
  for (let d = 0; d < days; d++) {
    const growth = 1 + d / days; // AI visits grow over the window
    for (const [source, perDay, conv] of weights) {
      const n = Math.round((source === "sin_ia" ? perDay : perDay * growth) * (0.7 + rand() * 0.6));
      for (let i = 0; i < n; i++) {
        const at = new Date(start + d * 864e5 + Math.floor(rand() * 864e5)).toISOString();
        out.push({ storeId, kind: "visita", source, at, demo: true });
        if (rand() < conv) {
          const pid = productIds.length > 0 ? productIds[Math.floor(rand() * productIds.length)]! : "p";
          out.push({ storeId, kind: "compra", source, at, total: Math.round((15_000 + rand() * 120_000) / 10) * 10, orderId: `demo-${storeId}-${d}-${source}-${i}`, productIds: [pid], demo: true });
        }
      }
    }
  }
  return out;
}
