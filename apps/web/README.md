# @agentpey/web

The simple frontend from T25 (Phase 4, MandateGate): a Node server
(`node:http`, no framework) plus a build-step-free static page that drives
the agent against the real bazaar on Stellar testnet — a live session, a
real x402 payment, a real Mandate revocation. See
[`docs/fase-4-mandategate/`](../../docs/fase-4-mandategate/) for the design
and evidence.

## Run it locally

From the repo root:

```bash
pnpm run web
```

Needs `.env.local` at the repo root (`pnpm run bootstrap` + `pnpm run
deploy:registry` set it up) and the agent's account funded with USDC (`pnpm
run fund:usdc`, then fund the printed address at Circle's testnet USDC
faucet). Opens on `http://localhost:8787` (override with `PORT=...`).

## Deploy it somewhere public (Render)

This is a stateful, long-running Node process, not a serverless function —
it needs a platform that keeps one process alive, not one that spins up
isolated invocations per request.

**Since T86 it is not deployed on its own.** `render.yaml` at the repo root
describes one Render service, `AgentPey`, whose start command
(`pnpm --filter @agentpey/gateway run start`) runs this app, `apps/realops`
and `apps/signaldesk` as three child processes behind one port, routed by
hostname: this app answers `agentpey.com`. See `apps/gateway/README.md` for how
the three are kept apart, and `render.yaml` for every variable and why it is
there.

**What you have to do yourself — deliberately not automated:**

1. Every variable `render.yaml` marks `sync: false` is a secret Render never
   asks for during a Blueprint sync: set it in the service's **Environment**
   tab. Copy the values from your own `.env.local` and paste them into
   Render's form yourself. Nothing in this repo, and nothing Claude Code does,
   ever transmits them anywhere.
2. A variable added to `render.yaml` reaches no app until it is also listed
   for that app in `apps/gateway/src/hosts.ts` (`envKeys`).

**No access control, on purpose.** Anyone with the link can click every
button, including "Comprar" — each click is a real (if tiny, ~0.001 USDC)
testnet transaction. That's the intended shape of a public demo of this
project; it is not a mistake to fix later.

**Operational note.** The agent's account needs to stay funded — both the
native XLM for fees (Friendbot-funded, effectively free to refill) and the
USDC each real purchase spends. A public demo that gets real traffic will
eventually need a top-up at Circle's testnet faucet; there's no
auto-refill, and a purchase past the balance will surface as an
`AgentPassError` in the UI, not a crash.

Render's free tier spins the service down after idle periods and takes a
few seconds to wake on the next request — normal for a demo, worth knowing
before someone clicks "Iniciar sesión" and waits.
