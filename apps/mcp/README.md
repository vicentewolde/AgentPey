# @agentpey/mcp

AgentPey's MCP server (T128): Claude and ChatGPT connect to it to search
Vitrinee stores, quote, pay on Stellar testnet from the MCP's own
`policy_rail`, read the order with its verified receipt, and sign a refund
claim. OAuth 2.1 in front of `/mcp`; the only person who can sign in is the
wallet that owns the rail, by signing a message with a Stellar wallet.

Connect a client to:

```
https://mcp.agentpey.com/mcp
```

Signing in needs a Stellar wallet that signs messages in the browser
(Freighter, xBull or LOBSTR, picked on the page), holding the account
that owns the rail (`MCP_ALLOWED_WALLET`). Any other account is refused. The
page loads the wallet layer from this server, `/wallet-kit.js`, pinned by its
integrity; locally it exists once `pnpm build` has run (otherwise the page is a
503).

## Connect Claude

Tested on claude.ai with an individual account on 2026-10-03. Per Anthropic's
docs, the same steps apply on Free, Pro and Max and in the desktop app; the
Team and Enterprise path below comes from those docs too, untested here.

1. Open **Customize → Connectors**, click **+ Add**, then **Add custom
   connector**.
2. Name: `AgentPey`. Remote MCP server URL:
   `https://mcp.agentpey.com/mcp`. Click **Continue**.
3. Authentication: **Sign in when needed**. OAuth client: keep the option
   Claude marks as detected. Leave **Request headers** empty. Click **Add**.
4. Claude opens "Connect to AgentPey". Click the button, approve the message
   in your wallet, and you are back in Claude, connected.
5. In a chat, open **+ → Connectors** and turn **AgentPey** on. Then ask, for
   example: `compra un imán en agentcommerce`.

On a Team or Enterprise plan an owner adds it first, under **Organization
settings → Connectors → Add → Custom → Web**, with the same URL. Members then
click **Connect** under **Customize → Connectors**.

Claude searches, quotes and reads the order with its receipt, but it does not
call `pay`: it leaves moving funds to the person, even on testnet and even when
asked (`R-11`). Pay the quote yourself, below.

## Connect ChatGPT

Tested with ChatGPT Plus on the web on 2026-10-03. Per OpenAI's docs,
developer mode is on Plus, Pro, Business, Enterprise and Education.

1. Open **Settings → Security and login** and turn on **Developer mode**.
2. Go to [ChatGPT Plugins](https://chatgpt.com/plugins), click **+ Add**,
   then **Create custom MCP server**. Name: `AgentPey`. Description: one
   line on what it does. MCP server URL: `https://mcp.agentpey.com/mcp`.
   Authentication: **OAuth**.
3. ChatGPT opens "Connect to AgentPey". Sign in with your wallet as above.
4. In a chat, open **+ → Developer mode** and select **AgentPey**. Name the
   tool when you ask, for example: `Use the AgentPey app to buy a magnet in
   agentcommerce`.

ChatGPT asks you to confirm before it pays, and then calls `pay` itself: no
need for the Inspector. Write calls (`quote`, `pay`, `open_claim`) may also
show their arguments for approval first.

## One product or a cart

`quote` takes one product (`product_id`, optional `quantity`) or a cart of up
to ten lines from the same store (`items: [{ product_id, quantity }]`), never
both. A cart is one checkout, one signed intent and one payment; the quote
lists its lines in `items`. `get_order` returns the payment's transaction link
in `receipt.explorer_url`.

## Pay a quote yourself

When the chat does not call `pay` (Claude would not, `R-11`), press it from
the official MCP Inspector, signed in with the same wallet. Connect first:
the quote lasts ten minutes and lives only in the server's memory.

```bash
npx @modelcontextprotocol/inspector@2.9.0
```

1. In the page it opens: Transport Type **Streamable HTTP**, URL
   `https://mcp.agentpey.com/mcp`, **Connect**. Sign in with your wallet; the
   page warns that a local app is asking, which is expected.
2. Ask the chat for a quote. Copy its quote id (`q_…`).
3. In the Inspector: **Tools → List Tools → pay**. `quote_id`: the id;
   `confirm`: true. **Run Tool**. The result has the order id and the receipt.
4. Tell the chat you paid and give it the order id; it reads the order with
   `get_order` and checks the receipt.

Check the receipt yourself, without trusting AgentPey or the store. From the
repo root (`pnpm run` scripts resolve a relative path from there), with `jq`
installed, save the receipt from the order and verify it. `<store>` is the
store's host, for example `agentcommerce.vitrinee.agentpey.com`:

```bash
curl -s https://<store>/ucp/v1/orders/<order_id> | jq -r .receipt.jws > receipt.jws
```

```bash
pnpm run vitrinee:verify -- receipt.jws
```

## Set up, once

Create the agent's key, its credential and its Mandate, and the OAuth secret
(writes `.env.local`; anchors on testnet):

```bash
pnpm run mcp:setup -- --principal G...
```

Deploy the MCP's rail (a new contract on testnet, 3.00 USDC per purchase,
5.00 per day), then run setup again so it records the rail:

```bash
pnpm run deploy:policy-rail -- --profile mcp --principal G...
```

```bash
pnpm run mcp:setup -- --principal G...
```

Fund the rail by sending testnet USDC to its contract id from the principal's
wallet. The server refuses to start unless, on chain, the rail is owned by
`MCP_AGENT_SECRET_KEY` and its principal is `MCP_ALLOWED_WALLET`. When a new store joins the directory, issue the Mandate again:

```bash
pnpm run mcp:setup -- --principal G... --reissue
```

## Cut access

Sign everyone out at once: put a new `MCP_OAUTH_SECRET` in Render (any 48+
random characters) and redeploy. Every access and refresh token stops working.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Stop the agent from paying at all, whatever it holds: withdraw the rail's
balance from the principal's wallet, or revoke the agent's credential in the
AgentPass registry. Access tokens last one hour and refresh tokens a week,
each refresh token works once; a restart forgets which ones were used, so one
already used can be used once more until it expires.

## Run locally

```bash
set -a; source .env.local; set +a; MCP_PUBLIC_URL=http://localhost:3010 pnpm --filter @agentpey/mcp start
```

## Check that the network refuses a purchase over the limit

```bash
pnpm run ucp:probe-per-tx -- --store https://agentcommerce.vitrinee.agentpey.com --product 67624503640370 --quantity 2 --rail mcp
```

## Tests

```bash
pnpm --filter @agentpey/mcp test
```

```bash
pnpm exec vitest run scripts/mcp/mcp-contract.test.ts
```
