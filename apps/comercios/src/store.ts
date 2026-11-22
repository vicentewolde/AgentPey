/**
 * What the panel server reads and writes, behind one async interface with two
 * backends:
 *
 * - SQLite (`sqliteStore`), the local file the CLI fills. Used when the server
 *   runs on this machine.
 * - Postgres (`pgStore`), the hosted mode. Render wipes the service's files on
 *   every deploy, so the hosted panel keeps its data in the pilot's existing
 *   Postgres, in its own `comercios` schema, reached by a role that sees only
 *   that schema (same pattern as Vitrinee).
 *
 * `importStores` copies the chosen stores from the local SQLite file to
 * Postgres: their catalogue, listing reviews, policies, AI answers and demo
 * events are replaced; real measurement events and clicks are never touched.
 */
import type { Db } from "./db.js";
import { GuideSchema, type Guide } from "./guia.js";
import { BrandPageSchema, summarize, type BrandPage, type BrandSummary } from "./marcas.js";
import { cleanTerms, COUNT_CAP, PriceRowSchema, type PriceRow } from "./precios.js";
import { ProductGroupSchema, type ProductGroup } from "./productos.js";
import { VisitRowSchema, type VisitRow } from "./visitas.js";
import type { MeasureEvent, Source } from "./medir.js";
import type { Product } from "./model.js";
import type { QuickResult } from "./rapido.js";

export interface Answer {
  engine: string;
  question: string;
  text: string;
  urls: string[];
  mentioned: boolean;
  cited: boolean;
  others: string[];
  at: string;
}
export interface Click {
  storeId: string;
  productId: string;
  url: string;
  channel: string;
}

export interface PanelStore {
  products(storeId: string): Promise<Product[]>;
  analyses(storeId: string): Promise<{ productId: string; status: string; data: unknown }[]>;
  policy(storeId: string): Promise<{ pages: string[]; status: string; data: unknown } | undefined>;
  answers(storeId: string): Promise<Answer[]>;
  events(storeId: string): Promise<MeasureEvent[]>;
  saveEvent(e: MeasureEvent): Promise<void>;
  saveClick(c: Click & { id: string }): Promise<void>;
  click(id: string): Promise<Click | undefined>;
  /** The public quick diagnosis ("pon tu URL"), with the email the owner left, if any. */
  saveQuick(r: QuickResult, email: string | undefined): Promise<void>;
  quick(id: string): Promise<QuickResult | undefined>;
  /** The latest quick diagnosis of a domain since a time, so a repeat does not spend again. */
  recentQuick(domain: string, since: string): Promise<QuickResult | undefined>;
  /** The public guides (guia.ts), as the CLI computed them; checked against their schema on the way out. */
  guides(): Promise<Guide[]>;
  /** The brand pages (marcas.ts): the index without the offers, and one page with them. */
  brandSummaries(): Promise<BrandSummary[]>;
  brandPage(slug: string): Promise<BrandPage | undefined>;
  /** The price search (precios.ts): rows containing every term, cheapest first, and how many there are in all. */
  searchPrices(terms: readonly string[], limit: number): Promise<{ total: number; rows: PriceRow[] }>;
  /** Visits of crawlers and assistants (visitas.ts): added to the day's counts; read back from a day on. */
  addVisits(rows: readonly VisitRow[]): Promise<void>;
  /** The product pages (productos.ts): the same product across stores. */
  productGroups(): Promise<ProductGroup[]>;
  visits(since: string): Promise<VisitRow[]>;
}

