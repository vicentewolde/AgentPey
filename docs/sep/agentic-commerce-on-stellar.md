# SEP draft: Agentic Commerce on Stellar

Updated Oct 23, 2026 · @vicentewolde

## Preamble

Working draft for pre-SEP discussion. Not yet submitted to `stellar/stellar-protocol`; the SEP number is assigned by the repository maintainers when the pull request is opened.

```text
SEP: To Be Assigned
Title: Agentic Commerce on Stellar
Author: Vicente Wolde (@vicentewolde)
Track: Standard
Status: Draft
Created: 2026-10-03
Updated: 2026-10-23
Version: 0.0.2
Discussion: TBD (GitHub Discussions thread to be opened)
```

## Simple Summary

This SEP defines how an AI agent buys from a merchant and pays on Stellar using commerce standards already adopted outside Stellar: the Universal Commerce Protocol (UCP) for discovery and checkout, AP2 for user-signed mandates, and x402 for the payment itself. It adds the pieces those standards leave open: a UCP payment handler for Stellar assets, a signed and anchored purchase receipt, and a dispute record that any resolver can produce.

## Motivation

- **Agents can find products but cannot pay real merchants on Stellar.** UCP lets third parties define payment handlers, but it defines none for stablecoins or on-chain payments.
- **Without a shared handler, every project invents its own.** Each agent wallet and each merchant gateway would need a custom integration with every other one.
- **On-chain payments have no chargebacks.** A buyer needs proof of purchase that anyone can verify, and a defined way to claim a refund.
- **Stellar already has the rails.** The official documentation recommends x402 and MPP for agentic payments. This SEP connects those rails to the merchant-side standards, so a merchant that speaks UCP can be paid on Stellar.

## Dependencies

