# Stellar x402 Payment Handler

* **Handler name:** `com.agentpey.stellar_x402`
* **Version:** `2026-09-30`
* **UCP version:** `2026-04-08`
* **Schema:** [`https://agentpey.com/ucp/handlers/stellar-x402/schema.json`](schema.json)
* **Status:** draft, Stellar testnet only

> Served at `https://agentpey.com/ucp/handlers/stellar-x402/spec`. Reference
> implementation: [AgentPey](https://agentpey.com), whose Vitrinee storefronts
> accept this handler.

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

**Business:** a Stellar account to receive payment (`pay_to`) with a trustline
to the asset, and access to an x402 facilitator for the network.

**Platform:** a payer that holds the asset and can sign a Soroban
authorization entry for it.

No onboarding with a third party is needed. There is no `PaymentIdentity`
beyond the `pay_to` account.

## Handler Declaration

### Business profile (`business_schema`)

```json
{
  "com.agentpey.stellar_x402": [
    {
      "id": "stellar_x402",
      "version": "2026-09-30",
      "spec": "https://agentpey.com/ucp/handlers/stellar-x402/spec",
      "schema": "https://agentpey.com/ucp/handlers/stellar-x402/schema.json",
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
        "pay_to": "G...",
        "facilitator": "https://channels.openzeppelin.com/x402/testnet"
      }
    }
  ]
}
```

`config` follows `#/$defs/business_config` of the schema.

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

The platform **MUST** treat `payment_requirements` as authoritative and
**MUST NOT** sign for any other amount, asset, network or recipient.

## Instrument Acquisition

1. Read `payment_requirements` from the checkout response.
2. Check them against the business profile: `payTo`, `asset` and `network`
   **MUST** equal `config.pay_to`, `config.asset.contract` and
   `config.network` of the handler declared at the business's
   `/.well-known/ucp`. The checkout response alone is not enough, since the
   business writes it.
3. Check them against the buyer's limits. A platform acting under a mandate
   **MUST** refuse before signing if they fall outside it.
4. Build a transaction that invokes `transfer(from = payer, to = payTo,
   amount)` on the asset contract, and sign the Soroban authorization entry
   for `from` (address credentials). The source account may be left for the
   facilitator to set.
5. Wrap it as the credential: the fields of an x402 `PaymentPayload`, with
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
    "accepted": { "scheme": "exact", "network": "stellar:testnet", "asset": "C...", "amount": "368315789", "payTo": "G...", "maxTimeoutSeconds": 300 },
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
4. Returns the checkout as `completed`, with the order.

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
  `pay_to`, asset and network (step 2 of acquisition) and against the buyer's
  limits (step 3). Once signed, the credential cannot be redirected to another
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
