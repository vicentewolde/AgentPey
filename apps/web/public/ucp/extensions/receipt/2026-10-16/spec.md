# Anchored Receipt Extension

* **Extension name:** `com.agentpey.shopping.receipt`
* **Version:** `2026-10-16`
* **Extends:** `dev.ucp.shopping.checkout`, `dev.ucp.shopping.order`
* **Schema:** [`https://agentpey.com/ucp/extensions/receipt/2026-10-16/schema.json`](schema.json)
* **Status:** draft, Stellar testnet only
* **Previous version:** [`2026-09-30`](https://agentpey.com/ucp/extensions/receipt/spec), still valid for stores paid directly

> Served at `https://agentpey.com/ucp/extensions/receipt/2026-10-16/spec`.

## What changed from `2026-09-30`

A store that charges into a `purchase-escrow` (handler `com.agentpey.stellar_x402` version `2026-10-15`) declares
this version, and its orders carry `receipt.escrow`: where the payment stands in that contract. Everything else is
unchanged. A store paid directly keeps declaring `2026-09-30`.

## Purpose

A UCP order says what was bought; it carries no proof that it was paid or
what the business committed to. This extension adds a `receipt` object to a
completed checkout and to the order: a receipt signed by the business, whose
hash is anchored in a contract on Stellar, and that anyone can verify without
trusting the business.

## Declaration

```json
{
  "com.agentpey.shopping.receipt": [
    {
      "version": "2026-10-16",
      "spec": "https://agentpey.com/ucp/extensions/receipt/2026-10-16/spec",
      "schema": "https://agentpey.com/ucp/extensions/receipt/2026-10-16/schema.json",
      "extends": ["dev.ucp.shopping.checkout", "dev.ucp.shopping.order"]
    }
  ]
}
```

## Shape

```json
"receipt": {
  "format": "jws",
  "jws": "eyJhbGciOiJFZERTQSIs...",
  "hash": "9f2c...",
  "network": "stellar:testnet",
  "settlement_tx_hash": "4a1b...",
  "anchor": { "status": "anchored", "registry": "C...", "tx_hash": "7c3d...", "ledger": 4900001 },
  "verify_url": "https://shop.example/receipts/9f2c.../verify"
}
```

* `jws`: compact JWS, `alg` `EdDSA`, signed by the business's signing key. Its
  `kid` is a `did:stellar` whose key is also published in the business
  profile: in `keys` (UCP 2026-08-25), and in `signing_keys`, mirrored in
  `keys`, in the 2026-04-08 profile.
* `hash`: sha256 of the compact JWS. This is the value anchored.
* `anchor.status`: `pending` right after completion (anchoring is
  asynchronous); `anchored` once the registry holds it. Read the order again to
  see it change.

## Verification

A receipt is valid when all three hold:

1. **Signature and content:** the JWS verifies against the key in its `kid`,
   and its payload does not contradict itself. The payload states every amount
   twice, as a decimal string for people and in the asset's atomic units, and
   only the atomic ones are compared against the chain in checks 2 and 3. So,
   in the payload's own claim names:
   * `amountUSDC` **MUST** be the same amount as `amountUSDCAtomic`;
   * each item's `unitPriceUSDC` **MUST** be the same amount as its
     `unitPriceUSDCAtomic`;
   * `asset` **MUST** be the asset contract the verifier trusts for the
     receipt's `network`. Today that is one contract, Circle's USDC on Stellar
     testnet, the same one the Stellar x402 handler declares in its `config`;
   * the items **MUST** add up to the total: the sum, over `items`, of
     `unitPriceUSDCAtomic` times `quantity` is `amountUSDCAtomic`. A checkout
     of several line items has one item per line, and nothing else (no
     shipping, no fee) is in the total.

   A business **MUST NOT** sign a receipt that fails this, and a verifier
   **MUST** reject one.
2. **Anchor:** the registry contract holds `hash`, recorded by that same key,
   for the receipt's amount and order reference.
3. **Settlement:** `settlement_tx_hash` is a successful Stellar transaction
   that moved exactly the receipt's amount from the payer to the business.

`verify_url` runs the three checks at the business, but a platform **SHOULD**
be able to run them itself against the network.

A business **MUST NOT** issue two receipts over one settlement transaction.
The registry does not enforce this yet: it keys a record by receipt hash and
does not store the transaction hash, so a verifier holding a single receipt
cannot tell.

## Disputes

On an **order**, `receipt.dispute` appears when the payer has opened a refund
claim over this receipt in AgentPey's AgentResolve contract. It holds only what
that contract stores: `status` (`open` or `resolved`), `claim_hash`,
`amount_atomic` locked while open, `opened_at`, and once resolved
`verdict_hash`, `refund_atomic` (`0` when the claim was rejected) and
`resolved_at`. Amounts are strings of the receipt asset's atomic units.

The order also carries the same event as a native UCP adjustment, so a platform
that does not know this extension still sees it: `type` `dispute`, `status`
`pending` while open and `completed` once resolved, and when money came back a
negative `total` in the order's currency (the share of the order total that the
refund represents, rounded down).

To check it, call `get(receipt)` on `contract` with `hash` as the key; every
field must match. The verdict's reasoning is not published here.

The field is optional and additive: version `2026-09-30` of this extension
is unchanged for checkouts and for orders without a dispute.

## Escrow

On an **order** paid into the store's `purchase-escrow`, `receipt.escrow` holds the purchase as that contract
stores it, read from the chain on each request:

* `status`: `held` (paid and recorded), `shipped` (the release window is running), `released` (paid to the store),
  `disputed` (a claim is open: the release is frozen), `responded` (the store answered), `resolved` (the arbiter
  decided) or `expired` (the arbiter did not decide in time, and the payer got everything back).
* `amount_atomic`, `held_at`, and as they happen `shipped_at`, `release_after`, `claim_hash`, `opened_at`,
  `respond_by`, `resolve_by`, `response_hash`, `verdict_hash` and `closed_at`.
* `refund_atomic` (paid back to the payer) and `refund_owed_atomic` (part of it the payer could not receive yet;
  the contract's `claim_refund` delivers it).

A dispute in the escrow is also a native UCP adjustment, as above: `pending` while open, `completed` once resolved
or expired, with the refunded share of the order total.

To check it, call `get(order id)` on `contract`; every field must match. If the chain cannot be read, the order still
answers, without `receipt.escrow`, and says so in a `warning` message (`escrow_state_unavailable`).

