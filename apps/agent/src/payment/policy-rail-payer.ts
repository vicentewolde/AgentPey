/**
 * Paying with `policy_rail` (T22) as the buyer — the smart account, not the
 * agent's classic (`G…`) account.
 *
 * `M-12`'s spike answered "can a `C…` account be the payer of an x402 `exact`
 * transfer?" by reading `@x402/stellar`, the facilitator and the Stellar SDK:
 * nothing on that path inspects or restricts the payer's address type. That
 * answer holds — but it is not the whole story, and this milestone found the
 * missing half by tracing the signing call chain in the installed SDK rather
 * than the types:
 *
 * `ExactStellarScheme.createPaymentPayload` signs via
 * `AssembledTransaction.signAuthEntries({ address, signAuthEntry, expiration })`,
 * whose internal callback always reduces a SEP-43 signer's answer to raw
 * signature bytes (`base64ToUint8Array(signedAuthEntry)`). `authorizeEntry`
 * then takes its "bare signature" branch, where the signing key is *derived
 * from the entry's own credential address* — `Keypair.fromPublicKey(
 * Address.fromScAddress(addrAuth.address).toString())`. For a contract
 * account that address is a `C…` strkey, which is not an Ed25519 public key:
 * it throws before any signature is verified. The stock client path is
 * therefore classic-account-only in practice, whatever the types allow.
 *
 * The escape hatch is public API, not a patch: `signAuthEntries` accepts an
 * `authorizeEntry` override, and `authorizeEntry` accepts a signing callback
 * that returns `{ signature, publicKey }` explicitly instead of a bare
 * signature. Down that branch the SDK builds
 * `scvVec([{ public_key: bytes32, signature: bytes64 }])` — field for field
 * the `Vec<Signature>` that `policy_rail`'s `__check_auth` expects (the shape
 * its docstring says it was chosen to match). So the owner's key signs the
 * same payload it would sign for a classic account, and the contract, not the
 * host's native check, decides whether it counts.
 *
 * Everything else about the payment is untouched: the same `AssembledTransaction`
 * against the same SEP-41 `transfer`, the same fee-sponsored facilitator flow,
 * the same `PaymentPayload` shape — this registers as one more
 * `SchemeNetworkClient`, so `x402Client` wraps it exactly as it wraps
 * `ExactStellarScheme`.
 *
 * Since T136 (R-21) the scheme itself lives in the public package
 * `@agentpey/ucp-stellar` (`policyRailPayer`), which takes a signing callback
 * instead of a secret. What stays here is the agent's side: the owner's
 * secret turned into that callback, the balance read the agent's way, and the
 * package's errors as `AgentPassError`s with the same codes.
 */
