# `@agentpey/resolve`

AgentResolve off chain (Fase 7, T124): the payer's signed claim, the checks
before a dispute opens, the AI arbiter, and the verdict whose hash the
`agent-resolve` contract stores.

- `signClaim` / `verifyClaim` — an `agentresolve-claim+jwt` JWS by the payer,
  or by the key that controls a contract payer (a `policy_rail`'s `owner()`).
- `checkClaim` — the receipt passed its three checks and is the one the claim
  embeds, the refund window is open, the amount is within the receipt, and the
  claimant may speak for the payer.
- `verifyMerchantResponse` (T126) — the merchant's answer: a position
  (`accept_full`, `accept_partial`, `contest`), a statement and evidence,
  signed with the owner's wallet (SEP-53) from the receipt's payout account
  (`E-20`), and about the `claim_hash` on chain. The page that signs it is
  `apps/web/public/resolve/responder.html`, served at
  `https://agentpey.com/resolve/responder` (`E-21`). `assertMayDecide`: without
  a response, no decision before 48 h (`E-22`).
- `createClaudeArbiter` — Claude Opus 5.5 (`E-17`), structured output, the
  claim and the response passed as untrusted data, refusals and malformed answers turned into
  `ResolveVerdictInvalid`. Its verdict is final: one dispute per receipt.
- `decideDispute` — bounds the proposal at the disputed amount and returns the
  verdict, with the response's hash in it (or `null`), and its `sha256`, which a person confirms before anything is paid
  (`E-18`).

Errors are `AgentPassError`: `ResolveClaimInvalid`, `ResolveReceiptInvalid`,
`ResolveClaimantNotPayer`, `ResolveClaimWindowClosed`, `ResolveAmountExceeded`,
`ResolveVerdictInvalid`, `ResolveConfirmationMismatch`, `ResolveResponseInvalid`,
`ResolveRespondentNotMerchant`, `ResolveResponseMismatch`, `ResolveResponsePending`.

```bash
pnpm --filter @agentpey/resolve test
```

The command line (testnet; needs `.env.local` with `AGENT_SECRET_KEY`,
`RESOLVE_ARBITER_SECRET_KEY`, `AGENT_RESOLVE_CONTRACT_ID` and, for `decide`,
`ANTHROPIC_API_KEY`):

```bash
pnpm run resolve:deposit -- --merchant <G...> --amount 3.00
```

```bash
pnpm run resolve:open -- --receipt .vitrinee/last-ucp-receipt.jws --reason not_delivered --description "<what happened>" --evidence "<evidence>"
```

Send the merchant the `claim.jws` that `open` prints. Its answer comes back
as a file:

```bash
pnpm run resolve:check-response -- --receipt <receipt hash> --response <response.json>
```

```bash
pnpm run resolve:decide -- --receipt <receipt hash> --response <response.json>
```

Without a response, once its 48 h have passed:

```bash
pnpm run resolve:decide -- --receipt <receipt hash>
```

```bash
pnpm run resolve:execute -- --receipt <receipt hash> --confirm <verdict hash>
```

```bash
pnpm run resolve:verify -- --receipt <receipt hash>
```
