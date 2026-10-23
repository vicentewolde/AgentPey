# Stellar x402 Payment Handler

* **Handler name:** `com.agentpey.stellar_x402`
* **Version:** `2026-10-15`
* **UCP version:** `2026-04-08`
* **Schema:** [`https://agentpey.com/ucp/handlers/stellar-x402/2026-10-15/schema.json`](schema.json)
* **Status:** draft, Stellar testnet only
* **Previous version:** [`2026-09-30`](https://agentpey.com/ucp/handlers/stellar-x402/spec), still valid for businesses paid directly

> Served at `https://agentpey.com/ucp/handlers/stellar-x402/2026-10-15/spec`.
> Reference implementation: [AgentPey](https://agentpey.com), whose Vitrinee
> storefronts accept this handler.

## What changed from `2026-09-30`

A business may hold each payment in a **purchase-escrow** contract until the
order ships and a release window closes. It declares this version, sets
`pay_to` to the escrow contract and adds an `escrow` block saying whose escrow
it is. The payment is the same x402 `exact` transfer; only the recipient is a
contract (`C...`). A business paid directly keeps declaring `2026-09-30`,
unchanged. A business **MUST NOT** declare an escrow under `2026-09-30`.

## Introduction

This handler lets a UCP platform (an AI agent) pay a UCP business with an
[x402](https://x402.org) `exact` payment on Stellar: a transfer of a SEP-41
token (USDC) authorized by the payer's signed Soroban authorization entry and
settled by an x402 facilitator.

It reuses x402's payment payload as the UCP payment credential. It does not
use HTTP 402: the payload travels in the body of Complete Checkout.

### Scope

* Networks: `stellar:testnet` only in this version.
* Scheme: `exact`, one transfer per checkout.
* Payer: any Stellar account (`G...`) or contract account (`C...`) that can
  authorize a SEP-41 `transfer`, including smart accounts that enforce their
  own spending limits in `__check_auth`.

## Participants

| Participant | Role |
| :---------- | :--- |
| **Business** | Advertises the handler, returns the payment requirements of each checkout, settles the credential through its facilitator and creates the order. |
| **Platform** | Discovers the handler, signs the authorization for the exact requirements, submits the credential on Complete Checkout. |
| **Facilitator** | An x402 facilitator chosen by the business. Rebuilds the transaction, may sponsor its fee, submits it to Stellar and reports the result. The platform never talks to it. |

## Prerequisites

**Business:** a payout account with a trustline to the asset; a
`purchase-escrow` contract deployed for it alone, whose `operator` is the key
that records purchases and whose `payee` is the payout account; and access to
an x402 facilitator for the network.

**Platform:** a payer that holds the asset and can sign a Soroban
authorization entry for it.

No onboarding with a third party is needed. There is no `PaymentIdentity`
beyond the `pay_to` escrow and its `payee`.

## Handler Declaration

### Business profile (`business_schema`)

```json
{
  "com.agentpey.stellar_x402": [
    {
      "id": "stellar_x402",
      "version": "2026-10-15",
      "spec": "https://agentpey.com/ucp/handlers/stellar-x402/2026-10-15/spec",
      "schema": "https://agentpey.com/ucp/handlers/stellar-x402/2026-10-15/schema.json",
      "available_instruments": [{ "type": "stellar_x402" }],
      "config": {
        "x402_version": 2,
        "scheme": "exact",
        "network": "stellar:testnet",
        "asset": {
          "code": "USDC",
          "contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "decimals": 7
        },
        "pay_to": "C...",
        "facilitator": "https://channels.openzeppelin.com/x402/testnet",
        "escrow": {
          "contract": "C...",
          "payee": "G...",
          "arbiter": "G...",
          "release_window_seconds": 604800,
          "response_window_seconds": 172800,
          "resolve_window_seconds": 259200
        }
      }
    }
  ]
}
```

`config` follows `#/$defs/business_config` of the schema. `pay_to` **MUST**
equal `escrow.contract`. The `escrow` block is what the contract's own
`config()` returns: `payee` is the business's payout account (a release pays
it), `arbiter` settles disputes, and the three windows are the contract's.

### Platform profile (`platform_schema`)

`config` follows `#/$defs/platform_config`: the x402 version and the networks
the platform can pay on.

### Checkout response (`response_schema`)

When a checkout is ready to pay, the business returns the handler with
`config` following `#/$defs/response_config`: the business config plus

* `payment_requirements`: the x402 `PaymentRequirements` of this checkout.
  `amount` is in the asset's atomic units and is the only amount the platform
  may authorize.
* `fx`: when the checkout's `currency` is not the asset (for example a
  business pricing in CLP and settling in USDC), the rate used to compute
  `amount`.
* `binding.checkout_id`: the checkout this credential is for.

`pay_to` is the business config's, so it is the escrow contract here too.
(Corrected on 2026-10-23: the schema's `response_config` still asked for a
`G...` account there, which no checkout of a store with an escrow could meet. The
text above and the checkouts already said the escrow.)

The platform **MUST** treat `payment_requirements` as authoritative and
**MUST NOT** sign for any other amount, asset, network or recipient.

## Instrument Acquisition

1. Read `payment_requirements` from the checkout response.
2. Check them against the business profile: `payTo`, `asset` and `network`
   **MUST** equal `config.pay_to`, `config.asset.contract` and
   `config.network` of the handler declared at the business's
   `/.well-known/ucp`. The checkout response alone is not enough, since the
   business writes it.
3. Check the escrow on chain before signing. The platform **MUST** read the
   `escrow.contract` instance and refuse unless:
   * it runs `purchase-escrow` code the platform knows (the SHA-256 of its
     wasm; AgentPey's is `f5c6bbb6a54a017b71efd62e1aa87bd9b1babf5a688c74e253100586d6602fc5`);
   * its `config()` says the same `payee`, `arbiter` and windows as the
     declaration, and its token is `asset.contract`;
   * its `payee` is the account the platform already knows the business by,
     and its `arbiter` is one the platform accepts;
   * its `operator` is the key the business signs its receipts with (the
     `did:stellar` key in its profile), so the purchase it records is the
     receipt's.

   A contract that merely imitates the interface could forward the payment
   anywhere; a declared escrow that does not hold together is not an escrow.
4. Check them against the buyer's limits. A platform acting under a mandate
   **MUST** refuse before signing if they fall outside it.
5. Build a transaction that invokes `transfer(from = payer, to = payTo,
   amount)` on the asset contract, and sign the Soroban authorization entry
   for `from` (address credentials). The source account may be left for the
   facilitator to set.
6. Wrap it as the credential: the fields of an x402 `PaymentPayload`, with
   the version spelled the UCP way: `{type: "x402_payment_payload",
   x402_version: 2, accepted: <payment_requirements>, payload: {transaction:
   <base64 XDR>}}`. x402's `resource` is omitted: UCP has no resource URL.

The instrument submitted on Complete Checkout follows `#/$defs/instrument`:

```json
{
  "id": "instr_1",
  "handler_id": "stellar_x402",
  "type": "stellar_x402",
  "selected": true,
  "credential": {
    "type": "x402_payment_payload",
    "x402_version": 2,
    "accepted": { "scheme": "exact", "network": "stellar:testnet", "asset": "C...", "amount": "368315789", "payTo": "C... (the escrow)", "maxTimeoutSeconds": 300 },
    "payload": { "transaction": "AAAA..." }
  },
  "display": { "payer": "C..." }
}
```

### Binding

The signed authorization binds the credential to the recipient, the asset and
the amount, and carries a nonce and an expiration ledger: it cannot be settled
at another business, for another amount, or twice. It does **not** sign the
checkout id. A business **MUST** reject a credential whose `accepted` differs
from the `payment_requirements` it returned for that checkout, and **MUST**
settle a given credential at most once.

## Processing

On Complete Checkout the business:

1. Checks that `accepted` equals the checkout's `payment_requirements`.
2. Submits the payload to its facilitator's `settle`. The payment is final
   when the facilitator reports a successful Stellar transaction.
3. Creates the order only after settlement succeeds.
4. Records the purchase in its escrow with `hold(order_ref, payer, amount,
   tx_hash, receipt_hash)`, signed by the escrow's `operator`, retrying until
   it lands. The escrow refuses a `tx_hash` it already holds (one payment, one
   receipt) and an amount above what it holds unassigned.
5. Returns the checkout as `completed`, with the order.

After paying, a platform **SHOULD** read the escrow's `by_tx(tx_hash)` and
tell the buyer if the purchase is not recorded, or is recorded for another
order, amount, receipt or payer: a payment the business never holds is
unassigned, and one held under another payer cannot be claimed or refunded to
the buyer. The contract does not check `payer`; the platform does.

### The escrow's life

`Held → Shipped → Released`, or `Held|Shipped → Disputed → (Responded) →
Resolved|Expired`. The business marks the order shipped (`mark_shipped`);
anyone may `release` once the release window has closed with no dispute. The
buyer may `open` a dispute until then, signed by the payer (for a
`policy_rail`, by its owner's key over a fixed message). The `payee` answers
within the response window; the `arbiter` resolves with a refund to the payer;
past both windows anyone may `expire` it, refunding the payer in full.

Settlement happens before the order exists, so a failed order creation after a
successful payment is the business's to resolve; it **MUST NOT** ask the
platform to pay again.

### Error mapping

| Condition | UCP error code | Severity |
| :-------- | :------------- | :------- |
| `accepted` does not match the checkout | `payment_failed` | `recoverable` |
| Payer lacks funds or trustline | `payment_failed` | `requires_buyer_input` |
| Payer's own policy refused the transfer (for example a smart-account limit) | `payment_failed` | `requires_buyer_review` |
| Authorization expired | `payment_failed` | `recoverable` |
| Facilitator or network unavailable | `payment_failed` | `recoverable` |

## Security Considerations

* The business writes `payment_requirements`, so the credential protects the
  payer only as far as the platform checks them: against the profile's
  `pay_to`, asset and network (step 2 of acquisition), against the escrow on
  chain (step 3) and against the buyer's limits (step 4).
* The escrow protects the buyer only if it is the code the platform knows:
  checking the wasm hash is what makes "held" mean the contract's rules apply. Once signed, the credential cannot be redirected to another
  recipient, raised, or settled twice.
* A payer with on-chain limits (for example a smart account enforcing a
  per-transaction and per-day cap in `__check_auth`) is protected even from a
  platform that ignores step 3 of acquisition.
* The facilitator sees the payload, not the buyer's personal data. Businesses
  **SHOULD NOT** send shipping or contact data to it.

## References

* UCP Payment Handler Guide, `2026-04-08`
* x402 protocol, version 2; `exact` scheme on Stellar (`@x402/stellar`)
* SEP-41 token interface
