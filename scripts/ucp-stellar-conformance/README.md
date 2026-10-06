# Stellar x402 payment handler conformance kit

Checks that a UCP store declaring `com.agentpey.stellar_x402` implements the
[handler spec](https://agentpey.com/ucp/handlers/stellar-x402/spec), one check
at a time, with a verdict and the reason. Stellar testnet only.

## Run it

Profile checks only. The store only sees GETs; P6 also simulates a balance
read on Stellar's RPC:

```bash
pnpm run ucp:stellar:conformance -- https://agentcommerce.vitrinee.agentpey.com --profile-only
```

Profile and requirement checks. This opens a checkout and sends one Complete
Checkout with a junk transaction, which a conforming store refuses. It moves no
money:

```bash
pnpm run ucp:stellar:conformance -- https://agentcommerce.vitrinee.agentpey.com --product 67624104591666
```

Everything, including a real payment on testnet. The key is yours, given in
`UCP_STELLAR_CONFORMANCE_SECRET`. It is either a classic account holding the
asset, or the owner of a `policy_rail` (with `--rail`). The run signs **one**
payment authorization, valid for two minutes at most. It sends that same
authorization to the signed probe (C1), to the payment (C2) and to the replay
(C3), so it settles once at most, whatever the store does. The most the run
can cost is one payment of up to `--max-amount`, in `--asset` (USDC on testnet
by default):

```bash
UCP_STELLAR_CONFORMANCE_SECRET=S... pnpm run ucp:stellar:conformance -- https://agentcommerce.vitrinee.agentpey.com --product 67624104591666 --pay --rail C... --max-amount 2.00
```

A store broken on purpose, to see the kit fail:

```bash
pnpm run ucp:stellar:broken-store -- --port 4137
```

```bash
pnpm run ucp:stellar:conformance -- http://localhost:4137
```

`--break spec-off-domain,decimals,pay-to-mismatch,no-binding,accepts-tampered,settles-signed`
picks the breaks; with none given, all are on. `settles-signed` refuses the
junk transaction but "settles" the signed probe while answering a refusal:
only `--pay` catches it, by the payer's balance.

Options: `--json` prints the report as JSON. `--asset C...` is the only asset
the charge pays in. `--anchor-wait <s>` is how long to wait for a pending
receipt anchor (60 by default; still pending after that is a warning, not a
failure). `--registry C...` trusts another receipt registry than AgentPey's,
which is read from `deployments/vitrinee-testnet.json`. `--platform-profile <url>` changes the
profile sent in `UCP-Agent`. `--email` sets the buyer's email on the checkout.
The exit code is 0 with no failure, 1 with one, and 2 for a usage error.

## The checks

| Id | Group | What it checks |
|---|---|---|
| P1 | profile | `/.well-known/ucp` answers a UCP business profile |
| P2 | profile | It declares `com.agentpey.stellar_x402`, with an id and a version |
| P3 | profile | Its spec and schema are on `https://agentpey.com` (UCP's namespace binding), and both answer |
| P4 | profile | `config` is valid against `#/$defs/business_config` of the published schema |
| P5 | profile | `stellar:testnet`, an asset with 7 decimals; another asset than testnet USDC is a warning |
| P6 | profile | `pay_to` has a trustline to the asset |
| P7 | profile | The REST endpoint is on the store's own origin (the kit's policy, not the spec's: a platform that pays where the profile points must trust that endpoint) |
| R1 | requirements | A checkout for one product is `ready_for_complete` |
| R2 | requirements | The handler's config is valid against `#/$defs/response_config` |
| R3 | requirements | `binding.checkout_id` is the checkout's id |
| R4 | requirements | `scheme` is `exact`; `payTo`, asset and network are the profile's (acquisition step 2) |
| R5 | requirements | `amount` is a positive integer of atomic units, with `fx` when the currency is not the asset |
| R6 | requirements | It refuses, with `payment_failed`, a credential whose `accepted` differs, sent with a junk transaction. A pass shows only that the store does not complete without settling |
| C1 | charge | The same, with a really signed transaction; the payer's balance must not move |
| C2 | charge | It completes with the exact credential, through `@agentpey/ucp-stellar` |
| C3 | charge | Replaying the credential makes no other order, and the payer paid exactly once |
| E1 | receipt | A receipt is on the completed checkout and on the order |
| E2 | receipt | Its signing key is published in the profile's `keys`, and is the key its `did:stellar` names |
| E3 | receipt | It is anchored in the trusted registry |
| E4 | receipt | Its three checks pass: signature and content, anchor, settlement |

The requirement checks run even on a profile with errors, so every error is
reported. Nothing is signed for a store that already failed P3, P5, P6, R2, R3,
R4, R5 or R6, nor for a checkout in another asset than `--asset` or above
`--max-amount`. If the signed probe does not reach the store, the run stops
there: the store may hold that authorization until it expires. The receipt checks run only when the store declares
`com.agentpey.shopping.receipt`.
