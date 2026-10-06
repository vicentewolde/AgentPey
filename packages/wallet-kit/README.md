# @agentpey/wallet-kit

The one wallet layer AgentPey's signing screens use (T143, `R-23`): Stellar Wallets Kit behind three calls,
`connect()`, `signMessage()` (SEP-53, the signature always handed back as base64 of its 64 bytes) and
`signTransaction()`, on Stellar testnet and for the connected account. Private to the monorepo.

Each screen loads it from its own origin, never from a CDN, and says on the script tag what it signs:

```html
<script src="/wallet-kit.js" data-needs="message transaction"></script>
```

The picker offers only the wallets that can sign all of it. A screen that declares nothing gets the strictest
list (message and transaction). Today: Freighter and xBull everywhere; LOBSTR and Hana only where nothing but a
message is signed (LOBSTR signs testnet transactions for mainnet; Hana is not tested yet).

## Build the bundle

`pnpm build` builds it, as Render does at deploy. To build only this:

```bash
pnpm --filter @agentpey/wallet-kit run bundle
```

It writes `dist/wallet-kit.js` (about 190 KB). Without it, `/wallet-kit.js` answers 503, the screens say the
wallet connection did not load, and the MCP sign-in page is not shown.

## Test

```bash
pnpm --filter @agentpey/wallet-kit test
```

## Check a wallet

On a local server (`pnpm run web`), `http://localhost:8787/wallet-lab.html` signs a SEP-53 message and a test
transaction with the wallet you pick, and shows whether the server verifies each. The test transaction has
sequence 0, so no network accepts it. The lab is a 404 on agentpey.com.
