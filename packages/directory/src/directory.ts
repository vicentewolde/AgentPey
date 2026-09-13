/**
 * The durable record of who exists: partners, their tenants, the wallets that
 * consent inside those tenants, the agents that act, and the signed documents
 * that authorise them.
 *
 * This is the piece the platform has been missing. Everything the pilot knows
 * about a visitor today lives in a `Map` in `apps/web`'s memory and is gone on
 * the next restart, which is why clicking "Iniciar sesión" a second time
 * issues a brand new credential and a brand new Mandate instead of finding the
 * ones already anchored on chain (`PLATAFORMA-PARTNERS.md` §5, `G7`).
 *
 * **What this package deliberately does not do.** It does not derive keys — it
 * hands out the index and asks the caller to derive, so the master seed never
 * has to be in scope here. It does not verify signatures, validate mandates or
 * decide anything: storing a signed document and judging one are different
 * jobs, and this package only does the first. And it never reads the
 * environment (`C-3`): the connection string arrives as a parameter, so
 * whoever calls decides where it came from.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AgentPassError } from "@agentpass/core";
import { Pool } from "pg";

import {
  agentInstanceSchema,
  apiKeySchema,
  consentSessionRecordSchema,
  credentialRecordSchema,
  idempotencyRecordSchema,
  mandateRecordSchema,
  partnerSchema,
  principalBindingSchema,
  purchaseRecordSchema,
  principalSchema,
  tenantSchema,
  type AgentInstance,
  type AgentStatus,
  type ApiKey,
  type ConsentSessionRecord,
  type CredentialRecord,
  type IdempotencyRecord,
  type MandateRecord,
  type PurchaseRecord,
  type MandateSignatureKind,
  type OnchainState,
  type Partner,
  type PartnerStatus,
  type Principal,
  type PrincipalBinding,
  type Tenant,
  type TenantStatus,
} from "./entities.js";
import { assertOpaqueExternalRef } from "./external-ref.js";
import { newId, newTenantId, parseTenantId } from "./ids.js";
import { DIRECTORY_SCHEMA_SQL } from "./schema-sql.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** `bigint` columns and `nextval` come back from `pg` as strings. */
function toSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new AgentPassError("ConfigError", `the directory returned a ${field} that is not a safe integer`, {
      details: { field, value: String(value) },
    });
  }
  return parsed;
}

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function pgConstraint(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "constraint" in error && typeof error.constraint === "string"
    ? error.constraint
    : undefined;
}

function wrap(message: string, error: unknown, details: Record<string, unknown> = {}): AgentPassError {
  const cause = error instanceof Error ? error.message : String(error);
  return new AgentPassError("ConfigError", message, { cause: error, details: { ...details, cause } });
}

// ---- Inputs ---------------------------------------------------------------

export interface DirectoryOptions {
  readonly connectionString: string;
  /**
   * Defaults to the same setting `createPostgresMandateVault` uses and for
   * the same reason (`C-12`): Supabase requires TLS, and Node's default CA
   * bundle does not ship its chain. It is a parameter rather than a constant
   * so that tightening it — brecha `G11`, deferred to the hardening milestone
   * — is a change at one call site and not a change in this file.
   */
  readonly ssl?: false | { readonly ca?: string; readonly rejectUnauthorized: boolean };
  /**
   * How many Postgres connections this directory may hold open. Defaults to
   * `pg`'s own default of 10.
   *
   * It is a knob rather than a constant because the pilot's database is a
   * Supabase session pooler, and a burst of concurrent writes against it
   * opens a new TLS connection per query until the host runs out of ephemeral
   * ports — observed as `EADDRNOTAVAIL` while writing this package's own
   * integration suite, not read in documentation. A small pool makes the
   * connections be reused instead, which is both faster and stable.
   */
  readonly maxConnections?: number;
}

/**
 * Turns an allocated key index into the Stellar identity derived from it.
 *
 * A callback, not a dependency on `@agentpey/tenancy`, so the master seed
 * never enters this package's scope — and so an agent row can never be
 * written with an address that does not correspond to its own index, which is
 * what two separate calls would eventually allow.
 */
export type DeriveAgentIdentity = (
  keyIndex: number,
) => { readonly address: string; readonly did: string } | Promise<{ readonly address: string; readonly did: string }>;

export interface CreateTenantInput {
  readonly partnerId: string;
  /** Opaque, partner-scoped. Validated as non-PII before anything is written. */
  readonly externalRef: string;
  readonly label?: string;
}

export interface CreateAgentInput {
  readonly tenantId: string;
  readonly derive: DeriveAgentIdentity;
  readonly label?: string;
}

export interface BindPrincipalInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly proofNonce: string;
  readonly proofSignature: string;
}

