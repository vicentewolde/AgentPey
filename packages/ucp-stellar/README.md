# @agentpey/ucp-stellar

Let an agent buy from a [UCP](https://ucp.dev) store that accepts Stellar. The package reads the store's profile,
checks its `com.agentpey.stellar_x402` payment handler, quotes a checkout and pays it, on **Stellar testnet**.

It never holds a key: a payer takes a function that signs, so the key stays in a wallet, an HSM or wherever you keep
it.

## Install

```bash
npm install @agentpey/ucp-stellar
```

Node.js 22 or later. ESM only.

## Example

A magnet from AgentPey's Shopify test store. The first run only quotes (it opens a checkout and moves no money);
with `PAY=yes` it pays from an AgentPey `policy_rail` on testnet.

```js
import { USDC_TESTNET, fromAtomic, pay, policyRailPayer, quote, railOwnerSigner } from "@agentpey/ucp-stellar";

const storeUrl = "https://agentcommerce.vitrinee.agentpey.com";
const buyer = { email: "buyer@example.com", first_name: "Ada", last_name: "Lovelace" };
const destination = { first_name: "Ada", last_name: "Lovelace", street_address: "Av. Providencia 1234", address_locality: "Providencia", address_country: "CL" };

// 1. Open a checkout and check it against the store's public profile. Nothing is signed.
const q = await quote({ storeUrl, productId: "67624104591666", quantity: 1, buyer, destination });
console.log(`checkout ${q.checkoutId}: ${fromAtomic(BigInt(q.requirements.amount), q.asset.decimals)} ${q.asset.code} to ${q.requirements.payTo}`);
if (process.env.PAY !== "yes") process.exit(0);

// 2. Pay from a policy_rail. The owner's key signs; the network enforces the rail's limits.
const payer = policyRailPayer({ contractId: process.env.RAIL_CONTRACT_ID, signAuthPayload: railOwnerSigner(process.env.RAIL_OWNER_SECRET) });
const receipt = await pay(q, { payer, maxAmount: "2.00", asset: USDC_TESTNET });
console.log(`order ${receipt.orderId}, tx https://stellar.expert/explorer/testnet/tx/${receipt.transaction}`);
```

```bash
node buy.mjs
```

```bash
PAY=yes RAIL_CONTRACT_ID=C... RAIL_OWNER_SECRET=S... node buy.mjs
```

The same file is [`example/buy.mjs`](example/buy.mjs).

## What is checked before anything is signed

`quote()` refuses, with a typed error, a store that:

- does not publish `/.well-known/ucp`, or declares the handler without its spec and schema on `agentpey.com`;
- declares a REST endpoint outside its own origin;
- is on a network other than `stellar:testnet`;
- declares an asset with other than Stellar's seven decimals;
- asks, in the checkout, to pay another account, asset or network than its profile declares;
- opens the checkout for other lines than the ones asked for, or not `ready_for_complete`.

`pay()` then, before signing:

- reads the profile and the checkout again (`recheck`, on by default) and refuses with `QuoteChanged` if the
  recipient, asset, network, amount or endpoint changed, and with `InvalidProduct` if the lines did;
- refuses an amount above your `maxAmount` (`AmountAboveLimit`), read with Stellar's seven decimals, never with a
  number the store declares;
- refuses, when you name it with `asset`, a checkout priced in another asset (`InvalidProduct`);
- calls your `beforeSign` hook, if any, with a frozen copy of what will be signed: throw there to stop the payment,
  or return extension members for the Complete Checkout body.

It signs exactly the checked requirement, capped at its own amount, and completes the checkout.

## API

| Export | What it does |
|---|---|
| `readStoreProfile(storeUrl, options?)` | Reads and checks the store's profile and handler |
| `quote(input, options?)` | Opens a checkout for `productId` and `quantity`, or `lines` (1 to 10), with a `destination` and an optional `buyer` (with `consent`, sent in an update after the create) |
| `pay(quote, options)` | Pays a quote. `payer` and `maxAmount` (a decimal string like `"2.00"`, or atomic units as a `bigint`) are required. Optional: `asset` (the contract you accept, such as `USDC_TESTNET`), `recheck`, `idempotencyKey`, `beforeSign` |
| `classicPayer(signer)` | Pays from a classic account (`G...`), with a SEP-43 signer such as a wallet's |
| `policyRailPayer({ contractId, signAuthPayload })` | Pays from an AgentPey `policy_rail` (`C...`); `signAuthPayload` signs the 32-byte authorization payload as the rail's owner |
| `keypairSigner(secret)`, `railOwnerSigner(secret)` | Build those signing functions from a secret you already hold. The secret stays in your process; the package never reads the environment or writes to disk |

With `recheck: false`, `pay()` trusts the quote as given (it still refuses one whose endpoint is off the store's
origin): keep a quote where nobody else can write it, or leave `recheck` on.

Store URLs are `https`; plain `http` only on a loopback host (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`).
The store is addressed by its origin: a path in the URL is dropped.

`options` takes `fetch` and `platformProfile`: the profile sent in the `UCP-Agent` header, which tells the store
which UCP version to answer in. It defaults to AgentPey's public platform profile
(`https://agentpey.com/ucp/platform/agentpey.json`, UCP `2026-04-08`, no AP2). Pass your own if you publish one.

## Errors

Every failure is a `UcpStellarError` with a `code` and `paymentSent`. `paymentSent: false` means nothing left your
process. With `true`, the store may have settled the payment: read the checkout before retrying. An error thrown by
your own payer or `beforeSign` reaches you as you threw it, and nothing was sent.

| `code` | When |
|---|---|
| `InvalidArguments` | The input is missing or malformed |
| `UnsupportedNetwork` | The store is not on Stellar testnet |
| `MerchantRejectedRequest` | No usable profile or handler, or no payable checkout |
| `InvalidProduct` | The checkout pays someone else, or is for other lines |
| `QuoteChanged` | Read again, the store no longer says what it quoted |
| `AmountAboveLimit` | The checkout costs more than `maxAmount` |
| `PaymentNotCreated` | The payment could not be built or signed |
| `RailInsufficientFunds` | The `policy_rail` does not hold enough |
| `NetworkError` | A call failed, or the store did not confirm the checkout |

## Not included

- **AP2 mandates.** An AP2 open mandate is signed by the agent's platform with its own key. A store asks for one
  only when the platform's profile declares AP2, and the default profile does not.
- **Spending authorization beyond `maxAmount`.** Paying from a `policy_rail`, the network enforces the rail's own
  per-payment and per-day limits inside the transfer, whoever signs. Your own policy goes in `beforeSign`.
- **Receipt verification.** `pay()` returns the store's receipt and its `verify_url` as they come.
- **Mainnet.** Testnet only.

## License

Apache-2.0
