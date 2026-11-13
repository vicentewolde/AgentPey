/**
 * Writes a copy of the demo database that holds only the stores named on the
 * command line, so a hosted panel never ships the Black Friday data or a pilot
 * that has not given a written OK.
 *
 *   npx tsx scripts/export-public-db.ts <salida.db> <tienda> [<tienda> ...]
 */
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const [out, ...keep] = process.argv.slice(2);
if (out === undefined || keep.length === 0) {
  console.error("uso: export-public-db.ts <salida.db> <tienda> [<tienda> ...]");
  process.exit(1);
}
copyFileSync(fileURLToPath(new URL("../data/comercios.db", import.meta.url)), out);
const db = new DatabaseSync(out);
const marks = keep.map(() => "?").join(",");
for (const table of ["products", "analyses", "policies", "answers", "events", "clicks", "ingest_runs"]) {
  db.prepare(`delete from ${table} where store_id not in (${marks})`).run(...keep);
}
db.exec("vacuum");
console.log(`${out}: ${keep.join(", ")}`);
