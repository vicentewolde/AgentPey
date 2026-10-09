# AgentPey

AI agents buy from online stores and pay in USDC on **Stellar testnet**. AgentPey builds on existing standards:
[UCP](https://ucp.dev) for checkout, AP2 for the user's authorization and x402 for payment. It adds what they lack: a
Stellar payment handler for UCP, signed receipts anchored on-chain, spend limits enforced on-chain (`policy_rail`), and
disputes with refunds (AgentResolve).

## See it live

| | |
|---|---|
| MCP server (connect Claude or ChatGPT) | `https://mcp.agentpey.com/mcp` ([setup steps](apps/mcp/README.md)) |
| Stores an agent can buy from | [agentpey.com/tiendas](https://agentpey.com/tiendas) |
| What agents are buying right now, read from the network | [agentpey.com/en-vivo](https://agentpey.com/en-vivo) (data: [`/api/live`](https://agentpey.com/api/live)) |
| The buyer's SDK | [`@agentpey/ucp-stellar`](https://www.npmjs.com/package/@agentpey/ucp-stellar) on npm |
| The Stellar payment handler for UCP | [spec](https://agentpey.com/ucp/handlers/stellar-x402/spec) |

## Evidence

As of 2026-10-09 (14:49 UTC), from `/api/live`, which counts only purchases whose signed receipt could be read and whose payment
transaction is known:

| | |
|---|---|
| Purchases | 26, at 3 test stores |
| USDC paid | 52.7157903 |
| Disputes | 3, all resolved |
| Refunded | 2.0842106 USDC (2 refunds; the other claim was rejected, 0 refunded) |

Every purchase has a receipt signed by the store, anchored in the
[`receipt-registry`](https://stellar.expert/explorer/testnet/contract/CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5)
contract, and a payment transaction you can open:

- An example purchase (a magnet, 0.5157895 USDC, 2026-10-09): [payment](https://stellar.expert/explorer/testnet/tx/a3200a4c2d745d6efefc97b80607905a5558dc446256d6096bcc30844f7ce8dd), [receipt anchor](https://stellar.expert/explorer/testnet/tx/7b9bce5030658e78d58e3f43861cff21938587d5772df329cc00cbfb67c9fde1).
- The refund of 2026-10-08, 1.5684211 USDC returned to the payer by the
  [AgentResolve](https://stellar.expert/explorer/testnet/contract/CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F)
  contract: [transaction](https://stellar.expert/explorer/testnet/tx/fbdd6e741ba92122fd3c5221b429048787166d8b9bdfacaececc6c6d917ee22a).
  The run, step by step: [`T124-reembolso-real.md`](docs/fase-8-agentes-reales/evidencia/T124-reembolso-real.md) (in Spanish).

Seven older records (Bazar Cordillera, 22 and 23 September) are anchored but their store no longer holds the orders,
so no payment can be shown for them. They are not counted; `/api/live` lists them apart under `incomplete`.

## Quickstart for builders

**Connect an agent to the MCP server.** In Claude: Customize, Connectors, Add custom connector, URL
`https://mcp.agentpey.com/mcp`. Only the wallet that owns the MCP's `policy_rail` can sign in. Steps for Claude and
ChatGPT: [`apps/mcp/README.md`](apps/mcp/README.md).

**Buy from your own agent with the SDK** (Node 22 or later, ESM). Quoting opens a checkout and moves no money:

```bash
npm install @agentpey/ucp-stellar
```

```js
// quote.mjs
import { fromAtomic, quote } from "@agentpey/ucp-stellar";

const q = await quote({
  storeUrl: "https://agentcommerce.vitrinee.agentpey.com",
  productId: "67624104591666",
  quantity: 1,
  buyer: { email: "buyer@example.com", first_name: "Ada", last_name: "Lovelace" },
  destination: { first_name: "Ada", last_name: "Lovelace", street_address: "Av. Providencia 1234", address_locality: "Providencia", address_country: "CL" },
});
console.log(`checkout ${q.checkoutId}: ${fromAtomic(BigInt(q.requirements.amount), q.asset.decimals)} ${q.asset.code} to ${q.requirements.payTo}`);
```

```bash
node quote.mjs
```

Paying takes a payer that signs with your key (a classic account or a `policy_rail`). The full example:
[`packages/ucp-stellar/README.md`](packages/ucp-stellar/README.md).

## Conformance

Two checks, both runnable from this repo (`pnpm install` and `pnpm build` first):

- **Stellar payment handler kit**: 20 checks (profile, requirements, charge, receipt) that a UCP store implements the
  handler. Profile checks, which only read:

  ```bash
  pnpm run ucp:stellar:conformance -- https://agentcommerce.vitrinee.agentpey.com --profile-only
  ```

  The other groups, and the store broken on purpose: [`scripts/ucp-stellar-conformance/`](scripts/ucp-stellar-conformance/README.md).
- **The official UCP conformance suite**, against a local Vitrinee store (needs [`uv`](https://docs.astral.sh/uv/)):

  ```bash
  pnpm run ucp:conformance
  ```

  Last recorded result, 2026-10-05: 49 pass, 8 fail with a stated reason, 20 skipped, of 77.
  Test by test: [`T131.md`](docs/fase-8-agentes-reales/evidencia/T131.md).

## Limitations

- **Testnet only.** Nothing here moves real money.
- So far, purchases happened only on our own test stores.
- MPP payments from a `policy_rail` don't work yet: the official SDK rejects them ([stellar/stellar-mpp-sdk#90](https://github.com/stellar/stellar-mpp-sdk/issues/90)).
- Card subscriptions are design only.
- Disputes are opened and resolved by one fixed arbiter account, by hand; the contract has no way to change it.

## Repo map

| Path | What is there |
|---|---|
| `apps/` | The runnable pieces: `mcp` (the MCP server), `web` (agentpey.com, `/en-vivo`, `/tiendas`), `gateway` (one service that hosts the apps on Render), `agent` (a buying agent), `vitrinee-*` (the seller's side), `realops` and `signaldesk` (a pilot platform and merchant) |
| `packages/` | Libraries: `ucp-stellar` (buyer SDK), `vitrinee-*` (store gateway, receipts, anchoring), `resolve` (disputes), `ap2`, `mandate`, `vault`, `sdk` and `core` (credentials), `wallet-kit` |
| `contracts/` | Soroban contracts: `policy-rail` (spend limits), `receipt-registry`, `agent-resolve` (disputes and refunds), `agent-registry` (credentials) |
| `docs/` | Design, decisions and a log per phase, in Spanish. Start at [`ROADMAP.md`](ROADMAP.md). Facilitator audit: [`docs/partners/auditoria-facilitator.md`](docs/partners/auditoria-facilitator.md) |

Every command from earlier phases (setup, team budget, Vitrinee, UCP purchases): [`docs/README-ANTERIOR.md`](docs/README-ANTERIOR.md).

## History

AgentPey started as **AgentPass** (phase 1): identity credentials for agents, issued and verified against Stellar
testnet. An agent proves who operates it and what it may do; only a hash of the credential is on-chain, in
`agent-registry`, and the operator can revoke it from outside the agent, so the same signed file stops verifying.
Later phases added spend limits (`policy_rail`), a signed Mandate, x402 payments, an evidence vault, stores that join
without writing code (Vitrinee), and the UCP, AP2 and MCP work above. The phase 1 walkthrough (issue, verify, revoke,
verify fails) is in [`docs/README-ANTERIOR.md`](docs/README-ANTERIOR.md); its design is in
[`docs/fase-1-agentpass/`](docs/fase-1-agentpass/CONTEXTO.md).

## License and contact

Apache License 2.0, see [LICENSE](LICENSE). [agentpey.com](https://agentpey.com) · X [@agentpeyai](https://x.com/agentpeyai) · Discord: @vicentewolde
