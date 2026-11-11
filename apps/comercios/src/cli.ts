/**
 * pnpm --filter @agentpey/comercios cli <command>
 *   ingest <storeId|all> [--max N]   read the public catalogue into data/comercios.db
 *   summary                          products per store and last run
 *   entender <storeId|piloto> [--n 20]   Claude reviews a sample of products (needs ANTHROPIC_API_KEY)
 *   politicas <storeId|piloto|all>       find and structure shipping/returns/warranty pages
 *   diagnostico <storeId|piloto|all> [--n 8]   ask AI assistants buyer questions; does the store show up?
 *   report                           readiness per store; writes data/feeds/<id>.jsonl and <id>.llms.txt
 */
import { fileURLToPath } from "node:url";

import { mkdirSync, writeFileSync } from "node:fs";

import { openDb } from "./db.js";
import { analyzeProduct, pool, sampleProducts } from "./entender.js";
import { createLlm } from "./llm.js";
import { llmsTxt, openAiFeed } from "./feeds.js";
import { extractPolicy, readPolicyPages } from "./politicas.js";
import { buyerQuestions, chatgptEngine, claudeEngine, judge, type Engine } from "./diagnostico.js";
import { readiness } from "./readiness.js";
import { createFetcher } from "./http.js";
import { ingestStore } from "./ingest/index.js";
import { findStore, STORES } from "./stores.js";

