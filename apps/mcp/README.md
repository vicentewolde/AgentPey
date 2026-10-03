# @agentpey/mcp

AgentPey's MCP server (T128): Claude and ChatGPT connect to it to search
Vitrinee stores, quote, pay on Stellar testnet from the MCP's own
`policy_rail`, read the order with its verified receipt, and sign a refund
claim. OAuth 2.1 in front of `/mcp`; the only person who can sign in is the
wallet that owns the rail, by signing a message with Freighter.

Connect a client to:

```
https://mcp.agentpey.com/mcp
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
