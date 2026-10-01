# `@agentpey/resolve`

AgentResolve off chain (Fase 7, T124): the payer's signed claim, the checks
before a dispute opens, the AI arbiter, and the verdict whose hash the
`agent-resolve` contract stores.

- `signClaim` / `verifyClaim` — an `agentresolve-claim+jwt` JWS by the payer,
  or by the key that controls a contract payer (a `policy_rail`'s `owner()`).
- `checkClaim` — the receipt passed its three checks and is the one the claim
  embeds, the refund window is open, the amount is within the receipt, and the
  claimant may speak for the payer.
- `createClaudeArbiter` — Claude Opus 5.5 (`E-17`), structured output, the
  claim passed as untrusted data, refusals and malformed answers turned into
  `ResolveVerdictInvalid`. Its verdict is final: one dispute per receipt.
- `decideDispute` — bounds the proposal at the disputed amount and returns the
  verdict with its `sha256`, which a person confirms before anything is paid
  (`E-18`).

Errors are `AgentPassError`: `ResolveClaimInvalid`, `ResolveReceiptInvalid`,
`ResolveClaimantNotPayer`, `ResolveClaimWindowClosed`, `ResolveAmountExceeded`,
`ResolveVerdictInvalid`, `ResolveConfirmationMismatch`.

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

```bash
pnpm run resolve:decide -- --receipt <receipt hash>
```

```bash
pnpm run resolve:execute -- --receipt <receipt hash> --confirm <verdict hash>
```

```bash
pnpm run resolve:verify -- --receipt <receipt hash>
```
