# `purchase-escrow`

One store's agent purchases, held on chain until they ship, then released to
the store or refunded to the buyer by the contract's own deadlines (Fase 9,
T157). One contract per store. Member of this Cargo workspace (soroban-sdk 27).

The payment arrives as a plain token `transfer` from the buyer's `policy_rail`,
settled by the x402 facilitator with `payTo` = this contract. The store then
records the purchase with `hold`. Nothing in `policy_rail` changes: it can only
authorise a `transfer`, and does not check who receives it.

| Function | Who | What |
|---|---|---|
| `hold(order_ref, payer, amount, tx_hash, receipt_hash)` | operator | Records a paid purchase. Refuses a repeated `tx_hash` (one payment, one receipt), a repeated order, and more than has arrived unallocated |
| `mark_shipped(order_ref)` | operator | Starts the release window |
| `release(order_ref)` | anyone | Pays the payee once the release window after shipping has closed |
| `open(order_ref, claim_hash, sig)` | the payer | Opens a dispute and freezes the release, until the release window closes. A rail payer signs the message below (`sig`); a classic account signs the call itself (`sig` = none) |
| `respond(order_ref, response_hash)` | payee | The store's answer, inside the response window |
| `resolve(order_ref, verdict_hash, refund)` | arbiter | Refund to the payer, the rest to the payee. Not while the store may still answer, not after the arbiter's deadline |
| `expire(order_ref)` | anyone | Full refund once the arbiter's deadline (response + resolve windows after `open`) has passed |
| `get`, `by_tx`, `unallocated`, `config`, `open_message`, `schema_version` | anyone | Reads |

`operator` is the store's signing account, whose key the store's server holds.
`payee` is its payout account, the merchant's own wallet. The arbiter is
AgentResolve's. The three windows are fixed at deploy.

Statuses: `Held → Shipped → Released`, or `Held | Shipped → Disputed →
(Responded) → Resolved | Expired`. One dispute per purchase. Each change emits
an event under the `escrow` topic: `held`, `shipped`, `released`, `opened`,
`responded`, `resolved`, `expired`.

## The `open` message

What a rail's owner signs with Ed25519, and what `open_message` returns:

| Bytes | Content |
|---|---|
| 32 | `agentpey/purchase-escrow/open/v1` |
| 32 | this contract's id (the 32 bytes behind its `C…` address) |
| 32 | `claim_hash`: SHA-256 of the compact claim JWS |
| 1–64 | `order_ref`, UTF-8 |

The contract reads the payer's `owner()` and verifies the signature; a bad
signature aborts the call. `escrowOpenMessage` and `signEscrowOpen` in
`@agentpey/resolve` build the same bytes. A shared test vector in both test
suites keeps them in step.

## Known limit

`payer` is what the operator says it is. A stolen operator key plus an absent
arbiter could `hold` with a fake payer and collect through `expire`. The receipt
verifier compares the payer with the settled transaction, and the arbiter's
deadline is the backstop.

Decisions: `X-1` to `X-18` in `docs/fase-9-compra-protegida/DECISIONES.md`.

```bash
cd contracts && cargo test -p purchase-escrow
```

The store's escrow. Its accounts are read from the store's live UCP profile:

```bash
pnpm run deploy:purchase-escrow -- --store agentcommerce --release 600 --response 900 --resolve 3600
```

The rehearsal escrow, with this repo's ADMIN and ISSUER keys as operator and
payee:

```bash
pnpm run deploy:purchase-escrow -- --rehearsal --release 120 --response 120 --resolve 300
```

Two real payments into the rehearsal escrow, one released and one refunded
(0.05 USDC each from the UCP rail; ask before running):

```bash
pnpm run escrow:rehearsal
```
