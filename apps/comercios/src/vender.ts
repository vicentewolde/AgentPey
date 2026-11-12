/**
 * The AI seller on the store's own site ("Atender"): it answers a shopper with
 * products from the store's catalogue and its approved policies, and nothing
 * else. Retrieval is plain keyword scoring with a price ceiling read from the
 * question; the model chooses among those candidates and must say so when the
 * catalogue or the policies do not answer something.
 */
import { z } from "zod";

import type { Llm } from "./llm.js";
import type { Product, Store } from "./model.js";
import type { Policy } from "./politicas.js";

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const STOP = new Set("de la el los las un una unos unas para con por que en y o a al del mi me se lo le es hay quiero busco necesito tienen tienes algo como cual cuales donde puedo comprar precio hasta menos mas bajo sobre chile envio despacho cuotas mil lucas millones pesos regiones santiago".split(" "));
const PRICE = /(hasta|menos de|bajo|maximo|max\.?|no mas de|presupuesto(?: de)?)\s*([\d.,]+)\s*(millones?|mil|lucas|m\b)?/;

/** Search words of a question, without stop words and without its price phrase. */
export function terms(text: string): string[] {
  const q = fold(text).replace(/\$/g, " ").replace(PRICE, " ");
  return [...new Set(q.split(/[^a-z0-9ñ]+/).filter((t) => t.length > 1 && !STOP.has(t)))];
}

/** Whole-word match for short words ("mil" must not hit "familia"); substring for longer ones ("rascador" hits "rascadores"). */
function hit(haystack: string, word: string): boolean {
  if (word.length >= 5) return haystack.includes(word);
  return new RegExp(`(^|[^a-z0-9ñ])${word}([^a-z0-9ñ]|$)`).test(haystack);
}

/** "hasta $900 mil", "menos de 50.000", "bajo 1,2 millones" → a price ceiling in CLP. */
export function priceCeiling(question: string): number | undefined {
  const q = fold(question).replace(/\$/g, " ");
  const m = PRICE.exec(q);
  if (!m) return undefined;
  const raw = m[2]!;
  const unit = m[3] ?? "";
  if (unit.startsWith("mill")) return Math.round(Number(raw.replace(/\./g, "").replace(",", ".")) * 1_000_000);
  const n = Number(raw.replace(/[.,]/g, ""));
  if (!Number.isFinite(n) || n === 0) return undefined;
  return unit === "mil" || unit === "lucas" ? n * 1000 : n;
}

/**
 * Products scored against a question. A product must match at least half of
 * the question's words (title, category, attributes or description) and score
 * at least 40% of the best match, so a single stray word does not bring in
 * unrelated items.
 */
export function scoreProducts(products: readonly Product[], question: string): { p: Product; score: number }[] {
  const qs = terms(question);
  if (qs.length === 0) return [];
  const ceiling = priceCeiling(question);
  const scored = products
    .filter((p) => ceiling === undefined || p.price === undefined || p.price <= ceiling)
    .map((p) => {
      const title = fold(p.title);
      const cat = fold(p.category ?? "");
      const attrs = fold(Object.entries(p.attributes).map(([a, b]) => `${a} ${b}`).join(" "));
      const desc = fold(p.description.slice(0, 2000));
      let score = 0;
      let matched = 0;
      for (const t of qs) {
        const s = (hit(title, t) ? 3 : 0) + (hit(cat, t) ? 2 : 0) + (hit(attrs, t) ? 1.5 : 0) + (hit(desc, t) ? 1 : 0);
        if (s > 0) matched++;
        score += s;
      }
      if (matched < Math.ceil(qs.length / 2)) score = 0;
      if (p.available === false) score *= 0.3;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return scored.filter((x) => x.score >= best * 0.4);
}

export function searchProducts(products: readonly Product[], question: string, k = 8): Product[] {
  return scoreProducts(products, question).slice(0, k).map((x) => x.p);
}

export const ReplySchema = z.object({
  respuesta: z.string().describe("Lo que le dices al cliente: breve, cordial, español de Chile."),
  recomendados: z.array(z.object({ id: z.string(), por_que: z.string() })).describe("Hasta 3 productos de la lista, con el motivo en una frase."),
  no_se: z.array(z.string()).describe("Lo que el cliente preguntó y la ficha o las políticas no responden."),
});
export type Reply = z.infer<typeof ReplySchema>;

export interface Turn {
  readonly role: "cliente" | "vendedor";
  readonly text: string;
}

function policyText(policy: Policy | undefined): string {
  if (policy === undefined) return "No hay políticas aprobadas: no afirmes nada sobre despacho, cambios, garantía ni cuotas.";
  const d = policy.despacho;
  return [
    `Despacho: ${d.cobertura || "no dice"}. Plazos: ${d.plazos.map((p) => `${p.zona}: ${p.plazo}`).join("; ") || "no dice"}. Costo: ${d.costo || "no dice"}. Retiro: ${d.retiro_en_tienda || "no dice"}.`,
    `Cambios y devoluciones: ${policy.cambios_y_devoluciones.acepta}${policy.cambios_y_devoluciones.plazo_dias ? `, ${policy.cambios_y_devoluciones.plazo_dias} días` : ""}. ${policy.cambios_y_devoluciones.condiciones}`,
    `Garantía: ${policy.garantia || "no dice"}.`,
    `Medios de pago: ${policy.medios_de_pago.join(", ") || "no dice"}. Cuotas: ${policy.cuotas || "no dice"}.`,
    `Contacto: ${policy.contacto || "no dice"}.`,
  ].join("\n");
}

export async function reply(llm: Llm, store: Store, policy: Policy | undefined, candidates: readonly Product[], history: readonly Turn[], question: string): Promise<Reply | undefined> {
  const system = `Eres el vendedor virtual de ${store.name}, una tienda online chilena de ${store.rubro}. Ayudas a elegir y a comprar.
Reglas:
- Recomienda solo productos de la lista que te doy, por su id. Si ninguno calza, dilo y haz una pregunta para afinar.
- Usa solo los datos de la ficha y de las políticas aprobadas. Si algo no está (stock exacto, plazo a una comuna, compatibilidad), no lo inventes: dilo y ponlo en "no_se".
- Precios en pesos chilenos, como "$49.990".
- Respuestas cortas: 2 a 5 frases.`;
  const catalog = candidates.map((p) => JSON.stringify({
    id: p.id, titulo: p.title, precio: p.price, precio_antes: p.compareAtPrice, disponible: p.available, marca: p.brand,
    atributos: p.attributes, descripcion: p.description.slice(0, 700),
  })).join("\n");
  const convo = history.slice(-6).map((t) => `${t.role === "cliente" ? "Cliente" : "Vendedor"}: ${t.text}`).join("\n");
  const user = `Políticas aprobadas:\n${policyText(policy)}\n\nProductos candidatos:\n${catalog || "(ninguno calza con la búsqueda)"}\n\nConversación:\n${convo}\nCliente: ${question}`;
  const out = await llm.structured(ReplySchema, system, user);
  if (out === undefined) return undefined;
  const ids = new Set(candidates.map((p) => p.id));
  return { ...out, recomendados: out.recomendados.filter((r) => ids.has(r.id)).slice(0, 3) };
}

/** The product link with AgentPey's click marker, so a purchase that follows is credited to the channel. */
export function trackedLink(url: string, clickId: string): string {
  const u = new URL(url);
  u.searchParams.set("ap_click", clickId);
  return u.toString();
}
