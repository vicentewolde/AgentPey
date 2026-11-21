/**
 * Prepares the hosted panel's data in the pilot's existing Postgres, and loads
 * the chosen stores into it from the local SQLite file. Run by the user: it
 * prints a secret (the role's connection string) for Render.
 *
 *   npx tsx scripts/setup-postgres.ts --env <path/.env.local> [--check | --solo-importar] [--guias] [<tienda> ...]
 *
 * In order, stopping at the first problem:
 *
 * 1. Creates the `comercios` role (or rotates its password) with no privilege
 *    beyond its own `comercios` schema, and the schema (same pattern as
 *    Vitrinee's `vitrinee` role).
 * 2. Checks, as the admin, that the role reaches no table outside the schema,
 *    and then, connected as the role, that AgentPey's tables refuse it.
 * 3. Creates the panel's tables, connected as the role, so the role owns them.
 * 4. Copies each store from the local SQLite file (catalogue, listing reviews,
 *    policy, AI answers, demo events). Real measurement events and clicks
 *    already in Postgres are kept.
 * 5. Prints `COMERCIOS_DATABASE_URL`.
 *
 * `--check` changes nothing and prints no secret: it checks the admin
 * connection, and that every store has data in the local file.
 *
 * `--max-caida <pct>` (the weekly job) refuses to replace them when the stores
 * across the guides or the brand pages would drop by more than that percentage.
 *
 * `--guias` also replaces the public guides (`cli base guia`, guia.ts) and the
 * brand pages (marcas.ts) with the ones in the local file. Guides alone need no store: `--solo-importar --guias`.
 *
 * `--solo-importar` only does step 4, for stores added later: it keeps the
 * role's password (nothing to change in Render) and prints no secret. The
 * admin acts as the role (`set role`), so the role still owns every row.
 *
 * Re-running without it rotates the role's password: load the new value into Render.
 * The admin connection is `DATABASE_URL` in the file given with `--env`
 * (the main checkout's `.env.local`). Never printed.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import pg from "pg";

import { localDataDir, openDb } from "../src/db.js";
import { GuideSchema } from "../src/guia.js";
import { publishDrop } from "../src/semanal.js";
import { SCHEMA, importBrandPages, importGuides, importStores, migrate, publishedTotals } from "../src/store.js";

const ROLE = "comercios";
const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const die = (message: string): never => {
  process.stderr.write(`\nsetup-postgres: ${message}\nNothing after this step was done.\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const importOnly = args.includes("--solo-importar");
const withGuides = args.includes("--guias");
const envIndex = args.indexOf("--env");
const envPath = envIndex === -1 ? undefined : args[envIndex + 1];
const dropIndex = args.indexOf("--max-caida");
const maxDrop = dropIndex === -1 ? undefined : Number(args[dropIndex + 1]);
const stores = args.filter((a, i) => !a.startsWith("--") && i !== envIndex + 1 && (dropIndex === -1 || i !== dropIndex + 1));
if (envPath === undefined) die("falta --env <ruta al .env.local con DATABASE_URL>");
if (stores.length === 0 && !withGuides) die("faltan las tiendas a cargar (o --guias)");
for (const s of stores) if (!/^[a-z0-9-]+$/.test(s)) die(`nombre de tienda inválido: ${s}`);
if (maxDrop !== undefined && !(maxDrop > 0 && maxDrop < 100)) die("--max-caida es un porcentaje entre 1 y 99");

/**
 * The connection string for the role, built from the admin one. Supabase's
 * pooler names a role `<role>.<project-ref>`; a plain Postgres just `<role>`.
 * Host, port, database and parameters are kept.
 */
export function roleConnectionString(adminUrl: string, password: string, role = ROLE): string {
  const url = new URL(adminUrl);
  const name = decodeURIComponent(url.username);
  const dot = name.indexOf(".");
  url.username = encodeURIComponent(`${role}${dot === -1 ? "" : name.slice(dot)}`);
  url.password = encodeURIComponent(password);
  return url.toString();
}

function pool(url: string): pg.Pool {
  const p = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false }, max: 2 });
  p.on("error", () => undefined);
  return p;
}

