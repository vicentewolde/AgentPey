# MPP charge probe (T135)

A technical probe, not part of AgentPey: can an MPP charge (`@stellar/mpp`) be paid from a `policy_rail` contract
account on Stellar testnet? The answer, its evidence and what it means are in
[`docs/fase-8-agentes-reales/evidencia/T135-mpp-charge.md`](../../docs/fase-8-agentes-reales/evidencia/T135-mpp-charge.md)
(decisions `R-4` and `R-20`).

It is its own pnpm workspace, outside AgentPey's: `@stellar/mpp` 0.7.1 wants `@stellar/stellar-sdk` 15, `mppx` 0.6
and `viem`, and AgentPey uses `@stellar/stellar-sdk` 17. `tsconfig.scripts.json` excludes this folder.

Install:

```bash
pnpm --dir scripts/mpp-probe install
```

Type-check:

```bash
pnpm --dir scripts/mpp-probe run typecheck
```

Run everything, including the control, which **moves 0.01 testnet USDC** from the agent's classic key
(`AGENT_SECRET_KEY` in `.env.local`) to agentcommerce's payTo account:

```bash
pnpm --dir scripts/mpp-probe run probe
```

Run only the rail's checks and attempts: a read-only simulation and four attempts that, with the pinned
`@stellar/mpp` 0.7.1, are refused before anything is broadcast. If the SDK ever accepted an unsponsored attempt, its
server would broadcast the rail's transfer (up to 0.01 USDC, within the rail's caps) and the verdict says stop:

```bash
pnpm --dir scripts/mpp-probe run probe -- --skip-control
```

Needs `AGENT_SECRET_KEY` and `UCP_POLICY_RAIL_CONTRACT_ID` in the repo's `.env.local`. Prints no secret.

Its errors are a local `ProbeError` with a `code`, not AgentPey's `AgentPassError`: this package is outside AgentPey's
workspace and does not import its packages.
