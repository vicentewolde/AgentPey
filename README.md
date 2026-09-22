# AgentPey

An agentic payments stack on **Stellar testnet**, built in seven phases: from
verifiable agent identity through spending policy, signed mandates, real
commerce, and verifiable evidence. See **[ROADMAP.md](ROADMAP.md)** for the
phases, what is done, and what comes next.

Everything below describes **Phase 1 — AgentPass**, which is complete and runs
end to end. Its code lives at the root of this repo (`packages/`, `contracts/`);
later phases add siblings there rather than parallel trees.

---

# Phase 1 — AgentPass

Identity credentials for AI agents, issued and verified against **Stellar
testnet**. An agent proves cryptographically who operates it and what it is
authorised to do; that authorisation can be cut from outside the agent, so no
prompt injection can talk its way past it.

Testnet only. No mainnet, no fiat rails, no PSP — deliberately.

## How it fits together

| Piece | What it does |
|---|---|
| `packages/core` | Typed errors, `did:stellar` derivation, VC-JWT sign/verify. **No I/O.** |
| `packages/sdk` | `issue()` / `verify()` / `revoke()` — core plus Soroban RPC. |
| `packages/cli` | The `agentpass` binary. |
| `packages/mandate` | Phase 3: `@agentpey/mandate` — the principal's signed consent. Depends on core, nothing depends on it. |
| `packages/vault` | Phase 5: `@agentpey/vault` — the hash-chained record of every grant, refusal and anchor. |
| `packages/tenancy` | Phase 6: `@agentpey/tenancy` — one Stellar keypair per derived identity, from a single master seed (SEP-0005). **No I/O.** |
| `packages/directory` | Phase 6: `@agentpey/directory` — the durable record of partners, tenants, principals, agents, credentials and mandates. |
| `contracts/policy-rail` | Soroban smart account that enforces `per_tx` / `per_day` inside the transfer itself. |
| `contracts/agent-registry` | Soroban contract holding credential hashes, their status, and the issuer set. |
| `deployments/testnet.json` | The only artefact shared between the TypeScript and Rust sides. |

A credential is **never** stored on-chain. On-chain there is only the SHA-256 of
the compact JWS, its status, and the issuer registry.

Verifying a credential is exactly three checks:

1. the JWS verifies against the public key derived from the issuer's DID;
2. `now` falls within `validFrom` / `validUntil`;
3. `status(sha256(jws)) == Active` and the issuer is active.

Checks 1 and 2 need no network at all — `did:stellar:testnet:<G-address>`
resolves deterministically, because the Stellar account's public key *is* the
`Ed25519VerificationKey2020`.

## Project documentation

Written in Spanish, because that is the language its readers use. Code,
comments and commit messages are in English.

| | |
|---|---|
| [docs/fase-1-agentpass/CONTEXTO.md](docs/fase-1-agentpass/CONTEXTO.md) | What AgentPass is, the thesis, what it is **not** |
| [docs/fase-1-agentpass/BITACORA.md](docs/fase-1-agentpass/BITACORA.md) | Running log: current state, what each milestone delivered |
| [docs/fase-1-agentpass/DECISIONES.md](docs/fase-1-agentpass/DECISIONES.md) | Every significant decision, with its rationale and the rejected alternative |
| [docs/fase-1-agentpass/evidencia/](docs/fase-1-agentpass/evidencia/) | Raw command output for each milestone |

## Requirements

- Node ≥ 22 and pnpm 11 (`brew install pnpm`)
- Rust stable with the `wasm32v1-none` target (`brew install rustup && rustup default stable`)
- `stellar` CLI 28 (`brew install stellar-cli`)

Homebrew installs rustup keg-only, so add it to your shell:

```bash
echo 'export PATH="/opt/homebrew/opt/rustup/bin:$PATH"' >> ~/.zshrc
```

## Getting a working testnet environment

```bash
pnpm install
```

```bash
pnpm run bootstrap
```

```bash
pnpm run deploy:registry
```

`bootstrap` generates the admin / issuer / agent keypairs, funds them through
Friendbot, writes `.env.local` (mode 600, gitignored, secrets never printed) and
reports the network's live protocol version. It is idempotent: re-running reuses
every existing keypair, skips accounts that are already funded, and preserves
keys it does not own — including the contract id `deploy:registry` writes.

`deploy:registry` builds, uploads and deploys `agent_registry`, then reads the
contract back through the SDK to confirm what landed on chain is what was meant,
and records it in `deployments/testnet.json` and `.env.local`. Re-running is a
no-op when the deployed contract matches the built wasm. Any drift stops the
script and asks for `--redeploy`, because a redeploy means a **new contract id**
and every credential anchored against the old one would be orphaned.

The live testnet deployment is
`CARC2SIQ3GTL34LVHSTGFRKDNNBYUXCSMGAUGKWGMT6Z2SDY6FXPP2DT`.

`deploy:registry` also registers the pilot's issuer in that contract if it
is not already active, which is what lets the walkthrough below run with no
manual setup beyond the three commands above.

## Build the CLI

```bash
pnpm build
```

## Full walkthrough: issue → verify → revoke → verify fails

Everything above — `pnpm install`, `bootstrap`, `deploy:registry`, `build` —
must have already run. Every command below is run from the repo root.

