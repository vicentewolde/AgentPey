# `@agentpey/ap2`

AgentPey's Mandate as **AP2 v0.2 open mandates**. Phase 7, task T123.

[AP2](https://github.com/google-agentic-commerce/AP2) (Agent Payments Protocol,
release 0.2.0) proves to a merchant and a payment processor that a user
authorised an agent. It has two mandate types, checkout and payment, each
**open** (constraints plus the agent's key in `cnf`, signed for the user) or
**closed** (signed by the agent when it buys). A principal's AgentPey Mandate
maps to the two open ones.

This package issues and verifies that pair as SD-JWTs (RFC 9901):

- `mandate.checkout.open.1` — `checkout.line_items` (the product and quantity)
  and `checkout.allowed_merchants`.
- `mandate.payment.open.1` — `payment.reference` (the checkout mandate's
  `sd_hash`), `payment.amount_range` (in cents, rounded down: AP2 reads `max`
  in minor units, `E-12`),
  `payment.allowed_payees`, `payment.allowed_payment_instruments`
  (`stellar_x402`) and `payment.execution_date`.

It does **no authorisation of its own**. Deciding whether a purchase is
allowed belongs to the agent: `exportMandateAsAp2`
(`apps/agent/src/ap2/export.ts`) verifies the credential and the Mandate on
chain, binds the intent to them, runs `checkScope` and `checkMandate`, caps the
amount at the smallest of the four limits (`E-12`, `E-13`), and only then calls
`issueOpenMandatePair`. Not exported, by design (`docs/fase-7-estandar-comercio-agentico/DECISIONES.md`):
`perDay` as a constraint, and revocation, which AP2 has no way to express (`E-10`).
Each pair expires with its intent, and within an hour at most.

## Install

Part of the AgentPey workspace; nothing to install separately.

```bash
pnpm install
```

## Use

```ts
import { issueOpenMandatePair, verifyOpenMandatePair } from "@agentpey/ap2";

const pair = await issueOpenMandatePair(task, signer); // { checkout, payment }

const verified = await verifyOpenMandatePair(pair, { issuerKey }); // the key YOU trust, never the token's
verified.payment.constraints; // AP2 v0.2, typed
verified.source; // { mandate_id, hash, registry } of the AgentPey Mandate behind it
```

Signing algorithms: `EdDSA` (a Stellar key, used by the real export) and
`ES256` (`E-9`). The header's `alg` must be the trusted key's algorithm.

Every allowlist must reveal at least one element: a holder can withhold a
disclosure without breaking the signature, so an empty list is rejected, never
read as "no restriction".

Errors, all `AgentPassError`: `Ap2MandateInvalid`, `Ap2SignatureInvalid`,
`Ap2DisclosureMismatch`, `Ap2MandateExpired`, `Ap2MandateNotYetValid`,
`Ap2ReferenceMismatch`, `Ap2ConstraintUnsupported`.

## Test

```bash
pnpm --filter @agentpey/ap2 test
```

No network. The tests check the exported mandates against the official AP2
JSON Schemas, vendored unmodified in `src/test/ap2-v0.2/`.

## Real export and cross-check

```bash
pnpm run ap2:export -- --store https://agentcommerce.vitrinee.agentpey.com --product 67624104591666 --ephemeral-p256
```

Anchors a credential and a Mandate on testnet (fees only), has the agent sign
a purchase intent, exports the pair and verifies it. `--ephemeral-p256` adds a
second pair through `apps/agent/src/ap2/cross-check.ts`, the only path that
binds `cnf` to a key other than the agent's own, under an
`urn:agentpey:ap2-cross-check:` issuer. Writes `.vitrinee/ap2/`.
Needs `.env.local` with `ISSUER_SECRET_KEY`, `AGENT_SECRET_KEY` and
`AGENT_REGISTRY_CONTRACT_ID`.

The AP2 reference SDK then verifies the same files, in a Python virtualenv:

```bash
python3 -m venv .venv-ap2
```

```bash
.venv-ap2/bin/pip install -r scripts/ap2-crosscheck/requirements.txt
```

```bash
.venv-ap2/bin/python scripts/ap2-crosscheck/verify.py .vitrinee/ap2
```

```bash
.venv-ap2/bin/python scripts/ap2-crosscheck/verify.py .vitrinee/ap2/p256
```

The pairs expire with the intent, about 15 minutes after the export; run the
cross-check within that window.