/** Locally the quick diagnoses live in memory: the SQLite file is the CLI's, and they are only a demo there. */
export function sqliteStore(db: Db): PanelStore {
  const quick = new Map<string, QuickResult>();
  return {
    saveQuick: async (r) => void quick.set(r.id, r),
    quick: async (id) => quick.get(id),
    recentQuick: async (domain, since) => [...quick.values()].filter((r) => r.domain === domain && r.at >= since).at(-1),
    products: async (id) => db.products(id),
    analyses: async (id) => db.analyses(id),
    policy: async (id) => db.policy(id),
    answers: async (id) => db.answers(id),
    events: async (id) => db.events(id),
    saveEvent: async (e) => db.saveEvent(e),
    saveClick: async (c) => db.saveClick(c),
    click: async (id) => db.click(id),
    guides: async () => db.guides().map((g) => GuideSchema.parse(g.data)),
    brandSummaries: async () => db.brandSummaries(),
    brandPage: async (slug) => {
      const data = db.brandPage(slug);
      return data === undefined ? undefined : BrandPageSchema.parse(data);
    },
    addVisits: async (rows) => db.addVisits(rows),
    productGroups: async () => db.productGroups().map((g) => ProductGroupSchema.parse(g)),
    visits: async (since) => db.visits(since).map((r) => VisitRowSchema.parse(r)),
    searchPrices: async (terms, limit) => {
      const r = db.searchPrices(cleanTerms(terms), limit, COUNT_CAP);
      return { total: r.total, rows: r.rows.map((x) => PriceRowSchema.parse(x)) };
    },
  };
}

/** The part of `pg.Pool`, `pg.PoolClient` and PGlite this module uses. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const SCHEMA = "comercios";

/** Idempotent; run by the setup script as the `comercios` role, so the role owns the tables. */
export const SCHEMA_SQL: readonly string[] = [
  `create schema if not exists ${SCHEMA}`,
  `create table if not exists ${SCHEMA}.products (
     store_id text not null, id text not null, data jsonb not null,
     primary key (store_id, id))`,
  `create table if not exists ${SCHEMA}.analyses (
     store_id text not null, product_id text not null, model text not null, data jsonb not null,
     status text not null default 'propuesta', at timestamptz not null,
     primary key (store_id, product_id))`,
  `create table if not exists ${SCHEMA}.policies (
     store_id text primary key, model text not null, pages jsonb not null, data jsonb not null,
     status text not null default 'propuesta', at timestamptz not null)`,
  `create table if not exists ${SCHEMA}.answers (
     seq bigserial primary key, store_id text not null, engine text not null, question text not null,
     text text not null, urls jsonb not null, mentioned boolean not null, cited boolean not null,
     others jsonb not null, at timestamptz not null)`,
  `create index if not exists answers_store on ${SCHEMA}.answers (store_id, at)`,
  `create table if not exists ${SCHEMA}.events (
     seq bigserial primary key, store_id text not null, kind text not null, source text not null,
     at timestamptz not null, total bigint, order_id text, products jsonb not null default '[]',
     demo boolean not null default false)`,
  `create index if not exists events_store on ${SCHEMA}.events (store_id, at)`,
  `create table if not exists ${SCHEMA}.clicks (
     id text primary key, store_id text not null, product_id text not null, url text not null,
     channel text not null, at timestamptz not null default now())`,
  `create table if not exists ${SCHEMA}.diagnosticos (
     id text primary key, domain text not null, email text, data jsonb not null, at timestamptz not null)`,
  `create index if not exists diagnosticos_domain on ${SCHEMA}.diagnosticos (domain, at)`,
  `create table if not exists ${SCHEMA}.guias (
     slug text primary key, data jsonb not null, at timestamptz not null)`,
  `create table if not exists ${SCHEMA}.marcas (
     slug text primary key, brand text not null, stores integer not null, price_min integer not null,
     updated text not null, data jsonb not null)`,
  `create table if not exists ${SCHEMA}.precios (
     seq bigserial primary key, store_id text not null, text text not null, price integer not null, data jsonb not null)`,
  `create table if not exists ${SCHEMA}.productos (slug text primary key, data jsonb not null)`,
  `create table if not exists ${SCHEMA}.visitas (
     day date not null, agent text not null, kind text not null, path text not null, n integer not null,
     primary key (day, agent, path))`,
  `create table if not exists ${SCHEMA}.ingest_runs (
     seq bigserial primary key, store_id text not null, at timestamptz not null, method text not null,
     count integer not null, notes jsonb not null)`,
];

