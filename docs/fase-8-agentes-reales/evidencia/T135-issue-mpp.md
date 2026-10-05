# Texto del issue para `stellar/stellar-mpp-sdk` (T135)

**Estado:** borrador, **sin publicar**. Se publica solo con el OK del usuario (`R-4`). Evidencia:
[T135-mpp-charge.md](T135-mpp-charge.md).

---

**Title:** Charge: support contract-account payers (`did:pkh:stellar:…:C…`, custom `__check_auth`)

**Summary**

`@stellar/mpp` 0.7.1 only accepts a classic Stellar account (`G…`) as the payer of a charge. Agents that pay from a
Soroban contract account (a smart wallet whose `__check_auth` enforces spending rules) cannot pay an MPP charge, even
though the same payment settles fine as an x402 `exact` payment, and the network itself verifies the contract's
authorization.

We are building [AgentPey](https://agentpey.com), where an AI agent pays from a `policy_rail` contract: the agent's
key signs, and the contract's `__check_auth` enforces a per-payment and a per-day cap on-chain, so a compromised or
prompt-injected agent cannot spend past them. That guarantee is the reason we cannot fall back to paying from the
agent's classic key.

**What we tried (testnet, 2026-10-05)**

The SDK's own charge server (`Mppx.create` + `stellar.charge`, unsponsored and sponsored) charging 0.01 USDC, and a
`transfer(from = <contract>, to, amount)` whose authorization entry is signed for the contract (address credentials,
signature `Vec<{ public_key, signature }>`, the shape `__check_auth` decodes):

| Attempt | Credential source | Result |
|---|---|---|
| pull, contract as payer | `did:pkh:stellar:testnet:C…` | `Credential source contains an invalid Stellar public key.` |
| pull, contract's signer as declared payer | `did:pkh:stellar:testnet:G…` | `Transfer "from" does not match credential source.` |
| sponsored, signer as source | `did:pkh:stellar:testnet:G…` | `Transfer "from" does not match credential source.` |
| sponsored, contract as payer | `did:pkh:stellar:testnet:C…` | `Credential source contains an invalid Stellar public key.` |
| control: the SDK client with a classic key | `did:pkh:stellar:testnet:G…` | paid (tx `9e9836644e434df99a5b359a94a145bbe36cd1a3219ecebd6f32a6fb8efd9be9`) |

Nothing was broadcast in the four refused attempts. We did not try push mode: there the client broadcasts before the
server verifies, so a contract payer would move funds and still be refused.

**Where it happens**

- Client: `charge()` takes a `Keypair` and always builds `transfer(from = keypair.publicKey(), …)`.
- Server: `publicKeyFromDID` validates the DID's last segment with `Keypair.fromPublicKey`, which rejects `C…`.
  `verifyTokenTransfer` then requires the transfer's `from` to equal that key.
- Sponsored path: `verifyAuthEntrySignature` rejects contract authorizers by design ("contract authorizers cannot be
  verified off-chain").

**Proposal**

1. Accept `did:pkh:stellar:<network>:C…` as a charge source, and require the transfer's `from` to equal it (the same
   rule as today, with a contract address).
2. For a contract authorizer, do not verify the signature off-chain: verify the transaction by simulating it in
   enforcing mode before broadcasting (the sponsored path already simulates), and treat a failed `__check_auth` as a
   verification failure. The on-chain result then settles it, as for any payment.
3. Client: let the caller give the payer address and an authorization-entry signer (a callback like
   `authorizeEntry`'s), instead of a `Keypair` only. Contract payers would use pull mode; `signedHash` push mode binds
   the credential with a classic-key signature, which a contract cannot produce.

We would be glad to send a PR if this direction fits the SDK.
