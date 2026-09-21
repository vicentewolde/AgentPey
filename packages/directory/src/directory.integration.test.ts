/**
 * Against a **live Postgres database** (Supabase in the pilot). Nothing is
 * mocked, because the guarantees this package exists to give are guarantees
 * the database makes and not guarantees TypeScript makes: a unique constraint,
 * a foreign key, and a sequence that never hands the same value out twice.
 *
 *   pnpm --filter @agentpey/directory run test:integration
 *
 * Requires `DATABASE_URL` in `.env.local`. Every test creates its own partners
 * and deletes everything it created in `afterEach`, so repeated runs never
 * accumulate rows and never collide with real data.
 *
 * `@agentpey/tenancy` is used here, and only here, to turn an allocated index
 * into a real Stellar keypair. That is deliberate: the claim this milestone
 * has to support is not "the directory stores a number", it is "two tenants
 * of two different partners end up with different Stellar identities", and
 * only the real derivation can show that.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { hasErrorCode, stellarAddressToDid } from "@agentpass/core";
import { deriveTenantKeypair, generateMasterMnemonic } from "@agentpey/tenancy";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDirectory, type Directory } from "./directory.js";
import { newId, newTenantId } from "./ids.js";

const ENV_PATH = fileURLToPath(new URL("../../../.env.local", import.meta.url));

async function loadDatabaseUrl(): Promise<string> {
  const contents = await readFile(ENV_PATH, "utf8").catch(() => {
    throw new Error(`${ENV_PATH} is missing. Add DATABASE_URL to it first — see .env.example.`);
  });
  for (const line of contents.split("\n")) {
    const match = /^\s*DATABASE_URL\s*=\s*"?(.*?)"?\s*$/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "") return match[1];
  }
  throw new Error(`DATABASE_URL is not set in ${ENV_PATH}.`);
}

describe("createDirectory", () => {
  let connectionString: string;
  let directory: Directory;
  let pool: Pool;
  const partnerIds: string[] = [];
  const principalAddresses: string[] = [];

  /** One master seed for the whole suite — the real thing, generated per run. */
  const masterMnemonic = generateMasterMnemonic();

  /** What `apps/web` will pass as `derive` once F4 wires this up for real. */
  function deriveFromMaster(keyIndex: number): { readonly address: string; readonly did: string } {
    const { publicKey } = deriveTenantKeypair(masterMnemonic, keyIndex, "agent");
    return { address: publicKey, did: stellarAddressToDid(publicKey, "testnet") };
  }

  beforeAll(async () => {
    connectionString = await loadDatabaseUrl();
    // Small pools on purpose: the pilot's database is a Supabase session
    // pooler, and letting `pg` open a connection per concurrent query
    // exhausts the local ephemeral ports before it exhausts the server.
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 2 });
    directory = await createDirectory({ connectionString, maxConnections: 4 });
  });

  afterEach(async () => {
    // Children first: every table here is behind a foreign key.
    while (partnerIds.length > 0) {
      const partnerId = partnerIds.pop();
      // T94: deliveries reference endpoints, and endpoints reference the
      // partner. Purchases reference mandates, so they have to go before the
      // mandates do — an order this cleanup got away with only while nothing
      // wrote a purchase row.
      await pool.query("delete from directory_webhook_deliveries where partner_id = $1", [partnerId]);
      await pool.query("delete from directory_webhook_endpoints where partner_id = $1", [partnerId]);
      await pool.query("delete from directory_purchases where partner_id = $1", [partnerId]);
      await pool.query(
        `delete from directory_consent_sessions where tenant_id in (select id from directory_tenants where partner_id = $1)`,
        [partnerId],
      );
      await pool.query(
        `delete from directory_mandates where tenant_id in (select id from directory_tenants where partner_id = $1)`,
        [partnerId],
      );
      await pool.query(
        `delete from directory_credentials where agent_id in (
           select a.id from directory_agents a join directory_tenants t on t.id = a.tenant_id where t.partner_id = $1)`,
        [partnerId],
      );
      await pool.query(
        `delete from directory_principal_bindings where tenant_id in (select id from directory_tenants where partner_id = $1)`,
        [partnerId],
      );
      await pool.query(
        `delete from directory_agents where tenant_id in (select id from directory_tenants where partner_id = $1)`,
        [partnerId],
      );
      await pool.query("delete from directory_tenants where partner_id = $1", [partnerId]);
      await pool.query("delete from directory_api_keys where partner_id = $1", [partnerId]);
      await pool.query("delete from directory_idempotency where partner_id = $1", [partnerId]);
      await pool.query("delete from directory_partners where id = $1", [partnerId]);
    }
    while (principalAddresses.length > 0) {
      await pool.query("delete from directory_principals where address = $1", [principalAddresses.pop()]);
    }
  });

  afterAll(async () => {
    await directory.close();
    await pool.end();
  });

  async function freshPartner(name = `test-${randomUUID()}`) {
    const partner = await directory.createPartner({ name });
    partnerIds.push(partner.id);
    return partner;
  }

  async function freshPrincipal(index: number) {
    const { publicKey } = deriveTenantKeypair(masterMnemonic, 900_000 + index, "issuer");
    const principal = await directory.upsertPrincipal({
      address: publicKey,
      did: stellarAddressToDid(publicKey, "testnet"),
    });
    principalAddresses.push(principal.address);
    return principal;
  }

  // ---- the claim this milestone exists to support ------------------------

  it("keeps one wallet used with two partners in two separate tenants, with two separate agent identities", async () => {
    const cloudops = await freshPartner("CloudOps");
    const otherPartner = await freshPartner("OtroPartner");

    // The same person, the same wallet, and — deliberately — the same
    // external reference string on both sides. Nothing about the input
    // distinguishes them except which partner is asking.
    const vinny = await freshPrincipal(1);
    const externalRef = "usr_123";

    const tenantA = await directory.createTenant({ partnerId: cloudops.id, externalRef });
    const tenantB = await directory.createTenant({ partnerId: otherPartner.id, externalRef });

    expect(tenantA.id).not.toBe(tenantB.id);
    expect(tenantA.partnerId).toBe(cloudops.id);
    expect(tenantB.partnerId).toBe(otherPartner.id);

    await directory.bindPrincipal({
      tenantId: tenantA.id,
      principalId: vinny.id,
      proofNonce: randomUUID(),
      proofSignature: "sig-a",
    });
    await directory.bindPrincipal({
      tenantId: tenantB.id,
      principalId: vinny.id,
      proofNonce: randomUUID(),
      proofSignature: "sig-b",
    });

    const agentA = await directory.createAgent({ tenantId: tenantA.id, derive: deriveFromMaster });
    const agentB = await directory.createAgent({ tenantId: tenantB.id, derive: deriveFromMaster });

    // Different index, therefore a different Stellar account: this is the
    // thing that `sha256(wallet address)` as a tenant id could never give.
    expect(agentA.keyIndex).not.toBe(agentB.keyIndex);
    expect(agentA.address).not.toBe(agentB.address);
    expect(agentA.did).not.toBe(agentB.did);

    // And each partner sees only its own.
    expect((await directory.listTenants(cloudops.id)).map((t) => t.id)).toEqual([tenantA.id]);
    expect((await directory.listTenants(otherPartner.id)).map((t) => t.id)).toEqual([tenantB.id]);
  });

  it("refuses a second tenant for the same partner and external reference", async () => {
    const partner = await freshPartner();
    await directory.createTenant({ partnerId: partner.id, externalRef: "usr_123" });

    await expect(directory.createTenant({ partnerId: partner.id, externalRef: "usr_123" })).rejects.toSatisfy((error) =>
      hasErrorCode(error, "TenantAlreadyExists"),
    );
  });

  it("refuses a tenant for a partner that does not exist", async () => {
    // Well-formed and never inserted, so the refusal comes from the foreign
    // key and not from the id's own shape.
    await expect(
      directory.createTenant({ partnerId: newId("partner"), externalRef: "usr_123" }),
    ).rejects.toSatisfy((error) => hasErrorCode(error, "PartnerNotFound"));
  });

  it("refuses personal data as an external reference before writing anything", async () => {
    const partner = await freshPartner();
    await expect(
      directory.createTenant({ partnerId: partner.id, externalRef: "vinny@cloudops.cl" }),
    ).rejects.toSatisfy((error) => hasErrorCode(error, "InvalidExternalRef"));
    expect(await directory.listTenants(partner.id)).toEqual([]);
  });

  // ---- key index allocation ---------------------------------------------

  it("never hands the same key index to two agents, even created concurrently", async () => {
    const partner = await freshPartner();
    const tenants = await Promise.all(
      Array.from({ length: 8 }, (_, i) => directory.createTenant({ partnerId: partner.id, externalRef: `usr_${i}` })),
    );

    const agents = await Promise.all(
      tenants.map((tenant) => directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster })),
    );

    const indices = agents.map((a) => a.keyIndex);
    expect(new Set(indices).size).toBe(indices.length);
    // A collision here would mean two tenants deriving the same keypair from
    // the master seed — so assert on the addresses too, not just the numbers.
    expect(new Set(agents.map((a) => a.address)).size).toBe(agents.length);
  });

  it("gives one tenant more than one agent, each with its own identity", async () => {
    // A tenant may hold several agents; renewing or replacing one must not
    // require a new tenant.
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_multi" });

    const first = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster, label: "primary" });
    const second = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster, label: "batch jobs" });

    expect(first.keyIndex).not.toBe(second.keyIndex);
    expect(first.address).not.toBe(second.address);
    const listed = await directory.listAgents(tenant.id);
    expect(listed.map((a) => a.id)).toEqual([first.id, second.id]);
  });

  it("creates an agent as derived, not funded — nothing is deployed on chain yet", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_lazy" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });

    expect(agent.onchainState).toBe("derived");
    const funded = await directory.setAgentOnchainState(agent.id, "funded");
    expect(funded.onchainState).toBe("funded");
  });

  it("creates an agent with no policy_rail yet, then persists one once deployed (F6/T58)", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_no_rail_yet" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });

    expect(agent.policyRailContractId).toBeNull();
    const railContractId = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
    const withRail = await directory.setAgentPolicyRail(agent.id, railContractId);
    expect(withRail.policyRailContractId).toBe(railContractId);

    // Persisted, not just returned — a fresh read agrees.
    const reread = await directory.findAgent(agent.id);
    expect(reread?.policyRailContractId).toBe(railContractId);
  });

  it("keeps the first policy_rail on a race — a second deploy does not overwrite it", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_rail_race" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });

    const first = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
    const second = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
    const won = await directory.setAgentPolicyRail(agent.id, first);
    const lost = await directory.setAgentPolicyRail(agent.id, second);

    expect(won.policyRailContractId).toBe(first);
    // The loser's call reports the winner's contract, not its own — the
    // caller that "lost" a race must not believe its own deploy is the one
    // that counts.
    expect(lost.policyRailContractId).toBe(first);
  });

  it("lists every agent with a policy_rail across tenants and partners, and none without one (T60)", async () => {
    const partnerA = await freshPartner();
    const partnerB = await freshPartner();
    const tenantA = await directory.createTenant({ partnerId: partnerA.id, externalRef: "usr_with_rail_a" });
    const tenantB = await directory.createTenant({ partnerId: partnerB.id, externalRef: "usr_with_rail_b" });
    const tenantC = await directory.createTenant({ partnerId: partnerA.id, externalRef: "usr_without_rail" });

    const agentA = await directory.createAgent({ tenantId: tenantA.id, derive: deriveFromMaster });
    const agentB = await directory.createAgent({ tenantId: tenantB.id, derive: deriveFromMaster });
    const agentC = await directory.createAgent({ tenantId: tenantC.id, derive: deriveFromMaster });

    const railA = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
    const railB = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
    await directory.setAgentPolicyRail(agentA.id, railA);
    await directory.setAgentPolicyRail(agentB.id, railB);
    // agentC never deploys one — the common case.

    const withRail = await directory.listAgentsWithPolicyRail();
    const ids = withRail.map((agent) => agent.id);
    expect(ids).toContain(agentA.id);
    expect(ids).toContain(agentB.id);
    expect(ids).not.toContain(agentC.id);
    expect(withRail.find((agent) => agent.id === agentA.id)?.policyRailContractId).toBe(railA);
    expect(withRail.find((agent) => agent.id === agentB.id)?.policyRailContractId).toBe(railB);
  });

  it("refuses to set a policy_rail on an agent that does not exist", async () => {
    await expect(
      directory.setAgentPolicyRail(newId("agent"), "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526"),
    ).rejects.toSatisfy((error) => hasErrorCode(error, "AgentNotFound"));
  });

  it("refuses an agent for a tenant that does not exist, without burning the derivation", async () => {
    let derivations = 0;
    await expect(
      directory.createAgent({
        tenantId: newTenantId(newId("partner")),
        derive: (index) => {
          derivations += 1;
          return deriveFromMaster(index);
        },
      }),
    ).rejects.toSatisfy((error) => hasErrorCode(error, "TenantNotFound"));
    expect(derivations).toBe(0);
  });

  // ---- api keys ----------------------------------------------------------

  it("authenticates a partner by its api key secret and stops once revoked", async () => {
    const partner = await freshPartner();
    const { apiKey, secret } = await directory.issueApiKey({
      partnerId: partner.id,
      name: "server",
      scopes: ["tenants:write"],
    });

    expect(secret.startsWith("ap_test_")).toBe(true);
    // The secret is never stored: only its hash comes back on the record.
    expect(apiKey.keyHash).not.toContain(secret);

    const authenticated = await directory.authenticate(secret);
    expect(authenticated?.partnerId).toBe(partner.id);
    expect(authenticated?.scopes).toEqual(["tenants:write"]);

    expect(await directory.authenticate(`${secret}x`)).toBeUndefined();

    await directory.revokeApiKey(apiKey.id);
    expect(await directory.authenticate(secret)).toBeUndefined();
  });

  // ---- principals and bindings ------------------------------------------

  it("treats one wallet as one principal no matter how many partners use it", async () => {
    const vinny = await freshPrincipal(2);
    const again = await directory.upsertPrincipal({ address: vinny.address, did: vinny.did });
    expect(again.id).toBe(vinny.id);
  });

  it("replaces the proof when a wallet reconnects, instead of stacking bindings", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_rebind" });
    const vinny = await freshPrincipal(3);

    const first = await directory.bindPrincipal({
      tenantId: tenant.id,
      principalId: vinny.id,
      proofNonce: "nonce-1",
      proofSignature: "sig-1",
    });
    await directory.revokeBinding(tenant.id, vinny.id);
    expect((await directory.findBinding(tenant.id, vinny.id))?.revokedAt).not.toBeNull();

    // Reconnecting from another browser: prove control again, and the binding
    // comes back rather than a second row shadowing the first.
    const second = await directory.bindPrincipal({
      tenantId: tenant.id,
      principalId: vinny.id,
      proofNonce: "nonce-2",
      proofSignature: "sig-2",
    });
    expect(second.id).toBe(first.id);
    expect(second.proofNonce).toBe("nonce-2");
    expect(second.revokedAt).toBeNull();
  });

  // ---- credentials and mandates -----------------------------------------

  it("stores a mandate document byte for byte, key order included", async () => {
    // The trap `C-5` documents for the vault: `jsonb` reorders keys, and a
    // mandate's hash is computed over its serialised text. A round trip that
    // reordered anything would make the stored document hash to something
    // other than what was signed and anchored.
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_mandate" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(4);

    const document = { z: "last", a: "first", nested: { y: 2, b: 1 }, validFrom: "2026-09-10T00:00:00.000Z" };
    const mandateHash = "a".repeat(64);

    const stored = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      mandateHash,
      signatureKind: "wallet-sep53",
      document,
      signature: "sep53-signature",
      validFrom: new Date("2026-09-10T00:00:00.000Z"),
      validUntil: new Date("2026-09-11T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const read = await directory.findMandateByHash(mandateHash);
    expect(JSON.stringify(read?.document)).toBe(JSON.stringify(document));
    expect(read?.signatureKind).toBe("wallet-sep53");
    expect(read?.jws).toBeNull();
    expect(stored.supersedesId).toBeNull();
  });

  it("renews a mandate without creating a new agent", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_renew" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(5);

    const base = {
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53" as const,
      document: { grant: "one" },
      validFrom: new Date("2026-09-10T00:00:00.000Z"),
      validUntil: new Date("2026-09-11T00:00:00.000Z"),
      anchorTx: "tx-1",
    };
    const first = await directory.recordMandate({ ...base, mandateHash: "b".repeat(64) });
    const renewal = await directory.recordMandate({
      ...base,
      mandateHash: "c".repeat(64),
      anchorTx: "tx-2",
      validUntil: new Date("2026-09-20T00:00:00.000Z"),
      supersedesId: first.id,
    });

    expect(renewal.agentId).toBe(agent.id);
    expect(renewal.supersedesId).toBe(first.id);
    expect((await directory.listAgents(tenant.id)).length).toBe(1);
  });

  it("stops listing a mandate once it is revoked or out of its window", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_window" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(6);

    const base = {
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "platform-jws" as const,
      document: { grant: "one" },
      anchorTx: "tx-1",
    };
    const live = await directory.recordMandate({
      ...base,
      mandateHash: "d".repeat(64),
      validFrom: new Date("2026-09-01T00:00:00.000Z"),
      validUntil: new Date("2026-09-30T00:00:00.000Z"),
    });
    await directory.recordMandate({
      ...base,
      mandateHash: "e".repeat(64),
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validUntil: new Date("2026-01-02T00:00:00.000Z"),
    });

    const at = new Date("2026-09-10T00:00:00.000Z");
    expect((await directory.listActiveMandates(tenant.id, at)).map((m) => m.id)).toEqual([live.id]);

    await directory.revokeMandate("d".repeat(64), "tx-revoke");
    expect(await directory.listActiveMandates(tenant.id, at)).toEqual([]);
    expect((await directory.findMandateByHash("d".repeat(64)))?.revokeTx).toBe("tx-revoke");
  });

  it("keeps a credential findable by the hash that is anchored on chain", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_cred" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(7);
    const credentialHash = "f".repeat(64);

    await directory.recordCredential({
      agentId: agent.id,
      tenantId: tenant.id,
      credentialHash,
      issuerDid: stellarAddressToDid(agent.address, "testnet"),
      principalDid: vinny.did,
      jws: "eyJ.header.signature",
      validFrom: new Date("2026-09-10T00:00:00.000Z"),
      validUntil: new Date("2026-09-11T00:00:00.000Z"),
      anchorTx: "tx-cred",
    });

    const found = await directory.findCredentialByHash(credentialHash);
    expect(found?.agentId).toBe(agent.id);
    expect(found?.tenantId).toBe(tenant.id);
    expect(found?.revokedAt).toBeNull();

    await directory.revokeCredential(credentialHash);
    expect((await directory.findCredentialByHash(credentialHash))?.revokedAt).not.toBeNull();
  });

  it("finds a shared agent by its Stellar address — the lookup a bootstrap step needs to be idempotent", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_shared_agent" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });

    const found = await directory.findAgentByAddress(agent.address);
    expect(found?.id).toBe(agent.id);
    expect(await directory.findAgentByAddress("GNONEXISTENT")).toBeUndefined();
  });

  it("finds the latest credential for a tenant, even before F4 gives it its own agent", async () => {
    // Simulates T39's transitional reality: many tenants' credentials all
    // naming the *same* shared agentId, distinguishable only by tenantId.
    const partner = await freshPartner();
    const tenantA = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_latest_cred_a" });
    const tenantB = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_latest_cred_b" });
    const sharedAgent = await directory.createAgent({ tenantId: tenantA.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(8);

    expect(await directory.findLatestCredential(tenantB.id)).toBeUndefined();

    const base = {
      agentId: sharedAgent.id,
      issuerDid: stellarAddressToDid(sharedAgent.address, "testnet"),
      principalDid: vinny.did,
      jws: "eyJ.a.b",
      validFrom: new Date("2026-09-10T00:00:00.000Z"),
      validUntil: new Date("2026-09-11T00:00:00.000Z"),
      anchorTx: "tx-a",
    };
    await directory.recordCredential({ ...base, tenantId: tenantA.id, credentialHash: "1".repeat(64) });
    const forB = await directory.recordCredential({ ...base, tenantId: tenantB.id, credentialHash: "2".repeat(64) });

    // Finds B's own credential, not A's — even though both name the same
    // shared agentId.
    const latestForB = await directory.findLatestCredential(tenantB.id);
    expect(latestForB?.id).toBe(forB.id);
    expect(latestForB?.credentialHash).toBe("2".repeat(64));
  });

  it("finds the latest mandate for a tenant regardless of revoked or expired status", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_latest_mandate" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(9);

    expect(await directory.findLatestMandate(tenant.id)).toBeUndefined();

    const base = {
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53" as const,
      document: { grant: "one" },
      anchorTx: "tx-1",
    };
    const first = await directory.recordMandate({
      ...base,
      mandateHash: "3".repeat(64),
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validUntil: new Date("2026-01-02T00:00:00.000Z"), // already expired
    });
    await directory.revokeMandate("3".repeat(64), "tx-revoke");

    // Even revoked and expired, it is still the latest one — supersedesId
    // chaining on renewal needs to find it regardless of its status.
    const latest = await directory.findLatestMandate(tenant.id);
    expect(latest?.id).toBe(first.id);
    expect(latest?.revokedAt).not.toBeNull();

    const renewal = await directory.recordMandate({
      ...base,
      mandateHash: "4".repeat(64),
      validFrom: new Date("2026-09-10T00:00:00.000Z"),
      validUntil: new Date("2026-09-11T00:00:00.000Z"),
      supersedesId: first.id,
    });
    expect((await directory.findLatestMandate(tenant.id))?.id).toBe(renewal.id);
  });

  it("finds a mandate by its id, the way /v1/mandates/{id} names it — not by its hash", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_mandate_by_id" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(10);

    const mandate = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      anchorTx: "tx-1",
      mandateHash: "5".repeat(64),
      validFrom: new Date("2026-09-10T00:00:00.000Z"),
      validUntil: new Date("2026-09-11T00:00:00.000Z"),
    });

    expect((await directory.findMandateById(mandate.id))?.mandateHash).toBe("5".repeat(64));
    expect(await directory.findMandateById("mdt_doesnotexist")).toBeUndefined();
  });

  it("lists every mandate of a tenant regardless of status — a partner's full history, unlike listActiveMandates", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_mandate_history" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(11);

    const base = {
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53" as const,
      document: { grant: "one" },
      anchorTx: "tx-1",
    };
    const active = await directory.recordMandate({
      ...base,
      mandateHash: "6".repeat(64),
      validFrom: new Date("2026-09-01T00:00:00.000Z"),
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
    });
    const revoked = await directory.recordMandate({
      ...base,
      mandateHash: "7".repeat(64),
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validUntil: new Date("2026-01-02T00:00:00.000Z"),
    });
    await directory.revokeMandate("7".repeat(64), "tx-revoke");

    expect(await directory.listActiveMandates(tenant.id, new Date("2026-09-10T00:00:00.000Z"))).toHaveLength(1);
    const all = await directory.listMandates(tenant.id);
    expect(all.map((m) => m.id).sort()).toEqual([active.id, revoked.id].sort());
  });

  // ---- idempotency (T49) --------------------------------------------------

  it("finds nothing for a key that was never recorded", async () => {
    const partner = await freshPartner();
    expect(await directory.findIdempotentResponse(partner.id, "req-never-seen")).toBeUndefined();
  });

  it("records and replays a response by (partnerId, key)", async () => {
    const partner = await freshPartner();

    const recorded = await directory.recordIdempotentResponse({
      partnerId: partner.id,
      key: "req-1",
      requestHash: "a".repeat(64),
      responseStatus: 201,
      responseBody: { ok: true, data: { id: "tnt_1" } },
    });
    expect(recorded.responseStatus).toBe(201);

    const found = await directory.findIdempotentResponse(partner.id, "req-1");
    expect(found).toEqual(recorded);
  });

  it("overwrites the same (partnerId, key) on a second write, rather than erroring — a concurrent retry racing to record is not a conflict", async () => {
    const partner = await freshPartner();

    await directory.recordIdempotentResponse({
      partnerId: partner.id,
      key: "req-2",
      requestHash: "b".repeat(64),
      responseStatus: 201,
      responseBody: { ok: true, data: { id: "tnt_2" } },
    });
    const second = await directory.recordIdempotentResponse({
      partnerId: partner.id,
      key: "req-2",
      requestHash: "b".repeat(64),
      responseStatus: 201,
      responseBody: { ok: true, data: { id: "tnt_2" } },
    });

    const found = await directory.findIdempotentResponse(partner.id, "req-2");
    expect(found).toEqual(second);
  });

  it("keeps the same key separate across two partners", async () => {
    const partnerA = await freshPartner();
    const partnerB = await freshPartner();

    await directory.recordIdempotentResponse({
      partnerId: partnerA.id,
      key: "shared-key-name",
      requestHash: "c".repeat(64),
      responseStatus: 201,
      responseBody: { ok: true, data: { id: "tnt_a" } },
    });

    expect(await directory.findIdempotentResponse(partnerB.id, "shared-key-name")).toBeUndefined();
  });

  // ---- consent sessions (T51) ---------------------------------------------

  const SAMPLE_GRANT = {
    actions: ["catalog:read", "intent:create"],
    venues: ["mock-bazaar:CCL57L4ZQVQCGTQKGQMOAX7QDPEDW4LX2QSPBQMTMLB7BFQ7I3TM7F4A"],
    assets: ["USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
    limits: { perTx: "50.0000000", perDay: "200.0000000", currency: "USDC" },
    payTo: ["GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
  };

  it("creates a pending consent session and finds it back, grant byte for byte", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_consent_1" });
    const now = new Date("2026-09-10T00:00:00.000Z");

    const created = await directory.createConsentSession({
      tenantId: tenant.id,
      grant: SAMPLE_GRANT,
      validFrom: now,
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });

    expect(created.status).toBe("pending");
    expect(created.mandateId).toBeNull();
    expect(created.grant).toEqual(SAMPLE_GRANT);

    const found = await directory.findConsentSession(created.id);
    expect(found).toEqual(created);
  });

  it("returns undefined for an id that does not exist", async () => {
    expect(await directory.findConsentSession("cns_doesnotexist")).toBeUndefined();
  });

  it("completes a pending session with the mandate it produced", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_consent_2" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(12);
    const now = new Date("2026-09-10T00:00:00.000Z");

    const session = await directory.createConsentSession({
      tenantId: tenant.id,
      grant: SAMPLE_GRANT,
      validFrom: now,
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const mandate = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53",
      document: { grant: SAMPLE_GRANT },
      anchorTx: "tx-consent-1",
      mandateHash: "8".repeat(64),
      validFrom: now,
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
    });

    const completed = await directory.completeConsentSession(session.id, mandate.id);
    expect(completed.status).toBe("completed");
    expect(completed.mandateId).toBe(mandate.id);
    expect((await directory.findConsentSession(session.id))?.status).toBe("completed");
  });

  it("refuses to complete the same consent session twice", async () => {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_consent_3" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const vinny = await freshPrincipal(13);
    const now = new Date("2026-09-10T00:00:00.000Z");

    const session = await directory.createConsentSession({
      tenantId: tenant.id,
      grant: SAMPLE_GRANT,
      validFrom: now,
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const firstMandate = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53",
      document: { grant: SAMPLE_GRANT },
      anchorTx: "tx-consent-2a",
      mandateHash: "9".repeat(64),
      validFrom: now,
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
    });
    const secondMandate = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: vinny.id,
      signatureKind: "wallet-sep53",
      document: { grant: SAMPLE_GRANT },
      anchorTx: "tx-consent-2b",
      mandateHash: "b".repeat(64),
      validFrom: now,
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
    });

    await directory.completeConsentSession(session.id, firstMandate.id);
    await expect(directory.completeConsentSession(session.id, secondMandate.id)).rejects.toEqual(
      expect.objectContaining({ code: "ConsentSessionAlreadyCompleted" }),
    );
    // The first completion is what stands — a losing second attempt never overwrites it.
    expect((await directory.findConsentSession(session.id))?.mandateId).toBe(firstMandate.id);
  });

  it("refuses to complete a consent session that does not exist", async () => {
    await expect(directory.completeConsentSession("cns_doesnotexist", "mdt_doesnotexist")).rejects.toEqual(
      expect.objectContaining({ code: "ConsentSessionNotFound" }),
    );
  });

  // ---- survives a restart ------------------------------------------------

  it("still has everything after the process that wrote it is gone", async () => {
    // The failure this package exists to fix: `apps/web` keeps its session in
    // a `Map`, so a restart loses the credential and the Mandate and the next
    // "Iniciar sesión" issues brand new ones.
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: "usr_restart" });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });

    const reopened = await createDirectory({ connectionString, maxConnections: 1 });
    try {
      const foundTenant = await reopened.findTenant(tenant.id);
      const foundAgent = await reopened.findAgent(agent.id);
      expect(foundTenant?.externalRef).toBe("usr_restart");
      expect(foundAgent?.address).toBe(agent.address);
      expect(foundAgent?.keyIndex).toBe(agent.keyIndex);
    } finally {
      await reopened.close();
    }
  });

  // ---- webhooks (T94) ----------------------------------------------------

  /**
   * These are the claims only a real database can support. The events are
   * fanned out by a CTE inside the very statement that records the change, so
   * what has to be true here — an event exists exactly when the change does,
   * a partner with no endpoint queues nothing, a second revoke queues nothing
   * — is true because of how Postgres runs a statement, not because of
   * anything TypeScript checks.
   */
  async function mandateFixture(events: readonly string[]) {
    const partner = await freshPartner();
    const tenant = await directory.createTenant({ partnerId: partner.id, externalRef: `usr_wh_${randomUUID()}` });
    const agent = await directory.createAgent({ tenantId: tenant.id, derive: deriveFromMaster });
    const principal = await freshPrincipal(50 + partnerIds.length);
    const endpoint =
      events.length === 0
        ? undefined
        : await directory.createWebhookEndpoint({
            partnerId: partner.id,
            url: "https://partner.example/hooks",
            secret: `whsec_${randomUUID()}`,
            events,
          });
    return { partner, tenant, agent, principal, endpoint };
  }

  async function deliveriesFor(partnerId: string): Promise<Array<{ type: string; payload: Record<string, unknown>; endpoint_id: string }>> {
    const { rows } = await pool.query<{ type: string; payload: Record<string, unknown>; endpoint_id: string }>(
      "select type, payload, endpoint_id from directory_webhook_deliveries where partner_id = $1 order by id asc",
      [partnerId],
    );
    return rows;
  }

  it("queues mandate.activated in the same statement that records the mandate", async () => {
    const { partner, tenant, agent, principal } = await mandateFixture(["mandate.activated"]);

    const mandate = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const queued = await deliveriesFor(partner.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.type).toBe("mandate.activated");
    // Thin: ids only. Nothing a misdirected delivery could leak.
    expect(queued[0]?.payload).toEqual({
      mandate_id: mandate.id,
      tenant_id: tenant.id,
      agent_id: agent.id,
    });
  });

  it("queues nothing for a partner with no endpoint — the outbox only holds work with somewhere to go", async () => {
    const { partner, tenant, agent, principal } = await mandateFixture([]);

    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    expect(await deliveriesFor(partner.id)).toEqual([]);
  });

  it("queues nothing for an endpoint that did not subscribe to that type", async () => {
    const { partner, tenant, agent, principal } = await mandateFixture(["payment.settled"]);

    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    expect(await deliveriesFor(partner.id)).toEqual([]);
  });

  it("queues mandate.revoked once, and a second revoke of the same mandate queues nothing", async () => {
    // The `revoked_at is null` guard already made the update idempotent; the
    // event is fanned out from the updated row, so idempotence comes free.
    const { partner, tenant, agent, principal } = await mandateFixture(["mandate.revoked"]);
    const mandateHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash,
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    await directory.revokeMandate(mandateHash, "tx-revoke");
    await directory.revokeMandate(mandateHash, "tx-revoke-again");

    const queued = await deliveriesFor(partner.id);
    expect(queued.filter((row) => row.type === "mandate.revoked")).toHaveLength(1);
  });

  it("names the event after the purchase's own outcome, so the two cannot disagree", async () => {
    const { partner, tenant, agent, principal } = await mandateFixture(["payment.settled", "payment.refused"]);
    const mandateHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
    const mandate = await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash,
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const base = {
      tenantId: tenant.id,
      agentId: agent.id,
      mandateId: mandate.id,
      partnerId: partner.id,
      venue: "signaldesk:CCL57L4ZDBRRWL2PKHZCYQZRDV4A37LOZRWMSCRQQ5JYRKMJW6I3TM7F",
      productId: "market-brief",
      quantity: 1,
      intentId: null,
      total: null,
      asset: null,
      payTo: null,
      transactionHash: null,
      delivery: null,
    };
    const settled = await directory.createPurchase({ ...base, outcome: "settled", code: null, reason: null });
    await directory.createPurchase({ ...base, outcome: "refused", code: "MandateExpired", reason: "expired" });

    const queued = await deliveriesFor(partner.id);
    const payments = queued.filter((row) => row.type.startsWith("payment."));
    expect(payments.map((row) => row.type).sort()).toEqual(["payment.refused", "payment.settled"]);
    const settledEvent = payments.find((row) => row.type === "payment.settled");
    expect(settledEvent?.payload).toEqual({ purchase_id: settled.id, tenant_id: tenant.id });
  });

  it("fans one event out to every subscribed endpoint, with a key per destination", async () => {
    const { partner, tenant, agent, principal } = await mandateFixture(["mandate.activated"]);
    await directory.createWebhookEndpoint({
      partnerId: partner.id,
      url: "https://partner.example/second",
      secret: `whsec_${randomUUID()}`,
      events: ["mandate.activated"],
    });

    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const queued = await deliveriesFor(partner.id);
    expect(queued).toHaveLength(2);
    // Each destination carries its own attempt count and backoff, so one
    // broken endpoint cannot hold back the other.
    expect(new Set(queued.map((row) => row.endpoint_id)).size).toBe(2);
  });

  it("stops queueing for a deleted endpoint, and leaves what was already owed alone", async () => {
    const { partner, tenant, agent, principal, endpoint } = await mandateFixture(["mandate.activated"]);
    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });
    expect(await deliveriesFor(partner.id)).toHaveLength(1);

    expect(await directory.deleteWebhookEndpoint(endpoint!.id, partner.id)).toBe(true);
    expect(await directory.listWebhookEndpoints(partner.id)).toEqual([]);

    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "two" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor-2",
    });

    // Still one: nothing new was queued, and a deletion is not a retraction of
    // what already happened.
    expect(await deliveriesFor(partner.id)).toHaveLength(1);
  });

  it("does not delete another partner's endpoint, and says the same 'no' an unknown id does", async () => {
    const { partner, endpoint } = await mandateFixture(["mandate.activated"]);
    const other = await freshPartner();
    expect(await directory.deleteWebhookEndpoint(endpoint!.id, other.id)).toBe(false);
    expect(await directory.listWebhookEndpoints(partner.id)).toHaveLength(1);
  });

  it("claims a due delivery once, and leases it away from a second drain", async () => {
    // Two instances drain the same table. `for update skip locked` plus the
    // lease is what stops both sending the same event.
    const { partner, tenant, agent, principal } = await mandateFixture(["mandate.activated"]);
    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const first = (await directory.claimDueWebhookDeliveries(10)).filter((row) => row.partnerId === partner.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.attempts).toBe(1);
    expect(first[0]?.url).toBe("https://partner.example/hooks");
    expect(first[0]?.event.type).toBe("mandate.activated");

    const second = (await directory.claimDueWebhookDeliveries(10)).filter((row) => row.partnerId === partner.id);
    expect(second).toEqual([]);

    await directory.markWebhookDelivered(first[0]!.id);
    // Delivered rows never come back, even once the lease expires.
    const later = (await directory.claimDueWebhookDeliveries(10, new Date(Date.now() + 10 * 60_000))).filter(
      (row) => row.partnerId === partner.id,
    );
    expect(later).toEqual([]);
  });

  it("stops claiming a delivery that was given up on", async () => {
    const { partner, tenant, agent, principal } = await mandateFixture(["mandate.activated"]);
    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const [claimed] = (await directory.claimDueWebhookDeliveries(10)).filter((row) => row.partnerId === partner.id);
    await directory.markWebhookFailed({ id: claimed!.id, lastError: "HTTP 410", giveUp: true });

    const later = (await directory.claimDueWebhookDeliveries(10, new Date(Date.now() + 10 * 60_000))).filter(
      (row) => row.partnerId === partner.id,
    );
    expect(later).toEqual([]);
  });

  it("schedules a retry, and the delivery comes back once its time arrives", async () => {
    // The other branch of `markWebhookFailed`. Both branches put a parameter
    // inside a `case`, and the first version of this method had neither cast:
    // Postgres typed them as `text` and every failed delivery threw.
    const { partner, tenant, agent, principal } = await mandateFixture(["mandate.activated"]);
    await directory.recordMandate({
      tenantId: tenant.id,
      agentId: agent.id,
      principalId: principal.id,
      mandateHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      signatureKind: "wallet-sep53",
      document: { grant: "one" },
      signature: "sig",
      validFrom: new Date("2026-09-20T00:00:00.000Z"),
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      anchorTx: "tx-anchor",
    });

    const [claimed] = (await directory.claimDueWebhookDeliveries(10)).filter((row) => row.partnerId === partner.id);
    const retryAt = new Date(Date.now() + 5 * 60_000);
    await directory.markWebhookFailed({ id: claimed!.id, lastError: "HTTP 503", giveUp: false, nextAttemptAt: retryAt });

    // Not before its time — the backoff is honoured.
    const early = (await directory.claimDueWebhookDeliveries(10, new Date(Date.now() + 60_000))).filter(
      (row) => row.partnerId === partner.id,
    );
    expect(early).toEqual([]);

    // After it, back again, with the attempt counted.
    const due = (await directory.claimDueWebhookDeliveries(10, new Date(retryAt.getTime() + 1_000))).filter(
      (row) => row.partnerId === partner.id,
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.attempts).toBe(2);
  });
});
