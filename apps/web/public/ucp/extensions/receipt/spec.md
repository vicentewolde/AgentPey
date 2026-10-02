# Anchored Receipt Extension

* **Extension name:** `com.agentpey.shopping.receipt`
* **Version:** `2026-09-30`
* **Extends:** `dev.ucp.shopping.checkout`, `dev.ucp.shopping.order`
* **Schema:** [`https://agentpey.com/ucp/extensions/receipt/schema.json`](schema.json)
* **Status:** draft, Stellar testnet only

> Served at `https://agentpey.com/ucp/extensions/receipt/spec`.

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
      "version": "2026-09-30",
      "spec": "https://agentpey.com/ucp/extensions/receipt/spec",
      "schema": "https://agentpey.com/ucp/extensions/receipt/schema.json",
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
  profile's `signing_keys`.
* `hash`: sha256 of the compact JWS. This is the value anchored.
* `anchor.status`: `pending` right after completion (anchoring is
  asynchronous); `anchored` once the registry holds it. Read the order again to
  see it change.

## Verification

A receipt is valid when all three hold:

1. **Signature:** the JWS verifies against the key in its `kid`.
2. **Anchor:** the registry contract holds `hash`, recorded by that same key,
   for the receipt's amount and order reference.
3. **Settlement:** `settlement_tx_hash` is a successful Stellar transaction
   that moved exactly the receipt's amount from the payer to the business.

`verify_url` runs the three checks at the business, but a platform **SHOULD**
be able to run them itself against the network.

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