export interface RecordCredentialInput {
  readonly agentId: string;
  readonly tenantId: string;
  readonly credentialHash: string;
  readonly issuerDid: string;
  readonly principalDid: string;
  readonly jws: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly anchorTx: string;
}

export interface RecordMandateInput {
  readonly tenantId: string;
  readonly agentId: string;
  readonly principalId: string;
  readonly mandateHash: string;
  readonly signatureKind: MandateSignatureKind;
  readonly document: Readonly<Record<string, unknown>>;
  readonly signature?: string;
  readonly jws?: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly anchorTx: string;
  /** The mandate this one renews. A renewal never creates a new agent. */
  readonly supersedesId?: string;
}

/** A freshly minted API key: the only moment its secret exists in plaintext. */
export interface IssuedApiKey {
  readonly apiKey: ApiKey;
  /** Show once, store nowhere. Only its `sha256` is persisted. */
  readonly secret: string;
}

export interface CreateConsentSessionInput {
  readonly tenantId: string;
  readonly grant: Readonly<Record<string, unknown>>;
  readonly validFrom: Date;
  readonly validUntil: Date;
  /** The invitation link's own window — distinct from `validUntil`, the resulting Mandate's window. */
  readonly expiresAt: Date;
  /**
   * Already checked against the partner's registered origins by the route.
   * This package stores it; it does not judge it — the same posture it takes
   * with `grant`.
   */
  readonly returnUrl?: string | null;
}

export interface CreatePurchaseInput {
  readonly tenantId: string;
  readonly agentId: string | null;
  readonly partnerId: string;
  readonly outcome: "settled" | "refused";
  readonly code: string | null;
  readonly reason: string | null;
  readonly venue: string;
  readonly productId: string;
  readonly quantity: number;
  readonly intentId: string | null;
  readonly total: string | null;
  readonly asset: string | null;
  readonly payTo: string | null;
  readonly transactionHash: string | null;
  readonly delivery: Readonly<Record<string, unknown>> | null;
}

export interface RecordIdempotentResponseInput {
  readonly partnerId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

// ---- Row mapping ----------------------------------------------------------

function toPartner(row: Record<string, unknown>): Partner {
  return partnerSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    // Postgres hands back a real array for `text[]`; the default is `'{}'`,
    // so a partner registered before T81 reads as "may not redirect anywhere".
    returnOrigins: row.return_origins ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toApiKey(row: Record<string, unknown>): ApiKey {
  return apiKeySchema.parse({
    id: row.id,
    partnerId: row.partner_id,
    name: row.name,
    keyHash: row.key_hash,
    scopes: row.scopes,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  });
}

function toTenant(row: Record<string, unknown>): Tenant {
  return tenantSchema.parse({
    id: row.id,
    partnerId: row.partner_id,
    externalRef: row.external_ref,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toPrincipal(row: Record<string, unknown>): Principal {
  return principalSchema.parse({
    id: row.id,
    address: row.address,
    did: row.did,
    createdAt: row.created_at,
  });
}

function toBinding(row: Record<string, unknown>): PrincipalBinding {
  return principalBindingSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    proofNonce: row.proof_nonce,
    proofSignature: row.proof_signature,
    boundAt: row.bound_at,
    revokedAt: row.revoked_at,
  });
}

function toAgent(row: Record<string, unknown>): AgentInstance {
  return agentInstanceSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    keyIndex: toSafeInteger(row.key_index, "key_index"),
    address: row.address,
    did: row.did,
    label: row.label,
    status: row.status,
    onchainState: row.onchain_state,
    policyRailContractId: row.policy_rail_contract_id,
    policyRailFundedAt: row.policy_rail_funded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toCredential(row: Record<string, unknown>): CredentialRecord {
  return credentialRecordSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    tenantId: row.tenant_id,
    credentialHash: row.credential_hash,
    issuerDid: row.issuer_did,
    principalDid: row.principal_did,
    jws: row.jws,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    anchorTx: row.anchor_tx,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  });
}

function toMandate(row: Record<string, unknown>): MandateRecord {
  return mandateRecordSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    principalId: row.principal_id,
    mandateHash: row.mandate_hash,
    signatureKind: row.signature_kind,
    document: row.document,
    signature: row.signature,
    jws: row.jws,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    anchorTx: row.anchor_tx,
    supersedesId: row.supersedes_id,
    revokedAt: row.revoked_at,
    revokeTx: row.revoke_tx,
    createdAt: row.created_at,
  });
}

function toIdempotencyRecord(row: Record<string, unknown>): IdempotencyRecord {
  return idempotencyRecordSchema.parse({
    partnerId: row.partner_id,
    key: row.key,
    requestHash: row.request_hash,
    responseStatus: toSafeInteger(row.response_status, "response_status"),
    responseBody: row.response_body,
    createdAt: row.created_at,
  });
}

