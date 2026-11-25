/**
 * The public stores' policies (shipping, exchanges and refunds, warranty,
 * payment), as the night shift read them from each store's own pages
 * (politicas.ts), offered to AI assistants by the public MCP server (ias.ts)
 * and as JSON at agentpey.com/chile/politicas?tienda=…
 *
 * Only the stores the guides may name (keptStores), only policies in the
 * current format, read in the last POLICY_MAX_AGE_DAYS days, and only claims
 * quoted from a page of the store's own domain. The contact field is left out:
 * it may name a person. Every answer says it was read and summarised by
 * AgentPey with AI from the store's pages, on which date, that the store did
 * not review it, and to confirm it in the store.
 */
import { z } from "zod";

import { guideUrl, keptStores, type GuideInput } from "./guia.js";
import { PolicySchema, policyOutdated } from "./politicas.js";
import { searchText } from "./precios.js";

/** A policy older than this is not offered (the night shift reads each store again every 30 days). */
export const POLICY_MAX_AGE_DAYS = 60;
/** Stores one lookup returns at most. */
export const POLICY_LIMIT = 3;

export const POLICY_NOTE =
  "Resumen hecho por AgentPey con IA a partir de las páginas de políticas de cada tienda, con una cita textual por dato. La tienda no lo revisó: confírmalo en su sitio antes de comprar.";

export const policiesUrl = (tienda?: string): string => `${guideUrl("politicas")}${tienda === undefined ? "" : `?tienda=${encodeURIComponent(tienda)}`}`;