Pull the demo agent's address out of `.env.local` (written by `bootstrap`):

```bash
AGENT_PUBLIC_KEY=$(grep '^AGENT_PUBLIC_KEY=' .env.local | cut -d'"' -f2)
```

Issue it a credential. [examples/scope.json](examples/scope.json) is a ready-made
scope file — what the agent may do, and its spending limits:

```bash
node packages/cli/dist/bin.js issue --subject "$AGENT_PUBLIC_KEY" --scope examples/scope.json --out credential.jws
```

This prints a summary including the credential's hash, and anchors that hash in
the registry. Verify the credential — this runs all three checks: signature,
validity window, and the registry:

```bash
node packages/cli/dist/bin.js verify credential.jws
```

`status` should be `Active`. Pull the hash out of that same output, so nothing
needs to be copied by hand:

```bash
HASH=$(node packages/cli/dist/bin.js verify credential.jws | grep '^hash' | awk '{print $2}')
```

Confirm it directly against the registry:

```bash
node packages/cli/dist/bin.js status "$HASH"
```

Now revoke it — this is the principal cutting the agent's authorisation from
**outside** the agent:

```bash
node packages/cli/dist/bin.js revoke "$HASH"
```

```bash
node packages/cli/dist/bin.js status "$HASH"
```

That should now print `Revoked`. Verify the exact same file again — the same
JWS, the same valid signature, nothing about the credential itself changed:

```bash
node packages/cli/dist/bin.js verify credential.jws
```

This must fail with `CredentialRevoked: the registry reports this credential as
revoked`, exit code 1. That failure is the whole point of the project: an
agent's authorisation was cut without touching the agent, the credential, or
its signature — only the registry.

## Test

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm run test:integration
```

```bash
cd contracts && cargo test
```

`pnpm test` is the fast suite and needs no keys. `test:integration` runs the
full cycle against live testnet with nothing mocked — issue, verify, revoke,
then confirm the same JWS no longer verifies — so it needs `.env.local` and a
deployed registry.

## Status

T1 through T8 are complete. The pilot's full loop — install, bootstrap, deploy,
build, then issue / verify / revoke / status from the CLI — runs end to end
against live Stellar testnet, following nothing but this README.

Out of scope for this phase, deliberately: enforcing `scope.limits` (signed and
transported, not yet enforced by anything), PolicyRail, Mandato, MandateGate,
MandateVault, any web UI, mainnet, and fiat rails. See
[docs/fase-1-agentpass/CONTEXTO.md](docs/fase-1-agentpass/CONTEXTO.md).

This file documents phase 1 (AgentPass) specifically — see
[ROADMAP.md](ROADMAP.md) for where the project stands as a whole.
[`apps/agent`](apps/agent/README.md) is phase 2, the minimal purchasing agent
built on top of AgentPass; from the repo root, after `bootstrap` and
`deploy:registry`, `pnpm demo` runs its full walkthrough — issue a credential,
a Spanish purchase instruction, a signed intent, a real revocation, a rejected
retry — against live testnet in about twelve seconds.
[`packages/mandate`](packages/mandate/README.md) is phase 3, complete: the
principal's signed consent, the document that says what the agent is actually
allowed to spend.

Phases 4 and 5 add real payments and their evidence. A purchase can be paid two
ways, and both settle a real x402 invoice against the bazaar on testnet:

```bash
pnpm run demo:pay-real
```

pays from the agent's own classic account (T24). Deploy the `policy_rail` smart
account once, naming the wallet that owns the money in it:

```bash
pnpm run deploy:policy-rail -- --principal GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

`--principal` is required and has no default. That wallet is the only one that
can withdraw the rail's balance or rotate the key allowed to spend from it
(T57); the agent's key can spend within the limits and nothing else. Once
deployed, the same purchase can be paid by the contract instead, with its
`perTx` and `perDay` limits enforced by the network inside the transfer itself
(T31):

```bash
pnpm run demo:pay-real -- --payer=policy-rail
```

`pnpm run web` puts both behind buttons, alongside the MandateVault log that
records every decision and anchors each payment on chain. It is deployed live
at [agentpey.com](https://agentpey.com), alongside the F9 pilot's
platform at [realops.agentpey.com](https://realops.agentpey.com) and its
merchant at [signaldesk.agentpey.com](https://signaldesk.agentpey.com) — three
apps on one Render service, see `apps/gateway/README.md`.

Phase 6 turns the pilot into something a third party can integrate: a
partner gets an API key (`pnpm run partner:create` for a new partner,
`pnpm run partner:key` to inspect or rotate an existing partner's key —
note that `partner:create` mints a *new* partner, and tenants are
partner-scoped), calls `/v1` to create
tenants and propose a spending grant, and a principal reviews and signs that
grant by connecting their own wallet at a hosted `/consent/{id}` link — no
partner ever touches a private key. Each tenant gets its own `policy_rail`,
funded and owned by that tenant's own wallet, not a shared account.
`packages/partner-api`, `packages/partner-sdk` and `packages/webhooks` are
the pieces; [`examples/cloudops-partner-integration.md`](examples/cloudops-partner-integration.md)
is a full walkthrough with exact `curl` commands. See
[docs/fase-6-agentguard-comercializacion/](docs/fase-6-agentguard-comercializacion/)
for the design and current state.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
