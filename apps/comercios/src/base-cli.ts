/**
 * pnpm --filter @agentpey/comercios cli base <subcommand>
 *   lista                       read blackfriday.cl's participants; platform and name from each home page
 *   contacto [--todas]          public contact address from each store's own home and contact pages
 *   ingest [--todas] [--max N] [--paralelo N] [--segmento pyme|grande]   read the public catalogues (skips stores already read);
 *                               --segmento grande: big stores and brands, kept as comparison data (never in guides, brands or search)
 *                               a re-read that fails or reads under half keeps the previous one (semanal.ts)
 *   diagnostico [--n 4] [--motores claude,chatgpt] [--desde YYYY-MM-DD] [--limite N] [--paralelo N]
 *                               buyer questions per store; skips stores already answered since --desde
 *                               --fuente cyber,piloto: only stores first listed there (on both lists = blackfriday)
 *                               --leidas: only stores whose catalogue reading has finished
 *                               --repetir <ISO>: ask again the questions answered between <ISO> and --desde
 *   cyber                       add cyber.cl's (CyberDay) brands: same rubros, a store on both lists is kept once
 *   blackfriday-anterior --archivo <copia.html> ...   past editions' brands (2022–2026) from the Internet Archive's
 *                               copies of blackfriday.cl's home and cyber pages; a store already in the base only gains the mark
 *   rubros [--n 15] [--desde ISO]   general buyer questions per rubro (no store in mind): who the AI recommends in each rubro
 *                               --repetir <ISO>: ask again the questions answered between <ISO> and --desde
 *                               --solo "Rubro A,Rubro B": only these rubros
 *   medir-guia [--desde ISO] [--hasta ISO]   per guide rubro: answers, how many cite agentpey.com, domains cited
 *   ajustar                     apply data/base/ajustes.json's segments to the stores already in the base
 *   piloto                      add the pilot stores (stores.ts, source "piloto") to the base, in their rubro
 *   comparar [--desde YYYY-MM-DD]   per store and per rubro: data/base/comparacion.json and resumen.md
 *   fichas [--desde YYYY-MM-DD]     data/fichas-bf/<id>.html, <id>-correo.txt and indice.csv
 *   guia [--rubros slug,slug]   the public guides (guia.ts) from the catalogues already read: saved in the
 *                               local base (table guias) for setup-postgres, and a preview in data/guias/<slug>.html;
 *                               also every brand two or more public stores sell (marcas.ts, table marcas)
 *   politicas [--max N] [--paralelo 3] [--hasta HH:MM] [--dias 30] [--solo id,id]
 *                               each public store's shipping, returns, warranty and payment pages, structured
 *                               by Claude with a quote per claim (politicas.ts); saved as "propuesta", never
 *                               published by this. Skips stores tried in the last --dias days; the night shift
 *                               (scripts/noche.sh) runs it until the plan's limit, --hasta or --max
 *   indexnow                    tell Bing and the other IndexNow engines every URL of the live sitemap (after publishing)
 *
 * Everything it reads or writes is in data/ (git-ignored), or in COMERCIOS_DATA when set (the weekly job, scripts/semanal.sh). Stops at the plan's usage limit.
 */
import { z } from "zod";

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

