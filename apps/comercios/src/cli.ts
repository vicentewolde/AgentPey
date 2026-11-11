/**
 * pnpm --filter @agentpey/comercios cli <command>
 *   ingest <storeId|all> [--max N]   read the public catalogue into data/comercios.db
 *   summary                          products per store and last run
 *   report                           readiness per store; writes data/feeds/<id>.jsonl and <id>.llms.txt
 */
import { fileURLToPath } from "node:url";

import { mkdirSync, writeFileSync } from "node:fs";

import { openDb } from "./db.js";
import { llmsTxt, openAiFeed } from "./feeds.js";
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