async function connectWithRetry(url: string, attempts = 6): Promise<pg.Pool> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const p = pool(url);
    try {
      await p.query("select 1");
      return p;
    } catch (error) {
      last = error;
      await p.end().catch(() => undefined);
      await new Promise<void>((done) => setTimeout(done, 2_000)); // a new role takes a moment to reach the pooler
    }
  }
  return die(`no pude conectarme como el rol ${ROLE}: ${last instanceof Error ? last.message : String(last)}`);
}

/** Tables outside the panel's schema the role can touch. Supabase's `extensions` views are granted to everyone and hold no AgentPey data. */
async function reachableOutsideSchema(admin: pg.Pool): Promise<string[]> {
  const { rows } = await admin.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','v','m','p','f')
        and n.nspname not in ('pg_catalog','information_schema','extensions', $1)
        and n.nspname not like 'pg\\_%'
        and (has_table_privilege($1, c.oid, 'SELECT') or has_table_privilege($1, c.oid, 'INSERT')
          or has_table_privilege($1, c.oid, 'UPDATE') or has_table_privilege($1, c.oid, 'DELETE'))`,
    [ROLE],
  );
  return rows.map((r) => r.name);
}

async function main(): Promise<void> {
  out(check ? "setup-postgres --check (no cambia nada, no imprime secretos)" : importOnly ? "setup-postgres --solo-importar (no cambia la contraseña, no imprime secretos)" : "setup-postgres");
  out();

  const adminUrl = parseEnv(readFileSync(envPath!, "utf8")).DATABASE_URL;
  if (adminUrl === undefined || adminUrl === "") return die(`${envPath} no tiene DATABASE_URL`);

  const source = openDb(`${localDataDir()}comercios.db`);
  for (const s of stores) {
    const n = source.products(s).length;
    if (n === 0) die(`la tienda ${s} no tiene productos en la base local`);
    out(`✓ ${s}: ${n} productos en la base local`);
  }
  if (withGuides) {
    const guides = source.guides();
    if (guides.length === 0) die("no hay guías en la base local: corre antes `npx tsx src/cli.ts base guia`");
    out(`✓ ${guides.length} guías en la base local: ${guides.map((g) => g.slug).join(", ")}`);
  }

  const admin = pool(adminUrl);
  try {
    const me = await admin.query(`select rolcreaterole from pg_roles where rolname = current_user`);
    if (me.rows[0]?.rolcreaterole !== true) die("la conexión de administrador no puede crear roles");
    const exists = (await admin.query(`select 1 from pg_roles where rolname = $1`, [ROLE])).rowCount === 1;
    out(`✓ el administrador puede crear roles · rol ${ROLE}: ${exists ? "existe" : "por crear"}`);

    if (check) {
      if (exists) {
        const reachable = await reachableOutsideSchema(admin);
        out(reachable.length === 0 ? "✓ el rol no alcanza ninguna tabla fuera de su esquema" : `✗ el rol alcanza: ${reachable.join(", ")}`);
      }
      out();
      out("Revisión lista. Corre sin --check para aplicar (imprime un secreto para Render).");
      return;
    }

    if (importOnly) {
      if (!exists) die(`el rol ${ROLE} no existe: corre primero sin --solo-importar`);
      const reachable = await reachableOutsideSchema(admin);
      if (reachable.length > 0) die(`el rol alcanza tablas fuera de su esquema: ${reachable.join(", ")}`);
      out("✓ el rol no alcanza ninguna tabla fuera de su esquema");
      // The admin created the role, so it holds ADMIN OPTION and may let itself act as it.
      await admin.query(`grant ${ROLE} to current_user with inherit false, set true`);
      const client = await admin.connect();
      try {
        await client.query(`set role ${ROLE}`);
        await migrate(client);
        for (const c of await importStores(client, source, stores)) {
          out(`✓ ${c.storeId}: ${c.products} productos, ${c.analyses} revisiones, política ${c.policy ? "sí" : "no"}, ${c.answers} respuestas de IA, ${c.demoEvents} eventos de demostración`);
        }
        if (withGuides && maxDrop !== undefined) {
          const before = await publishedTotals(client);
          const after = { guideStores: source.guides().reduce((n, g) => n + GuideSchema.parse(g.data).stores.length, 0), brands: source.brandSummaries().length };
          const drop = publishDrop(before, after, maxDrop);
          if (drop !== undefined) die(`no se publica: ${drop}. Revisa la lectura; para publicar igual, corre sin --max-caida`);
          out(`✓ publicadas antes: ${before.guideStores} tiendas en las guías y ${before.brands} marcas; ahora ${after.guideStores} y ${after.brands}`);
        }
        if (withGuides) out(`✓ guías publicadas: ${(await importGuides(client, source)).join(", ")}`);
        if (withGuides) out(`✓ páginas de marcas publicadas: ${await importBrandPages(client, source)}`);
        await client.query("reset role");
      } finally {
        client.release();
      }
      out();
      out("Listo. La contraseña del rol no cambió: no hay nada que actualizar en Render.");
      return;
    }

    // 1. Role and schema.
    const password = randomBytes(24).toString("base64url");
    // base64url only: safe inside a SQL literal, and DDL takes no bind parameters.
    if (!/^[A-Za-z0-9_-]+$/.test(password)) die("la contraseña generada tiene un carácter inesperado");
    await admin.query(`${exists ? "alter" : "create"} role ${ROLE} with login password '${password}' nocreatedb nocreaterole nobypassrls noinherit connection limit 10`);
    await admin.query(`create schema if not exists ${SCHEMA}`);
    await admin.query(`revoke all on schema ${SCHEMA} from public`);
    await admin.query(`grant usage, create on schema ${SCHEMA} to ${ROLE}`);
    out(`✓ rol ${ROLE} ${exists ? "con contraseña nueva" : "creado"} · esquema ${SCHEMA} listo`);

    // 2. Isolation, as the admin sees it.
    const reachable = await reachableOutsideSchema(admin);
    if (reachable.length > 0) die(`el rol alcanza tablas fuera de su esquema: ${reachable.join(", ")}`);
    out("✓ el rol no alcanza ninguna tabla fuera de su esquema");

    // 3. Tables, created by the role; and isolation as the role sees it.
    const roleUrl = roleConnectionString(adminUrl, password);
    const role = await connectWithRetry(roleUrl);
    try {
      try {
        await role.query(`select 1 from public.directory_tenants limit 1`);
        die("conectado como el rol, la tabla directory_tenants de AgentPey se pudo leer");
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "42501" && code !== "42P01") throw error; // permission denied, or no such table
      }
      out("✓ conectado como el rol; las tablas de AgentPey lo rechazan");
      await migrate(role);
      out("✓ tablas del panel creadas, del rol");

      // 4. The stores, each in its own transaction on one connection.
      const client = await role.connect();
      try {
        for (const c of await importStores(client, source, stores)) {
          out(`✓ ${c.storeId}: ${c.products} productos, ${c.analyses} revisiones, política ${c.policy ? "sí" : "no"}, ${c.answers} respuestas de IA, ${c.demoEvents} eventos de demostración`);
        }
        if (withGuides && maxDrop !== undefined) {
          const before = await publishedTotals(client);
          const after = { guideStores: source.guides().reduce((n, g) => n + GuideSchema.parse(g.data).stores.length, 0), brands: source.brandSummaries().length };
          const drop = publishDrop(before, after, maxDrop);
          if (drop !== undefined) die(`no se publica: ${drop}. Revisa la lectura; para publicar igual, corre sin --max-caida`);
          out(`✓ publicadas antes: ${before.guideStores} tiendas en las guías y ${before.brands} marcas; ahora ${after.guideStores} y ${after.brands}`);
        }
        if (withGuides) out(`✓ guías publicadas: ${(await importGuides(client, source)).join(", ")}`);
        if (withGuides) out(`✓ páginas de marcas publicadas: ${await importBrandPages(client, source)}`);
      } finally {
        client.release();
      }

      out();
      out("Carga este valor en el servicio AgentPey de Render (Environment) y vuelve a desplegar.");
      out("No lo pegues en ningún chat ni archivo del repositorio.");
      out();
      out(`COMERCIOS_DATABASE_URL=${roleUrl}`);
    } finally {
      await role.end();
    }
  } finally {
    await admin.end();
    source.close();
  }
}

main().catch((error: unknown) => die(error instanceof Error ? error.message : String(error)));
