/**
 * Local storage for the demo: one SQLite file (node:sqlite, no extra
 * dependency). Products are stored as JSON per (store, product id); each ingest
 * replaces a store's catalogue and records a run.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Product } from "./model.js";

export type Db = ReturnType<typeof openDb>;

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
    create table if not exists ingest_runs (
      store_id   text not null,
      at         text not null,
      method     text not null,
      count      integer not null,
      notes      text not null
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
    answers(storeId: string): { engine: string; question: string; text: string; urls: string[]; mentioned: boolean; cited: boolean; others: string[]; at: string }[] {
      return db.prepare("select * from answers where store_id = ? order by at").all(storeId).map((r) => ({
        engine: String(r.engine), question: String(r.question), text: String(r.text), urls: JSON.parse(String(r.urls)) as string[],
        mentioned: Number(r.mentioned) === 1, cited: Number(r.cited) === 1, others: JSON.parse(String(r.others)) as string[], at: String(r.at),
      }));
    },
    close(): void {
      db.close();
    },
  };
}
