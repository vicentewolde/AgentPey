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
  db.exec(`
    create table if not exists products (
      store_id text not null,
      id       text not null,
      data     text not null,
      primary key (store_id, id)
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
    close(): void {
      db.close();
    },
  };
}