function toPurchase(row: Record<string, unknown>): PurchaseRecord {
  return purchaseRecordSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    partnerId: row.partner_id,
    outcome: row.outcome,
    code: row.code,
    reason: row.reason,
    venue: row.venue,
    productId: row.product_id,
    quantity: row.quantity,
    intentId: row.intent_id,
    total: row.total,
    asset: row.asset,
    payTo: row.pay_to,
    transactionHash: row.transaction_hash,
    delivery: row.delivery,
    createdAt: row.created_at,
  });
}

function toConsentSession(row: Record<string, unknown>): ConsentSessionRecord {
  return consentSessionRecordSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    grant: row.proposed_grant,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    returnUrl: row.return_url ?? null,
    mandateId: row.mandate_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

// ---- The port -------------------------------------------------------------

export interface Directory {
  createPartner(input: { readonly name: string }): Promise<Partner>;
  findPartner(id: string): Promise<Partner | undefined>;
  setPartnerStatus(id: string, status: PartnerStatus): Promise<Partner>;
  /**
   * Replaces this partner's allowed return origins (T81). Replaces rather than
   * appends: an allowlist that only ever grows is one nobody can take an
   * entry out of, and removing a compromised origin has to be possible.
   */
  setPartnerReturnOrigins(id: string, origins: readonly string[]): Promise<Partner>;

  issueApiKey(input: { readonly partnerId: string; readonly name: string; readonly scopes: readonly string[] }): Promise<IssuedApiKey>;
  /** Constant-time lookup by secret. `undefined` for unknown or revoked. */
  authenticate(secret: string): Promise<ApiKey | undefined>;
  revokeApiKey(id: string, at?: Date): Promise<void>;

  createTenant(input: CreateTenantInput): Promise<Tenant>;
  findTenant(id: string): Promise<Tenant | undefined>;
  findTenantByExternalRef(partnerId: string, externalRef: string): Promise<Tenant | undefined>;
  listTenants(partnerId: string): Promise<readonly Tenant[]>;
  setTenantStatus(id: string, status: TenantStatus): Promise<Tenant>;

  /** Idempotent by address: the same wallet is one principal, across every partner. */
  upsertPrincipal(input: { readonly address: string; readonly did: string }): Promise<Principal>;
  findPrincipalByAddress(address: string): Promise<Principal | undefined>;

  bindPrincipal(input: BindPrincipalInput): Promise<PrincipalBinding>;
  findBinding(tenantId: string, principalId: string): Promise<PrincipalBinding | undefined>;
  revokeBinding(tenantId: string, principalId: string, at?: Date): Promise<void>;

  createAgent(input: CreateAgentInput): Promise<AgentInstance>;
  findAgent(id: string): Promise<AgentInstance | undefined>;
  /** Unique by address — the lookup that makes bootstrapping a shared agent idempotent (T39, `C-33`). */
  findAgentByAddress(address: string): Promise<AgentInstance | undefined>;
  listAgents(tenantId: string): Promise<readonly AgentInstance[]>;
  /**
   * Every agent that has deployed its own `policy_rail` (F6/T58), across
   * every tenant and partner — the read a balance-monitoring script needs
   * and no per-tenant listing gives (`listAgents` is scoped to one tenant
   * on purpose; this is the one deliberate exception, and it reads nothing
   * a partner could not already see about its own tenants through `/v1`).
   */
  listAgentsWithPolicyRail(): Promise<readonly AgentInstance[]>;
  setAgentStatus(id: string, status: AgentStatus): Promise<AgentInstance>;
  setAgentOnchainState(id: string, state: OnchainState): Promise<AgentInstance>;
  /**
   * Persists this agent's own `policy_rail` (F6/T58) — first write wins. A
   * second call (two concurrent first payments racing to deploy one) does
   * not overwrite the winner's contract id; it returns the winner's row,
   * same reconcile-by-re-reading shape `ensureTenantAgent` already uses for
   * its own creation race.
   */
  setAgentPolicyRail(id: string, contractId: string): Promise<AgentInstance>;

  recordCredential(input: RecordCredentialInput): Promise<CredentialRecord>;
  findCredentialByHash(credentialHash: string): Promise<CredentialRecord | undefined>;
  /** Most recently created credential for this tenant, regardless of status. `undefined` if it has none yet. */
  findLatestCredential(tenantId: string): Promise<CredentialRecord | undefined>;
  revokeCredential(credentialHash: string, at?: Date): Promise<void>;

  recordMandate(input: RecordMandateInput): Promise<MandateRecord>;
  findMandateByHash(mandateHash: string): Promise<MandateRecord | undefined>;
  /** Looked up by the id `/v1/mandates/{id}` names, not the hash the registry knows it by. */
  findMandateById(id: string): Promise<MandateRecord | undefined>;
  /** Every mandate of this tenant that is neither revoked nor outside its window at `at`. */
  listActiveMandates(tenantId: string, at?: Date): Promise<readonly MandateRecord[]>;
  /** Every mandate of this tenant regardless of status — a partner's history view, unlike {@link listActiveMandates}. */
  listMandates(tenantId: string): Promise<readonly MandateRecord[]>;
  /**
   * Most recently created mandate for this tenant, active or not. Used to
   * chain `supersedesId` on renewal — a renewal must find what it renews
   * even when the prior mandate has expired or been revoked.
   */
  findLatestMandate(tenantId: string): Promise<MandateRecord | undefined>;
  revokeMandate(mandateHash: string, revokeTx: string, at?: Date): Promise<void>;

  /** `/v1`'s idempotency store — `resolveIdempotency` (`@agentpey/partner-api`) reads through this. */
  findIdempotentResponse(partnerId: string, key: string): Promise<IdempotencyRecord | undefined>;
  recordIdempotentResponse(input: RecordIdempotentResponseInput): Promise<IdempotencyRecord>;

  /**
   * Claims the right to fund this agent's rail, exactly once (T77).
   * `true` means this caller may transfer the sponsored balance; `false`
   * means someone else already did, or is doing it right now. A caller whose
   * transfer then fails must call {@link releaseRailFunding}, or the rail
   * stays deployed and empty forever.
   */
  claimRailFunding(agentId: string): Promise<boolean>;
  /** Undoes a claim whose funding transfer failed, so the next attempt can retry. */
  releaseRailFunding(agentId: string): Promise<void>;
  /** How many rails the reserve has funded, across every tenant — the sponsored-credit cap counts against this. */
  countFundedRails(): Promise<number>;

  /** Records one purchase a partner asked for — settled or refused (T75). */
  createPurchase(input: CreatePurchaseInput): Promise<PurchaseRecord>;
  findPurchase(id: string): Promise<PurchaseRecord | undefined>;
  /** This tenant's purchases, newest first. */
  listPurchases(tenantId: string, limit?: number): Promise<readonly PurchaseRecord[]>;
  createConsentSession(input: CreateConsentSessionInput): Promise<ConsentSessionRecord>;
  findConsentSession(id: string): Promise<ConsentSessionRecord | undefined>;
  /** Sets `status = 'completed'` and the Mandate it produced. Refuses (`ConsentSessionAlreadyCompleted`) if already completed — a session signs once. */
  completeConsentSession(id: string, mandateId: string): Promise<ConsentSessionRecord>;

  close(): Promise<void>;
}

/**
 * Opens the directory, creating its tables on first use.
 *
 * @throws AgentPassError `ConfigError` if the database cannot be reached or
 * initialised — loudly, rather than a directory that behaves as if it were
 * empty.
 */
export async function createDirectory(options: DirectoryOptions): Promise<Directory> {
  const postgresCa = process.env.POSTGRES_CA_CERT;
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl:
      options.ssl ??
      (postgresCa === undefined || postgresCa === ""
        ? { rejectUnauthorized: false }
        : { ca: postgresCa, rejectUnauthorized: true }),
    max: options.maxConnections ?? 10,
  });
  // An idle client the server drops is emitted here; unlistened, it crashes the process.
  pool.on("error", (error) => {
    console.error(`[directory] idle Postgres client failed: ${error.message}`);
  });

  try {
    for (const statement of DIRECTORY_SCHEMA_SQL) await pool.query(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[directory] could not reach or initialise Postgres: ${message}`);
    await pool.end().catch(() => undefined);
    throw wrap("could not reach or initialise the directory's Postgres database", error);
  }

  async function one<T>(sql: string, params: readonly unknown[], map: (row: Record<string, unknown>) => T): Promise<T | undefined> {
    const { rows } = await pool.query<Record<string, unknown>>(sql, [...params]);
    return rows[0] === undefined ? undefined : map(rows[0]);
  }

  async function requirePartner(id: string): Promise<void> {
    const found = await one("select id from directory_partners where id = $1", [id], (row) => row.id);
    if (found === undefined) {
      throw new AgentPassError("PartnerNotFound", "no partner with that id", { details: { partnerId: id } });
    }
  }

  return {
    // ---- partners -------------------------------------------------------
    async createPartner(input) {
      const id = newId("partner");
      const row = await one(
        "insert into directory_partners (id, name, status) values ($1, $2, 'active') returning *",
        [id, input.name],
        toPartner,
      );
      if (row === undefined) throw wrap("inserting a partner returned no row", undefined, { partnerId: id });
      return row;
    },

    findPartner(id) {
      return one("select * from directory_partners where id = $1", [id], toPartner);
    },

    async setPartnerReturnOrigins(id, origins) {
      const row = await one(
        "update directory_partners set return_origins = $2, updated_at = now() where id = $1 returning *",
        [id, [...origins]],
        toPartner,
      );
      if (row === undefined) {
        throw new AgentPassError("PartnerNotFound", `no partner with id "${id}"`, { details: { partnerId: id } });
      }
      return row;
    },

    async setPartnerStatus(id, status) {
      const row = await one(
        "update directory_partners set status = $2, updated_at = now() where id = $1 returning *",
        [id, status],
        toPartner,
      );
      if (row === undefined) {
        throw new AgentPassError("PartnerNotFound", "no partner with that id", { details: { partnerId: id } });
      }
      return row;
    },

    // ---- api keys -------------------------------------------------------
    async issueApiKey(input) {
      await requirePartner(input.partnerId);
      const id = newId("apiKey");
      // `ap_test_` names the environment in the key itself, so a testnet key
      // pasted into something expecting production is visibly wrong before it
      // is ever used. This pilot mints nothing else — mainnet is out of scope.
      const secret = `ap_test_${randomBytes(24).toString("base64url")}`;
      const keyHash = createHash("sha256").update(secret, "utf8").digest("hex");
      const row = await one(
        "insert into directory_api_keys (id, partner_id, name, key_hash, scopes) values ($1, $2, $3, $4, $5) returning *",
        [id, input.partnerId, input.name, keyHash, [...input.scopes]],
        toApiKey,
      );
      if (row === undefined) throw wrap("inserting an api key returned no row", undefined, { apiKeyId: id });
      return { apiKey: row, secret };
    },

    async authenticate(secret) {
      // Looked up by hash rather than compared row by row: the index does the
      // work, and the hash of a wrong secret simply matches nothing. The
      // timing-safe compare below is belt and braces for the matched row.
      const keyHash = createHash("sha256").update(secret, "utf8").digest("hex");
      const row = await one(
        "select * from directory_api_keys where key_hash = $1 and revoked_at is null",
        [keyHash],
        toApiKey,
      );
      if (row === undefined) return undefined;
      const a = Buffer.from(row.keyHash, "hex");
      const b = Buffer.from(keyHash, "hex");
      return a.length === b.length && timingSafeEqual(a, b) ? row : undefined;
    },

    async revokeApiKey(id, at) {
      await pool.query("update directory_api_keys set revoked_at = $2 where id = $1 and revoked_at is null", [
        id,
        at ?? new Date(),
      ]);
    },

    // ---- tenants --------------------------------------------------------
    async createTenant(input) {
      // Validated before the partner is even looked up: a request carrying
      // personal data should be refused as early as possible, not after it
      // has been used as a lookup key and possibly logged.
      const externalRef = assertOpaqueExternalRef(input.externalRef);
      const id = newTenantId(input.partnerId);
      try {
        const row = await one(
          "insert into directory_tenants (id, partner_id, external_ref, label, status) values ($1, $2, $3, $4, 'active') returning *",
          [id, input.partnerId, externalRef, input.label ?? null],
          toTenant,
        );
        if (row === undefined) throw wrap("inserting a tenant returned no row", undefined, { tenantId: id });
        return row;
      } catch (error) {
        if (pgErrorCode(error) === UNIQUE_VIOLATION) {
          throw new AgentPassError("TenantAlreadyExists", "this partner already has a tenant for that external reference", {
            cause: error,
            details: { partnerId: input.partnerId },
          });
        }
        if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) {
          throw new AgentPassError("PartnerNotFound", "no partner with that id", {
            cause: error,
            details: { partnerId: input.partnerId },
          });
        }
        throw error;
      }
    },

    findTenant(id) {
      return one("select * from directory_tenants where id = $1", [id], toTenant);
    },

    findTenantByExternalRef(partnerId, externalRef) {
      return one(
        "select * from directory_tenants where partner_id = $1 and external_ref = $2",
        [partnerId, externalRef],
        toTenant,
      );
    },

    async listTenants(partnerId) {
      const { rows } = await pool.query<Record<string, unknown>>(
        "select * from directory_tenants where partner_id = $1 order by id asc",
        [partnerId],
      );
      return rows.map(toTenant);
    },

    async setTenantStatus(id, status) {
      const row = await one(
        "update directory_tenants set status = $2, updated_at = now() where id = $1 returning *",
        [id, status],
        toTenant,
      );
      if (row === undefined) {
        throw new AgentPassError("TenantNotFound", "no tenant with that id", { details: { tenantId: id } });
      }
      return row;
    },

    // ---- principals -----------------------------------------------------
    async upsertPrincipal(input) {
      const id = newId("principal");
      const row = await one(
        `insert into directory_principals (id, address, did) values ($1, $2, $3)
         on conflict (address) do update set address = excluded.address
         returning *`,
        [id, input.address, input.did],
        toPrincipal,
      );
      if (row === undefined) throw wrap("upserting a principal returned no row", undefined, { address: input.address });
      return row;
    },

    findPrincipalByAddress(address) {
      return one("select * from directory_principals where address = $1", [address], toPrincipal);
    },

    // ---- bindings -------------------------------------------------------
    async bindPrincipal(input) {
      // Re-proving control of the same wallet in the same tenant replaces the
      // proof and clears an earlier revocation — it does not stack rows, and
      // it does not leave a revoked binding shadowing a fresh one.
      const id = newId("binding");
      const row = await one(
        `insert into directory_principal_bindings (id, tenant_id, principal_id, proof_nonce, proof_signature)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, principal_id) do update
           set proof_nonce = excluded.proof_nonce,
               proof_signature = excluded.proof_signature,
               bound_at = now(),
               revoked_at = null
         returning *`,
        [id, input.tenantId, input.principalId, input.proofNonce, input.proofSignature],
        toBinding,
      );
      if (row === undefined) throw wrap("binding a principal returned no row", undefined, { tenantId: input.tenantId });
      return row;
    },

    findBinding(tenantId, principalId) {
      return one(
        "select * from directory_principal_bindings where tenant_id = $1 and principal_id = $2",
        [tenantId, principalId],
        toBinding,
      );
    },

    async revokeBinding(tenantId, principalId, at) {
      await pool.query(
        "update directory_principal_bindings set revoked_at = $3 where tenant_id = $1 and principal_id = $2 and revoked_at is null",
        [tenantId, principalId, at ?? new Date()],
      );
    },

    // ---- agents ---------------------------------------------------------
    async createAgent(input) {
      parseTenantId(input.tenantId);
      const existing = await one("select id from directory_tenants where id = $1", [input.tenantId], (row) => row.id);
      if (existing === undefined) {
        throw new AgentPassError("TenantNotFound", "no tenant with that id", { details: { tenantId: input.tenantId } });
      }

      // Allocated from the sequence, outside any transaction that could give
      // it back: an index handed out is spent, whether or not the insert that
      // follows succeeds. A gap costs nothing; a reused index would mean two
      // agents deriving the same keypair from the master seed.
      const { rows } = await pool.query<{ readonly nextval: string }>("select nextval('directory_key_index_seq')");
      const keyIndex = toSafeInteger(rows[0]?.nextval, "key_index");

      const identity = await input.derive(keyIndex);
      const id = newId("agent");
      const row = await one(
        `insert into directory_agents (id, tenant_id, key_index, address, did, label, status, onchain_state)
         values ($1, $2, $3, $4, $5, $6, 'active', 'derived') returning *`,
        [id, input.tenantId, keyIndex, identity.address, identity.did, input.label ?? null],
        toAgent,
      );
      if (row === undefined) throw wrap("inserting an agent returned no row", undefined, { agentId: id });
      return row;
    },

    findAgent(id) {
      return one("select * from directory_agents where id = $1", [id], toAgent);
    },

    findAgentByAddress(address) {
      return one("select * from directory_agents where address = $1", [address], toAgent);
    },

    async listAgents(tenantId) {
      const { rows } = await pool.query<Record<string, unknown>>(
        "select * from directory_agents where tenant_id = $1 order by key_index asc",
        [tenantId],
      );
      return rows.map(toAgent);
    },

    async listAgentsWithPolicyRail() {
      const { rows } = await pool.query<Record<string, unknown>>(
        "select * from directory_agents where policy_rail_contract_id is not null order by updated_at desc",
      );
      return rows.map(toAgent);
    },

    async setAgentStatus(id, status) {
      const row = await one(
        "update directory_agents set status = $2, updated_at = now() where id = $1 returning *",
        [id, status],
        toAgent,
      );
      if (row === undefined) {
        throw new AgentPassError("AgentNotFound", "no agent with that id", { details: { agentId: id } });
      }
      return row;
    },

    async setAgentOnchainState(id, state) {
      const row = await one(
        "update directory_agents set onchain_state = $2, updated_at = now() where id = $1 returning *",
        [id, state],
        toAgent,
      );
      if (row === undefined) {
        throw new AgentPassError("AgentNotFound", "no agent with that id", { details: { agentId: id } });
      }
      return row;
    },

    async setAgentPolicyRail(id, contractId) {
      const row = await one(
        `update directory_agents set policy_rail_contract_id = $2, updated_at = now()
         where id = $1 and policy_rail_contract_id is null
         returning *`,
        [id, contractId],
        toAgent,
      );
      if (row !== undefined) return row;

      // Zero rows means either the agent does not exist, or it already has a
      // rail — one more read tells them apart, and in the second case hands
      // back the winner's row rather than pretending this call had no effect.
      const existing = await one("select * from directory_agents where id = $1", [id], toAgent);
      if (existing === undefined) {
        throw new AgentPassError("AgentNotFound", "no agent with that id", { details: { agentId: id } });
      }
      return existing;
    },

    // ---- credentials ----------------------------------------------------
    async recordCredential(input) {
      const id = newId("credential");
      const row = await one(
        `insert into directory_credentials
           (id, agent_id, tenant_id, credential_hash, issuer_did, principal_did, jws, valid_from, valid_until, anchor_tx)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [
          id,
          input.agentId,
          input.tenantId,
          input.credentialHash,
          input.issuerDid,
          input.principalDid,
          input.jws,
          input.validFrom,
          input.validUntil,
          input.anchorTx,
        ],
        toCredential,
      );
      if (row === undefined) throw wrap("inserting a credential returned no row", undefined, { credentialId: id });
      return row;
    },

    findCredentialByHash(credentialHash) {
      return one("select * from directory_credentials where credential_hash = $1", [credentialHash], toCredential);
    },

    findLatestCredential(tenantId) {
      return one(
        "select * from directory_credentials where tenant_id = $1 order by id desc limit 1",
        [tenantId],
        toCredential,
      );
    },

    async revokeCredential(credentialHash, at) {
      await pool.query(
        "update directory_credentials set revoked_at = $2 where credential_hash = $1 and revoked_at is null",
        [credentialHash, at ?? new Date()],
      );
    },

    // ---- mandates -------------------------------------------------------
    async recordMandate(input) {
      const id = newId("mandate");
      const row = await one(
        `insert into directory_mandates
           (id, tenant_id, agent_id, principal_id, mandate_hash, signature_kind, document,
            signature, jws, valid_from, valid_until, anchor_tx, supersedes_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
        [
          id,
          input.tenantId,
          input.agentId,
          input.principalId,
          input.mandateHash,
          input.signatureKind,
          // Serialised here rather than handed to `pg` as an object, for the
          // same reason the column is `json` and not `jsonb` (`C-5`): the text
          // that goes in is the text that comes back, and a mandate's hash is
          // computed over exactly that text.
          JSON.stringify(input.document),
          input.signature ?? null,
          input.jws ?? null,
          input.validFrom,
          input.validUntil,
          input.anchorTx,
          input.supersedesId ?? null,
        ],
        toMandate,
      );
      if (row === undefined) throw wrap("inserting a mandate returned no row", undefined, { mandateId: id });
      return row;
    },

    findMandateByHash(mandateHash) {
      return one("select * from directory_mandates where mandate_hash = $1", [mandateHash], toMandate);
    },

    findMandateById(id) {
      return one("select * from directory_mandates where id = $1", [id], toMandate);
    },

    async listActiveMandates(tenantId, at) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `select * from directory_mandates
         where tenant_id = $1 and revoked_at is null and valid_from <= $2 and valid_until >= $2
         order by id asc`,
        [tenantId, at ?? new Date()],
      );
      return rows.map(toMandate);
    },

    async listMandates(tenantId) {
      const { rows } = await pool.query<Record<string, unknown>>(
        "select * from directory_mandates where tenant_id = $1 order by id asc",
        [tenantId],
      );
      return rows.map(toMandate);
    },

    findLatestMandate(tenantId) {
      return one(
        "select * from directory_mandates where tenant_id = $1 order by id desc limit 1",
        [tenantId],
        toMandate,
      );
    },

    async revokeMandate(mandateHash, revokeTx, at) {
      await pool.query(
        "update directory_mandates set revoked_at = $2, revoke_tx = $3 where mandate_hash = $1 and revoked_at is null",
        [mandateHash, at ?? new Date(), revokeTx],
      );
    },

    // ---- idempotency ------------------------------------------------------
    findIdempotentResponse(partnerId, key) {
      return one(
        "select * from directory_idempotency where partner_id = $1 and key = $2",
        [partnerId, key],
        toIdempotencyRecord,
      );
    },

    async recordIdempotentResponse(input) {
      // `on conflict do update` rather than a plain insert: two concurrent
      // retries of the same key racing here should not surface as a raw
      // unique-violation to whichever loses — the second write is the same
      // logical fact (this key's response, recorded), so it is safe to let
      // it win rather than fail closed as if it were something new.
      const row = await one(
        `insert into directory_idempotency (partner_id, key, request_hash, response_status, response_body)
         values ($1, $2, $3, $4, $5)
         on conflict (partner_id, key) do update set
           request_hash = excluded.request_hash,
           response_status = excluded.response_status,
           response_body = excluded.response_body
         returning *`,
        [input.partnerId, input.key, input.requestHash, input.responseStatus, JSON.stringify(input.responseBody)],
        toIdempotencyRecord,
      );
      if (row === undefined) throw wrap("recording an idempotent response returned no row", undefined, { partnerId: input.partnerId });
      return row;
    },

    // ---- consent sessions (T51) --------------------------------------------
    async claimRailFunding(agentId) {
      // The claim *is* the conditional update: two processes racing here, one
      // wins the row and the other is told `false`, with no read-then-write
      // gap in between for both to pass through.
      const { rowCount } = await pool.query(
        `update directory_agents set policy_rail_funded_at = now(), updated_at = now()
         where id = $1 and policy_rail_contract_id is not null and policy_rail_funded_at is null`,
        [agentId],
      );
      return (rowCount ?? 0) > 0;
    },

    async releaseRailFunding(agentId) {
      await pool.query(
        "update directory_agents set policy_rail_funded_at = null, updated_at = now() where id = $1",
        [agentId],
      );
    },

    async countFundedRails() {
      const { rows } = await pool.query<{ count: string }>(
        "select count(*)::text as count from directory_agents where policy_rail_funded_at is not null",
      );
      return Number(rows[0]?.count ?? "0");
    },

    async createPurchase(input) {
      const id = newId("purchase");
      const row = await one(
        `insert into directory_purchases
           (id, tenant_id, agent_id, partner_id, outcome, code, reason, venue, product_id,
            quantity, intent_id, total, asset, pay_to, transaction_hash, delivery)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
        [
          id,
          input.tenantId,
          input.agentId,
          input.partnerId,
          input.outcome,
          input.code,
          input.reason,
          input.venue,
          input.productId,
          input.quantity,
          input.intentId,
          input.total,
          input.asset,
          input.payTo,
          input.transactionHash,
          input.delivery === null ? null : JSON.stringify(input.delivery),
        ],
        toPurchase,
      );
      if (row === undefined) throw wrap("inserting a purchase returned no row", undefined, { purchaseId: id });
      return row;
    },

    findPurchase(id) {
      return one("select * from directory_purchases where id = $1", [id], toPurchase);
    },

    async listPurchases(tenantId, limit = 50) {
      const { rows } = await pool.query<Record<string, unknown>>(
        // `id desc` and not `created_at desc`: ids are ULIDs, so they sort by
        // creation time anyway, and they break ties that a timestamp with
        // millisecond resolution cannot.
        "select * from directory_purchases where tenant_id = $1 order by id desc limit $2",
        [tenantId, limit],
      );
      return rows.map(toPurchase);
    },

    async createConsentSession(input) {
      const id = newId("consentSession");
      const row = await one(
        `insert into directory_consent_sessions
           (id, tenant_id, status, proposed_grant, valid_from, valid_until, expires_at, return_url)
         values ($1, $2, 'pending', $3, $4, $5, $6, $7) returning *`,
        [
          id,
          input.tenantId,
          JSON.stringify(input.grant),
          input.validFrom,
          input.validUntil,
          input.expiresAt,
          input.returnUrl ?? null,
        ],
        toConsentSession,
      );
      if (row === undefined) throw wrap("inserting a consent session returned no row", undefined, { consentSessionId: id });
      return row;
    },

    findConsentSession(id) {
      return one("select * from directory_consent_sessions where id = $1", [id], toConsentSession);
    },

    async completeConsentSession(id, mandateId) {
      const row = await one(
        `update directory_consent_sessions
         set status = 'completed', mandate_id = $2
         where id = $1 and status = 'pending'
         returning *`,
        [id, mandateId],
        toConsentSession,
      );
      if (row === undefined) {
        const existing = await one("select * from directory_consent_sessions where id = $1", [id], toConsentSession);
        if (existing === undefined) {
          throw new AgentPassError("ConsentSessionNotFound", "no consent session with that id", { details: { consentSessionId: id } });
        }
        // Reaching here with a real row means the `where status = 'pending'`
        // guard is what refused the update — it was already completed
        // (racing to sign twice, or replaying an old link), not vanished.
        throw new AgentPassError("ConsentSessionAlreadyCompleted", "this consent session was already completed", {
          details: { consentSessionId: id },
        });
      }
      return row;
    },

    async close() {
      await pool.end();
    },
  };
}
