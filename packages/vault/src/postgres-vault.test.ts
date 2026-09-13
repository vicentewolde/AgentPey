import { afterEach, describe, expect, it, vi } from "vitest";

interface PoolOptions {
  readonly connectionString: string;
  readonly ssl: { readonly ca?: string; readonly rejectUnauthorized: boolean };
}

const pools = vi.hoisted((): PoolOptions[] => []);
const errorListeners = vi.hoisted(() => ({ count: 0 }));

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: PoolOptions) {
      pools.push(options);
    }

    on(event: string) {
      if (event === "error") errorListeners.count += 1;
      return this;
    }

    async query() {
      return { rows: [] };
    }

    async end() {}
  },
}));

import { createPostgresMandateVault } from "./postgres-vault.js";

const originalPostgresCa = process.env.POSTGRES_CA_CERT;

afterEach(() => {
  pools.length = 0;
  errorListeners.count = 0;
  if (originalPostgresCa === undefined) delete process.env.POSTGRES_CA_CERT;
  else process.env.POSTGRES_CA_CERT = originalPostgresCa;
});

describe("createPostgresMandateVault idle-client errors", () => {
  /**
   * `pg` emits a dropped idle connection as an `error` event on the pool, and
   * an unlistened `error` event kills the Node process. Against Supabase's
   * pooler that took the whole web service down mid-flow in the pilot; see
   * the T84 evidence for the reproduction against the real database.
   */
  it("listens for pool errors, so a dropped idle connection cannot crash the process", async () => {
    await createPostgresMandateVault({ connectionString: "postgres://test", tenantId: "tenant" });

    expect(errorListeners.count).toBe(1);
  });
});

describe("createPostgresMandateVault TLS", () => {
  it("keeps the existing encrypted-but-unverified TLS behavior without a provider CA", async () => {
    delete process.env.POSTGRES_CA_CERT;

    await createPostgresMandateVault({ connectionString: "postgres://test", tenantId: "tenant" });

    expect(pools).toHaveLength(1);
    expect(pools[0]?.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("requires certificate verification when a provider CA is configured", async () => {
    process.env.POSTGRES_CA_CERT = "test provider CA";

    await createPostgresMandateVault({ connectionString: "postgres://test", tenantId: "tenant" });

    expect(pools[0]?.ssl).toEqual({ ca: "test provider CA", rejectUnauthorized: true });
  });
});
