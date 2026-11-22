/**
 * The visits report (visitas.ts): which crawlers and assistants read the
 * public pages, and how many people arrived from an assistant's answer. Reads
 * only; prints no secret.
 *
 *   npx tsx scripts/visitas.ts --env <path/.env.local> [--desde AAAA-MM-DD]
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import pg from "pg";

import { SCHEMA } from "../src/store.js";
import { VisitRowSchema, visitsReport } from "../src/visitas.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const envPath = flag("--env");
if (envPath === undefined) {
  console.error("falta --env <ruta al .env.local con DATABASE_URL>");
  process.exit(2);
}
const since = flag("--desde") ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--desde va como AAAA-MM-DD");
  process.exit(2);
}
const url = parseEnv(readFileSync(envPath, "utf8")).DATABASE_URL;
if (url === undefined || url === "") {
  console.error(`${envPath} no tiene DATABASE_URL`);
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
await client.connect();
try {
  const exists = await client.query(`select to_regclass('${SCHEMA}.visitas') is not null as ok`);
  if (exists.rows[0]?.ok !== true) {
    console.log("Todavía no hay tabla de visitas: el servidor la crea al arrancar con esta versión.");
  } else {
    const { rows } = await client.query(`select to_char(day, 'YYYY-MM-DD') as day, agent, kind, path, n from ${SCHEMA}.visitas where day >= $1 order by day`, [since]);
    console.log(visitsReport(rows.map((r) => VisitRowSchema.parse(r))));
  }
} finally {
  await client.end();
}
