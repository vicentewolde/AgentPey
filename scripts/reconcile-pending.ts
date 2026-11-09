#!/usr/bin/env node
/**
 * `pnpm run reconcile:pending` — shows, and with `--apply` helps unstick, checkouts the store never learned the
 * payment outcome of (Fase 9, T180, X-32): `complete_in_progress` with a settlement attempt and no settlement.
 *
 * DRY RUN BY DEFAULT. It reads the held checkouts from the pilot's Postgres and the chain from Horizon, checks each
 * payment (the payer that signed it, the exact USDC amount, the escrow or merchant it names) and prints what the
 * store would do. Nothing is written, no order is made and no transaction is sent.
 *
 *   pnpm run reconcile:pending                              every held checkout of every comercio
 *   pnpm run reconcile:pending -- --session <checkout id>    one checkout
 *   pnpm run reconcile:pending -- --session <id> --tx <hash> a payment a person found for a checkout that has no hash
 *   pnpm run reconcile:pending -- --session <id> --tx <hash> --apply
 *
 * `--apply` never creates the order itself (a second process cannot update the store's order cache): it only records
 * the verified hash on the held checkout, and clears a "needs review" mark. The running store, with
 * `VITRINEE_RECONCILE_PENDING=1`, finishes it on its next pass (within a minute): the order, the escrow `hold`
 * and the receipt. A hash that does not verify is refused, and `--apply` without `--tx` has nothing to apply.
 *
 * Env: `VITRINEE_DATABASE_URL` (a Postgres role limited to the `vitrinee` schema); `STELLAR_HORIZON_URL` optional
 * (testnet by default). Testnet only.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { PostgresCheckoutSessions, createVitrineePool } from "../packages/vitrinee-gateway/src/platform/postgres.js";
import { verifyStrandedPayment } from "../packages/vitrinee-gateway/src/ucp/reconcile.js";

const { values } = parseArgs({
  options: { session: { type: "string" }, tx: { type: "string" }, apply: { type: "boolean", default: false } },
  strict: true,
});

if (process.env["VITRINEE_DATABASE_URL"] === undefined) {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, "..", ".env.vitrinee.local"));
  } catch {
    // No env file: the variable must come from the shell.
  }
}
const databaseUrl = process.env["VITRINEE_DATABASE_URL"];
if (databaseUrl === undefined) throw new Error("VITRINEE_DATABASE_URL is not set");
if (values.tx !== undefined && values.session === undefined) throw new Error("--tx names a payment for one checkout: pass --session too");
if (values.apply && values.tx === undefined) throw new Error("--apply records a hash you found: pass --tx and --session (without it there is nothing to apply)");
const horizonUrl = process.env["STELLAR_HORIZON_URL"] ?? "https://horizon-testnet.stellar.org";

const pool = createVitrineePool(databaseUrl);
try {
  const comercios = (await pool.query(`select id, slug from vitrinee.comercios order by slug`)).rows as { id: string; slug: string }[];
  let found = 0;
  for (const comercio of comercios) {
    const sessions = new PostgresCheckoutSessions(pool, comercio.id);
    for (const session of (await sessions.listStranded()) ?? []) {
      if (values.session !== undefined && session.id !== values.session) continue;
      found += 1;
      const hint = values.tx;
      const recorded = session.settleAttempt?.transaction ?? null;
      console.log(`\n${comercio.slug} · ${session.id}`);
      console.log(`  held since       ${session.settleAttempt?.at}  (${session.settleAttempt?.error.slice(0, 120)})`);
      console.log(`  amount (atomic)  ${session.requirements?.amount}  →  ${session.requirements?.payTo}`);
      console.log(`  recorded hash    ${recorded ?? "none"}`);
      if (session.reconcile?.review != null) console.log(`  marked for review: ${session.reconcile.review.reason}`);
      const verdict = await verifyStrandedPayment({ horizonUrl }, session, hint);
      if (verdict.kind === "verified") {
        console.log(`  VERIFIED         ${verdict.transaction} paid by ${verdict.payer}${verdict.closedAt === undefined ? "" : ` at ${verdict.closedAt}`}`);
        if (!values.apply) {
          console.log("  would do         with the store's reconciliation on: record the settlement, make the order once, hold it in the escrow, anchor the receipt");
          if (hint !== undefined && hint !== recorded) console.log("                   (the hash was passed by hand: run again with --apply to record it on the checkout)");
        }
      } else {
        console.log(`  ${verdict.kind === "retry" ? "NOT YET       " : "NEEDS REVIEW  "}   ${verdict.reason}`);
      }
      if (values.apply && verdict.kind === "verified") {
        session.settleAttempt = { transaction: verdict.transaction, error: session.settleAttempt?.error ?? "recorded by hand", at: session.settleAttempt?.at ?? new Date().toISOString() };
        session.reconcile = null;
        session.updatedAt = new Date().toISOString();
        await sessions.save(session);
        console.log("  APPLIED          hash recorded on the checkout; the running store finishes it on its next pass");
      }
    }
  }
  if (found === 0) console.log(values.session === undefined ? "no held checkouts" : `no held checkout ${values.session}`);
} finally {
  await pool.end();
}
