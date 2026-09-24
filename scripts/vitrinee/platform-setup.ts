#!/usr/bin/env node
/**
 * `pnpm run vitrinee:platform-setup` — prepares the multi-merchant platform
 * (T103) in the pilot's Postgres, once, and prints the two values the user
 * loads into Render. Run by the user: it prints secrets (P-10).
 *
 * What it does, in order, stopping at the first problem:
 *
 * 1. Creates the `vitrinee` role (or rotates its password) with no privilege
 *    beyond its own schema, and the `vitrinee` schema (C-143).
 * 2. Checks, as the admin, that the role can read or write no table outside
 *    that schema, and then, connected as the role, that AgentPey's tables
 *    refuse it.
 * 3. Creates Vitrinee's tables, connected as the role, so the role owns them.
 * 4. Registers Bazar Cordillera as the first comercio from `.env.vitrinee.local`,
 *    sealed with the master key (VT-27), after checking that its payout
 *    account and signing key are the ones the live store publishes.
 * 5. With `--import-order <backup.json>`, rebuilds a pending order from its
 *    public backup and AgentPey's record of the same payment, and stores it.
 * 6. Prints `VITRINEE_DATABASE_URL` and `VITRINEE_MASTER_KEY`.
 *
 * `--check` does steps that change nothing and prints no secret.
 *
 * Re-running rotates the role's password (print, load again). The master key
 * is generated only while no comercio exists; after that it must be passed in
 * `VITRINEE_MASTER_KEY`, because every sealed secret depends on it.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";

import { DEFAULT_SEED_SLUG, openComercioSecrets, seedComercioFromEnv } from "../../packages/vitrinee-gateway/src/platform/comercios.js";
import { PostgresComercioStore, PostgresOrderPersistence, createVitrineePool, migrate } from "../../packages/vitrinee-gateway/src/platform/postgres.js";
import { createSecretBox, generateMasterKey } from "../../packages/vitrinee-gateway/src/platform/secret-box.js";
import { readEnvFile } from "./lib/env-file.js";
import { VITRINEE_ROLE, rebuildOrder, roleConnectionString, type PublicOrderBackup } from "./lib/platform-setup.js";
import type { OrderRecord } from "../../packages/vitrinee-gateway/src/orders.js";

type Pool = ReturnType<typeof createVitrineePool>;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/**
 * The seed comercio's own store, at its subdomain (C-142). Since T104 the root
 * host is only the portal and serves no store, so the keys are checked against
 * the store's own manifest, not the root's.
 */
const liveManifestUrl = (slug: string): string => `https://${slug}.vitrinee.agentpey.com/.well-known/agent-storefront.json`;

const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const die = (message: string): never => {
  process.stderr.write(`\nvitrinee:platform-setup: ${message}\nNothing after this step was done.\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const importIndex = args.indexOf("--import-order");
const importPath = importIndex === -1 ? undefined : args[importIndex + 1];
if (importIndex !== -1 && importPath === undefined) die("--import-order needs a path to the order backup");

async function envValue(file: string, key: string): Promise<string | undefined> {
  try {
    return (await readEnvFile(resolve(REPO_ROOT, file))).values.get(key);
  } catch {
    return undefined;
  }
}

async function connectWithRetry(url: string, attempts = 6): Promise<Pool> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const pool = createVitrineePool(url);
    try {
      await pool.query("select 1");
      return pool;
    } catch (error) {
      last = error;
      await pool.end().catch(() => undefined);
      await new Promise<void>((done) => setTimeout(done, 2_000));
    }
  }
  return die(`could not connect as the ${VITRINEE_ROLE} role: ${last instanceof Error ? last.message : String(last)}`);
}

/** Tables outside Vitrinee's schema the role can touch. Supabase's `extensions` views are granted to everyone and hold no AgentPey data. */
async function reachableOutsideSchema(admin: Pool): Promise<string[]> {
  const { rows } = await admin.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','v','m','p','f')
        and n.nspname not in ('pg_catalog','information_schema','extensions', $1)
        and n.nspname not like 'pg\\_%'
        and (has_table_privilege($1, c.oid, 'SELECT') or has_table_privilege($1, c.oid, 'INSERT')
          or has_table_privilege($1, c.oid, 'UPDATE') or has_table_privilege($1, c.oid, 'DELETE'))`,
    [VITRINEE_ROLE],
  );
  return rows.map((r) => r.name);
}

