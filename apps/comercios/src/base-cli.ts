/**
 * pnpm --filter @agentpey/comercios cli base <subcommand>
 *   lista                       read blackfriday.cl's participants; platform and name from each home page
 *   contacto [--todas]          public contact address from each store's own home and contact pages
 *   ingest [--todas] [--max N] [--paralelo N]   read the public catalogues (skips stores already read)
 *   diagnostico [--n 4] [--motores claude,chatgpt] [--desde YYYY-MM-DD] [--limite N] [--paralelo N]
 *                               buyer questions per store; skips stores already answered since --desde
 *                               --fuente cyber,piloto: only stores first listed there (on both lists = blackfriday)
 *                               --leidas: only stores whose catalogue reading has finished
 *                               --repetir <ISO>: ask again the questions answered between <ISO> and --desde
 *   cyber                       add cyber.cl's (CyberDay) brands: same rubros, a store on both lists is kept once
 *   rubros [--n 15] [--desde ISO]   general buyer questions per rubro (no store in mind): who the AI recommends in each rubro
 *   ajustar                     apply data/base/ajustes.json's segments to the stores already in the base
 *   piloto                      add the pilot stores (stores.ts, source "piloto") to the base, in their rubro
 *   comparar [--desde YYYY-MM-DD]   per store and per rubro: data/base/comparacion.json and resumen.md
 *   fichas [--desde YYYY-MM-DD]     data/fichas-bf/<id>.html, <id>-correo.txt and indice.csv
 *
 * Everything it reads or writes is in data/ (git-ignored). Stops at the plan's usage limit.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compare, contactLinks, cyberRubro, isBigMarket, mailableEmail, parseCyber, findEmails, isAffiliate, mainRubro, parseBlackFriday, rankEmails, segmentOf, toStore, type Segment, type StoredAnswer, type StoreInput, type Tienda } from "./base.js";
import type { Db } from "./db.js";
import { buyerQuestions, chatgptEngine, claudeEngine, hostOf, judge, type Engine } from "./diagnostico.js";
import { pool } from "./entender.js";
import { fichaHtml, correoTexto, resumenMd, csvIndex, informeHtml } from "./ficha.js";
import { createFetcher, type Fetcher } from "./http.js";
import type { Platform } from "./model.js";
import { ingestStore } from "./ingest/index.js";
import { createLlm, UsageLimitError } from "./llm.js";
import { detectPlatform, siteName } from "./rapido.js";
import { readiness } from "./readiness.js";
import { STORES } from "./stores.js";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));
const BASE = `${DATA}base/`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function tables(db: Db): void {
  db.raw.exec(`
    create table if not exists tiendas (id text primary key, domain text, data text not null, at text not null);
    create table if not exists rubro_answers (rubro text not null, engine text not null, question text not null, text text not null, urls text not null, at text not null);
    create table if not exists answer_errors (store_id text not null, engine text not null, question text not null, error text not null, at text not null);
  `);
}

export function loadTiendas(db: Db): Tienda[] {
  tables(db);
  return db.raw.prepare("select data from tiendas order by id").all().map((r) => JSON.parse(String(r.data)) as Tienda);
}

function saveTienda(db: Db, t: Tienda): void {
  db.raw.prepare("insert or replace into tiendas (id, domain, data, at) values (?, ?, ?, ?)").run(t.id, t.domain ?? null, JSON.stringify(t), new Date().toISOString());
}

const today = () => new Date().toISOString().slice(0, 10);

export async function baseCommand(db: Db, sub: string | undefined, rest: string[]): Promise<void> {
  tables(db);
  mkdirSync(BASE, { recursive: true });
  const fetcher = createFetcher();
  if (sub === "lista") return lista(db, fetcher);
  if (sub === "contacto") return contacto(db, fetcher, rest.includes("--todas"));
  if (sub === "ingest") return ingest(db, fetcher, rest);
  if (sub === "diagnostico") return diagnostico(db, rest);
  if (sub === "piloto") return piloto(db);
  if (sub === "cyber") return cyber(db, fetcher);
  if (sub === "ajustar") return ajustar(db);
  if (sub === "rubros") return rubros(db, rest);
  if (sub === "comparar" || sub === "fichas") return comparar(db, rest, sub === "fichas");
  console.error("uso: cli base lista | contacto | ingest | diagnostico | comparar | fichas");
  process.exitCode = 2;
}

/** Overrides kept in data/base/ajustes.json: {"segmento": {"slug": "grande"}, "dominio": {"slug": "tienda.cl"}}. */
function ajustes(): { segmento: Record<string, Segment>; dominio: Record<string, string> } {
  const path = `${BASE}ajustes.json`;
  if (!existsSync(path)) return { segmento: {}, dominio: {} };
  const j = JSON.parse(readFileSync(path, "utf8")) as { segmento?: Record<string, Segment>; dominio?: Record<string, string> };
  return { segmento: j.segmento ?? {}, dominio: j.dominio ?? {} };
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function lista(db: Db, fetcher: Fetcher): Promise<void> {
  const page = await fetcher.text("https://www.blackfriday.cl/");
  if (page.status !== 200) throw new Error(`blackfriday.cl respondió ${page.status}`);
  writeFileSync(`${BASE}blackfriday-${today()}.html`, page.body);
  const entries = parseBlackFriday(page.body);
  const adj = ajustes();
  const known = new Map(loadTiendas(db).map((t) => [t.id, t]));
  const rows = await pool(entries, 6, async (e) => {
    // The domain: the listed link, unless it is an affiliate redirect (not followed: it would count as a click);
    // then a store already in the demo with the same name, then a manual override.
    const byName = STORES.find((s) => fold(s.name) === fold(e.name) || fold(s.id) === fold(e.slug));
    const direct = isAffiliate(e.link) || /mercadolibre/.test(e.link) ? undefined : hostOf(e.link);
    const domain = adj.dominio[e.slug] ?? direct ?? (byName ? hostOf(byName.origin) : undefined);
    const existing = STORES.find((s) => domain !== undefined && hostOf(s.origin) === domain);
    const id = existing?.id ?? e.slug;
    const segment = segmentOf(e, domain, adj.segmento);
    let origin = domain === undefined ? undefined : existing?.origin ?? `https://${domain}`;
    let platform = existing?.platform;
    let name = e.name;
    const notes: string[] = [];
    if (domain !== undefined && segment === "pyme") {
      try {
        let home = await fetcher.text(`https://${domain}/`).catch(() => ({ status: 0, body: "", url: "" }));
        // Some sites answer only on www (or only without it).
        if (home.status !== 200 && !domain.startsWith("www.")) home = await fetcher.text(`https://www.${domain}/`);
        if (home.status === 200) {
          origin = new URL(home.url).origin;
          platform = detectPlatform(home.body);
          if (existing === undefined && name.length < 3) name = siteName(home.body, domain);
          const mails = findEmails(home.body);
          if (mails.length > 0) notes.push(`correos en portada: ${mails.length}`);
        } else notes.push(`portada: HTTP ${home.status}`);
      } catch (error) {
        notes.push(`portada: ${(error as Error).message.slice(0, 120)}`);
      }
    }
    const prev = known.get(id);
    const t: Tienda = {
      id, domain, origin, name, rubro: mainRubro(e.categories), categories: e.categories, ...(e.sells ? { sells: e.sells } : {}),
      platform, segment, bfSlug: e.slug, bfLink: e.link, ...(prev?.emails ? { emails: prev.emails } : {}), checkedAt: new Date().toISOString(), notes,
    };
    saveTienda(db, t);
    console.log(`${id.padEnd(28)} ${segment.padEnd(11)} ${(platform ?? "-").padEnd(12)} ${domain ?? "(sin dominio)"} · ${t.rubro}`);
    return t;
  });
  // A brand that left the list (or changed id) leaves the base; its catalogue and answers stay in their tables.
  const current = new Set(rows.map((t) => t.id));
  for (const t of known.values()) if (!current.has(t.id) && t.bfSlug !== "" && !(t.sources ?? []).some((x) => x !== "blackfriday")) db.raw.prepare("delete from tiendas where id = ?").run(t.id);
  const by = (s: Segment) => rows.filter((t) => t.segment === s).length;
  console.log(`\n${rows.length} marcas: ${by("pyme")} pymes con dominio, ${by("grande")} grandes, ${by("no-tienda")} sin catálogo (inmobiliarias, viajes, servicios), ${by("sin-dominio")} sin dominio`);
  writeFileSync(`${BASE}tiendas.json`, JSON.stringify(loadTiendas(db), null, 2));
}

/** Platform, final origin and notes from a store's home page (www and bare domain both tried). */
async function homeInfo(fetcher: Fetcher, domain: string): Promise<{ origin?: string; platform?: Platform; notes: string[] }> {
  const notes: string[] = [];
  try {
    let home = await fetcher.text(`https://${domain}/`).catch(() => ({ status: 0, body: "", url: "" }));
    if (home.status !== 200 && !domain.startsWith("www.")) home = await fetcher.text(`https://www.${domain}/`);
    if (home.status === 200) return { origin: new URL(home.url).origin, platform: detectPlatform(home.body), notes };
    notes.push(`portada: HTTP ${home.status}`);
  } catch (error) {
    notes.push(`portada: ${(error as Error).message.slice(0, 120)}`);
  }
  return { notes };
}

async function cyber(db: Db, fetcher: Fetcher): Promise<void> {
  const page = await fetcher.text("https://www.cyber.cl/");
  if (page.status !== 200) throw new Error(`cyber.cl respondió ${page.status}`);
  writeFileSync(`${BASE}cyber-${today()}.html`, page.body);
  const entries = parseCyber(page.body);
  const adj = ajustes();
  const known = loadTiendas(db);
  let added = 0;
  let merged = 0;
  await pool(entries, 6, async (e) => {
    const domain = hostOf(e.url.replace(/\\u0026/g, "&"));
    if (domain === undefined) return;
    const same = known.find((t) => t.domain !== undefined && t.domain.replace(/^www\./, "") === domain);
    if (same !== undefined) {
      saveTienda(db, { ...same, sources: [...new Set([...(same.sources ?? ["blackfriday"]), "cyber" as const])] });
      merged++;
      return;
    }
    const slug = `cy-${fold(e.name).slice(0, 30) || e.id}`;
    const r = cyberRubro(e.category);
    const segment: Segment = adj.segmento[slug] ?? (isBigMarket(domain) ? "grande" : r.segment);
    const info = segment === "pyme" ? await homeInfo(fetcher, domain) : { notes: [] as string[] };
    const t: Tienda = {
      id: slug, domain, origin: info.origin ?? `https://${domain}`, name: e.name, rubro: r.rubro, categories: [e.category],
      platform: info.platform, segment, bfSlug: "", bfLink: e.url, sources: ["cyber"], checkedAt: new Date().toISOString(), notes: info.notes,
    };
    saveTienda(db, t);
    added++;
    console.log(`${slug.padEnd(28)} ${segment.padEnd(10)} ${(t.platform ?? "-").padEnd(12)} ${domain} · ${t.rubro}`);
  });
  console.log(`\ncyber.cl: ${entries.length} marcas · ${added} nuevas en la base · ${merged} ya estaban (Black Friday)`);
  writeFileSync(`${BASE}tiendas.json`, JSON.stringify(loadTiendas(db), null, 2));
}

export function rubroAnswers(db: Db, since: string): Map<string, StoredAnswer[]> {
  tables(db);
  const out = new Map<string, StoredAnswer[]>();
  for (const r of db.raw.prepare("select rubro, engine, question, text, urls, at from rubro_answers where at >= ?").all(since)) {
    const a = { engine: String(r.engine), question: String(r.question), text: String(r.text), urls: JSON.parse(String(r.urls)) as string[], at: String(r.at) };
    out.set(String(r.rubro), [...(out.get(String(r.rubro)) ?? []), a]);
  }
  return out;
}

/**
 * Questions about the rubro, not about one store: the same for every store of
 * the rubro, so they show who the AI recommends when nobody is named. The
 * questions are written from products of several stores of the rubro.
 */
async function rubros(db: Db, rest: string[]): Promise<void> {
  const n = Number(flag(rest, "--n") ?? 15);
  const since = flag(rest, "--desde") ?? today();
  const llm = createLlm("cuenta");
  const engine = claudeEngine(llm);
  const tiendas = loadTiendas(db).filter((t) => t.segment === "pyme" && t.origin !== undefined);
  const done = rubroAnswers(db, since);
  const names = [...new Set(tiendas.map((t) => t.rubro))].filter((r) => tiendas.filter((t) => t.rubro === r).length >= 3 && (done.get(r)?.length ?? 0) === 0);
  console.log(`${names.length} rubros por preguntar (${n} preguntas cada uno)`);
  let stopped: string | undefined;
  for (const rubro of names) {
    if (stopped !== undefined) break;
    const sample = tiendas.filter((t) => t.rubro === rubro).flatMap((t) => db.products(t.id).slice(0, 6)).sort(() => Math.random() - 0.5).slice(0, 40);
    let questions: string[];
    try {
      questions = await buyerQuestions(llm, { id: "rubro", name: rubro, origin: "https://rubro.invalid", platform: "propia", rubro: `${rubro} (tiendas online chilenas)`, source: "black-friday", sellsOnline: true }, sample, n);
    } catch (error) {
      if (error instanceof UsageLimitError) stopped = error.message;
      console.log(`${rubro}: no se pudieron escribir las preguntas (${(error as Error).message.slice(0, 160)})`);
      continue;
    }
    let ok = 0;
    await pool(questions, 5, async (q) => {
      if (stopped !== undefined) return;
      try {
        const a = await engine.ask(q);
        db.raw.prepare("insert into rubro_answers (rubro, engine, question, text, urls, at) values (?, ?, ?, ?, ?, ?)").run(rubro, engine.name, q, a.text, JSON.stringify(a.urls), new Date().toISOString());
        ok++;
      } catch (error) {
        if (error instanceof UsageLimitError) stopped = (error as Error).message;
        console.error(`${rubro} · ${(error as Error).message.slice(0, 160)}`);
      }
    });
    console.log(`${rubro}: ${ok}/${questions.length} respuestas`);
  }
  if (stopped !== undefined) {
    console.log(`\nSe detuvo por el límite de uso: ${stopped}`);
    process.exitCode = 3;
  }
}

function ajustar(db: Db): void {
  const adj = ajustes();
  let n = 0;
  for (const t of loadTiendas(db)) {
    const forced = adj.segmento[t.id] ?? adj.segmento[t.bfSlug];
    if (forced !== undefined && forced !== t.segment) {
      saveTienda(db, { ...t, segment: forced });
      n++;
    }
  }
  console.log(`${n} tiendas cambiaron de segmento`);
}

/** The pilot's own stores are not on blackfriday.cl; they join the base in the closest blackfriday.cl category. */
const PILOT_RUBRO: Readonly<Record<string, string>> = {
  bestmart: "Tecnología y Gaming", csbyte: "Tecnología y Gaming", pethome: "Mascotas", felinus: "Mascotas",
  homemobili: "Hogar y Decoración", luminova: "Hogar y Decoración",
};

function piloto(db: Db): void {
  for (const s of STORES.filter((x) => PILOT_RUBRO[x.id] !== undefined)) {
    const prev = loadTiendas(db).find((t) => t.id === s.id);
    const rubro = PILOT_RUBRO[s.id]!;
    saveTienda(db, {
      id: s.id, domain: hostOf(s.origin), origin: s.origin, name: s.name, rubro, categories: [rubro], sells: s.rubro,
      platform: s.platform, segment: "pyme", bfSlug: "", bfLink: "", ...(prev?.emails ? { emails: prev.emails } : {}),
      checkedAt: new Date().toISOString(), sources: ["piloto"], notes: ["tienda del piloto, no está en blackfriday.cl"],
    });
    console.log(`${s.id}: ${rubro}`);
  }
}

async function contacto(db: Db, fetcher: Fetcher, all: boolean): Promise<void> {
  const targets = loadTiendas(db).filter((t) => t.segment === "pyme" && t.origin !== undefined && (all || t.emails === undefined));
  await pool(targets, 6, async (t) => {
    const found: { email: string; page: string }[] = [];
    const add = (emails: string[], page: string) => {
      for (const e of emails) if (!found.some((f) => f.email === e)) found.push({ email: e, page });
    };
    try {
      const home = await fetcher.text(`${t.origin}/`);
      add(findEmails(home.body), home.url);
      for (const link of contactLinks(home.body, home.url)) {
        if (found.length >= 3) break;
        try {
          const p = await fetcher.text(link);
          if (p.status === 200) add(findEmails(p.body), p.url);
        } catch {
          /* a contact page that fails is skipped */
        }
      }
    } catch (error) {
      console.log(`${t.id}: no se pudo leer (${(error as Error).message.slice(0, 100)})`);
    }
    const order = rankEmails(found.map((f) => f.email), t.domain);
    const emails = order.map((e) => found.find((f) => f.email === e)!);
    saveTienda(db, { ...t, emails });
    console.log(`${t.id}: ${emails.length === 0 ? "sin correo público" : emails.map((e) => e.email).join(", ")}`);
  });
}

async function ingest(db: Db, fetcher: Fetcher, rest: string[]): Promise<void> {
  const max = Number(flag(rest, "--max") ?? 1500);
  const pages = Number(flag(rest, "--paginas") ?? 200);
  const only = flag(rest, "--solo")?.split(",");
  const targets = loadTiendas(db).filter((t) => t.segment === "pyme" && t.origin !== undefined && (only === undefined ? rest.includes("--todas") || db.lastRun(t.id) === undefined : only.includes(t.id)));
  console.log(`${targets.length} catálogos por leer`);
  await pool(targets, Number(flag(rest, "--paralelo") ?? 6), async (t) => {
    const started = Date.now();
    try {
      const result = await ingestStore(toStore(t), fetcher, { maxProducts: max, maxPages: pages });
      db.replaceCatalogue(t.id, result.products, result.method, result.notes);
      console.log(`${t.id}: ${result.products.length} productos por ${result.method} en ${Math.round((Date.now() - started) / 1000)} s${result.notes.length ? ` · ${result.notes.slice(0, 3).join(" · ")}` : ""}`);
    } catch (error) {
      db.replaceCatalogue(t.id, [], "falló", [(error as Error).message.slice(0, 200)]);
      console.log(`${t.id}: falló (${(error as Error).message.slice(0, 200)})`);
    }
  });
}

function answeredSince(db: Db, id: string, since: string): number {
  return Number(db.raw.prepare("select count(*) n from answers where store_id = ? and at >= ?").get(id, since)?.n ?? 0);
}

async function diagnostico(db: Db, rest: string[]): Promise<void> {
  const n = Number(flag(rest, "--n") ?? 4);
  const since = flag(rest, "--desde") ?? today();
  const limit = Number(flag(rest, "--limite") ?? 1000);
  const llm = createLlm("cuenta");
  const wanted = (flag(rest, "--motores") ?? "claude,chatgpt").split(",");
  const engines: Engine[] = [];
  if (wanted.includes("claude")) engines.push(claudeEngine(llm));
  if (wanted.includes("chatgpt")) engines.push(chatgptEngine());
  const only = flag(rest, "--solo")?.split(",");
  const repeat = flag(rest, "--repetir");
  const fuentes = flag(rest, "--fuente")?.split(",");
  // Stores with a readable catalogue first, bigger catalogues first; then the rest.
  const targets = loadTiendas(db)
    .filter((t) => t.segment === "pyme" && t.origin !== undefined && (only === undefined || only.includes(t.id)) && (fuentes === undefined || fuentes.includes((t.sources ?? ["blackfriday"])[0]!)) && (!rest.includes("--leidas") || db.lastRun(t.id) !== undefined) && answeredSince(db, t.id, since) === 0)
    .map((t) => ({ t, count: db.lastRun(t.id)?.count ?? 0 }))
    .sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || a.t.rubro.localeCompare(b.t.rubro))
    .slice(0, limit);
  console.log(`${targets.length} tiendas por diagnosticar (${n} preguntas × ${engines.map((e) => e.name).join("+")}), desde ${since}`);
  let stopped: string | undefined;
  await pool(targets, Number(flag(rest, "--paralelo") ?? 2), async ({ t }) => {
    if (stopped !== undefined) return;
    const store = toStore(t);
    const products = db.products(t.id);
    let questions: string[];
    // A repeat sample asks the very same questions again, to see how much the answers move.
    const again = repeat === undefined ? [] : [...new Set(db.answers(t.id).filter((a) => a.at >= repeat && a.at < since).map((a) => a.question))];
    if (repeat !== undefined && again.length === 0) return;
    try {
      questions = again.length > 0 ? again : await buyerQuestions(llm, store, products, n);
    } catch (error) {
      if (error instanceof UsageLimitError) stopped = error.message;
      console.log(`${t.id}: no se pudieron escribir las preguntas (${(error as Error).message})`);
      return;
    }
    let mentioned = 0;
    let total = 0;
    await pool(questions.flatMap((q) => engines.map((e) => ({ q, e }))), 4, async ({ q, e }) => {
      if (stopped !== undefined) return;
      try {
        const answer = await e.ask(q);
        const v = judge(store, answer);
        db.saveAnswer(t.id, { engine: e.name, question: q, text: answer.text, urls: answer.urls, ...v });
        total++;
        if (v.mentioned) mentioned++;
      } catch (error) {
        const message = (error as Error).message;
        if (error instanceof UsageLimitError) stopped = message;
        db.raw.prepare("insert into answer_errors (store_id, engine, question, error, at) values (?, ?, ?, ?, ?)").run(t.id, e.name, q, message.slice(0, 500), new Date().toISOString());
        console.error(`${t.id} · ${e.name}: ${message.slice(0, 200)}`);
      }
    });
    console.log(`${t.id} (${t.rubro}): aparece en ${mentioned}/${total} respuestas`);
  });
  if (stopped !== undefined) {
    console.log(`\nSe detuvo por el límite de uso: ${stopped}\nLo respondido quedó guardado; se retoma con el mismo comando.`);
    process.exitCode = 3;
  }
}