import { AgentPassError } from "@agentpass/core";
import {
  assertSimulationUsable as packageAssertSimulationUsable,
  authorizeAsRailOwner,
  describeShortfall as packageDescribeShortfall,
  isUcpStellarError,
  policyRailPayer,
  railOwnerSigner,
  type BalanceReader,
  type UcpStellarPayer,
} from "@agentpey/ucp-stellar";
import type { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { findDefaultAsset } from "@x402/stellar";

import { readRailUsdcBalance } from "../policy/rail-balance.js";
import { toScaledAmount } from "../scope/amount.js";

/** Which smart account pays, and whose key speaks for it. */
export interface PolicyRailPayer {
  /** The deployed `policy_rail` contract id (`C…`) — the `from` of the transfer. */
  readonly contractId: string;
  /**
   * The secret whose raw Ed25519 public key is the contract's stored `owner`.
   * `policy_rail` verifies a signature over exactly those 32 bytes; the
   * `G…` address around them is only how this codebase carries a keypair.
   */
  readonly ownerSecret: string;
}

/** The package's error as the agent's, with the same code: the package's codes are a subset of the agent's (R-21). */
function asAgentPassError(error: unknown): unknown {
  return isUcpStellarError(error) ? new AgentPassError(error.code, error.message, { cause: error.cause, details: { ...error.details } }) : error;
}

/** The agent reads balances as seven-decimal strings; the package, as atomic units. */
function atomicReader(readBalance: (address: string, assetContractId: string) => Promise<string>): BalanceReader {
  return async (address, assetContractId) => toScaledAmount(await readBalance(address, assetContractId));
}

/** What {@link describeShortfall} needs to ask "is the rail simply empty?". */
export interface InsufficientFundsProbe {
  readonly contractId: string;
  /** The asset contract the challenge named — not assumed to be the default USDC. */
  readonly asset: string;
  /** The challenge's amount, scaled to seven decimals, exactly as the transfer would move it. */
  readonly amount: string;
  readonly readBalance: (address: string, assetContractId: string) => Promise<string>;
}

/**
 * `{ balance, required }` when the rail holds less than the transfer needs,
 * `undefined` when it holds enough — or when the balance could not be read at
 * all (this runs while another failure is already being reported).
 */
export async function describeShortfall(
  probe: InsufficientFundsProbe,
): Promise<{ readonly balance: string; readonly required: string } | undefined> {
  return packageDescribeShortfall({ ...probe, readBalance: atomicReader(probe.readBalance) });
}

/**
 * @throws AgentPassError `RailInsufficientFunds` when the simulation failed and
 * the rail is short; `NetworkError` for any other unusable simulation (`C-113`).
 */
export async function assertSimulationUsable(
  simulation: rpc.Api.SimulateTransactionResponse | undefined,
  details: Record<string, unknown>,
  funds: InsufficientFundsProbe,
): Promise<void> {
  try {
    await packageAssertSimulationUsable(simulation, details, { ...funds, readBalance: atomicReader(funds.readBalance) });
  } catch (error) {
    throw asAgentPassError(error);
  }
}

/**
 * Signs one authorization entry as `policy_rail`'s owner, returning
 * `{ signature, publicKey }`: the only branch of `authorizeEntry` that does not
 * read a signing key out of the entry's own (`C…`) address, and the one that
 * produces the `{ public_key, signature }` struct `__check_auth` decodes.
 */
export function authorizeAsPolicyRailOwner(
  owner: Keypair,
): (
  entry: xdr.SorobanAuthorizationEntry,
  _signer: unknown,
  validUntilLedgerSeq: number,
  networkPassphrase: string,
) => Promise<xdr.SorobanAuthorizationEntry> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return authorizeAsRailOwner(async (payload) => ({ publicKey: owner.publicKey(), signature: owner.sign(Buffer.from(payload)) }));
}

/**
 * The `exact` scheme, paid by a `policy_rail` smart account: the package's
 * `policyRailPayer`, signing with the owner's secret.
 */
export class PolicyRailStellarScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * The same reverse lookup `ExactStellarScheme` registers. Without it
   * `x402Client`'s spend controls reject every challenge priced in USDC as an
   * unknown asset before this scheme is ever asked to build anything.
   */
  readonly findDefaultAsset = findDefaultAsset;

  private readonly inner: UcpStellarPayer;

  constructor(
    payer: PolicyRailPayer,
    /** Injected so tests can answer "how much does the rail hold?" without a network. */
    readBalance: (address: string, assetContractId: string) => Promise<string> = readRailUsdcBalance,
  ) {
    try {
      this.inner = policyRailPayer({ contractId: payer.contractId, signAuthPayload: railOwnerSigner(payer.ownerSecret), readBalance: atomicReader(readBalance) });
    } catch (error) {
      throw asAgentPassError(error);
    }
  }

  /**
   * @throws AgentPassError `RailInsufficientFunds` when the simulation fails
   * and the rail turns out not to hold enough of the asset (`C-113`).
   * @throws AgentPassError `NetworkError` when the RPC is unreachable, the
   * simulation fails for any other reason, or the signed transaction still
   * reports a missing signer — what a mismatch between the deployed
   * contract's `owner` and `ownerSecret` looks like from here.
   * @throws AgentPassError `PaymentNotCreated` when anything else stops the
   * transfer from being built; nothing was sent.
   */
  async createPaymentPayload(x402Version: number, paymentRequirements: PaymentRequirements): Promise<PaymentPayloadResult> {
    try {
      return await this.inner.createPaymentPayload(x402Version, paymentRequirements);
    } catch (error) {
      throw asAgentPassError(error);
    }
  }
}