/** The pending order, rebuilt from its public backup and AgentPey's record of the same payment. */
async function orderFromBackup(admin: Pool, path: string): Promise<OrderRecord> {
  const backup = JSON.parse(await readFile(resolve(path), "utf8")) as PublicOrderBackup;
  const recorded = await admin.query<{ url: string | null }>(
    `select delivery->>'resource_url' as url from directory_purchases where transaction_hash = $1 and outcome = 'settled'`,
    [backup.settlement.txHash],
  );
  const url = recorded.rows[0]?.url;
  if (url == null) return die("AgentPey has no settled purchase for that order's payment");
  return rebuildOrder(backup, url);
}

async function main(): Promise<void> {
  out(check ? "vitrinee:platform-setup --check (changes nothing, prints no secret)" : "vitrinee:platform-setup");
  out();

  const adminUrl = await envValue(".env.local", "DATABASE_URL");
  if (adminUrl === undefined) die("DATABASE_URL is missing from .env.local (the pilot's admin connection)");
  const merchantEnv = Object.fromEntries((await readEnvFile(resolve(REPO_ROOT, ".env.vitrinee.local"))).values);

  // The store the platform takes over must be the one that is live today.
  const payTo = merchantEnv["MERCHANT_STELLAR_ACCOUNT"];
  const signingSecret = merchantEnv["MERCHANT_SIGNING_SECRET"];
  if (!payTo || !signingSecret) die(".env.vitrinee.local needs MERCHANT_STELLAR_ACCOUNT and MERCHANT_SIGNING_SECRET");
  if (!merchantEnv["JUMPSELLER_LOGIN"] || !merchantEnv["JUMPSELLER_AUTHTOKEN"]) die(".env.vitrinee.local needs JUMPSELLER_LOGIN and JUMPSELLER_AUTHTOKEN");
  const signingAccount = Keypair.fromSecret(signingSecret!).publicKey();
  const manifestUrl = liveManifestUrl(merchantEnv["SEED_COMERCIO_SLUG"] || DEFAULT_SEED_SLUG);
  const liveResponse = await fetch(manifestUrl);
  if (!liveResponse.ok) die(`${manifestUrl} answered ${liveResponse.status}: the store to take over is not live at its subdomain`);
  const live = (await liveResponse.json()) as { merchant?: { stellarAccount?: string; did?: string } };
  if (live.merchant?.stellarAccount !== payTo || live.merchant?.did !== `did:stellar:testnet:${signingAccount}`) {
    die(`the payout account or signing key in .env.vitrinee.local is not the one ${manifestUrl} publishes`);
  }
  out(`✓ local store keys match the live store (payTo ${payTo}, signing ${signingAccount})`);

  const admin = createVitrineePool(adminUrl!);
  try {
    const role = await admin.query(`select rolcreaterole, rolsuper from pg_roles where rolname = current_user`);
    if (role.rows[0]?.rolcreaterole !== true) die("the admin connection cannot create roles");
    const exists = (await admin.query(`select 1 from pg_roles where rolname = $1`, [VITRINEE_ROLE])).rowCount === 1;
    const schema = (await admin.query(`select to_regnamespace('vitrinee') is not null as present`)).rows[0]?.present === true;
    out(`✓ admin can create roles · role ${VITRINEE_ROLE}: ${exists ? "exists" : "to create"} · schema vitrinee: ${schema ? "exists" : "to create"}`);

    // The master key is settled BEFORE the role's password is touched. Rotating
    // first and failing on the key afterwards changed the password and never
    // showed the new one, leaving production on the old one until a rerun.
    const givenKey = process.env["VITRINEE_MASTER_KEY"];
    if (exists && !givenKey) die("the role and its comercios already exist, so their master key is needed: run again with VITRINEE_MASTER_KEY set in the shell. Nothing was changed.");
    if (givenKey) createSecretBox(givenKey); // wrong length: stops here, naming the rule and never the value
    if (exists && givenKey) {
      let sealed: Awaited<ReturnType<PostgresComercioStore["list"]>> | undefined;
      try {
        sealed = await new PostgresComercioStore(admin).list();
      } catch {
        sealed = undefined; // the admin may not be allowed to read the role's tables; the check after rotation still runs
      }
      if (sealed !== undefined) {
        const box = createSecretBox(givenKey);
        for (const c of sealed) openComercioSecrets(c, box);
        out(`✓ the master key opens the ${sealed.length} registered comercio(s)`);
      }
    }

    if (check) {
      if (exists) {
        const reachable = await reachableOutsideSchema(admin);
        out(reachable.length === 0 ? "✓ the role reaches no table outside its schema" : `✗ the role reaches: ${reachable.join(", ")}`);
      }
      if (importPath !== undefined) {
        const order = await orderFromBackup(admin, importPath);
        out(`✓ order ${order.orderId} rebuilds: ${order.status}, ${order.amountUSDC} USDC, receipt ${order.receipt?.hash.slice(0, 12)}…, shipping fields ${Object.keys(order.buyer.shipping ?? {}).join(",")}`);
      }
      out();
      out("Check done. Run without --check to apply (it prints two secrets for Render).");
      return;
    }

    // 1. Role and schema.
    const password = randomBytes(24).toString("base64url");
    // base64url only: safe inside a SQL literal, and DDL takes no bind parameters.
    if (!/^[A-Za-z0-9_-]+$/.test(password)) die("generated password has an unexpected character");
    const literal = `'${password}'`;
    await admin.query(
      `${exists ? "alter" : "create"} role ${VITRINEE_ROLE} with login password ${literal} nocreatedb nocreaterole nobypassrls noinherit connection limit 10`,
    );
    await admin.query(`create schema if not exists vitrinee`);
    await admin.query(`revoke all on schema vitrinee from public`);
    await admin.query(`grant usage, create on schema vitrinee to ${VITRINEE_ROLE}`);
    out(`✓ role ${VITRINEE_ROLE} ${exists ? "password rotated" : "created"} · schema vitrinee ready`);

    // 2. Isolation, as the admin sees it.
    const reachable = await reachableOutsideSchema(admin);
    if (reachable.length > 0) die(`the role can reach tables outside its schema: ${reachable.join(", ")}`);
    out("✓ the role reaches no table outside its schema");

    // 3. Tables, created by the role itself; and isolation as the role sees it.
    const roleUrl = roleConnectionString(adminUrl!, password);
    const vitrinee = await connectWithRetry(roleUrl);
    try {
      try {
        await vitrinee.query(`select 1 from public.directory_tenants limit 1`);
        die("connected as the role, AgentPey's directory_tenants was readable");
      } catch (error) {
        if ((error as { code?: string }).code !== "42501") throw error;
      }
      out("✓ connected as the role through the pooler; AgentPey's tables refuse it");
      await migrate(vitrinee);
      out("✓ Vitrinee's tables created, owned by the role");

      // 4. Master key and the first comercio.
      const comercios = new PostgresComercioStore(vitrinee);
      const existing = await comercios.list();
      if (existing.length > 0 && !givenKey) {
        die("comercios already exist, so their master key must be reused: run again with VITRINEE_MASTER_KEY set in the shell");
      }
      const masterKey = givenKey || generateMasterKey();
      const box = createSecretBox(masterKey);
      for (const c of existing) openComercioSecrets(c, box); // a wrong key stops here, not in production
      const seeded = await seedComercioFromEnv({ ...merchantEnv, ADAPTER: "jumpseller" }, comercios, box, new Date());
      if (seeded === undefined) die("nothing to seed");
      out(`✓ comercio ${seeded!.comercio.slug} ${seeded!.created ? "registered" : "already registered"} (${seeded!.comercio.id})`);

      // 5. The pending order.
      if (importPath !== undefined) {
        const order = await orderFromBackup(admin, importPath);
        const persistence = new PostgresOrderPersistence(vitrinee, seeded!.comercio.id);
        const already = (await persistence.load()).some((o) => o.orderId === order.orderId);
        if (!already) await persistence.save(order);
        out(`✓ order ${order.orderId} ${already ? "already stored" : "stored"} as ${order.status}, receipt untouched`);
      }

      out();
      out("Load these two into the AgentPey service on Render (Environment), then redeploy.");
      out("Keep the master key somewhere safe too: without it, no comercio's secrets open.");
      out();
      out(`VITRINEE_DATABASE_URL=${roleUrl}`);
      out(`VITRINEE_MASTER_KEY=${masterKey}`);
    } finally {
      await vitrinee.end();
    }
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => die(error instanceof Error ? error.message : String(error)));
