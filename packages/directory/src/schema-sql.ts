/**
 * The directory's tables, created on first use — same self-initialising
 * approach `createPostgresMandateVault` already uses (T33), and for the same
 * reason: this pilot has no migration runner, and adding one to hold four
 * `create table if not exists` statements would be more machinery than the
 * problem has.
 *
 * Two things here are deliberate and would be wrong if copied blindly into a
 * project that did not share this one's constraints:
 *
 * - **`key_index` comes from a Postgres sequence, not from `max(key_index)+1`.**
 *   A sequence hands out a value without waiting for the transaction that
 *   asked for it, so two concurrent tenant creations can never receive the
 *   same index — which is the failure that matters, because two agents on one
 *   index means two tenants deriving the same Stellar keypair from the master
 *   seed. Sequences leave gaps when a transaction rolls back; a gap is
 *   harmless (the requirement is "never reused", not "no holes"), and a
 *   collision is not.
 * - **`document` is `json`, not `jsonb`.** Exactly the trap `C-5` documents
 *   for the vault: `jsonb` normalises key order on write, and a mandate's
 *   hash is computed over its serialised text, so a `jsonb` round trip would
 *   silently produce a document whose hash no longer matches what was signed
 *   and anchored.
 */

/** Bumped when the layout changes incompatibly. Mirrors the contracts' own convention. */
export const DIRECTORY_SCHEMA_VERSION = 9;

