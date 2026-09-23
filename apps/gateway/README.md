# Gateway

One Render service, four apps. `agentpey.com`, `realops.agentpey.com`,
`signaldesk.agentpey.com` and `vitrinee.agentpey.com` all point at this one
service; this process spawns `apps/web`, `apps/realops`, `apps/signaldesk` and
`packages/vitrinee-gateway` as separate children and forwards each request to
the right one by its `Host` header.

**Vitrinee is different in three ways (T102, `C-136`).** Its variables are
stored as `VITRINEE_<NAME>` and handed to its process alone as `<NAME>`
(`envAliases` in `hosts.ts`), because it reads generic names like `ADAPTER` and
`PUBLIC_BASE_URL`. It is only started when its secrets are set
(`requiredEnv`); until then its host answers `503`. And it is not critical: if
it exits, its host answers `503` and the other three keep serving, instead of
the whole service restarting.

**Why this exists.** Before T86 the three apps were three separate Render
services — three Starter plans to keep all of them warm. `agentpey-web`,
`agentpey-realops` and `agentpey-signaldesk` never imported each other and
never shared a key; that separation is the whole reason SignalDesk is credible
as a merchant that could not reach into AgentPey's authorisation even if it
wanted to (`C-88`). This package keeps that separation — three OS processes,
each with only its own slice of the container's secrets (`hosts.ts`'s
`envKeys`, applied by `env-filter.ts`) — while billing as one service.

**What it does not do.** It does not decide anything, verify anything, or
touch a database. If a line here looked like it was making an authorisation
call or reaching into a request body, that would be the bug — this is routing
and process supervision, nothing else.

## Running it

```bash
pnpm run build   # once, from the repo root — pnpm build compiles the workspace packages every app depends on
pnpm --filter @agentpey/gateway run start
```

Needs the union of what each of the three apps needs in `.env.local` — see
`.env.example`. With everything present it starts all three, waits for each to
answer on its own internal port, then listens on `PORT` (`8080` if unset) and
prints the host → app map it built.

Visiting it locally: point each hostname at `127.0.0.1` (an `/etc/hosts`
entry, or a `Host` header set by hand) and the gateway forwards to whichever
app that hostname is configured for. `GATEWAY_AGENTPEY_HOST`,
`GATEWAY_REALOPS_HOST`, `GATEWAY_SIGNALDESK_HOST` and `GATEWAY_VITRINEE_HOST`
override the hostnames it matches, for testing with names other than the real
ones.

```bash
pnpm --filter @agentpey/gateway test
```

## What is, and is not, unit-tested

`hosts.ts` (the host → app map, and why it is exact-match, never a prefix),
`env-filter.ts` (which secrets a child does and does not see) and `proxy.ts`
(the `Host` header survives the hop, unchanged) are pure or run against a real
local HTTP server, and are fully covered. Actually spawning the three real
apps — each needing a real Postgres and real Stellar keys to come up — is
exercised by running the gateway itself, not by a unit test, the same line
`apps/web/src/server.ts` and its siblings already draw around their own
entrypoints.
