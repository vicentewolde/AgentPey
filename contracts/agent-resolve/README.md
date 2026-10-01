# `agent-resolve`

AgentResolve's contract (Fase 7, T124): merchants' guarantees in USDC, and
disputes over receipts anchored in Vitrinee's `receipt-registry`, refunded from
those guarantees. Member of this Cargo workspace (soroban-sdk 27); it calls the
deployed `receipt-registry` (its own workspace, soroban-sdk 28) through a
declared interface.

| Function | Who | What |
|---|---|---|
| `deposit(from, merchant, amount)` | `from` | Adds to a merchant's guarantee; anyone may fund it |
| `withdraw(merchant, to, amount)` | the merchant | Takes back what open disputes do not lock |
| `open(receipt, payer, claim_hash, amount)` | the arbiter | Locks `amount` in **the receipt's** merchant's guarantee, within the claim window, never above the receipt |
| `resolve(receipt, verdict_hash, refund)` | the arbiter | Records the verdict hash and pays `refund` (≤ locked) to the payer; once |
| `get`, `guarantee`, `config`, `schema_version` | anyone | Reads |

Decisions: `E-14` to `E-19` in `docs/fase-7-estandar-comercio-agentico/DECISIONES.md`.

```bash
cd contracts && cargo test -p agent-resolve
```

```bash
pnpm run deploy:agent-resolve
```