const DB_PATH = fileURLToPath(new URL("../data/comercios.db", import.meta.url));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [command, target, ...rest] = argv;
  const db = openDb(DB_PATH);
  try {
    if (command === "ingest" && target !== undefined) {
      const max = Number(flag(rest, "--max") ?? 2000);
      const stores = target === "all" ? STORES : [findStore(target)];
      const fetcher = createFetcher();
      for (const store of stores) {
        const started = Date.now();
        try {
          const result = await ingestStore(store, fetcher, { maxProducts: max, maxPages: Math.min(max, 400), log: (l) => console.error(l) });
          db.replaceCatalogue(store.id, result.products, result.method, result.notes);
          console.log(`${store.id}: ${result.products.length} productos por ${result.method} en ${Math.round((Date.now() - started) / 1000)} s${result.notes.length ? ` · ${result.notes.join(" · ")}` : ""}`);
        } catch (error) {
          console.log(`${store.id}: falló (${(error as Error).message})`);
        }
      }
      return;
    }
    if (command === "summary") {
      for (const store of STORES) {
        const run = db.lastRun(store.id);
        console.log(`${store.id.padEnd(14)} ${store.platform.padEnd(12)} ${run === undefined ? "sin leer" : `${String(run.count).padStart(5)} productos · ${run.method} · ${run.at}`}`);
      }
      return;
    }
    if (command === "entender" && target !== undefined) {
      const n = Number(flag(rest, "--n") ?? 20);
      const llm = createLlm();
      const stores = target === "piloto" ? STORES.filter((s) => s.source === "piloto") : [findStore(target)];
      for (const store of stores) {
        const sample = sampleProducts(db.products(store.id), n);
        const results = await pool(sample, 4, async (p) => {
          try {
            const r = await analyzeProduct(llm, store, p);
            if (r.kind === "ok") {
              db.saveAnalysis(store.id, p.id, r.model, r.analysis);
              return r.analysis.puntaje;
            }
            console.error(`${store.id}/${p.id}: ${r.reason}`);
          } catch (error) {
            console.error(`${store.id}/${p.id}: ${(error as Error).message}`);
          }
          return undefined;
        });
        const scores = results.filter((x): x is number => x !== undefined);
        const avg = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
        console.log(`${store.id}: ${scores.length}/${sample.length} fichas revisadas · puntaje promedio ${avg.toFixed(1)}/10`);
      }
      console.log(`modelo ${llm.name}`);
      return;
    }
    if (command === "politicas" && target !== undefined) {
      const llm = createLlm();
      const fetcher = createFetcher();
      const stores = target === "all" ? STORES : target === "piloto" ? STORES.filter((s) => s.source === "piloto") : [findStore(target)];
      for (const store of stores) {
        try {
          const pages = await readPolicyPages(store, fetcher);
          if (pages.length === 0) {
            console.log(`${store.id}: no se encontraron páginas de políticas`);
            continue;
          }
          const policy = await extractPolicy(llm, store, pages);
          if (policy === undefined) {
            console.log(`${store.id}: no se pudo estructurar`);
            continue;
          }
          db.savePolicy(store.id, llm.name, pages.map((p) => p.url), policy);
          console.log(`${store.id}: ${pages.length} páginas · devoluciones: ${policy.cambios_y_devoluciones.acepta}${policy.cambios_y_devoluciones.plazo_dias ? ` (${policy.cambios_y_devoluciones.plazo_dias} días)` : ""} · falta: ${policy.falta.length}`);
        } catch (error) {
          console.log(`${store.id}: falló (${(error as Error).message})`);
        }
      }
      return;
    }
    if (command === "diagnostico" && target !== undefined) {
      const n = Number(flag(rest, "--n") ?? 8);
      const llm = createLlm();
      const wanted = (flag(rest, "--motores") ?? "claude,chatgpt").split(",");
      const engines: Engine[] = [];
      if (wanted.includes("claude")) engines.push(claudeEngine(llm));
      if (wanted.includes("chatgpt")) engines.push(chatgptEngine());
      const stores = target === "all" ? STORES : target === "piloto" ? STORES.filter((s) => s.source === "piloto") : [findStore(target)];
      for (const store of stores) {
        const products = db.products(store.id);
        let questions: string[];
        try {
          questions = await buyerQuestions(llm, store, products, n);
        } catch (error) {
          console.log(`${store.id}: no se pudieron escribir las preguntas (${(error as Error).message})`);
          continue;
        }
        let mentioned = 0;
        let cited = 0;
        let total = 0;
        const others = new Map<string, number>();
        await pool(questions.flatMap((q) => engines.map((e) => ({ q, e }))), 3, async ({ q, e }) => {
          try {
            const answer = await e.ask(q);
            const v = judge(store, answer);
            db.saveAnswer(store.id, { engine: e.name, question: q, text: answer.text, urls: answer.urls, ...v });
            total++;
            if (v.mentioned) mentioned++;
            if (v.cited) cited++;
            for (const o of v.others.slice(0, 5)) others.set(o, (others.get(o) ?? 0) + 1);
          } catch (error) {
            console.error(`${store.id} · ${e.name} · ${q}: ${(error as Error).message}`);
          }
        });
        const top = [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, c]) => `${h} (${c})`).join(", ");
        console.log(`${store.id} [${engines.map((e) => e.name).join("+")}]: aparece en ${mentioned}/${total} respuestas, citada en ${cited}/${total} · en su lugar: ${top}`);
      }
      return;
    }
    if (command === "report") {
      const dir = fileURLToPath(new URL("../data/feeds/", import.meta.url));
      mkdirSync(dir, { recursive: true });
      console.log("tienda          productos  puntaje  rechazadas por OpenAI  peor punto");
      for (const store of STORES) {
        const products = db.products(store.id);
        if (products.length === 0) continue;
        const r = readiness(store, products);
        const feed = openAiFeed(store, products);
        writeFileSync(`${dir}${store.id}.jsonl`, feed.jsonl);
        writeFileSync(`${dir}${store.id}.llms.txt`, llmsTxt(store, products, `https://agentpey.com/feeds/${store.id}.jsonl`));
        const worst = [...r.checks].sort((a, b) => a.pass - b.pass)[0];
        console.log(`${store.id.padEnd(15)} ${String(r.products).padStart(9)}  ${String(r.score).padStart(7)}  ${String(r.rejected).padStart(21)}  ${worst ? `${worst.label} (${Math.round(worst.pass * 100)}%)` : ""}`);
      }
      return;
    }
    console.error("uso: cli ingest <storeId|all> [--max N] | cli summary | cli report");
    process.exitCode = 2;
  } finally {
    db.close();
  }
}

await main(process.argv.slice(2));
