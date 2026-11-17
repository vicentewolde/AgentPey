import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "./db.js";
import type { Product } from "./model.js";
import { importStores, migrate, pgStore, sqliteStore, type PanelStore, type Queryable } from "./store.js";

const product = (id: string, title = `Producto ${id}`): Product => ({
  id, title, url: `https://tienda.cl/p/${id}`, price: 1000, currency: "CLP", available: true,
  description: "", images: [], categories: [], attributes: {}, variants: [],
} as unknown as Product);

/** A local SQLite base like the one the CLI fills, with two stores. */
function localDb(): Db {
  const db = openDb(":memory:");
  db.replaceCatalogue("a", [product("1"), product("2")], "shopify", ["nota"]);
  db.replaceCatalogue("b", [product("9")], "woo", []);
  db.saveAnalysis("a", "1", "sonnet", { puntaje: 6, contradicciones: [] });
  db.savePolicy("a", "sonnet", ["https://tienda.cl/envios"], { despacho: { cobertura: "Chile" } });
  db.saveAnswer("a", { engine: "chatgpt", question: "¿dónde compro?", text: "En la tienda a", urls: ["https://tienda.cl"], mentioned: true, cited: false, others: ["x"] });
  db.replaceDemoEvents("a", [{ storeId: "a", kind: "visita", source: "chatgpt", at: "2026-11-01T10:00:00.000Z", productIds: ["1"] }]);
  return db;
}

// One in-process Postgres for the file (starting one takes seconds), emptied before each test.
let pglite: PGlite;
let q: Queryable;
beforeAll(async () => {
  pglite = new PGlite();
  q = pglite as unknown as Queryable;
  await migrate(q);
});
beforeEach(async () => {
  await q.query("truncate comercios.products, comercios.analyses, comercios.policies, comercios.answers, comercios.events, comercios.clicks, comercios.ingest_runs");
});
afterAll(async () => {
  await pglite.close();
});

describe("Postgres store", () => {
  it("migrate can run twice", async () => {
    await migrate(q);
  });

  it("imports a store from the local file and reads it back like SQLite does", async () => {
    const db = localDb();
    const counts = await importStores(q, db, ["a"]);
    expect(counts).toEqual([{ storeId: "a", products: 2, analyses: 1, policy: true, answers: 1, demoEvents: 1 }]);

    const pgs = pgStore(q);
    const lite = sqliteStore(db);
    for (const s of [pgs, lite] as PanelStore[]) {
      expect((await s.products("a")).map((p) => p.id)).toEqual(["1", "2"]);
      expect(await s.analyses("a")).toEqual([{ productId: "1", status: "propuesta", data: { puntaje: 6, contradicciones: [] } }]);
      expect(await s.policy("a")).toEqual({ pages: ["https://tienda.cl/envios"], status: "propuesta", data: { despacho: { cobertura: "Chile" } } });
      const [answer] = await s.answers("a");
      expect(answer).toMatchObject({ engine: "chatgpt", mentioned: true, cited: false, urls: ["https://tienda.cl"], others: ["x"] });
      expect(await s.events("a")).toEqual([{ storeId: "a", kind: "visita", source: "chatgpt", at: "2026-11-01T10:00:00.000Z", productIds: ["1"], demo: true }]);
    }
    // Only the chosen store goes up.
    expect(await pgs.products("b")).toEqual([]);
    db.close();
  });

  it("re-importing replaces the catalogue and demo events but keeps real events and clicks", async () => {
    const db = localDb();
    await importStores(q, db, ["a"]);
    const pgs = pgStore(q);
    await pgs.saveEvent({ storeId: "a", kind: "compra", source: "perplexity", at: "2026-11-02T12:00:00.000Z", total: 19990, orderId: "42", productIds: ["2"] });
    await pgs.saveClick({ id: "abc123abc123", storeId: "a", productId: "1", url: "https://tienda.cl/p/1", channel: "vendedor" });

    db.replaceCatalogue("a", [product("3")], "shopify", []);
    await importStores(q, db, ["a"]);

    expect((await pgs.products("a")).map((p) => p.id)).toEqual(["3"]);
    const events = await pgs.events("a");
    expect(events.filter((e) => e.demo)).toHaveLength(1);
    expect(events.filter((e) => !e.demo)).toEqual([
      { storeId: "a", kind: "compra", source: "perplexity", at: "2026-11-02T12:00:00.000Z", total: 19990, orderId: "42", productIds: ["2"], demo: false },
    ]);
    expect(await pgs.click("abc123abc123")).toEqual({ storeId: "a", productId: "1", url: "https://tienda.cl/p/1", channel: "vendedor" });
    db.close();
  });

  it("refuses a store with no products and leaves Postgres as it was", async () => {
    const db = localDb();
    await expect(importStores(q, db, ["nadie"])).rejects.toThrow(/nadie/);
    expect(await pgStore(q).products("a")).toEqual([]);
    db.close();
  });

  it("rolls back a store whose import fails halfway", async () => {
    const db = localDb();
    await importStores(q, db, ["a"]);
    // A policy row that cannot be inserted (pages is not JSON) makes the second import fail after the deletes.
    db.raw.prepare("update policies set pages = 'no es json' where store_id = 'a'").run();
    await expect(importStores(q, db, ["a"])).rejects.toThrow();
    expect((await pgStore(q).products("a")).map((p) => p.id)).toEqual(["1", "2"]);
    db.close();
  });

  it("imports more rows than one batch holds", async () => {
    const db = openDb(":memory:");
    db.replaceCatalogue("big", Array.from({ length: 2345 }, (_, i) => product(String(i).padStart(4, "0"))), "shopify", []);
    const [count] = await importStores(q, db, ["big"]);
    expect(count?.products).toBe(2345);
    const ids = (await pgStore(q).products("big")).map((p) => p.id);
    expect(ids).toHaveLength(2345);
    expect(ids[0]).toBe("0000");
    expect(ids.at(-1)).toBe("2344");
    db.close();
  });

  it("a role without CREATE on the database can migrate once the admin made the schema", async () => {
    // Like production: the setup script creates the schema as the admin, then migrates as the role.
    const pg = new PGlite();
    try {
      await pg.query(`create role panel nocreatedb nocreaterole`);
      await pg.query(`revoke create on database ${(await pg.query<{ d: string }>("select current_database() d")).rows[0]!.d} from public`);
      await pg.query(`create schema comercios`);
      await pg.query(`grant usage, create on schema comercios to panel`);
      await pg.query(`set role panel`);
      await expect(pg.query(`create schema if not exists comercios`)).rejects.toThrow(/permission denied/);
      await migrate(pg as unknown as Queryable);
      await migrate(pg as unknown as Queryable);
      const { rows } = await pg.query<{ owner: string }>(`select tableowner owner from pg_tables where schemaname = 'comercios' and tablename = 'products'`);
      expect(rows).toEqual([{ owner: "panel" }]);
    } finally {
      await pg.close();
    }
  });

  it("unknown clicks and policies come back undefined", async () => {
    const pgs = pgStore(q);
    expect(await pgs.click("000000000000")).toBeUndefined();
    expect(await pgs.policy("a")).toBeUndefined();
  });
});
