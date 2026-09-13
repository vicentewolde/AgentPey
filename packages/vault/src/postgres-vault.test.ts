import { afterEach, describe, expect, it, vi } from "vitest";

interface PoolOptions {
  readonly connectionString: string;
  readonly ssl: { readonly ca?: string; readonly rejectUnauthorized: boolean };
}

const pools = vi.hoisted((): PoolOptions[] => []);
const errorListeners = vi.hoisted(() => ({ count: 0 }));
const queries = vi.hoisted((): string[] => []);
const failNextCreate = vi.hoisted(() => ({ value: false }));

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: PoolOptions) {
      pools.push(options);
    }

    on(event: string) {
      if (event === "error") errorListeners.count += 1;
      return this;
    }

    async query(text: string) {
      queries.push(text);
      if (failNextCreate.value && text.includes("create table")) {
        failNextCreate.value = false;
        throw new Error("could not connect");
      }
      return { rows: [] };
    }

    async end() {}
  },
}));

import { createPostgresMandateVault } from "./postgres-vault.js";

const originalPostgresCa = process.env.POSTGRES_CA_CERT;

/**
 * Pools are shared per process, so each test names its own database: a pool
 * one test opened would otherwise be reused by the next, and the assertions
 * below are about when a pool is opened.
 */
let databases = 0;
function freshDatabase(): string {
  databases += 1;
  return `postgres://test-${databases}`;
}

const createTableQueries = () => queries.filter((text) => text.includes("create table")).length;

afterEach(() => {
  pools.length = 0;
  queries.length = 0;
  errorListeners.count = 0;
  failNextCreate.value = false;
  if (originalPostgresCa === undefined) delete process.env.POSTGRES_CA_CERT;
  else process.env.POSTGRES_CA_CERT = originalPostgresCa;
});

describe("createPostgresMandateVault connections", () => {
  /**
   * T84. Every vault used to open its own pool and never close it; `apps/web`
   * builds one per request, and the connections piled up against the pooler
   * until a single activity read took 73 s in the deployed pilot.
   */
  it("shares one pool, and creates the table once, across vaults on the same database", async () => {
    const connectionString = freshDatabase();

    await createPostgresMandateVault({ connectionString, tenantId: "tenant-a" });
    await createPostgresMandateVault({ connectionString, tenantId: "tenant-b" });
    await createPostgresMandateVault({ connectionString, tenantId: "tenant-a" });

    expect(pools).toHaveLength(1);
    expect(createTableQueries()).toBe(1);
  });

  it("shares the pool even when vaults are created at the same moment", async () => {
    const connectionString = freshDatabase();

    await Promise.all([
      createPostgresMandateVault({ connectionString, tenantId: "tenant-a" }),
      createPostgresMandateVault({ connectionString, tenantId: "tenant-b" }),
    ]);

    expect(pools).toHaveLength(1);
  });

  it("does not keep a pool whose initialisation failed — the next vault tries again", async () => {
    const connectionString = freshDatabase();
    failNextCreate.value = true;

    await expect(createPostgresMandateVault({ connectionString, tenantId: "tenant" })).rejects.toMatchObject({
      code: "ConfigError",
    });
    await createPostgresMandateVault({ connectionString, tenantId: "tenant" });

    expect(pools).toHaveLength(2);
  });

  /**
   * `pg` emits a dropped idle connection as an `error` event on the pool, and
   * an unlistened `error` event kills the Node process. Against Supabase's
   * pooler that took the whole web service down mid-flow in the pilot.
   */
  it("listens for pool errors, so a dropped idle connection cannot crash the process", async () => {
    await createPostgresMandateVault({ connectionString: freshDatabase(), tenantId: "tenant" });

    expect(errorListeners.count).toBe(1);
  });
});

describe("createPostgresMandateVault TLS", () => {
  it("keeps the existing encrypted-but-unverified TLS behavior without a provider CA", async () => {
    delete process.env.POSTGRES_CA_CERT;

    await createPostgresMandateVault({ connectionString: freshDatabase(), tenantId: "tenant" });

    expect(pools).toHaveLength(1);
    expect(pools[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("requires certificate verification when a provider CA is configured", async () => {
    process.env.POSTGRES_CA_CERT = "test provider CA";

    await createPostgresMandateVault({ connectionString: freshDatabase(), tenantId: "tenant" });

    expect(pools[0]?.ssl).toEqual({ ca: "test provider CA", rejectUnauthorized: true });
  });

  it("never serves one TLS posture from a pool opened under the other", async () => {
    const connectionString = freshDatabase();

    delete process.env.POSTGRES_CA_CERT;
    await createPostgresMandateVault({ connectionString, tenantId: "tenant" });
    process.env.POSTGRES_CA_CERT = "test provider CA";
    await createPostgresMandateVault({ connectionString, tenantId: "tenant" });

    expect(pools).toHaveLength(2);
    expect(pools[1]?.ssl).toEqual({ ca: "test provider CA", rejectUnauthorized: true });
  });
});