import { compare, contactLinks, cyberRubro, isBigMarket, mailableEmail, parseCyber, findEmails, isAffiliate, mainRubro, parseBlackFriday, parseBlackFridayGallery, rankEmails, segmentOf, toStore, type BfEntry, type Segment, type StoredAnswer, type StoreInput, type Tienda } from "./base.js";
import { localDataDir, type Db } from "./db.js";
import { buyerQuestions, chatgptEngine, claudeEngine, hostOf, judge, type Engine } from "./diagnostico.js";
import { pool } from "./entender.js";
import { fichaHtml, correoTexto, resumenMd, csvIndex, informeHtml } from "./ficha.js";
import { buildGuide, citations, freshReadAt, GUIDE_ORIGIN, GUIDE_RUBROS, guideHtml, guideUrl, guidesIndexHtml, INDEXNOW_KEY, indexNowKeyUrl } from "./guia.js";
import { brandHtml, brandsIndexHtml, buildBrandPages, summarize } from "./marcas.js";
import { createFetcher, type Fetcher } from "./http.js";
import { BIG_STORES, bigPriceRows, mayBeOneOf, readBigStore } from "./grandes.js";
import type { Platform } from "./model.js";
import { ingestStore } from "./ingest/index.js";
import { createLlm, UsageLimitError } from "./llm.js";
import { deadline, nightSummary, policyTargets, retryBusy, type StopReason } from "./noche.js";
import { extractPolicy, policyOutdated, readPolicyPages } from "./politicas.js";
import { buildPublicPolicies } from "./politicas-publicas.js";
import { detectPlatform, siteName } from "./rapido.js";
import { readiness } from "./readiness.js";
import { buildPriceRows } from "./precios.js";
import { isCodeKey, matchByCode, matchProducts, ProductGroupSchema } from "./productos.js";
import { rereadVerdict } from "./semanal.js";
import { STORES } from "./stores.js";

const DATA = localDataDir();
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
    create table if not exists policy_attempts (store_id text primary key, result text not null, detail text, at text not null);
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
  if (sub === "cyber") return cyber(db, fetcher, rest);
  if (sub === "blackfriday-anterior") return blackfridayAnterior(db, fetcher, rest);
  if (sub === "grandes") return grandes(db, fetcher, rest);
  if (sub === "ajustar") return ajustar(db);
  if (sub === "rubros") return rubros(db, rest);
  if (sub === "comparar" || sub === "fichas") return comparar(db, rest, sub === "fichas");
  if (sub === "guia") return guia(db, rest);
  if (sub === "medir-guia") return medirGuia(db, rest);
  if (sub === "indexnow") return indexNow();
  if (sub === "politicas") return politicas(db, fetcher, rest);
  console.error("uso: cli base lista | contacto | ingest | diagnostico | comparar | fichas | guia | medir-guia | indexnow");
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
  // One also on another list stays, now as a past participant of blackfriday.cl.
  for (const t of known.values()) {
    if (current.has(t.id) || t.bfSlug === "") continue;
    const sources = t.sources ?? ["blackfriday"];
    if (!sources.some((x) => x !== "blackfriday")) db.raw.prepare("delete from tiendas where id = ?").run(t.id);
    else if (sources.includes("blackfriday")) saveTienda(db, { ...t, sources: [...new Set(sources.map((x) => (x === "blackfriday" ? ("blackfriday-anterior" as const) : x)))] });
  }
  const by = (s: Segment) => rows.filter((t) => t.segment === s).length;
  console.log(`\n${rows.length} marcas: ${by("pyme")} pymes con dominio, ${by("grande")} grandes, ${by("no-tienda")} sin catálogo (inmobiliarias, viajes, servicios), ${by("sin-dominio")} sin dominio`);
  writeFileSync(`${BASE}tiendas.json`, JSON.stringify(loadTiendas(db), null, 2));
}

/** Platform, final origin and notes from a store's home page (www and bare domain both tried). */
async function homeInfo(fetcher: Fetcher, domain: string): Promise<{ origin?: string; platform?: Platform; name?: string; notes: string[] }> {
  const notes: string[] = [];
  try {
    let home = await fetcher.text(`https://${domain}/`).catch(() => ({ status: 0, body: "", url: "" }));
    if (home.status !== 200 && !domain.startsWith("www.")) home = await fetcher.text(`https://www.${domain}/`);
    if (home.status === 200) return { origin: new URL(home.url).origin, platform: detectPlatform(home.body), name: siteName(home.body, domain), notes };
    notes.push(`portada: HTTP ${home.status}`);
  } catch (error) {
    notes.push(`portada: ${(error as Error).message.slice(0, 120)}`);
  }
  return { notes };
}

