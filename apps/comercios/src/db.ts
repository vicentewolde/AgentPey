/**
 * Local storage for the demo: one SQLite file (node:sqlite, no extra
 * dependency). Products are stored as JSON per (store, product id); each ingest
 * replaces a store's catalogue and records a run.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { MeasureEvent, Source } from "./medir.js";
import type { Product } from "./model.js";

export type Db = ReturnType<typeof openDb>;

/** The local data folder (git-ignored), ending in "/": COMERCIOS_DATA when set (the weekly job keeps it outside any checkout), else this app's data/. */
export function localDataDir(): string {
  const dir = process.env.COMERCIOS_DATA;
  return dir === undefined || dir === "" ? fileURLToPath(new URL("../data/", import.meta.url)) : `${dir.replace(/\/$/, "")}/`;
}

/** Methods of runs that left the previous catalogue in place: "falló" is also a first reading that read nothing. */
export const KEPT_METHODS = ["falló", "conservado"] as const;

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Several CLI runs (ingest, entender, politicas) may write at once: wait for the lock instead of failing.
  db.exec("pragma journal_mode = wal; pragma busy_timeout = 10000;");
  db.exec(`
    create table if not exists products (
      store_id text not null,
      id       text not null,
      data     text not null,
      primary key (store_id, id)
    );
    create table if not exists analyses (
      store_id   text not null,
      product_id text not null,
      model      text not null,
      data       text not null,
      status     text not null default 'propuesta',
      at         text not null,
      primary key (store_id, product_id)
    );
    create table if not exists policies (
      store_id text primary key,
      model    text not null,
      pages    text not null,
      data     text not null,
      status   text not null default 'propuesta',
      at       text not null
    );
    create table if not exists answers (
      store_id  text not null,
      engine    text not null,
      question  text not null,
      text      text not null,
      urls      text not null,
      mentioned integer not null,
      cited     integer not null,
      others    text not null,
      at        text not null
    );
    create table if not exists events (
      store_id   text not null,
      kind       text not null,
      source     text not null,
      at         text not null,
      total      integer,
      order_id   text,
      products   text not null default '[]',
      demo       integer not null default 0
    );
    create index if not exists events_store on events (store_id, at);
    create table if not exists clicks (
      id         text primary key,
      store_id   text not null,
      product_id text not null,
      url        text not null,
      channel    text not null,
      at         text not null
    );
    create table if not exists ingest_runs (
      store_id   text not null,
      at         text not null,
      method     text not null,
      count      integer not null,
      notes      text not null
    );
    create table if not exists guias (
      slug text primary key,
      data text not null,
      at   text not null
    );
    create table if not exists precios (
      store_id text not null,
      text     text not null,
      price    integer not null,
      data     text not null
    );
    create table if not exists marcas (
      slug      text primary key,
      brand     text not null,
      stores    integer not null,
      price_min integer not null,
      updated   text not null,
      data      text not null
    );
  `);
  return {
    raw: db,
    replaceCatalogue(storeId: string, products: readonly Product[], method: string, notes: readonly string[]): void {
      db.exec("begin");
      try {
        db.prepare("delete from products where store_id = ?").run(storeId);
        const insert = db.prepare("insert or replace into products (store_id, id, data) values (?, ?, ?)");
        for (const p of products) insert.run(storeId, p.id, JSON.stringify(p));
        db.prepare("insert into ingest_runs (store_id, at, method, count, notes) values (?, ?, ?, ?, ?)").run(
          storeId, new Date().toISOString(), method, products.length, JSON.stringify(notes),
        );
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    products(storeId: string): Product[] {
      return db.prepare("select data from products where store_id = ? order by id").all(storeId).map((r) => JSON.parse(String(r.data)) as Product);
    },
    lastRun(storeId: string): { at: string; method: string; count: number; notes: string[] } | undefined {
      const r = db.prepare("select at, method, count, notes from ingest_runs where store_id = ? order by rowid desc limit 1").get(storeId);
      return r === undefined ? undefined : { at: String(r.at), method: String(r.method), count: Number(r.count), notes: JSON.parse(String(r.notes)) as string[] };
    },
    /** The last reading that replaced the catalogue: a failed or kept re-read (KEPT_METHODS) does not date it. */
    lastGoodRun(storeId: string): { at: string; method: string; count: number } | undefined {
      const r = db.prepare(`select at, method, count from ingest_runs where store_id = ? and method not in (${KEPT_METHODS.map(() => "?").join(", ")}) order by rowid desc limit 1`).get(storeId, ...KEPT_METHODS);
      return r === undefined ? undefined : { at: String(r.at), method: String(r.method), count: Number(r.count) };
    },
    /** Records a re-read that did not replace the catalogue (it failed, or read far less than before): the previous one stays. */
    recordKeptRun(storeId: string, method: (typeof KEPT_METHODS)[number], count: number, notes: readonly string[]): void {
      db.prepare("insert into ingest_runs (store_id, at, method, count, notes) values (?, ?, ?, ?, ?)").run(storeId, new Date().toISOString(), method, count, JSON.stringify(notes));
    },
    saveAnalysis(storeId: string, productId: string, model: string, data: unknown): void {
      db.prepare("insert or replace into analyses (store_id, product_id, model, data, status, at) values (?, ?, ?, ?, 'propuesta', ?)").run(
        storeId, productId, model, JSON.stringify(data), new Date().toISOString(),
      );
    },
    analyses(storeId: string): { productId: string; status: string; data: unknown }[] {
      return db.prepare("select product_id, status, data from analyses where store_id = ? order by product_id").all(storeId)
        .map((r) => ({ productId: String(r.product_id), status: String(r.status), data: JSON.parse(String(r.data)) as unknown }));
    },
    setAnalysisStatus(storeId: string, productId: string, status: "propuesta" | "aprobada" | "rechazada"): void {
      db.prepare("update analyses set status = ? where store_id = ? and product_id = ?").run(status, storeId, productId);
    },
    savePolicy(storeId: string, model: string, pages: readonly string[], data: unknown): void {
      db.prepare("insert or replace into policies (store_id, model, pages, data, status, at) values (?, ?, ?, ?, 'propuesta', ?)").run(
        storeId, model, JSON.stringify(pages), JSON.stringify(data), new Date().toISOString(),
      );
    },
    policy(storeId: string): { pages: string[]; status: string; data: unknown } | undefined {
      const r = db.prepare("select pages, status, data from policies where store_id = ?").get(storeId);
      return r === undefined ? undefined : { pages: JSON.parse(String(r.pages)) as string[], status: String(r.status), data: JSON.parse(String(r.data)) as unknown };
    },
    saveAnswer(storeId: string, a: { engine: string; question: string; text: string; urls: readonly string[]; mentioned: boolean; cited: boolean; others: readonly string[] }): void {
      db.prepare("insert into answers (store_id, engine, question, text, urls, mentioned, cited, others, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        storeId, a.engine, a.question, a.text, JSON.stringify(a.urls), a.mentioned ? 1 : 0, a.cited ? 1 : 0, JSON.stringify(a.others), new Date().toISOString(),
      );
    },
    clearAnswers(storeId: string): void {
      db.prepare("delete from answers where store_id = ?").run(storeId);
    },
    answers(storeId: string): { engine: string; question: string; text: string; urls: string[]; mentioned: boolean; cited: boolean; others: string[]; at: string }[] {
      return db.prepare("select * from answers where store_id = ? order by at").all(storeId).map((r) => ({
        engine: String(r.engine), question: String(r.question), text: String(r.text), urls: JSON.parse(String(r.urls)) as string[],
        mentioned: Number(r.mentioned) === 1, cited: Number(r.cited) === 1, others: JSON.parse(String(r.others)) as string[], at: String(r.at),
      }));
    },
    saveEvent(e: MeasureEvent): void {
      db.prepare("insert into events (store_id, kind, source, at, total, order_id, products, demo) values (?, ?, ?, ?, ?, ?, ?, ?)").run(
        e.storeId, e.kind, e.source, e.at, e.total ?? null, e.orderId ?? null, JSON.stringify(e.productIds ?? []), e.demo === true ? 1 : 0,
      );
    },
    replaceDemoEvents(storeId: string, events: readonly MeasureEvent[]): void {
      db.exec("begin");
      try {
        db.prepare("delete from events where store_id = ? and demo = 1").run(storeId);
        const insert = db.prepare("insert into events (store_id, kind, source, at, total, order_id, products, demo) values (?, ?, ?, ?, ?, ?, ?, 1)");
        for (const e of events) insert.run(e.storeId, e.kind, e.source, e.at, e.total ?? null, e.orderId ?? null, JSON.stringify(e.productIds ?? []));
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    events(storeId: string): MeasureEvent[] {
      return db.prepare("select * from events where store_id = ? order by at").all(storeId).map((r) => ({
        storeId: String(r.store_id), kind: String(r.kind) as MeasureEvent["kind"], source: String(r.source) as Source, at: String(r.at),
        ...(r.total === null ? {} : { total: Number(r.total) }), ...(r.order_id === null ? {} : { orderId: String(r.order_id) }),
        productIds: JSON.parse(String(r.products)) as string[], demo: Number(r.demo) === 1,
      }));
    },
    saveClick(c: { id: string; storeId: string; productId: string; url: string; channel: string }): void {
      db.prepare("insert into clicks (id, store_id, product_id, url, channel, at) values (?, ?, ?, ?, ?, ?)").run(c.id, c.storeId, c.productId, c.url, c.channel, new Date().toISOString());
    },
    click(id: string): { storeId: string; productId: string; url: string; channel: string } | undefined {
      const r = db.prepare("select store_id, product_id, url, channel from clicks where id = ?").get(id);
      return r === undefined ? undefined : { storeId: String(r.store_id), productId: String(r.product_id), url: String(r.url), channel: String(r.channel) };
    },
    /** A public guide (guia.ts), stored as computed; replaced on every `base guia`. */
    saveGuide(slug: string, data: unknown): void {
      db.prepare("insert or replace into guias (slug, data, at) values (?, ?, ?)").run(slug, JSON.stringify(data), new Date().toISOString());
    },
    /** Drops guides whose slug is no longer one of `keep` (a renamed or retired guide must not be published again). */
    dropGuidesExcept(keep: readonly string[]): string[] {
      const gone = (db.prepare("select slug from guias").all() as { slug: string }[]).map((r) => String(r.slug)).filter((s) => !keep.includes(s));
      for (const slug of gone) db.prepare("delete from guias where slug = ?").run(slug);
      return gone;
    },
    /** Replaces every brand page (marcas.ts) at once: a brand that left the list must not stay published. */
    replaceBrandPages(pages: readonly { slug: string; brand: string; stores: number; priceMin: number; updatedAt: string; data: unknown }[]): void {
      db.exec("begin");
      try {
        db.exec("delete from marcas");
        const ins = db.prepare("insert into marcas (slug, brand, stores, price_min, updated, data) values (?, ?, ?, ?, ?, ?)");
        for (const p of pages) ins.run(p.slug, p.brand, p.stores, p.priceMin, p.updatedAt, JSON.stringify(p.data));
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    /** Replaces every row of the price search (precios.ts) at once, like the brand pages. */
    replacePrices(rows: readonly { storeId: string; text: string; price: number; data: unknown }[]): void {
      db.exec("begin");
      try {
        db.exec("delete from precios");
        const ins = db.prepare("insert into precios (store_id, text, price, data) values (?, ?, ?, ?)");
        for (const r of rows) ins.run(r.storeId, r.text, r.price, JSON.stringify(r.data));
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    /** Rows with every term (cleanTerms) at the start of a word, cheapest first; the total counted up to countCap + 1. */
    searchPrices(terms: readonly string[], limit: number, countCap: number): { total: number; rows: unknown[] } {
      if (terms.length === 0) return { total: 0, rows: [] };
      // Each term at the start of a word: "50ml" must not find "150ml".
      const where = terms.map(() => "(' ' || text) like ?").join(" and ");
      const args = terms.map((t) => `% ${t}%`);
      const total = Number(db.prepare(`select count(*) n from (select 1 from precios where ${where} limit ?)`).get(...args, countCap + 1)?.n ?? 0);
      const rows = db.prepare(`select data from precios where ${where} order by price, rowid limit ?`).all(...args, limit).map((r) => JSON.parse(String(r.data)) as unknown);
      return { total, rows };
    },
    /** Every price row, for setup-postgres; in insertion order. */
    priceRows(): { storeId: string; text: string; price: number; data: unknown }[] {
      return db.prepare("select store_id, text, price, data from precios order by rowid").all()
        .map((r) => ({ storeId: String(r.store_id), text: String(r.text), price: Number(r.price), data: JSON.parse(String(r.data)) as unknown }));
    },
    brandSummaries(): { slug: string; brand: string; stores: number; priceMin: number; updatedAt: string }[] {
      return db.prepare("select slug, brand, stores, price_min, updated from marcas order by slug").all()
        .map((r) => ({ slug: String(r.slug), brand: String(r.brand), stores: Number(r.stores), priceMin: Number(r.price_min), updatedAt: String(r.updated) }));
    },
    brandPage(slug: string): unknown {
      const r = db.prepare("select data from marcas where slug = ?").get(slug);
      return r === undefined ? undefined : (JSON.parse(String(r.data)) as unknown);
    },
    brandPages(): unknown[] {
      return db.prepare("select data from marcas order by slug").all().map((r) => JSON.parse(String(r.data)) as unknown);
    },
    guides(): { slug: string; data: unknown }[] {
      return db.prepare("select slug, data from guias order by slug").all().map((r) => ({ slug: String(r.slug), data: JSON.parse(String(r.data)) as unknown }));
    },
    close(): void {
      db.close();
    },
  };
}
