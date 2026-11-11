/**
 * Problem 2, "que lo entiendan": Claude reads one product the way a shopping
 * assistant would and says what it cannot answer, what contradicts itself and
 * how the listing could read better. It never invents facts: a rewrite only
 * reorders what the store already says, and anything missing goes to the
 * owner as "por confirmar". Nothing is applied until the owner approves it.
 */
import { z } from "zod";

import type { Llm } from "./llm.js";
import type { Product, Store } from "./model.js";

export const AnalysisSchema = z.object({
  entiende: z.string().describe("Una frase: qué producto es y para quién, según lo que dice la ficha."),
  puntaje: z.number().int().min(0).max(10).describe("Qué tan bien puede un asistente de compras recomendar este producto con esta ficha (0 a 10)."),
  problemas: z.array(z.object({
    tipo: z.enum(["falta_dato", "contradiccion", "descripcion_pobre", "titulo_confuso", "condicion_chilena"]),
    detalle: z.string(),
  })),
  preguntas_sin_respuesta: z.array(z.string()).describe("Preguntas reales de un comprador chileno que la ficha no responde."),
  atributos_extraidos: z.array(z.object({
    nombre: z.string(),
    valor: z.string(),
    evidencia: z.string().describe("Cita textual de la ficha que lo respalda."),
  })).describe("Atributos que SÍ están en el texto pero no como dato estructurado."),
  por_confirmar: z.array(z.object({
    nombre: z.string(),
    por_que: z.string(),
  })).describe("Datos que faltan y que solo el dueño puede confirmar."),
  titulo_propuesto: z.string(),
  descripcion_propuesta: z.string().describe("Reescrita SOLO con hechos presentes en la ficha. Sin inventar."),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

const SYSTEM = `Eres el revisor de fichas de producto de AgentPey. Lees una ficha de una tienda online chilena como la leería un asistente de compras con IA (ChatGPT, Gemini, Perplexity) que tiene que decidir si recomendarla.

Reglas:
- No inventes hechos. Si un dato no está en la ficha, no lo afirmes: ponlo en "por_confirmar".
- "atributos_extraidos" solo con datos que aparecen literalmente en la ficha, con su cita en "evidencia".
- "descripcion_propuesta" reordena y aclara lo que la ficha ya dice, en español de Chile, en 80 a 200 palabras, sin superlativos vacíos. Si la ficha no tiene casi nada, la propuesta queda corta: no rellenes.
- "titulo_propuesto": marca + tipo de producto + 1 o 2 atributos clave que estén en la ficha. Máximo 150 caracteres.
- Busca contradicciones (por ejemplo "usado" en el título y "nuevo" en la descripción, o precios distintos).
- "condicion_chilena": falta información que un comprador en Chile pregunta (despacho a regiones, cuotas, garantía legal, boleta o factura), solo si es relevante para el producto.
- "preguntas_sin_respuesta": de 3 a 6, como las haría un comprador real.
- El puntaje mide cuánto puede usar la ficha un asistente, no la calidad del producto.`;

function productForPrompt(store: Store, p: Product): string {
  return JSON.stringify({
    tienda: store.name,
    rubro: store.rubro,
    titulo: p.title,
    precio_clp: p.price,
    precio_antes_clp: p.compareAtPrice,
    disponible: p.available,
    marca: p.brand,
    categoria: p.category,
    etiquetas: p.tags.slice(0, 15),
    atributos: p.attributes,
    variantes: p.variants.slice(0, 10).map((v) => v.title).filter((t) => t !== "" && t !== "Default Title"),
    descripcion: p.description.slice(0, 6000),
    url: p.url,
  }, null, 1);
}

export type AnalyzeResult =
  | { readonly kind: "ok"; readonly analysis: Analysis; readonly model: string }
  | { readonly kind: "skipped"; readonly reason: string };

export async function analyzeProduct(llm: Llm, store: Store, p: Product): Promise<AnalyzeResult> {
  const analysis = await llm.structured(AnalysisSchema, SYSTEM, `Revisa esta ficha:\n\n${productForPrompt(store, p)}`);
  return analysis === undefined ? { kind: "skipped", reason: "sin respuesta en el formato esperado" } : { kind: "ok", analysis, model: llm.name };
}

/** A spread sample: the catalogue sorted by price, then every k-th, so cheap and expensive items both show up. */
export function sampleProducts(products: readonly Product[], n: number): Product[] {
  const priced = [...products].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  if (priced.length <= n) return priced;
  const step = priced.length / n;
  return Array.from({ length: n }, (_, i) => priced[Math.floor(i * step)]!);
}

/** Run `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}
