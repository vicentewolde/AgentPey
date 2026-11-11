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
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { DEFAULT_MODEL } from "./entender.js";
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

/** Buyer questions for a store's catalogue, without naming the store, so the answer is not led. */
export async function buyerQuestions(client: Anthropic, store: Store, products: readonly Product[], n = 8, model = DEFAULT_MODEL): Promise<string[]> {
  const categories = [...new Set(products.map((p) => p.category).filter((c): c is string => c !== undefined))].slice(0, 25);
  const examples = products.filter((p) => p.price !== undefined).slice(0, 40).map((p) => `${p.title} ($${p.price})`);
  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: "Escribes preguntas que un comprador chileno le haría a un asistente de IA antes de comprar online. Naturales, concretas (presupuesto, uso, despacho, cuotas cuando aplique) y variadas: algunas genéricas ('dónde compro…') y otras de un producto específico. Nunca nombras una tienda.",
    messages: [{ role: "user", content: `Rubro: ${store.rubro}. Categorías: ${categories.join("; ")}.\nEjemplos del catálogo:\n${examples.join("\n")}\n\nEscribe ${n} preguntas.` }],
    output_config: { effort: "low", format: zodOutputFormat(QuestionsSchema) },
  });
  return (response.parsed_output?.preguntas ?? []).slice(0, n);
}

/** Claude answering as a shopping assistant, with web search located in Chile. */
export function claudeEngine(client: Anthropic, model = DEFAULT_MODEL): Engine {
  return {
    name: "claude",
    async ask(question) {
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
      let response: Anthropic.Message | undefined;
      for (let turn = 0; turn < 3; turn++) {
        response = await client.messages.create({
          model,
          max_tokens: 8000,
          system: "Eres un asistente de compras. El usuario está en Chile y quiere comprar online. Recomienda tiendas y productos concretos con enlaces, como lo harías normalmente.",
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "CL" } }],
          messages,
          output_config: { effort: "low" },
        });
        if (response.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: response.content });
      }
      const urls = new Set<string>();
      let text = "";
      for (const block of response?.content ?? []) {
        if (block.type === "text") {
          text += block.text;
          for (const c of block.citations ?? []) if ("url" in c && typeof c.url === "string") urls.add(c.url);
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result") urls.add(r.url);
        }
      }
      return { engine: "claude", text, urls: [...urls] };
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
