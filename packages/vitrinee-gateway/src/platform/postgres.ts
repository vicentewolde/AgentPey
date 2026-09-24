/**
 * Vitrinee's own tables, in its own schema, reached with its own role (C-143).
 *
 * The connection is `VITRINEE_DATABASE_URL`: a Postgres role that owns the
 * `vitrinee` schema and has no privilege on AgentPey's tables. Vitrinee never
 * receives AgentPey's `DATABASE_URL` (C-136). Every table name here is
 * schema-qualified, so nothing depends on the role's `search_path`.
 */
import { VitrineeError } from "@vitrinee/core";
import pg from "pg";

import { orderRecordSchema, type OrderPersistence, type OrderRecord } from "../orders.js";
import { comercioSchema, type Comercio, type ComercioStore } from "./comercios.js";

export const VITRINEE_SCHEMA_SQL: readonly string[] = [
  // In production the schema is created by `pnpm run vitrinee:platform-setup`,
  // owned by the admin role, and this role only has USAGE and CREATE on it.
  // `create schema if not exists` would still check CREATE on the database
  // first and fail; this only creates it where it is missing (a local database).
  `do $$ begin if to_regnamespace('vitrinee') is null then create schema vitrinee; end if; end $$`,
  `create table if not exists vitrinee.comercios (
     id                    text        primary key,
     slug                  text        not null unique,
     name                  text        not null,
     pay_to                text        not null,
     signing_account       text        not null,
     platform              text        not null,
     status                text        not null,
     country               text        not null,
     currency              text        not null,
     sealed_signing_secret text        not null,
     sealed_credentials    text        not null,
     created_at            timestamptz not null,
     updated_at            timestamptz not null
   )`,
  `create table if not exists vitrinee.orders (
     order_id    text        primary key,
     comercio_id text        not null references vitrinee.comercios(id),
     record      jsonb       not null,
     created_at  timestamptz not null,
     updated_at  timestamptz not null default now()
   )`,
  `create index if not exists orders_comercio_created_idx on vitrinee.orders (comercio_id, created_at desc)`,
];

export function createVitrineePool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    // Same as SignalDesk and the directory: the pooler requires TLS, and Node's
    // default CA bundle does not carry Supabase's chain.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => {
    process.stderr.write(`vitrinee: idle Postgres client failed: ${error.message}\n`);
  });
  return pool;
}

/** @throws VitrineeError `StorageError` naming the failure, never the connection string. */
export async function migrate(pool: pg.Pool): Promise<void> {
  try {
    for (const statement of VITRINEE_SCHEMA_SQL) await pool.query(statement);
  } catch (error) {
    throw storageError("could not initialise the vitrinee schema", error);
  }
}

interface ComercioRow {
  id: string;
  slug: string;
  name: string;
  pay_to: string;
  signing_account: string;
  platform: string;
  status: string;
  country: string;
  currency: string;
  sealed_signing_secret: string;
  sealed_credentials: string;
  created_at: Date;
  updated_at: Date;
}

function fromRow(row: ComercioRow): Comercio {
  const parsed = comercioSchema.safeParse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    payTo: row.pay_to,
    signingAccount: row.signing_account,
    platform: row.platform,
    status: row.status,
    country: row.country,
    currency: row.currency,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sealedSigningSecret: row.sealed_signing_secret,
    sealedCredentials: row.sealed_credentials,
  });
  if (!parsed.success) {
    throw new VitrineeError("StorageError", "a comercio row does not have the expected shape", { details: { id: row.id } });
  }
  return parsed.data;
}

export class PostgresComercioStore implements ComercioStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(c: Comercio): Promise<void> {
    const comercio = comercioSchema.parse(c);
    try {
      await this.pool.query(
        `insert into vitrinee.comercios
           (id, slug, name, pay_to, signing_account, platform, status, country, currency,
            sealed_signing_secret, sealed_credentials, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          comercio.id,
          comercio.slug,
          comercio.name,
          comercio.payTo,
          comercio.signingAccount,
          comercio.platform,
          comercio.status,
          comercio.country,
          comercio.currency,
          comercio.sealedSigningSecret,
          comercio.sealedCredentials,
          comercio.createdAt,
          comercio.updatedAt,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new VitrineeError("ComercioConflict", `a comercio with slug "${comercio.slug}" already exists`, { details: { slug: comercio.slug } });
      }
      throw storageError("could not save the comercio", error);
    }
  }

  async getBySlug(slug: string): Promise<Comercio | undefined> {
    const rows = await this.query<ComercioRow>(`select * from vitrinee.comercios where slug = $1`, [slug]);
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  }

  async list(): Promise<Comercio[]> {
    return (await this.query<ComercioRow>(`select * from vitrinee.comercios order by slug`, [])).map(fromRow);
  }

  private async query<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return (await this.pool.query<T>(sql, params)).rows;
    } catch (error) {
      throw storageError("could not read comercios", error);
    }
  }
}

/** One comercio's orders. Every statement carries its id: no query reads another merchant's orders. */
export class PostgresOrderPersistence implements OrderPersistence {
  constructor(
    private readonly pool: pg.Pool,
    private readonly comercioId: string,
  ) {}

  async load(): Promise<OrderRecord[]> {
    let rows: { order_id: string; record: unknown }[];
    try {
      rows = (await this.pool.query(`select order_id, record from vitrinee.orders where comercio_id = $1`, [this.comercioId])).rows;
    } catch (error) {
      throw storageError("could not load orders", error);
    }
    return rows.map((row) => {
      const parsed = orderRecordSchema.safeParse(row.record);
      if (!parsed.success) {
        throw new VitrineeError("StorageError", "an order row does not have the expected shape", { details: { orderId: row.order_id } });
      }
      return parsed.data as OrderRecord;
    });
  }

  async save(order: OrderRecord): Promise<void> {
    try {
      const result = await this.pool.query(
        `insert into vitrinee.orders (order_id, comercio_id, record, created_at, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (order_id) do update set record = excluded.record, updated_at = now()
           where vitrinee.orders.comercio_id = excluded.comercio_id`,
        [order.orderId, this.comercioId, JSON.stringify(order), order.createdAt],
      );
      // The `where` makes an order id that belongs to another comercio a no-op
      // instead of a silent overwrite; surface it.
      if (result.rowCount === 0) {
        throw new VitrineeError("StorageError", "that order id belongs to another comercio", { details: { orderId: order.orderId } });
      }
    } catch (error) {
      if (error instanceof VitrineeError) throw error;
      throw storageError("could not save the order", error);
    }
  }
}

function storageError(message: string, error: unknown): VitrineeError {
  const reason = error instanceof Error ? error.message : String(error);
  return new VitrineeError("StorageError", `${message}: ${reason}`, { cause: error });
}