export const PublicPolicySchema = PolicySchema.omit({ contacto: true }).extend({
  storeId: z.string(),
  store: z.string(),
  domain: z.string(),
  readAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pages: z.array(z.string().url().regex(/^https?:\/\//)),
});
export type PublicPolicy = z.infer<typeof PublicPolicySchema>;

/** A saved policy as the local base holds it. */
export interface SavedPolicy {
  readonly storeId: string;
  readonly pages: readonly string[];
  readonly data: unknown;
  readonly at: string;
}

const bareHost = (u: string): string | undefined => {
  try {
    return new URL(u).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
};

/** A page of the store itself (its domain or a subdomain of it), over http(s). */
export function ownPage(url: string, domain: string): boolean {
  const host = bareHost(url);
  const d = domain.replace(/^www\./, "").toLowerCase();
  return /^https?:\/\//.test(url) && host !== undefined && (host === d || host.endsWith(`.${d}`));
}

/**
 * One public policy per store the guides may name: its saved policy, when in
 * the current format and fresh, with only the quotes and pages of its own
 * site; none when no quote is left.
 */
export function buildPublicPolicies(inputs: readonly GuideInput[], saved: ReadonlyMap<string, SavedPolicy>, today: string): { policy: PublicPolicy; text: string }[] {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - POLICY_MAX_AGE_DAYS * 86_400_000).toISOString();
  const out: { policy: PublicPolicy; text: string }[] = [];
  for (const { store } of keptStores(inputs)) {
    const s = saved.get(store.id);
    if (s === undefined || s.at < cutoff || policyOutdated(s.data)) continue;
    const parsed = PolicySchema.safeParse(s.data);
    if (!parsed.success) continue;
    const { contacto: _contacto, ...rest } = parsed.data;
    const citas = rest.citas.filter((c) => c.cita.trim() !== "" && ownPage(c.url, store.domain));
    const pages = s.pages.filter((p) => ownPage(p, store.domain));
    if (citas.length === 0 || pages.length === 0) continue;
    const policy = PublicPolicySchema.parse({ ...rest, citas, storeId: store.id, store: store.name, domain: store.domain, readAt: s.at.slice(0, 10), pages });
    out.push({ policy, text: searchText(`${store.name} ${store.domain}`) });
  }
  return out;
}

/** The store's domain from what a person may type ("https://www.luminova.cl/x" → "luminova.cl"), or undefined when it is not one. */
export function asDomain(q: string): string | undefined {
  const t = q.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/, 1)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : undefined;
}

const DESDE = { recepcion: "desde que recibes el producto", compra: "desde la compra", no_dice: "" } as const;
const DIAS = { corridos: "corridos", habiles: "hábiles", no_dice: "" } as const;
const SINO = { si: "sí", no: "no", no_dice: "no lo dice" } as const;

function returnsLine(p: PublicPolicy): string {
  const c = p.cambios_y_devoluciones;
  const days = (n: number | null) => (n === null ? "" : ` ${n} días${DIAS[c.tipo_de_dias] === "" ? "" : ` ${DIAS[c.tipo_de_dias]}`}`);
  const parts = [
    `cambio${c.cambio.plazo_dias === null ? ": plazo no lo dice" : `:${days(c.cambio.plazo_dias)}`}${c.cambio.solo_por_falla ? " (solo productos fallados o que no corresponden)" : ""}`,
    `devolución del dinero: ${SINO[c.devolucion_dinero.acepta]}${c.devolucion_dinero.acepta === "si" ? days(c.devolucion_dinero.plazo_dias) : ""}${c.devolucion_dinero.solo_por_falla ? " (solo productos fallados o que no corresponden)" : ""}`,
  ];
  const desde = DESDE[c.plazo_desde];
  return `${c.acepta === "no_dice" ? "no lo dice" : c.acepta === "no" ? "no acepta" : parts.join("; ")}${c.acepta === "si" && desde !== "" ? `, ${desde}` : ""}.`;
}

/** The text an assistant reads: one block per store, the quotes, and the note once. */
export function policiesText(query: string, found: readonly PublicPolicy[]): string {
  if (found.length === 0) return `No tenemos políticas leídas de una tienda que coincida con "${query}". Prueba con el dominio (por ejemplo "tienda.cl") o el nombre exacto.`;
  const blocks = found.map((p) => {
    const d = p.despacho;
    const lines = [
      `${p.store} (${p.domain}), según su sitio, leído el ${p.readAt}:`,
      d.cobertura === "" ? "" : `- Despacho: ${d.cobertura}`,
      d.costo === "" ? "" : `- Costo de despacho: ${d.costo}`,
      ...d.plazos.map((x) => `- Plazo de despacho (${x.zona}): ${x.plazo}`),
      d.retiro_en_tienda === "" ? "" : `- Retiro en tienda: ${d.retiro_en_tienda}`,
      `- Cambios y devoluciones: ${returnsLine(p)}`,
      p.cambios_y_devoluciones.condiciones === "" ? "" : `  Condiciones: ${p.cambios_y_devoluciones.condiciones}`,
      p.garantia === "" ? "" : `- Garantía: ${p.garantia}`,
      p.medios_de_pago.length === 0 ? "" : `- Medios de pago: ${p.medios_de_pago.join("; ")}`,
      p.cuotas === "" ? "" : `- Cuotas: ${p.cuotas}`,
      p.falta.length === 0 ? "" : `- Sus páginas no dicen: ${p.falta.join("; ")}`,
      "Citas:",
      ...p.citas.map((c) => `- ${c.dato}: "${c.cita}" (${c.url})`),
    ];
    return lines.filter((l) => l !== "").join("\n");
  });
  return [...blocks, "", `${POLICY_NOTE} En JSON: ${policiesUrl(query)}`].join("\n\n");
}

/** The JSON answer: the same policies, with the note. */
export function policiesJson(query: string, found: readonly PublicPolicy[]): unknown {
  return {
    query, note: POLICY_NOTE, maxAgeDays: POLICY_MAX_AGE_DAYS,
    results: found.map((p) => ({
      store: p.store, domain: p.domain, readAt: p.readAt, pages: p.pages,
      shipping: p.despacho, returns: p.cambios_y_devoluciones, warranty: p.garantia, payment: p.medios_de_pago, installments: p.cuotas,
      notStated: p.falta, quotes: p.citas,
    })),
  };
}
