/**
 * Problem 4a, "¿te recomiendan?": ask AI assistants the questions a Chilean
 * buyer would ask, with web search on, and record whether the store shows up,
 * whether it is cited as a source, and which other stores appear instead.
 *
 * Engines are pluggable. Claude (with web search) runs with the Anthropic key
 * already in the project; ChatGPT, Gemini and Perplexity are added when their
 * keys exist. Answers vary from run to run, so a diagnosis is a sample with a
 * date, never a ranking promise.
 */
import { z } from "zod";

import type { Llm } from "./llm.js";
import type { Product, Store } from "./model.js";

export interface EngineAnswer {
  readonly engine: string;
  readonly text: string;
  /** URLs the engine cited or searched. */
  readonly urls: readonly string[];
}

export interface Engine {
  readonly name: string;
  ask(question: string): Promise<EngineAnswer>;
}

const QuestionsSchema = z.object({
  preguntas: z.array(z.string()).describe("Preguntas de compra reales, en español de Chile, sin nombrar ninguna tienda."),
});

const QUESTIONS_SYSTEM = "Escribes preguntas que un comprador chileno le haría a un asistente de IA antes de comprar online. Naturales, concretas (presupuesto, uso, despacho, cuotas cuando aplique) y variadas: algunas genéricas ('dónde compro…') y otras de un producto específico. Nunca nombras una tienda.";

/** Buyer questions for a store's catalogue, without naming the store, so the answer is not led. */
export async function buyerQuestions(llm: Llm, store: Store, products: readonly Product[], n = 8): Promise<string[]> {
  const categories = [...new Set(products.map((p) => p.category).filter((c): c is string => c !== undefined))].slice(0, 25);
  const examples = products.filter((p) => p.price !== undefined).slice(0, 40).map((p) => `${p.title} ($${p.price})`);
  const out = await llm.structured(QuestionsSchema, QUESTIONS_SYSTEM, `Rubro: ${store.rubro}. Categorías: ${categories.join("; ")}.\nEjemplos del catálogo:\n${examples.join("\n")}\n\nEscribe ${n} preguntas.`);
  return (out?.preguntas ?? []).slice(0, n);
}

const ASSISTANT_SYSTEM = "Eres un asistente de compras. El usuario está en Chile y quiere comprar online. Recomienda tiendas y productos concretos con enlaces, como lo harías normalmente.";

/** Claude answering as a shopping assistant, with web search (through the subscription or the API). */
export function claudeEngine(llm: Llm): Engine {
  return {
    name: "claude",
    async ask(question) {
      const r = await llm.searchAnswer(ASSISTANT_SYSTEM, question);
      return { engine: "claude", text: r.text, urls: r.urls };
    },
  };
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export interface Verdict {
  /** The store's name or domain appears in the answer text. */
  readonly mentioned: boolean;
  /** One of the store's pages is among the cited or searched URLs. */
  readonly cited: boolean;
  /** Other stores' domains in the URLs, most frequent first. */
  readonly others: readonly string[];
}

const NOT_STORES = /(^|\.)(google|youtube|wikipedia|reddit|facebook|instagram|tiktok|x|twitter|linkedin|bing|duckduckgo|blogspot|medium)\./;

export function judge(store: Store, answer: EngineAnswer): Verdict {
  const domain = hostOf(store.origin)!;
  const text = fold(answer.text);
  const name = fold(store.name);
  const mentioned = text.includes(domain) || (name.length >= 4 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  const hosts = answer.urls.map(hostOf).filter((h): h is string => h !== undefined);
  const cited = hosts.some((h) => h === domain || h.endsWith(`.${domain}`));
  const counts = new Map<string, number>();
  for (const h of hosts) if (h !== domain && !NOT_STORES.test(`${h}.`)) counts.set(h, (counts.get(h) ?? 0) + 1);
  return { mentioned, cited, others: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h) };
}