function comparar(db: Db, rest: string[], fichas: boolean): void {
  const since = flag(rest, "--desde") ?? today();
  const tiendas = loadTiendas(db).filter((t) => t.segment === "pyme" && t.origin !== undefined);
  const inputs: StoreInput[] = tiendas.map((t) => {
    const store = toStore(t);
    const products = db.products(t.id);
    const answers = db.answers(t.id).filter((a) => a.at >= since);
    const failed = Number(db.raw.prepare("select count(*) n from answer_errors where store_id = ? and at >= ?").get(t.id, since)?.n ?? 0);
    return { tienda: t, store: { ...store, rubro: t.rubro }, readiness: products.length > 0 ? readiness(store, products) : undefined, products: products.length, answers, failed };
  });
  const results = compare(inputs, rubroAnswers(db, since));
  const runs = new Map(tiendas.map((t) => [t.id, db.lastRun(t.id)]));
  const dates = inputs.flatMap((i) => i.answers.map((a) => a.at.slice(0, 10))).sort();
  const period = dates.length === 0 ? "sin respuestas" : dates[0] === dates.at(-1) ? dates[0]! : `${dates[0]} a ${dates.at(-1)}`;
  writeFileSync(`${BASE}comparacion.json`, JSON.stringify({ desde: since, periodo: period, tiendas: results, lectura: Object.fromEntries(runs) }, null, 2));
  writeFileSync(`${BASE}resumen.md`, resumenMd(results, tiendas, runs, period));
  console.log(`${BASE}comparacion.json y resumen.md · ${results.length} tiendas · respuestas ${period}`);
  if (!fichas) return;
  const dir = `${DATA}fichas-bf/`;
  mkdirSync(dir, { recursive: true });
  const rows: string[][] = [];
  for (const r of results) {
    const t = tiendas.find((x) => x.id === r.id)!;
    const run = runs.get(r.id);
    const html = fichaHtml(r, t, run, period);
    writeFileSync(`${dir}${r.id}.html`, html);
    writeFileSync(`${dir}${r.id}-correo.txt`, correoTexto(r, t, period));
    writeFileSync(`${dir}${r.id}-informe.html`, informeHtml(r, t, run, period));
    rows.push([r.name, r.domain, r.rubro, r.platform, String(r.products), r.score === undefined ? "sin leer" : String(r.score), r.answers === 0 ? "sin diagnóstico" : `${r.mentioned}/${r.answers}`, String(r.cited), mailableEmail(t.emails, t.domain)?.email ?? "", mailableEmail(t.emails, t.domain)?.page ?? "", `fichas-bf/${r.id}.html`]);
  }
  writeFileSync(`${dir}indice.csv`, csvIndex(["tienda", "dominio", "rubro", "plataforma", "productos_leidos", "puntaje", "aparece", "citada_como_fuente", "correo_contacto", "correo_fuente", "ficha"], rows));
  console.log(`${dir}: ${results.length} fichas e indice.csv`);
  // Every brand looked at, for finding the right person later (Apollo or by hand): the target ones first.
  const all = loadTiendas(db).sort((a, b) => Number(b.segment === "pyme") - Number(a.segment === "pyme") || a.rubro.localeCompare(b.rubro));
  const byId = new Map(results.map((r) => [r.id, r]));
  writeFileSync(`${BASE}lista-empresas.csv`, csvIndex(
    ["empresa", "dominio", "rubro", "segmento", "fuente", "plataforma", "puntaje", "recomendada_con_su_sitio", "marca_sin_sitio", "correo_publico", "correo_fuente", "otros_correos_vistos"],
    all.map((t) => {
      const r = byId.get(t.id);
      const mail = mailableEmail(t.emails, t.domain);
      return [t.name, t.domain ?? "", t.rubro, t.segment, (t.sources ?? ["blackfriday"]).join("+"), t.platform ?? "",
        r?.score === undefined ? "" : String(r.score), r === undefined || r.answers === 0 ? "" : `${r.mentioned}/${r.answers}`, r?.brandOnly ? String(r.brandOnly) : "",
        mail?.email ?? "", mail?.page ?? "", (t.emails ?? []).map((e) => e.email).filter((e) => e !== mail?.email).join(" ")];
    }),
  ));
  console.log(`${BASE}lista-empresas.csv: ${all.length} empresas`);
}