export async function migrate(q: Queryable): Promise<void> {
  // `create schema if not exists` needs CREATE on the database even when the schema is there,
  // and the `comercios` role does not have it: the setup script creates the schema as the admin.
  const { rows } = await q.query(`select 1 from pg_namespace where nspname = $1`, [SCHEMA]);
  const statements = rows.length > 0 ? SCHEMA_SQL.slice(1) : SCHEMA_SQL;
  for (const statement of statements) await q.query(statement);
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export function pgStore(q: Queryable): PanelStore {
  return {
    async products(storeId) {
      const { rows } = await q.query(`select data from ${SCHEMA}.products where store_id = $1 order by id`, [storeId]);
      return rows.map((r) => r.data as Product);
    },
    async analyses(storeId) {
      const { rows } = await q.query(`select product_id, status, data from ${SCHEMA}.analyses where store_id = $1 order by product_id`, [storeId]);
      return rows.map((r) => ({ productId: String(r.product_id), status: String(r.status), data: r.data }));
    },
    async policy(storeId) {
      const { rows } = await q.query(`select pages, status, data from ${SCHEMA}.policies where store_id = $1`, [storeId]);
      const r = rows[0];
      return r === undefined ? undefined : { pages: r.pages as string[], status: String(r.status), data: r.data };
    },
    async answers(storeId) {
      const { rows } = await q.query(`select * from ${SCHEMA}.answers where store_id = $1 order by at, seq`, [storeId]);
      return rows.map((r) => ({
        engine: String(r.engine), question: String(r.question), text: String(r.text), urls: r.urls as string[],
        mentioned: r.mentioned === true, cited: r.cited === true, others: r.others as string[], at: iso(r.at),
      }));
    },
    async events(storeId) {
      const { rows } = await q.query(`select * from ${SCHEMA}.events where store_id = $1 order by at, seq`, [storeId]);
      return rows.map((r) => ({
        storeId: String(r.store_id), kind: String(r.kind) as MeasureEvent["kind"], source: String(r.source) as Source, at: iso(r.at),
        ...(r.total === null ? {} : { total: Number(r.total) }), ...(r.order_id === null ? {} : { orderId: String(r.order_id) }),
        productIds: r.products as string[], demo: r.demo === true,
      }));
    },
    async saveEvent(e) {
      await q.query(
        `insert into ${SCHEMA}.events (store_id, kind, source, at, total, order_id, products, demo) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [e.storeId, e.kind, e.source, e.at, e.total ?? null, e.orderId ?? null, JSON.stringify(e.productIds ?? []), e.demo === true],
      );
    },
    async addVisits(rows) {
      if (rows.length === 0) return;
      // One statement for the whole flush: all of it is added, or none.
      await q.query(
        `insert into ${SCHEMA}.visitas (day, agent, kind, path, n)
         select * from unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::int[])
         on conflict (day, agent, path) do update set n = ${SCHEMA}.visitas.n + excluded.n`,
        [rows.map((r) => r.day), rows.map((r) => r.agent), rows.map((r) => r.kind), rows.map((r) => r.path), rows.map((r) => r.n)],
      );
    },
    async productGroups() {
      const { rows } = await q.query(`select data from ${SCHEMA}.productos order by slug`);
      return rows.map((r) => ProductGroupSchema.parse(r.data));
    },
    async visits(since) {
      const { rows } = await q.query(`select to_char(day, 'YYYY-MM-DD') as day, agent, kind, path, n from ${SCHEMA}.visitas where day >= $1 order by day, agent, path`, [since]);
      return rows.map((r) => VisitRowSchema.parse(r));
    },
    async saveClick(c) {
      await q.query(`insert into ${SCHEMA}.clicks (id, store_id, product_id, url, channel) values ($1, $2, $3, $4, $5)`, [c.id, c.storeId, c.productId, c.url, c.channel]);
    },
    async saveQuick(r, email) {
      await q.query(`insert into ${SCHEMA}.diagnosticos (id, domain, email, data, at) values ($1, $2, $3, $4, $5)`, [r.id, r.domain, email ?? null, JSON.stringify(r), r.at]);
    },
    async quick(id) {
      const { rows } = await q.query(`select data from ${SCHEMA}.diagnosticos where id = $1`, [id]);
      return rows[0]?.data as QuickResult | undefined;
    },
    async recentQuick(domain, since) {
      const { rows } = await q.query(`select data from ${SCHEMA}.diagnosticos where domain = $1 and at >= $2 order by at desc limit 1`, [domain, since]);
      return rows[0]?.data as QuickResult | undefined;
    },
    async guides() {
      const { rows } = await q.query(`select data from ${SCHEMA}.guias order by slug`);
      return rows.map((r) => GuideSchema.parse(r.data));
    },
    async brandSummaries() {
      const { rows } = await q.query(`select slug, brand, stores, price_min, updated from ${SCHEMA}.marcas order by slug`);
      return rows.map((r) => ({ slug: String(r.slug), brand: String(r.brand), stores: Number(r.stores), priceMin: Number(r.price_min), updatedAt: String(r.updated) }));
    },
    async brandPage(slug) {
      const { rows } = await q.query(`select data from ${SCHEMA}.marcas where slug = $1`, [slug]);
      return rows[0] === undefined ? undefined : BrandPageSchema.parse(rows[0].data);
    },
    async searchPrices(raw, limit) {
      const terms = cleanTerms(raw);
      if (terms.length === 0) return { total: 0, rows: [] };
      // Letters and digits only (cleanTerms): LIKE sees no wildcard. Each term at the start of a word.
      const where = terms.map((_, i) => `(' ' || text) like $${i + 1}`).join(" and ");
      const args = terms.map((t) => `% ${t}%`);
      const n = terms.length;
      // The count stops at COUNT_CAP + 1, and the jsonb is read only for the rows shown: a broad word stays cheap.
      const counted = await q.query(`select count(*)::int as n from (select 1 from ${SCHEMA}.precios where ${where} limit $${n + 1}) m`, [...args, COUNT_CAP + 1]);
      const { rows } = await q.query(
        `select p.data from (select seq, price from ${SCHEMA}.precios where ${where} order by price, seq limit $${n + 1}) top join ${SCHEMA}.precios p using (seq) order by top.price, top.seq`,
        [...args, limit],
      );
      return { total: Number((counted.rows[0] as { n: number }).n), rows: rows.map((r) => PriceRowSchema.parse(r.data)) };
    },
    async click(id) {
      const { rows } = await q.query(`select store_id, product_id, url, channel from ${SCHEMA}.clicks where id = $1`, [id]);
      const r = rows[0];
      return r === undefined ? undefined : { storeId: String(r.store_id), productId: String(r.product_id), url: String(r.url), channel: String(r.channel) };
    },
  };
}

type Column = "text" | "jsonb" | "timestamptz" | "bigint" | "integer" | "boolean";

/**
 * Inserts rows in batches: each batch is one query whose only parameter is a
 * JSON array of rows, unpacked by Postgres. Row by row, a big catalogue and
 * its demo events would be some 140,000 round trips to the hosted database.
 */
async function insertMany(q: Queryable, table: string, columns: Record<string, Column>, rows: readonly unknown[][], batch = 1000): Promise<void> {
  const names = Object.keys(columns);
  const exprs = Object.values(columns).map((type, i) => (type === "jsonb" ? `x->${i}` : type === "text" ? `x->>${i}` : `(x->>${i})::${type}`));
  const sql = `insert into ${SCHEMA}.${table} (${names.join(", ")}) select ${exprs.join(", ")} from jsonb_array_elements($1::jsonb) x`;
  for (let i = 0; i < rows.length; i += batch) await q.query(sql, [JSON.stringify(rows.slice(i, i + batch))]);
}

export interface ImportCount {
  storeId: string;
  products: number;
  analyses: number;
  policy: boolean;
  answers: number;
  demoEvents: number;
}

/**
 * Replaces, for each store and inside one transaction per store, the data the
 * CLI produces. `q` must be a single connection (a `PoolClient`, or PGlite),
 * since a pool may run `begin` and `commit` on different connections.
 *
 * @throws Error if a store has no products in the source (nothing to publish).
 */
export async function importStores(q: Queryable, source: Db, storeIds: readonly string[]): Promise<ImportCount[]> {
  const raw = source.raw;
  const counts: ImportCount[] = [];
  for (const storeId of storeIds) {
    const products = raw.prepare("select id, data from products where store_id = ?").all(storeId);
    if (products.length === 0) throw new Error(`la tienda ${storeId} no tiene productos en la base local`);
    const analyses = raw.prepare("select product_id, model, data, status, at from analyses where store_id = ?").all(storeId);
    const policy = raw.prepare("select model, pages, data, status, at from policies where store_id = ?").get(storeId);
    const answers = raw.prepare("select engine, question, text, urls, mentioned, cited, others, at from answers where store_id = ? order by at").all(storeId);
    const demo = raw.prepare("select kind, source, at, total, order_id, products from events where store_id = ? and demo = 1 order by at").all(storeId);
    const runs = raw.prepare("select at, method, count, notes from ingest_runs where store_id = ? order by rowid").all(storeId);

    await q.query("begin");
    try {
      for (const table of ["products", "analyses", "policies", "answers", "ingest_runs"]) {
        await q.query(`delete from ${SCHEMA}.${table} where store_id = $1`, [storeId]);
      }
      await q.query(`delete from ${SCHEMA}.events where store_id = $1 and demo`, [storeId]);
      const json = (v: unknown) => JSON.parse(String(v)) as unknown;
      await insertMany(q, "products", { store_id: "text", id: "text", data: "jsonb" }, products.map((p) => [storeId, p.id, json(p.data)]));
      await insertMany(q, "analyses", { store_id: "text", product_id: "text", model: "text", data: "jsonb", status: "text", at: "timestamptz" },
        analyses.map((a) => [storeId, a.product_id, a.model, json(a.data), a.status, a.at]));
      if (policy !== undefined) {
        await insertMany(q, "policies", { store_id: "text", model: "text", pages: "jsonb", data: "jsonb", status: "text", at: "timestamptz" },
          [[storeId, policy.model, json(policy.pages), json(policy.data), policy.status, policy.at]]);
      }
      await insertMany(q, "answers", { store_id: "text", engine: "text", question: "text", text: "text", urls: "jsonb", mentioned: "boolean", cited: "boolean", others: "jsonb", at: "timestamptz" },
        answers.map((a) => [storeId, a.engine, a.question, a.text, json(a.urls), Number(a.mentioned) === 1, Number(a.cited) === 1, json(a.others), a.at]));
      await insertMany(q, "events", { store_id: "text", kind: "text", source: "text", at: "timestamptz", total: "bigint", order_id: "text", products: "jsonb", demo: "boolean" },
        demo.map((e) => [storeId, e.kind, e.source, e.at, e.total, e.order_id, json(e.products), true]));
      await insertMany(q, "ingest_runs", { store_id: "text", at: "timestamptz", method: "text", count: "integer", notes: "jsonb" },
        runs.map((r) => [storeId, r.at, r.method, r.count, json(r.notes)]));
      await q.query("commit");
    } catch (error) {
      await q.query("rollback");
      throw error;
    }
    counts.push({ storeId, products: products.length, analyses: analyses.length, policy: policy !== undefined, answers: answers.length, demoEvents: demo.length });
  }
  return counts;
}

/**
 * Replaces every row of the price search in Postgres with the local ones, in
 * one transaction. Public facts only: title, brand, price, address and date of
 * in-stock products the stores publish themselves.
 */
export async function importPrices(q: Queryable, source: Db): Promise<number> {
  const rows = source.priceRows().map((r) => ({ ...r, data: PriceRowSchema.parse(r.data) }));
  await q.query("begin");
  try {
    await q.query(`delete from ${SCHEMA}.precios`);
    for (let i = 0; i < rows.length; i += 1000) {
      await insertMany(q, "precios", { store_id: "text", text: "text", price: "integer", data: "jsonb" }, rows.slice(i, i + 1000).map((r) => [r.storeId, r.text, r.price, r.data]));
    }
    await q.query("commit");
  } catch (error) {
    await q.query("rollback");
    throw error;
  }
  return rows.length;
}

/** Replaces every product page in Postgres with the local ones, in one transaction. */
export async function importProducts(q: Queryable, source: Db): Promise<number> {
  const groups = source.productGroups().map((g) => ProductGroupSchema.parse(g));
  await q.query("begin");
  try {
    await q.query(`delete from ${SCHEMA}.productos`);
    if (groups.length > 0) await insertMany(q, "productos", { slug: "text", data: "jsonb" }, groups.map((g) => [g.slug, g]));
    await q.query("commit");
  } catch (error) {
    await q.query("rollback");
    throw error;
  }
  return groups.length;
}

/** What the /chile pages publish now: stores across the guides and brand pages (before a replace, to refuse a sharp drop). */
export async function publishedTotals(q: Queryable): Promise<{ guideStores: number; brands: number; prices: number }> {
  const g = await q.query(`select coalesce(sum(jsonb_array_length(data->'stores')), 0)::int as n from ${SCHEMA}.guias`);
  const m = await q.query(`select count(*)::int as n from ${SCHEMA}.marcas`);
  const p = await q.query(`select count(*)::int as n from ${SCHEMA}.precios`);
  return { guideStores: Number((g.rows[0] as { n: number }).n), brands: Number((m.rows[0] as { n: number }).n), prices: Number((p.rows[0] as { n: number }).n) };
}

/**
 * Replaces every public guide in Postgres with the ones in the local file, in
 * one transaction (same single-connection rule as `importStores`). A guide is
 * aggregates and public facts only: no catalogue rows travel.
 */
export async function importGuides(q: Queryable, source: Db): Promise<string[]> {
  const guides = source.guides().map((g) => GuideSchema.parse(g.data));
  await q.query("begin");
  try {
    await q.query(`delete from ${SCHEMA}.guias`);
    await insertMany(q, "guias", { slug: "text", data: "jsonb", at: "timestamptz" }, guides.map((g) => [g.slug, g, new Date().toISOString()]));
    await q.query("commit");
  } catch (error) {
    await q.query("rollback");
    throw error;
  }
  return guides.map((g) => g.slug);
}

/**
 * Replaces every brand page in Postgres with the ones in the local file, in one
 * transaction. Like the guides, only public facts travel: each store's cheapest
 * listings of the brand, with their price and date.
 */
export async function importBrandPages(q: Queryable, source: Db): Promise<number> {
  const pages = source.brandPages().map((p) => BrandPageSchema.parse(p));
  await q.query("begin");
  try {
    await q.query(`delete from ${SCHEMA}.marcas`);
    for (let i = 0; i < pages.length; i += 200) {
      await insertMany(q, "marcas", { slug: "text", brand: "text", stores: "integer", price_min: "integer", updated: "text", data: "jsonb" },
        pages.slice(i, i + 200).map((p) => {
          const s = summarize(p);
          return [s.slug, s.brand, s.stores, s.priceMin, s.updatedAt, p];
        }));
    }
    await q.query("commit");
  } catch (error) {
    await q.query("rollback");
    throw error;
  }
  return pages.length;
}
