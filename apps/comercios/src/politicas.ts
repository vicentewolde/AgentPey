/**
 * Problem 3, "que no prometa algo falso": find the store's shipping, returns,
 * warranty and payment pages, and have Claude turn them into a structured
 * policy with a quote for every claim. The owner approves it; only then is it
 * offered to assistants (and mapped to the OpenAI feed's return fields).
 */
import { z } from "zod";

import type { Fetcher } from "./http.js";
import type { Llm } from "./llm.js";
import { htmlToText, type Store } from "./model.js";

const KEYWORDS = /despacho|env[ií]o|shipping|cambio|devoluci|refund|retracto|garant|t[eé]rminos|condiciones|terms|preguntas|faq|ayuda|medios-de-pago|formas-de-pago|pago|pol[ií]tica|policies/i;

/** Candidate policy URLs: the home page's links that look like policies, plus Shopify's fixed policy paths. */
export async function findPolicyPages(store: Store, fetcher: Fetcher, max = 8): Promise<string[]> {
  const found = new Set<string>();
  if (store.platform === "shopify") {
    for (const p of ["shipping-policy", "refund-policy", "terms-of-service"]) found.add(`${store.origin}/policies/${p}`);
  }
  try {
    const home = await fetcher.text(`${store.origin}/`);
    for (const m of home.body.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = htmlToText(m[2]);
      let url: string;
      try {
        url = new URL(m[1]!, home.url).toString();
      } catch {
        continue;
      }
      if (new URL(url).host.replace(/^www\./, "") !== new URL(store.origin).host.replace(/^www\./, "")) continue;
      if (KEYWORDS.test(url) || KEYWORDS.test(label)) found.add(url.split("?")[0]!);
    }
  } catch {
    /* the fixed paths may still work */
  }
  return [...found].slice(0, max);
}

export const PolicySchema = z.object({
  despacho: z.object({
    cobertura: z.string().describe("Dónde despachan (todo Chile, solo RM, etc.). Vacío si no lo dice."),
    plazos: z.array(z.object({ zona: z.string(), plazo: z.string() })),
    costo: z.string().describe("Cómo se calcula el costo o si es gratis sobre un monto. Vacío si no lo dice."),
    retiro_en_tienda: z.string(),
  }),
  cambios_y_devoluciones: z.object({
    acepta: z.enum(["si", "no", "no_dice"]).describe("Si acepta cambios o devoluciones de algún tipo."),
    plazo_dias: z.number().int().nullable().describe("Plazo para devolver el producto y recibir el dinero de vuelta; null si solo hay cambio o no lo dice."),
    condiciones: z.string(),
    cambio: z.object({
      plazo_dias: z.number().int().nullable().describe("Plazo para cambiar por otro producto; null si no lo dice."),
      solo_por_falla: z.boolean().describe("true si el cambio vale solo para productos fallados o que no corresponden."),
    }),
    devolucion_dinero: z.object({
      acepta: z.enum(["si", "no", "no_dice"]).describe("Si devuelve el dinero (incluido el retracto, si la tienda lo menciona)."),
      plazo_dias: z.number().int().nullable(),
      solo_por_falla: z.boolean().describe("true si la devolución del dinero vale solo para productos fallados o que no corresponden."),
    }),
    plazo_desde: z.enum(["recepcion", "compra", "no_dice"]).describe("Desde cuándo se cuentan los plazos."),
    tipo_de_dias: z.enum(["corridos", "habiles", "no_dice"]),
  }),
  garantia: z.string(),
  medios_de_pago: z.array(z.string()),
  cuotas: z.string().describe("Cuotas sin interés u otras, si lo dice."),
  contacto: z.string(),
  citas: z.array(z.object({ dato: z.string(), cita: z.string(), url: z.string() })).describe("Una cita textual por cada dato afirmado."),
  falta: z.array(z.string()).describe("Información que un comprador pregunta y que las páginas no dicen."),
});

export type Policy = z.infer<typeof PolicySchema>;

/** A saved policy read before cambio and devolución were told apart: the night shift reads it again. */
export const policyOutdated = (data: unknown): boolean =>
  typeof data !== "object" || data === null || !("devolucion_dinero" in ((data as { cambios_y_devoluciones?: object }).cambios_y_devoluciones ?? {}));

const SYSTEM = `Extraes las políticas de una tienda online chilena desde el texto de sus páginas, para que un asistente de compras con IA responda bien y no prometa nada que la tienda no ofrezca.
Reglas:
- Solo lo que dice el texto. Si no lo dice, deja el campo vacío, usa "no_dice" o null, y anótalo en "falta".
- Cada dato que afirmes debe tener una cita textual en "citas", con la URL de donde salió.
- No inventes plazos, costos ni coberturas. No completes con lo que "suelen" hacer las tiendas.
- Cambio (por otro producto) y devolución del dinero son cosas distintas, con plazos que pueden ser distintos: no pongas el plazo de cambio como plazo de devolución. Marca "solo_por_falla" cuando el plazo vale solo para productos fallados o que no corresponden.
- Los campos describen a la tienda para un comprador: no escribas en ellos notas sobre el texto ("el texto no dice", "aparece cortado", "según el banner"). Lo que falta va en "falta".
- Español de Chile, frases cortas.`;

export async function extractPolicy(llm: Llm, store: Store, pages: { url: string; text: string }[]): Promise<Policy | undefined> {
  const corpus = pages.map((p) => `=== ${p.url} ===\n${p.text.slice(0, 12000)}`).join("\n\n");
  return llm.structured(PolicySchema, SYSTEM, `Tienda: ${store.name} (${store.origin}), rubro ${store.rubro}.\n\n${corpus}`);
}

export async function readPolicyPages(store: Store, fetcher: Fetcher): Promise<{ url: string; text: string }[]> {
  const urls = await findPolicyPages(store, fetcher);
  const pages: { url: string; text: string }[] = [];
  for (const url of urls) {
    try {
      const res = await fetcher.text(url);
      if (res.status !== 200) continue;
      const main = /<main[\s\S]*?<\/main>/i.exec(res.body)?.[0] ?? res.body;
      const text = htmlToText(main.replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, " "));
      if (text.length > 200) pages.push({ url: res.url, text });
    } catch {
      /* skip unreadable pages */
    }
  }
  return pages;
}

/** The OpenAI feed's return fields, from an approved policy. */
export function feedReturnFields(policy: Policy, policyUrl: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (policy.cambios_y_devoluciones.acepta === "si") {
    out.accepts_returns = true;
    if (policy.cambios_y_devoluciones.plazo_dias !== null && policy.cambios_y_devoluciones.plazo_dias > 0) out.return_deadline_in_days = policy.cambios_y_devoluciones.plazo_dias;
  } else if (policy.cambios_y_devoluciones.acepta === "no") {
    out.accepts_returns = false;
  }
  if (policyUrl !== undefined) out.return_policy = policyUrl;
  return out;
}
