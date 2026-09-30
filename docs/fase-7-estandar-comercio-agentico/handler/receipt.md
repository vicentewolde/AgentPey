# Anchored Receipt Extension

* **Extension name:** `com.agentpey.shopping.receipt`
* **Version:** `2026-09-30`
* **Extends:** `dev.ucp.shopping.checkout`, `dev.ucp.shopping.order`
* **Schema:** `https://agentpey.com/ucp/extensions/receipt/schema.json`
  ([source](receipt.schema.json))
* **Status:** draft, Stellar testnet only

> Written in English on purpose: it is the public specification that will be
> served at `https://agentpey.com/ucp/extensions/receipt/spec`.

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