/**
 * cyber.cl's brands into the base. With `--archivo <file.html> ...`, past
 * editions' lists from the Internet Archive's copies of cyber.cl instead
 * (http://web.archive.org/web/<timestamp>id_/https://cyber.cl/), marked
 * "cyber-anterior": the guides say so, they never pass them as this year's.
 */
async function cyber(db: Db, fetcher: Fetcher, rest: string[]): Promise<void> {
  const files = rest.includes("--archivo") ? rest.slice(rest.indexOf("--archivo") + 1).filter((f) => !f.startsWith("--")) : [];
  const source = files.length > 0 ? ("cyber-anterior" as const) : ("cyber" as const);
  let entries: ReturnType<typeof parseCyber>;
  if (files.length > 0) {
    const seen = new Set<string>();
    entries = files.flatMap((f) => parseCyber(readFileSync(f, "utf8"))).filter((e) => {
      const d = hostOf(e.url.replace(/\\u0026/g, "&"));
      if (d === undefined || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
  } else {
    const page = await fetcher.text("https://www.cyber.cl/");
    if (page.status !== 200) throw new Error(`cyber.cl respondió ${page.status}`);
    writeFileSync(`${BASE}cyber-${today()}.html`, page.body);
    entries = parseCyber(page.body);
  }
  const adj = ajustes();
  const known = loadTiendas(db);
  const added = new Set<string>();
  let merged = 0;
  await pool(entries, 6, async (e) => {
    const domain = hostOf(e.url.replace(/\\u0026/g, "&"));
    if (domain === undefined) return;
    const same = known.find((t) => t.domain !== undefined && t.domain.replace(/^www\./, "") === domain);
    if (same !== undefined) {
      saveTienda(db, { ...same, sources: [...new Set([...(same.sources ?? ["blackfriday"]), source])] });
      merged++;
      return;
    }
    // A new store never takes the id of another one with the same name.
    const base = `cy-${fold(e.name).slice(0, 30) || e.id}`;
    const taken = (id: string) => known.some((t) => t.id === id) || added.has(id);
    let slug = base;
    for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
    added.add(slug);
    const r = cyberRubro(e.category);
    const segment: Segment = adj.segmento[slug] ?? (isBigMarket(domain) ? "grande" : r.segment);
    const info = segment === "pyme" ? await homeInfo(fetcher, domain) : { notes: [] as string[] };
    const t: Tienda = {
      id: slug, domain, origin: info.origin ?? `https://${domain}`, name: e.name, rubro: r.rubro, categories: [e.category],
      platform: info.platform, segment, bfSlug: "", bfLink: e.url, sources: [source], checkedAt: new Date().toISOString(), notes: info.notes,
    };
    saveTienda(db, t);
    console.log(`${slug.padEnd(28)} ${segment.padEnd(10)} ${(t.platform ?? "-").padEnd(12)} ${domain} · ${t.rubro}`);
  });
  console.log(`\ncyber.cl${files.length > 0 ? ` (${files.length} copias de ediciones anteriores)` : ""}: ${entries.length} marcas · ${added.size} nuevas en la base · ${merged} ya estaban`);
  writeFileSync(`${BASE}tiendas.json`, JSON.stringify(loadTiendas(db), null, 2));
}

/**
 * Past editions of blackfriday.cl (2022–2026): the brand gallery of the
 * Internet Archive's copies of its home and cyber pages
 * (http://web.archive.org/web/<timestamp>id_/https://www.blackfriday.cl/),
 * marked "blackfriday-anterior". A brand already in the base only gains the
 * mark; a new one comes in with the same segments as this year's list.
 */
async function blackfridayAnterior(db: Db, fetcher: Fetcher, rest: string[]): Promise<void> {
  const files = rest.includes("--archivo") ? rest.slice(rest.indexOf("--archivo") + 1).filter((f) => !f.startsWith("--")) : [];
  if (files.length === 0) {
    console.error("uso: cli base blackfriday-anterior --archivo <copia.html> ...");
    process.exitCode = 2;
    return;
  }
  const byHost = new Map<string, BfEntry>();
  for (const f of files) {
    for (const e of parseBlackFridayGallery(readFileSync(f, "utf8"))) {
      const prev = byHost.get(e.slug);
      byHost.set(e.slug, prev === undefined ? e : { ...prev, name: prev.name || e.name, categories: [...new Set([...prev.categories, ...e.categories])].sort() });
    }
  }
  const entries = [...byHost.values()];
  const adj = ajustes();
  const known = loadTiendas(db);
  const added = new Set<string>();
  let merged = 0;
  await pool(entries, 6, async (e) => {
    const domain = adj.dominio[e.slug] ?? e.slug;
    const same = known.find((t) => t.domain !== undefined && t.domain.replace(/^www\./, "") === domain.replace(/^www\./, ""));
    if (same !== undefined) {
      saveTienda(db, { ...same, sources: [...new Set([...(same.sources ?? ["blackfriday"]), "blackfriday-anterior" as const])] });
      merged++;
      return;
    }
    const base = `bfa-${fold(e.name || domain.split(".")[0]!).slice(0, 30) || fold(domain)}`;
    const taken = (id: string) => known.some((t) => t.id === id) || added.has(id);
    let slug = base;
    for (let i = 2; taken(slug); i++) slug = `${base}-${i}`;
    added.add(slug);
    const segment: Segment = adj.segmento[slug] ?? (isBigMarket(domain) ? "grande" : segmentOf({ ...e, slug }, domain));
    const info = segment === "pyme" ? await homeInfo(fetcher, domain) : { notes: [] as string[] };
    const t: Tienda = {
      id: slug, domain, origin: info.origin ?? `https://${domain}`, name: e.name || info.name || domain, rubro: mainRubro(e.categories), categories: e.categories,
      platform: info.platform, segment, bfSlug: "", bfLink: e.link, sources: ["blackfriday-anterior"], checkedAt: new Date().toISOString(), notes: info.notes,
    };
    saveTienda(db, t);
    console.log(`${slug.padEnd(28)} ${segment.padEnd(10)} ${(t.platform ?? "-").padEnd(12)} ${domain} · ${t.rubro}`);
  });
  console.log(`\nblackfriday.cl (${files.length} copias de ediciones anteriores): ${entries.length} marcas · ${added.size} nuevas en la base · ${merged} ya estaban`);
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
  const repeat = flag(rest, "--repetir");
  const only = flag(rest, "--solo")?.split(",").map((x) => x.trim());
  // A repeat asks the very same questions again (the guide's before/after), never new ones.
  const earlier = new Map<string, string[]>();
  if (repeat !== undefined) {
    for (const r of db.raw.prepare("select rubro, question from rubro_answers where at >= ? and at < ? order by at").all(repeat, since)) {
      const list = earlier.get(String(r.rubro)) ?? [];
      if (!list.includes(String(r.question))) list.push(String(r.question));
      earlier.set(String(r.rubro), list);
    }
  }
  const names = [...new Set(tiendas.map((t) => t.rubro))].filter((r) => tiendas.filter((t) => t.rubro === r).length >= 3 && (done.get(r)?.length ?? 0) === 0
    && (only === undefined || only.includes(r)) && (repeat === undefined || (earlier.get(r)?.length ?? 0) > 0));
  console.log(`${names.length} rubros por preguntar (${n} preguntas cada uno)`);
  let stopped: string | undefined;
  for (const rubro of names) {
    if (stopped !== undefined) break;
    const sample = tiendas.filter((t) => t.rubro === rubro).flatMap((t) => db.products(t.id).slice(0, 6)).sort(() => Math.random() - 0.5).slice(0, 40);
    let questions: string[];
    try {
      questions = repeat !== undefined ? earlier.get(rubro)! : await buyerQuestions(llm, { id: "rubro", name: rubro, origin: "https://rubro.invalid", platform: "propia", rubro: `${rubro} (tiendas online chilenas)`, source: "black-friday", sellsOnline: true }, sample, n);
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
  // Big stores' catalogues are read as comparison data only: guides, brands and the search keep to pymes.
  const segment = z.enum(["pyme", "grande"]).safeParse(flag(rest, "--segmento") ?? "pyme");
  if (!segment.success) {
    console.error("uso: base ingest [--segmento pyme|grande] ...");
    process.exitCode = 2;
    return;
  }
  const targets = loadTiendas(db).filter((t) => t.segment === segment.data && t.origin !== undefined && (only === undefined ? rest.includes("--todas") || db.lastRun(t.id) === undefined : only.includes(t.id)));
  console.log(`${targets.length} catálogos por leer`);
  const tally = { leidas: 0, conservadas: [] as string[], fallidas: 0 };
  await pool(targets, Number(flag(rest, "--paralelo") ?? 6), async (t) => {
    const started = Date.now();
    const previous = db.lastGoodRun(t.id) === undefined ? 0 : db.products(t.id).length;
    try {
      const result = await ingestStore(toStore(t), fetcher, { maxProducts: max, maxPages: pages });
      const last = db.lastRun(t.id);
      const verdict = rereadVerdict(previous, result.products.length, last?.method === "conservado" ? last.count : undefined);
      if (!verdict.replace) {
        db.recordKeptRun(t.id, "conservado", result.products.length, [verdict.reason, ...result.notes]);
        console.log(`${t.id}: se conserva la lectura anterior (${verdict.reason})`);
        tally.conservadas.push(t.id);
        return;
      }
      db.replaceCatalogue(t.id, result.products, result.method, result.notes);
      tally.leidas += 1;
      console.log(`${t.id}: ${result.products.length} productos por ${result.method} en ${Math.round((Date.now() - started) / 1000)} s${result.notes.length ? ` · ${result.notes.slice(0, 3).join(" · ")}` : ""}`);
    } catch (error) {
      const message = (error as Error).message.slice(0, 200);
      if (rereadVerdict(previous, undefined).replace) db.replaceCatalogue(t.id, [], "falló", [message]);
      else db.recordKeptRun(t.id, "falló", 0, [message]);
      console.log(`${t.id}: falló (${message})${previous > 0 ? ", se conserva la lectura anterior" : ""}`);
      if (previous > 0) tally.conservadas.push(t.id);
      else tally.fallidas += 1;
    }
  });
  console.log(`resumen: ${tally.leidas} leídas, ${tally.conservadas.length} con la lectura anterior${tally.conservadas.length ? ` (${tally.conservadas.sort().join(", ")})` : ""}, ${tally.fallidas} sin leer`);
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
    .map((t) => ({ t, count: db.lastGoodRun(t.id)?.count ?? 0 }))
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

async function politicas(db: Db, fetcher: Fetcher, rest: string[]): Promise<void> {
  const start = new Date();
  const hasta = flag(rest, "--hasta");
  const stopAt = hasta === undefined ? undefined : deadline(start, hasta);
  if (hasta !== undefined && stopAt === undefined) {
    console.error(`--hasta ${hasta}: se espera HH:MM`);
    process.exitCode = 2;
    return;
  }
  const only = flag(rest, "--solo")?.split(",");
  const max = flag(rest, "--max") === undefined ? Infinity : Number(flag(rest, "--max"));
  const tried = new Map(db.raw.prepare("select store_id, at from policy_attempts").all().map((r) => [String(r.store_id), String(r.at)]));
  // A policy saved in an older format is due again, whenever it was read.
  for (const r of db.raw.prepare("select store_id, data from policies").all()) if (policyOutdated(JSON.parse(String(r.data)))) tried.delete(String(r.store_id));
  // Pilot stores are left out: their policy is served by the panel's MCP once imported, and a new reading would replace the one shown.
  const tiendas = new Map(loadTiendas(db).filter((t) => t.segment === "pyme" && t.origin !== undefined && !(t.sources ?? []).includes("piloto") && (only === undefined || only.includes(t.id))).map((t) => [t.id, t]));
  const targets = policyTargets([...tiendas.values()].map((t) => ({ id: t.id, products: db.lastGoodRun(t.id)?.count ?? 0, triedAt: tried.get(t.id) })), start, Number(flag(rest, "--dias") ?? 30), max);
  const llm = createLlm("cuenta");
  console.log(`${targets.length} tiendas por leer políticas (${llm.name})${stopAt === undefined ? "" : `, hasta ${stopAt.toLocaleString("es-CL")}`}`);
  const insert = db.raw.prepare("insert or replace into policy_attempts (store_id, result, detail, at) values (?, ?, ?, ?)");
  const attempt = { run: (id: string, result: string, why: string | null, at: string) => retryBusy(() => insert.run(id, result, why, at)) };
  const n = { tried: 0, saved: 0, empty: 0, failed: 0, calls: 0 };
  let reason: StopReason | undefined;
  let detail: string | undefined;
  await pool(targets, Number(flag(rest, "--paralelo") ?? 3), async ({ id }) => {
    if (reason !== undefined) return;
    if (stopAt !== undefined && Date.now() >= stopAt.getTime()) {
      reason = "hora de término";
      return;
    }
    const store = toStore(tiendas.get(id)!);
    n.tried++;
    try {
      const pages = await readPolicyPages(store, fetcher);
      if (pages.length === 0) {
        n.empty++;
        await attempt.run(id, "sin-paginas", null, new Date().toISOString());
        console.log(`${id}: sin páginas de políticas`);
        return;
      }
      n.calls++;
      const policy = await extractPolicy(llm, store, pages);
      if (policy === undefined) {
        n.failed++;
        await attempt.run(id, "sin-estructura", null, new Date().toISOString());
        console.log(`${id}: no se pudo estructurar`);
        return;
      }
      await retryBusy(() => db.savePolicy(id, llm.name, pages.map((p) => p.url), policy));
      await attempt.run(id, "guardada", null, new Date().toISOString());
      n.saved++;
      console.log(`${id}: ${pages.length} páginas · devoluciones ${policy.cambios_y_devoluciones.acepta} · medios de pago ${policy.medios_de_pago.length} · falta ${policy.falta.length}`);
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof UsageLimitError) {
        // Not recorded as tried: the store goes again in the next window.
        reason = "límite del plan";
        detail = message;
        n.tried--;
        return;
      }
      n.failed++;
      await attempt.run(id, "error", message.slice(0, 300), new Date().toISOString()).catch(() => undefined);
      console.log(`${id}: falló (${message.slice(0, 200)})`);
    }
  });
  reason ??= targets.length >= max ? "tope de tiendas" : "terminó la lista";
  console.log(`\n${nightSummary({ start, end: new Date(), ...n, reason, detail })}`);
  if (reason === "límite del plan") process.exitCode = 3;
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
  const runs = new Map(tiendas.map((t) => [t.id, db.lastGoodRun(t.id)]));
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

/**
 * Big stores, for comparison on the product pages only: their pages for the
 * pilot houses, from their product sitemaps. `--tiendas gr-paris,gr-lider`
 * reads some; `--max N` caps the pages opened per store. A reading with no
 * product keeps the previous one.
 */
async function grandes(db: Db, fetcher: Fetcher, rest: string[]): Promise<void> {
  const pick = z.array(z.enum(BIG_STORES.map((s) => s.id) as [string, ...string[]])).optional().safeParse(flag(rest, "--tiendas")?.split(","));
  const max = z.coerce.number().int().positive().max(5000).safeParse(flag(rest, "--max") ?? 600);
  if (!pick.success || !max.success) {
    console.error(`uso: base grandes [--tiendas ${BIG_STORES.map((s) => s.id).join(",")}] [--max N]`);
    process.exitCode = 2;
    return;
  }
  // Only addresses that may be a product the pyme stores already make a page for: run `base guia` first.
  const wanted = mayBeOneOf(db.productGroups().map((g) => ProductGroupSchema.parse(g).key).flatMap((k) => (isCodeKey(k) ? [] : [k])));
  for (const store of BIG_STORES.filter((s) => pick.data === undefined || pick.data.includes(s.id))) {
    const started = Date.now();
    const r = await readBigStore(store, fetcher, { maxPages: max.data, wanted, log: (l) => process.stderr.write(`${l}\n`) });
    const method = "sitemap de productos de casas árabes + datos estructurados";
    // Like the pyme stores: a reading with nothing, or far less than the last one, keeps the last one.
    const before = db.lastGoodRun(store.id)?.count ?? 0;
    const keep = r.products.length === 0 || r.products.length < before * 0.5;
    if (!keep) db.replaceCatalogue(store.id, r.products, method, r.notes);
    console.log(`${store.id}: ${r.products.length} productos de ${r.opened} páginas abiertas (${r.urls} en el sitemap) en ${Math.round((Date.now() - started) / 1000)} s${keep ? ` · se mantiene la lectura anterior (${before} productos)` : ""}${r.notes.length > 0 ? ` · ${r.notes.join(" · ")}` : ""}`);
  }
}

/**
 * The public guides, from what the base already has: no catalogue is read and
 * no AI is asked. Each guide is saved in the local base, where setup-postgres
 * picks it up for the panel, and as a preview page in data/guias/.
 */
function guia(db: Db, rest: string[]): void {
  const wanted = flag(rest, "--rubros")?.split(",");
  const metas = GUIDE_RUBROS.filter((r) => wanted === undefined || wanted.includes(r.slug));
  if (metas.length === 0) {
    console.error(`rubros conocidos: ${GUIDE_RUBROS.map((r) => r.slug).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  for (const slug of db.dropGuidesExcept(GUIDE_RUBROS.map((r) => r.slug))) console.log(`${slug}: ya no es una guía, borrada de la base local`);
  const dir = `${DATA}guias/`;
  mkdirSync(dir, { recursive: true });
  const tiendas = loadTiendas(db);
  const built = metas.map((meta) => {
    const inputs = tiendas.filter((t) => t.rubro === meta.rubro).map((t) => ({ tienda: t, products: db.products(t.id), readAt: freshReadAt(db.lastGoodRun(t.id)?.at, today()) }));
    const g = buildGuide(meta, inputs, today());
    db.saveGuide(g.slug, g);
    console.log(`${g.slug}: ${g.stores.length} tiendas de ${inputs.length} del rubro, ${g.brands.length} marcas en dos o más tiendas, catálogos leídos ${g.readFrom} a ${g.readTo}`);
    return g;
  });
  for (const g of built) writeFileSync(`${dir}${g.slug}.html`, guideHtml(g, GUIDE_RUBROS));
  writeFileSync(`${dir}index.html`, guidesIndexHtml(built.map((g) => ({ slug: g.slug, title: g.title, updatedAt: g.updatedAt, stores: g.stores.length }))));
  // Brands across every public store, not only the guide rubros: "where do I buy <brand>" has no rubro.
  const all = tiendas.map((t) => ({ tienda: t, products: db.products(t.id), readAt: freshReadAt(db.lastGoodRun(t.id)?.at, today()) }));
  const pages = buildBrandPages(all, today());
  db.replaceBrandPages(pages.map((p) => ({ ...summarize(p), data: p })));
  mkdirSync(`${dir}marcas/`, { recursive: true });
  writeFileSync(`${dir}marcas/index.html`, brandsIndexHtml(pages.map(summarize)));
  for (const p of pages.filter((x) => x.stores.length >= 10)) writeFileSync(`${dir}marcas/${p.slug}.html`, brandHtml(p, GUIDE_RUBROS));
  const prices = buildPriceRows(all);
  db.replacePrices(prices.map((p) => ({ storeId: p.row.storeId, text: p.text, price: p.row.price, data: p.row })));
  console.log(`buscador: ${prices.length} productos con stock y precio`);
  const policies = buildPublicPolicies(all, new Map(db.policies().map((p) => [p.storeId, p])), today());
  db.replacePublicPolicies(policies.map((p) => ({ storeId: p.policy.storeId, domain: p.policy.domain, text: p.text, data: p.policy })));
  console.log(`políticas: ${policies.length} tiendas con políticas leídas de su sitio, con citas`);
  const big = BIG_STORES.flatMap((s) => bigPriceRows(s, db.products(s.id), freshReadAt(db.lastGoodRun(s.id)?.at, today())));
  // Big stores and brands' own stores from the lists (segment "grande"): comparison rows for the barcode pages only.
  const grandes = tiendas.filter((t) => t.segment === "grande" && t.domain !== undefined)
    .flatMap((t) => bigPriceRows({ id: t.id, name: t.name, domain: t.domain!, sitemap: "" }, db.products(t.id), freshReadAt(db.lastGoodRun(t.id)?.at, today())));
  const perfumes = matchProducts(prices.map((p) => p.row), 3, big);
  const coded = matchByCode(prices.map((p) => p.row), 2, [...big, ...grandes]);
  const taken = new Set(perfumes.map((g) => g.slug));
  const groups = [...perfumes, ...coded.filter((g) => !taken.has(g.slug))];
  db.replaceProducts(groups);
  console.log(`productos: ${perfumes.length} páginas del mismo perfume en tres o más tiendas, ${perfumes.filter((g) => g.reference.length > 0).length} con precio de tiendas grandes para comparar`);
  console.log(`productos por código de barras: ${coded.length} páginas en dos o más tiendas, ${coded.filter((g) => g.reference.length > 0).length} con precio de tiendas grandes o de la marca`);
  console.log(`marcas: ${pages.length} páginas (${pages.filter((p) => p.same.length > 0).length} con el mismo producto en varias tiendas)`);
  console.log(`${dir}: vista previa de ${built.length} guías y de las marcas con 10 o más tiendas. Para publicarlas: scripts/setup-postgres.ts --solo-importar --guias`);
}

/**
 * IndexNow: announces every URL of the live sitemap to Bing, Yandex, Seznam and
 * Naver at once (they share what they receive). Run after publishing; the key
 * file must already answer, or the engines reject the call.
 */
async function indexNow(): Promise<void> {
  const keyFile = await fetch(indexNowKeyUrl());
  if (!keyFile.ok || (await keyFile.text()).trim() !== INDEXNOW_KEY) {
    console.error(`${indexNowKeyUrl()} no responde la clave: publica antes (setup-postgres y el despliegue)`);
    process.exitCode = 1;
    return;
  }
  const sitemap = await (await fetch(guideUrl("sitemap.xml"))).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  for (let i = 0; i < urls.length; i += 10_000) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(GUIDE_ORIGIN).host, key: INDEXNOW_KEY, keyLocation: indexNowKeyUrl(), urlList: urls.slice(i, i + 10_000) }),
    });
    console.log(`IndexNow: ${urls.slice(i, i + 10_000).length} direcciones, respuesta ${res.status} ${res.statusText}`);
    if (!res.ok) process.exitCode = 1;
  }
}

/** The guide experiment's measure: for each guide rubro, the general answers in a window, and whether any cites agentpey.com. */
function medirGuia(db: Db, rest: string[]): void {
  const since = flag(rest, "--desde") ?? "2026-11-18";
  const until = flag(rest, "--hasta") ?? "9999";
  const answers = rubroAnswers(db, since);
  for (const meta of GUIDE_RUBROS) {
    const window = (answers.get(meta.rubro) ?? []).filter((a) => a.at < until);
    const c = citations(window);
    const at = window.map((a) => a.at.slice(0, 10)).sort();
    console.log(`\n${meta.rubro}: ${c.answers} respuestas (${at[0] ?? "-"} a ${at.at(-1) ?? "-"}), agentpey.com en ${c.agentpey}`);
    console.log(`  ${c.domains.slice(0, 15).map((d) => `${d.domain} ${d.count}`).join(" · ")}`);
  }
}