export const DIRECTORY_SCHEMA_SQL: readonly string[] = [
  `create sequence if not exists directory_key_index_seq as bigint start with 0 minvalue 0`,

  `create table if not exists directory_partners (
     id         text        primary key,
     name       text        not null,
     status     text        not null,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,

  `create table if not exists directory_api_keys (
     id         text        primary key,
     partner_id text        not null references directory_partners(id),
     name       text        not null,
     key_hash   text        not null unique,
     scopes     text[]      not null,
     created_at timestamptz not null default now(),
     revoked_at timestamptz
   )`,

  `create index if not exists directory_api_keys_partner_idx on directory_api_keys (partner_id)`,

  // The unique constraint is the whole point of the table: one partner cannot
  // have two tenants for the same user, and two partners naming the same user
  // do not collide, because the partner is part of the key.
  `create table if not exists directory_tenants (
     id           text        primary key,
     partner_id   text        not null references directory_partners(id),
     external_ref text        not null,
     label        text,
     status       text        not null,
     created_at   timestamptz not null default now(),
     updated_at   timestamptz not null default now(),
     unique (partner_id, external_ref)
   )`,

  `create table if not exists directory_principals (
     id         text        primary key,
     address    text        not null unique,
     did        text        not null unique,
     created_at timestamptz not null default now()
   )`,

  // One binding per (tenant, principal): re-proving control of the same
  // wallet in the same tenant updates the proof, it does not add a row.
  `create table if not exists directory_principal_bindings (
     id              text        primary key,
     tenant_id       text        not null references directory_tenants(id),
     principal_id    text        not null references directory_principals(id),
     proof_nonce     text        not null,
     proof_signature text        not null,
     bound_at        timestamptz not null default now(),
     revoked_at      timestamptz,
     unique (tenant_id, principal_id)
   )`,

  `create table if not exists directory_agents (
     id            text        primary key,
     tenant_id     text        not null references directory_tenants(id),
     key_index     bigint      not null unique,
     address       text        not null unique,
     did           text        not null unique,
     label         text,
     status        text        not null,
     onchain_state text        not null,
     created_at    timestamptz not null default now(),
     updated_at    timestamptz not null default now()
   )`,

  `create index if not exists directory_agents_tenant_idx on directory_agents (tenant_id)`,

  `create table if not exists directory_credentials (
     id              text        primary key,
     agent_id        text        not null references directory_agents(id),
     credential_hash text        not null unique,
     issuer_did      text        not null,
     principal_did   text        not null,
     jws             text        not null,
     valid_from      timestamptz not null,
     valid_until     timestamptz not null,
     anchor_tx       text        not null,
     revoked_at      timestamptz,
     created_at      timestamptz not null default now(),
     tenant_id       text        references directory_tenants(id)
   )`,

  // Added in schema version 2 (T39), via `alter` rather than only in the
  // `create table` above, because this table already exists — empty, but
  // existing — on the pilot's live database from T38's own integration
  // tests. `agent_id` alone identified a credential's *identity* correctly,
  // but not which tenant it belongs to: before F4 wires a distinct Stellar
  // identity per tenant, every tenant's credential shares one `agent_id`
  // (`C-33`), so rehydrating "the credential for this tenant" needs a column
  // that scopes by tenant directly. Nullable at the SQL level — no row has
  // ever been written without it, and every write path (`recordCredential`)
  // requires it as a matter of TypeScript's own types — but not enforced
  // `not null` in the schema itself, so this statement stays safe to replay
  // against a database this migration has already run against.
  `alter table directory_credentials add column if not exists tenant_id text references directory_tenants(id)`,

  `create index if not exists directory_credentials_agent_idx on directory_credentials (agent_id)`,
  `create index if not exists directory_credentials_tenant_idx on directory_credentials (tenant_id)`,

  `create table if not exists directory_mandates (
     id             text        primary key,
     tenant_id      text        not null references directory_tenants(id),
     agent_id       text        not null references directory_agents(id),
     principal_id   text        not null references directory_principals(id),
     mandate_hash   text        not null unique,
     signature_kind text        not null,
     document       json        not null,
     signature      text,
     jws            text,
     valid_from     timestamptz not null,
     valid_until    timestamptz not null,
     anchor_tx      text        not null,
     supersedes_id  text        references directory_mandates(id),
     revoked_at     timestamptz,
     revoke_tx      text,
     created_at     timestamptz not null default now()
   )`,

  `create index if not exists directory_mandates_tenant_idx on directory_mandates (tenant_id)`,

  // Schema version 3 (T49): `/v1`'s idempotency store. `response_body` is
  // `json`, not `jsonb` — no hash is computed over it, so there is no `C-5`
  // trap here, but `jsonb` normalising key order would still be a pointless
  // rewrite of a value that is only ever replayed verbatim, never queried by
  // field. The primary key is exactly `resolveIdempotency`'s own lookup key.
  `create table if not exists directory_idempotency (
     partner_id      text        not null references directory_partners(id),
     key             text        not null,
     request_hash    text        not null,
     response_status integer     not null,
     response_body   json        not null,
     created_at      timestamptz not null default now(),
     primary key (partner_id, key)
   )`,

  // Schema version 4 (T51): a partner's hosted-consent invitation, waiting
  // for a principal to sign it. `proposed_grant` (not `grant` — a reserved
  // SQL keyword, would need quoting on every statement) is `json`, not
  // `jsonb` — same `C-5` reasoning as `directory_mandates.document`, even
  // though nothing hashes this particular value: there is still no reason
  // for Postgres to rewrite key order in something only ever handed back
  // verbatim.
  `create table if not exists directory_consent_sessions (
     id             text        primary key,
     tenant_id      text        not null references directory_tenants(id),
     status         text        not null,
     proposed_grant json        not null,
     valid_from     timestamptz not null,
     valid_until    timestamptz not null,
     mandate_id     text        references directory_mandates(id),
     created_at     timestamptz not null default now(),
     expires_at     timestamptz not null
   )`,

  `create index if not exists directory_consent_sessions_tenant_idx on directory_consent_sessions (tenant_id)`,

  // Schema version 5 (T58/F6): each wallet-connected tenant's own
  // `policy_rail`, deployed lazily the first time it actually pays. `null`
  // is the normal state for the overwhelming majority of agents — same
  // reasoning `onchain_state` already carries for the classic account.
  `alter table directory_agents add column if not exists policy_rail_contract_id text`,

  // Schema version 6 (T75/F9): what a partner asked for through
  // `POST /v1/purchases`, and what happened. Refusals are rows too — see
  // `purchaseRecordSchema` for why storing only successes would make the
  // most important question about this system unanswerable.
  //
  // `partner_id` is stored rather than joined through the tenant: reading a
  // purchase checks ownership on every request, and a check that needs a
  // join is a check that can be written without one by mistake.
  //
  // `delivery` is `json`, not `jsonb` — `C-5` again. Nothing hashes it, and
  // nothing gains from Postgres reordering something handed back verbatim.
  `create table if not exists directory_purchases (
     id               text        primary key,
     tenant_id        text        not null references directory_tenants(id),
     -- Nullable on purpose: a request refused before this platform even
     -- resolves the tenant's agent (an unregistered venue, say) still has to
     -- be recorded, and inventing an agent id for it would be a lie.
     agent_id         text        references directory_agents(id),
     partner_id       text        not null references directory_partners(id),
     outcome          text        not null,
     code             text,
     reason           text,
     venue            text        not null,
     product_id       text        not null,
     quantity         integer     not null,
     intent_id        text,
     total            text,
     asset            text,
     pay_to           text,
     transaction_hash text,
     delivery         json,
     created_at       timestamptz not null default now()
   )`,

  `create index if not exists directory_purchases_tenant_idx on directory_purchases (tenant_id, created_at desc)`,

  // Schema version 7 (T77/F9): whether a deployed rail has actually received
  // its sponsored balance.
  //
  // Before this, `ensureTenantPolicyRail` deployed, funded, and only then
  // persisted the contract id — so a crash between funding and persisting
  // made the next purchase deploy and fund a *second* rail, and the first
  // one was left with the reserve's money and no row pointing at it. Two
  // concurrent first purchases did the same thing without any crash. This
  // column is what lets funding be claimed exactly once and retried safely:
  // deploy, persist, claim, fund. A rail whose funding failed releases the
  // claim and is funded on the next attempt, and a rail that spent its
  // balance down to zero is never mistaken for one that was never funded.
  `alter table directory_agents add column if not exists policy_rail_funded_at timestamptz`,

  // Schema version 8 (T81/F9): where a partner may send a principal back to
  // after they sign, and where a given session actually sends them.
  //
  // This closes the last security gap `PILOTO-F9.md` § 8 listed as unbuilt
  // (row 8, open redirect). A consent session ends with a redirect; if the
  // partner could name any destination, the consent URL would be an open
  // redirect hosted on AgentPey's own domain — the single most credible place
  // for one, because it is exactly where the person was told to go and sign.
  //
  // The default of `'{}'` is not a placeholder: an empty list means this
  // partner may not supply a `return_url` at all. That is the fail-closed
  // reading of an empty list this project has used since `B-1`, and it means
  // every partner that existed before this column is, correctly, not allowed
  // to redirect anywhere until someone registers an origin on purpose.
  `alter table directory_partners add column if not exists return_origins text[] not null default '{}'`,

  // Validated against that list when the session is created, so whatever
  // renders the redirect can trust the stored value without re-deriving the
  // allowlist. Null means "no redirect": the person stays on AgentPey.
  `alter table directory_consent_sessions add column if not exists return_url text`,

  // Schema version 9 (T90): which Mandate a purchase went through.
  //
  // A tenant can hold several Mandates at once (one per agent a partner shows
  // a person), and from T90 the partner may name the one to use. Storing it is
  // what lets anyone check afterwards that the Mandate chosen was the Mandate
  // used. Nullable: a refusal before any Mandate was resolved has none, and
  // every row written before this column existed stays `null` rather than
  // being back-filled with a guess.
  `alter table directory_purchases add column if not exists mandate_id text references directory_mandates(id)`,
];