- [UCP](https://ucp.dev/2026-04-08/specification/overview/) `2026-04-08`: profile discovery at `/.well-known/ucp`, the checkout and order capabilities, third-party payment handlers and extensions.
- x402 version 2, scheme `exact` on Stellar, with facilitator-based settlement ([Stellar docs](https://developers.stellar.org/docs/build/agentic-payments)).
- [AP2](https://ap2-protocol.org/) `v0.2` open mandates, as SD-JWT.
- SEP-41 token interface, for the asset contract.
- SEP-53, for messages signed by a wallet.

## Abstract

The standard has four parts. Each can be adopted on its own, and the reference implementation uses all four.

1. **Payment handler.** A UCP payment handler that carries a signed x402 `exact` authorization for a Stellar asset inside the UCP checkout. A merchant declares it in its profile; an agent that supports it can pay that merchant.
2. **Receipt.** A purchase receipt signed by the merchant, whose hash is anchored in a Soroban contract. Anyone can check three things without trusting the merchant: the signature, the anchor and the payment.
3. **Mandates.** A mapping from a principal's spend policy to AP2 `v0.2` open mandates, so verifiers outside Stellar can check what the agent was allowed to buy.
4. **Disputes.** A claim, a merchant response and a verdict, each signed or hashed, linked to the receipt and readable from the UCP order. The format does not fix who decides: an AI arbiter, a human or an escrow's resolver can produce the verdict. It does not fix where the refund comes from either: Section 4.3 describes two models, and a reference escrow per purchase.

## Specification 1: the Stellar x402 payment handler

The key words MUST, SHOULD and MAY are to be read as in RFC 2119. In this draft the handler is named `<namespace>.stellar_x402`. UCP requires the `spec` and `schema` URLs of a handler to sit on the domain of its namespace; the reference implementation uses `com.agentpey.stellar_x402` on `agentpey.com`. A neutral namespace is an open question (see Open Questions).

### 1.1 Business configuration

A merchant declares the handler in its UCP profile. Instrument type `stellar_x402`, credential type `x402_payment_payload`.

```json
{
  "id": "stellar_x402",
  "version": "2026-09-30",
  "spec": "https://<namespace-domain>/ucp/handlers/stellar-x402/spec",
  "schema": "https://<namespace-domain>/ucp/handlers/stellar-x402/schema.json",
  "available_instruments": [{ "type": "stellar_x402" }],
  "config": {
    "x402_version": 2,
    "scheme": "exact",
    "network": "stellar:testnet",
    "asset": { "code": "USDC", "contract": "C…", "decimals": 7 },
    "pay_to": "G…",
    "facilitator": "https://…"
  }
}
```

### 1.2 Resolved configuration in the checkout response

When a checkout session is `ready_for_complete`, the handler entry MUST carry the x402 `PaymentRequirements` for that session, unchanged from x402 v2. `amount` is in atomic units of the asset.

```json
{
  "payment_requirements": {
    "scheme": "exact", "network": "stellar:testnet", "asset": "C…",
    "amount": "15684211", "payTo": "G…", "maxTimeoutSeconds": 300,
    "extra": { "paymentFlow": "upfront", "areFeesSponsored": true }
  },
  "fx": { "base": "USD", "quote": "CLP", "rate": "950", "as_of": "2026-10-01T13:20:00.000Z" },
  "binding": { "checkout_id": "cs_…" }
}
```

The session total stays in the merchant's ISO 4217 currency. The amount in the Stellar asset exists only here, with the `fx` rate used to convert it.

### 1.3 Credential sent on `complete`

The platform sends the signed authorization as the instrument's credential. It is the content x402 carries in the `PAYMENT-SIGNATURE` header, without `resource`, which UCP does not have. Inside UCP there is no HTTP 402 round trip: the payment travels in the body of `POST /checkout-sessions/{id}/complete`.

```json
{
  "id": "instr_1", "handler_id": "stellar_x402", "type": "stellar_x402",
  "credential": {
    "type": "x402_payment_payload",
    "x402_version": 2,
    "accepted": { "…": "the session's payment_requirements, unchanged" },
    "payload": { "transaction": "<base64 XDR with the signed Soroban authorization entry>" }
  }
}
```

### 1.4 Platform obligations, before signing

1. The handler's `spec` and `schema` MUST be on the namespace's domain; the platform MUST reject a profile that omits either.
2. The session MUST be `ready_for_complete`, and `binding.checkout_id` MUST be the session the platform opened.
3. `payTo`, `asset` and `network` in the requirements MUST equal `pay_to`, `asset.contract` and `network` in the merchant's profile. The checkout response is written by the merchant; the profile is what it published.
4. The platform MUST check its own spend policy (for example, the mandate in Specification 3) before signing, and SHOULD sign with a spend cap equal to the authorized amount.

### 1.5 Merchant obligations, on `complete`

1. The merchant MUST re-quote; if the total changed, it MUST NOT settle and MUST return the new requirements.
2. `accepted` MUST equal the requirements stored in the session. The merchant MUST settle the stored requirements, never the ones in the credential.
3. The merchant MUST persist the settlement before creating the order.
4. If the facilitator's outcome is ambiguous (timeout, or a failure reported after a transaction was submitted), the merchant MUST NOT settle again. It MUST hold the session as `complete_in_progress` with message `payment_pending` until it reconciles.

| Facilitator result | Session outcome | UCP error |
| --- | --- | --- |
| Success | Order created, `completed` | — |
| Failure, no transaction submitted | Back to `ready_for_complete` | `payment_failed` |
| Timeout, or failure after submission | Held as `complete_in_progress` | `payment_pending` |
| Stock check fails before charging | Not charged | `out_of_stock` |

## Specification 2: signed and anchored receipts

After a successful settlement the merchant MUST issue a receipt, sign it, and anchor its hash on Stellar. Anyone can then verify the purchase without trusting the merchant.

### 2.1 Format

A compact JWS, `alg: EdDSA` (Stellar Ed25519), signed with the merchant's signing key. The signing key SHOULD differ from the account that receives payments.

```json
{ "alg": "EdDSA", "typ": "JWT", "kid": "did:stellar:testnet:G…#key-1" }
```

| Claim | Content |
| --- | --- |
| `typ` | Receipt type and version (reference: `vitrinee-receipt/0.1`; final name open) |
| `orderId` | The issuer's order id |
| `platformOrderId` | The id in the merchant's commerce platform, or `null` if the platform rejected the order after payment |
| `platform` | Free text, e.g. `shopify`, `jumpseller` |
| `merchantDid` | Identifier of the signing key |
| `merchantAccount` | `G…`, the account that received the payment |
| `payerAccount` | `G…`, or `C…` when a contract account paid |
| `network` | `stellar:testnet` or `stellar:pubnet` |
| `asset` | SEP-41 contract of the asset |
| `amountUSDC`, `amountUSDCAtomic` | Decimal and atomic amounts |
| `settlementTxHash` | Hash of the payment transaction, lowercase hex |
| `items[]` | `productId`, `sku`, `name`, `quantity`, unit prices |
| `issuedAt`, `refundWindowEndsAt` | ISO 8601 |

The **receipt hash** is `sha256` of the compact JWS as UTF-8, in lowercase hex.

### 2.2 Anchoring

The registry contract MUST expose:

```text
anchor(hash: BytesN<32>, merchant: Address, amount: i128, order_ref: Bytes)
get(hash: BytesN<32>) -> Option<Record>
```

`anchor` MUST require the signature of `merchant`, MUST reject `amount <= 0`, an empty `order_ref` or one longer than 64 bytes, and MUST reject a hash that is already anchored.

### 2.3 Verification

A receipt is valid only if all three checks pass:

1. **Signature.** The claims match the schema, the `kid` identifies `merchantDid`, and the Ed25519 signature verifies. No network needed.
2. **Anchor.** `get(receipt hash)` exists, with `merchant` equal to the signing account, `amount` equal to `amountUSDCAtomic` and `order_ref` equal to `orderId`.
3. **Payment.** `settlementTxHash` exists on the network, succeeded, and moved exactly `amountUSDCAtomic` of the asset from `payerAccount` to `merchantAccount`. The verifier MUST use the asset it trusts, not the `asset` the receipt claims.

This draft also requires two checks the reference implementation does not yet make: the decimal and atomic amounts MUST describe the same value, and one settlement transaction MUST back at most one receipt.

### 2.4 The receipt in the UCP order

A UCP extension that extends `dev.ucp.shopping.checkout` and `dev.ucp.shopping.order` adds a `receipt` object. A client that does not negotiate the extension does not receive it, and `order.permalink_url` SHOULD point to a public page for the receipt so that client can still reach the proof.

```json
"receipt": {
  "format": "jws",
  "jws": "eyJ…",
  "hash": "fe3c5730…",
  "network": "stellar:testnet",
  "settlement_tx_hash": "06ff47cf…",
  "anchor": { "status": "anchored", "registry": "C…", "tx_hash": "60a26da5…", "ledger": 4967422 },
  "verify_url": "https://…/receipts/<hash>/verify"
}
```

Anchoring MAY be asynchronous: `anchor.status` moves from `pending` to `anchored`, or to `failed` after retries, and the client sees it by reading the order again.

## Specification 3: mandates as AP2 open mandates

A principal's spend policy for an agent SHOULD be exportable as an AP2 `v0.2` pair of open mandates (checkout and payment), so that verifiers outside Stellar can check it. The export does not replace on-chain enforcement: the payer account keeps applying its own limits.

### 3.1 Mapping

| Spend policy on Stellar | AP2 open mandate |
| --- | --- |
| The agent's identity | `cnf.jwk`, the agent's Ed25519 key |
| Per-purchase and per-day limits | `payment.amount_range.max`: the lowest applicable limit, in cents, rounded down |
| Limit currency | `payment.amount_range.currency` |
| Cumulative daily spend | Not exported; enforced by the payer account on-chain |
| Allowed merchant | `checkout.allowed_merchants` and `payment.allowed_payees` |
| Allowed asset | `payment.allowed_payment_instruments`, `type: "stellar_x402"` |
| Product and quantity | `checkout.line_items` |
| Policy expiry | `exp`: the earliest of the purchase intent, the agent credential, the policy, and one hour |
| Policy reference | A vendor claim with the policy id, its hash and its registry contract |

### 3.2 Rules

1. The issuer MUST verify, before exporting, that the agent's credential and the policy are anchored and not revoked, and that the purchase fits both.
2. The issuer MUST emit one pair per purchase. AP2 requires the open checkout mandate to name the products, and the payment mandate to reference it.
3. `payment.reference.conditional_transaction_id` MUST be the `sd_hash` of the checkout token: `base64url(sha256(token))`, disclosures included.
4. Amounts MUST be expressed in cents and rounded down, so an export never allows more than the policy. A 3.00 USDC limit is `300`, never `30000000`.
5. Mandates SHOULD be signed with Ed25519, so one Stellar key serves both the chain and AP2. The reference export also verifies with the official AP2 library using P-256.

### 3.3 Not covered

Negotiating AP2 inside the UCP checkout and closed mandates signed by the agent at purchase time are out of scope for this version. In UCP `2026-08-25` the AP2 extension was renamed `dev.ucp.common.payment.ap2_mandate`; a later version of this SEP should target it.

## Specification 4: dispute records

A payer MAY open a claim against a receipt. This section fixes the formats and the on-chain record, not who decides: any resolver that produces a verdict in this format is compliant.

### 4.1 The three documents

1. **Claim.** A JWS signed by the payer, or by the owner key when the payer is a contract account. It carries the whole receipt, a reason (`not_delivered`, `not_as_described`, `damaged`, `unauthorized`, `other`), a description, up to five evidence items and the amount requested. `claim_hash` is its `sha256`.
2. **Merchant response.** A position (`accept_full`, `accept_partial` with an amount, or `contest`), a statement and up to five evidence items. The merchant signs, with SEP-53 from the `merchantAccount` in the receipt, a message that contains the `sha256` of the response's canonical JSON. The response MUST name the `claim_hash` it answers.
3. **Verdict.** An outcome (`refund_full`, `refund_partial`, `rejected`), the refund amount, the reasoning, and the hash of the merchant response (or `null` if none arrived). `verdict_hash` is the `sha256` of its canonical JSON, so the anchored hash also covers the response.

### 4.2 On-chain record

The dispute contract MUST expose `get(receipt_hash)` returning the status (`open` or `resolved`), `claim_hash`, asset, disputed amount, `opened_at`, and, once resolved, `verdict_hash`, refund amount and `resolved_at`. It MUST enforce:

| Rule | Why |
| --- | --- |
| The receipt is anchored in the receipt registry | No claims on unknown purchases |
| The claim opens within the refund window, counted from the anchor | Bounded liability for the merchant |
| The disputed amount does not exceed the anchored receipt amount, read from the registry | The caller cannot inflate it |
| One dispute per receipt | No repeated claims |
| The refund does not exceed the disputed amount, and a dispute resolves once | Bounded payout |
| Only an authorized resolver may resolve | The verdict has an accountable author. Who may open depends on the refund model (4.3) |

The rules above describe a dispute record anchored to a receipt registry. A deployment that holds the payment in an escrow enforces the rules of 4.3.1 instead, and MUST still expose the same fields through a read function.

### 4.3 Where the refund comes from

Two models are compliant. A deployment declares which one it uses.

| Model | How it works | Gains | Costs |
| --- | --- | --- | --- |
| **Merchant guarantee** (reference implementation) | The merchant deposits a guarantee; the disputed amount is locked when a claim opens and refunds come from it | The payment flow is unchanged | The merchant locks capital, and can withdraw unlocked funds before a claim arrives |
| **Escrow per purchase** (reference implementation: `purchase-escrow`, one contract per merchant) | The x402 `payTo` is the escrow contract. The merchant registers each payment with `hold`; the payment is released to the merchant after shipping and a release window, or refunded by a verdict | The buyer's money is not in the merchant's hands before delivery; deadlines run on the ledger; one payment binds to one receipt | `payTo` is a contract, so the facilitator must settle transfers to contract addresses; the merchant must register every payment; a merchant that never ships leaves the payment held until the buyer claims |

The resolver can be an AI arbiter whose verdict a person confirms (the reference implementation), a human arbiter, or an escrow's dispute resolver.

**Why a purpose-built escrow.** In October 2026 we evaluated a general-purpose escrow service, [Trustless Work](https://docs.trustlesswork.com/trustless-work/introduction/technology-overview.md), against its public documentation and contracts, and reached out to its team. It did not fit an agent purchase: a buyer that is a contract account limited to a single transfer call cannot make the funding call its escrow requires, and its contract has no deadlines for the merchant or the resolver. It may suit milestone payments between businesses. That is why the reference implementation is an escrow built for agent purchases, and why 4.3.1 fixes the minimum behavior that any other escrow has to meet.

#### 4.3.1 Escrow per purchase: minimum behavior

An escrow that declares this model MUST:

1. **Bind one payment to one purchase.** `hold(order, payer, amount, tx_hash, receipt_hash)` rejects a repeated `tx_hash`, a repeated order, and an amount larger than the contract's unallocated balance. Reading by `tx_hash` returns the purchase, its payer, amount and `receipt_hash`.
2. **Follow these states.** Held, then Shipped, then Released; or Held or Shipped, then Disputed, then Responded, then Resolved or Expired. A purchase admits one dispute.
3. **Let the payer open the claim.** The claim is authorized by the payer's own signature: when the payer is a contract account, an Ed25519 signature by its owner key over a short message with a fixed domain, the escrow address, the order and the `claim_hash`; a payer with a classic account signs the call. The claim is valid until the release window closes, and it freezes the release.
4. **Enforce the deadlines.** The merchant's response, signed from its payout account, is rejected on-chain after the response window. The arbiter cannot resolve before the response window closes unless the merchant has responded. If the arbiter has not resolved within the response and resolve windows, anyone may call `expire`, which refunds the payer in full.
5. **Never block the outcome on a refund that cannot be delivered.** A refund that cannot be paid (for example, a missing trustline) becomes a debt the payer can collect later, and a merchant that cannot receive does not prevent `expire`.
6. **Be named in the receipt.** The receipt carries the escrow address, and a verifier checks that the contract was credited and that the escrow holds the same purchase, payer, amount and `receipt_hash` for that payment.

A buyer agent SHOULD check, before signing, that the `payTo` in the x402 requirement is the escrow the merchant declared and that the contract runs known code (the reference implementation pins the wasm hash).

### 4.4 The dispute in the UCP order

The order SHOULD show the dispute in two forms, read from the contract: a native UCP adjustment of type `dispute` that any client understands, and a `receipt.dispute` object with the fields of 4.2 for checking against the network. An open dispute is `pending`; a refund appears as a negative total in the order's currency, while the exact amount in the asset stays in `receipt.dispute`.

## Design Rationale

- **Compose, do not invent.** UCP, AP2 and x402 already have the merchants, wallets and libraries. A Stellar-only commerce protocol would ask every merchant for one more integration. This SEP only fills the places those standards leave to third parties.
- **x402 as a credential format inside UCP, not as an HTTP flow.** UCP has no 402 status. Reusing the x402 `exact` payload and facilitator keeps the existing Stellar tooling, while the payment travels where UCP expects it: in `complete`.
- **Merchant currency in the session, Stellar asset in the handler.** Merchants price in their own ISO 4217 currency, and UCP assumes one. Keeping the asset amount and its exchange rate inside the handler leaves the session readable to any UCP client.
- **A receipt anchored on-chain.** UCP orders have no field for proof of payment. An anchored, signed receipt lets a buyer, a resolver or an auditor check a purchase without trusting the merchant's server.
- **Disputes defined by format, not by resolver.** Escrows with dispute roles already exist on Stellar, and the reference implementation is one more. Fixing the claim, response and verdict formats lets any of them, or an AI arbiter, plug in without changing the order or the receipt, as long as an escrow that holds the payment meets the minimum behavior of 4.3.1.
- **Ed25519 throughout.** One Stellar key can sign the authorization, the receipt and the AP2 mandates, with no second key type to manage.

## Security Concerns

Each item is a real limit found while building the reference implementation, not a hypothetical.

| Concern | Effect today | Possible fix in this SEP |
| --- | --- | --- |
| The binding to the checkout is logical, not cryptographic | The Soroban authorization signs payee, asset, amount, nonce and expiry, but not the session id; two sessions with the same merchant and amount are interchangeable, although each credential settles once | Bind the authorization to the session, for example through a memo or a nonce derived from `checkout_id` |
| Ambiguous settlement result | Neither UCP nor x402 says what to do when the facilitator times out after submitting; the reference implementation holds the order and reconciles by hand | Define how to query the facilitator and close the session |
| Revoking a mandate does not stop the payer account | The contract account enforces per-purchase and per-day limits, but does not read the mandate registry or pin the payee | Let the account check the mandate status, or pin allowed payees, at the cost of one more read per payment |
| A merchant can drain its guarantee before a claim | Guarantee model only: only funds locked by an open dispute are protected. In the escrow model the payment is not in the merchant's hands before release | Require notice before withdrawals, or use the escrow model |
| The resolver is a single point of trust | Guarantee model: the registry does not record the payer, so the resolver names the refund recipient, and an open dispute never expires if the resolver disappears. Escrow model: the payer is stored at `hold`, and a missed deadline refunds in full through `expire`; the arbiter remains trusted for any amount between zero and the payment | Guarantee model: store the payer in the receipt registry and add a dispute timeout. Escrow model: the reference escrow already does both |
| An AI verdict is not deterministic | Asking again may produce a different verdict | Archive every verdict and publish how many attempts count; require human confirmation before funds move |
| Claims and responses are untrusted input to an AI arbiter | Prompt injection could try to steer the verdict | Treat both as data, cap the refund in code and again in the contract |
| Asset amounts have no ISO 4217 code | AP2 reads minor units as cents; 3.00 USDC written in Stellar units would read as 300,000 | Fix the unit for Stellar assets in AP2 exports |
| A payment can arrive without `hold` | The payment sits unallocated: the buyer cannot claim it and only the escrow operator can assign it | Issue the receipt only after `hold`, as the reference implementation does |
| A merchant that never ships | The payment stays held until the buyer claims `not_delivered`; nothing releases or refunds it automatically | A shipping deadline after which the buyer can reclaim without a claim (not in the reference implementation yet) |
| A refund that cannot be delivered (no trustline, unauthorized balance) | The refund becomes a debt collectible later; the dispute still closes | Check the buyer's trustline before accepting the payment |

## Open Questions

- [ ] **Neutral namespace.** UCP ties a handler's name to the domain that hosts its spec. Should the handler live on a neutral domain (for example one SDF hosts), instead of `com.agentpey.*`?
- [ ] **One SEP or several.** Should the handler, the receipt and the disputes be three separate SEPs, so each can be adopted and versioned alone?
- [ ] **Signer identifier.** Keep `did:stellar:…` in the receipt's `kid`, or use a plain `G…` account, since no SEP defines a Stellar DID method?
- [ ] **MPP.** Should the handler also accept an MPP charge credential, or should MPP be a second handler?
- [ ] **Receipt type name.** Replace the reference `vitrinee-receipt/0.1` with a neutral name.
- [ ] **UCP version.** Target `2026-08-25`, where the AP2 extension was renamed, before moving out of Draft.
- [ ] **Default refund model.** The reference implementation now offers both. Should the SEP recommend the escrow per purchase as the default for agent purchases, and keep the merchant guarantee for merchants whose x402 payee cannot be a contract?
- [ ] **Contract payees.** The reference escrow depends on the facilitator settling a transfer to a contract address. The OpenZeppelin facilitator on testnet does. Should the handler require facilitators to declare that they support it?
- [ ] **Known code.** A buyer agent should only pay an escrow that runs known code. Who publishes the accepted wasm hashes, and how does an agent learn them?

## Reference Implementation

AgentPey ([vicentewolde/AgentPey](https://github.com/vicentewolde/AgentPey)) implements all four parts, and the escrow of 4.3.1, on Stellar testnet. The claim from a chat, the merchant response page and the shipping events are still being connected. On 1 October 2026 an agent bought a product from a Shopify test store through UCP, paid 1.5684211 USDC from a contract account, and received a receipt that passed all three checks. A second payment over the per-purchase limit was rejected by the contract (`PerTxExceeded`).

| Contract (testnet) | Id | Role |
| --- | --- | --- |
| `agent-registry` | `CARC2SIQ3GTL34LVHSTGFRKDNNBYUXCSMGAUGKWGMT6Z2SDY6FXPP2DT` | Anchors and revokes credentials and mandates |
| `policy_rail` (UCP) | `CA6P4KKV77Q5J4AH6L4V7S42QNF6DLKUAM4SCOQO4GMLB7V7STC5VIYP` | Payer account with per-purchase and per-day limits |
| `receipt-registry` | `CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5` | Anchors receipt hashes |
| `agent-resolve` | `CCYMGX56FJ65EVXUY2M4BTVBCCOBXBTAMGSCWN5X4TQLQTCCEAHDCD3F` | Merchant guarantees and dispute records |
| `purchase-escrow` | `CBQFELK556ECU5KD2WVFYEXWNCDD7KEDYIFNFVUNR77LNOFQ7CVDO27A` | One store's escrow: holds each payment until release, and refunds by verdict or by `expire`. Wasm sha256 `f5c6bbb6a54a017b71efd62e1aa87bd9b1babf5a688c74e253100586d6602fc5`; windows of 10, 15 and 60 minutes (a test configuration; the default release window is 7 days) |

| Item | Value |
| --- | --- |
| Payment transaction | `06ff47cf38a4c1f8f22a9d4095c3cfb34b5d6ffd9c5914cb248fa299e2210ea6` |
| Anchored receipt hash | `fe3c5730884a59a72760217ae192757b7bb376bb1467f1e2d2ea7a6047c0f076` |
| Handler spec | [agentpey.com/ucp/handlers/stellar-x402/spec](https://agentpey.com/ucp/handlers/stellar-x402/spec) |
| Facilitator | Built on Stellar (OpenZeppelin Channels), testnet |
| Payment held in the escrow, from a real store checkout (payment, then `hold`) | `ed11e866b57004827165f3d7b8fd204f8f9df0cb12314c2894bd8ba970a0b754`, `6ae292d4870d869446cb0bc9e88321e326662037043d0dd7362998222e1ef09f` |
| Claim opened by the payer in the escrow | `ad7cbf28bb1a0b5e8a0d13c43027230a8c30d91e3d393f8baa6491361a864540` |
| Verdict `refund_full` paid from the held payment | `65f5f8910b549a147e438983ed16c75d35e7c0a98ea5d4d1e83f8e39fa911816` |
| Payment released to the merchant (test escrow `CCTVYTWFGOBD23UF7A2AX6CMCKF7ACHENU6YNFJPG6S3O5P3FBKCYLDO`) | `61ab66405bd359d49ef1394e428de2407aaf373e0fe2ee95e938f19ddcfb3662` |
| A second receipt for the same payment, rejected by the network (same test escrow; the transaction failed) | `87a80cc144eb35a12b5112fa1be01afd24d38d27ab3e5b8e0af5f0beb142b102` |

## Changelog

| Date | Version | Change |
| --- | --- | --- |
| 2026-10-23 | v0.0.2 | Escrow per purchase described as a model with minimum behavior (4.3.1) and a reference implementation; the rules of 4.2 split by model; security table updated; Trustless Work evaluated and kept as a design reference |
| 2026-10-03 | v0.0.1 | First working draft for pre-SEP discussion |

## Sources

- [UCP specification overview, `2026-04-08`](https://ucp.dev/2026-04-08/specification/overview/)
- [AP2](https://ap2-protocol.org/)
- [Agentic payments on Stellar (x402 and MPP)](https://developers.stellar.org/docs/build/agentic-payments)
- [SEP process](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/README.md)
- [Trustless Work escrow design](https://docs.trustlesswork.com/trustless-work/introduction/technology-overview.md)
