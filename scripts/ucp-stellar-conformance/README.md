# Stellar x402 payment handler conformance kit

Checks that a UCP store declaring `com.agentpey.stellar_x402` implements the
[handler spec](https://agentpey.com/ucp/handlers/stellar-x402/spec), one check
at a time, with a verdict and the reason. Stellar testnet only.

## Run it

Profile checks only (GETs, nothing else):

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
asset, or the owner of a `policy_rail` (with `--rail`):

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

`--break spec-off-domain,decimals,pay-to-mismatch,no-binding,accepts-tampered`
picks the breaks; with none given, all are on.

Options: `--json` prints the report as JSON. `--registry C...` trusts another
receipt registry than AgentPey's. `--platform-profile <url>` changes the
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
| P7 | profile | The REST endpoint is on the store's own origin |
| R1 | requirements | A checkout for one product is `ready_for_complete` |
| R2 | requirements | The handler's config is valid against `#/$defs/response_config` |
| R3 | requirements | `binding.checkout_id` is the checkout's id |
| R4 | requirements | `payTo`, asset and network are the profile's (acquisition step 2) |
| R5 | requirements | `amount` is a positive integer of atomic units, with `fx` when the currency is not the asset |
| R6 | requirements | It refuses, with `payment_failed`, a credential whose `accepted` differs (junk transaction) |
| C1 | charge | The same, with a really signed transaction |
| C2 | charge | It completes with the exact credential, through `@agentpey/ucp-stellar` |
| C3 | charge | Replaying the credential makes no other order |
| E1 | receipt | A receipt is on the completed checkout and on the order |
| E2 | receipt | Its signing key is published in the profile's `keys` |
| E3 | receipt | It is anchored in the trusted registry |
| E4 | receipt | Its three checks pass: signature and content, anchor, settlement |

The requirement checks run even on a profile with errors, so every error is
reported. The charge runs only on a profile a platform may pay against, and
only up to `--max-amount`. The receipt checks run only when the store declares
`com.agentpey.shopping.receipt`.
