/**
 * Who pays, and how they sign. A payer builds the x402 `exact` payment for one
 * requirement; it never stores a key. Each takes a function that signs, so the
 * key can stay in a wallet, an HSM or wherever the caller keeps it:
 *
 * - {@link classicPayer}: a classic Stellar account (`G…`), with a SEP-43 signer.
 * - {@link policyRailPayer}: an AgentPey `policy_rail` smart account (`C…`),
 *   whose owner signs the authorization. The network checks the rail's own
 *   per-payment and per-day limits inside the transfer, whoever signs.
 *
 * {@link keypairSigner} and {@link railOwnerSigner} build those functions from
 * a secret the caller already holds; the secret stays in the caller's memory.
 */
import { Keypair, authorizeEntry, contract, nativeToScVal, rpc, type xdr } from "@stellar/stellar-sdk";
import type { PaymentPayloadResult, PaymentRequirements } from "@x402/core/types";
import {
  ExactStellarScheme,
  createEd25519Signer,
  findDefaultAsset,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  type ClientStellarSigner,
} from "@x402/stellar";

import { fromAtomic } from "./amount.js";
import { UcpStellarError, isUcpStellarError } from "./errors.js";
import { STELLAR_DECIMALS, STELLAR_TESTNET } from "./wire.js";
import type { UcpStellarPayer } from "./checkout.js";

export type { ClientStellarSigner };

/**
 * Signs a `policy_rail` authorization payload as the rail's owner: the 32-byte payload in, the owner's Ed25519
 * signature over it out, with the owner's public key (`G…`). This is what the rail's `__check_auth` verifies.
 */
export type RailOwnerSigner = (payload: Uint8Array) => Promise<{ readonly publicKey: string; readonly signature: Uint8Array }>;

function notCreated(message: string, details: Record<string, unknown>, cause?: unknown): UcpStellarError {
  return new UcpStellarError("PaymentNotCreated", message, { cause, details });
}

/** A failure talking to the RPC: building, simulating. Nothing was sent. */
function rpcFailed(message: string, details: Record<string, unknown>, cause?: unknown): UcpStellarError {
  return new UcpStellarError("NetworkError", message, { cause, details });
}

/** A SEP-43 signer for a classic account, from its secret (`S…`). The secret stays in the returned closure. */
export function keypairSigner(secret: string): ClientStellarSigner {
  try {
    return createEd25519Signer(secret, STELLAR_TESTNET);
  } catch (error) {
    throw new UcpStellarError("InvalidArguments", "that is not a Stellar secret key", { cause: error, details: {} });
  }
}

/** A {@link RailOwnerSigner} from the owner's secret (`S…`). The secret stays in the returned closure. */
export function railOwnerSigner(secret: string): RailOwnerSigner {
  let owner: Keypair;
  try {
    owner = Keypair.fromSecret(secret);
  } catch (error) {
    throw new UcpStellarError("InvalidArguments", "that is not a Stellar secret key", { cause: error, details: {} });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (payload) => ({ publicKey: owner.publicKey(), signature: owner.sign(Buffer.from(payload)) });
}

/**
 * Pays from a classic account. Every failure is a typed `PaymentNotCreated`, unless the signer itself threw a
 * {@link UcpStellarError}.
 */
export function classicPayer(signer: ClientStellarSigner): UcpStellarPayer {
  const scheme = new ExactStellarScheme(signer);
  return {
    scheme: scheme.scheme,
    findDefaultAsset: scheme.findDefaultAsset?.bind(scheme),
    createPaymentPayload: async (x402Version, requirements) => {
      try {
        return await scheme.createPaymentPayload(x402Version, requirements);
      } catch (error) {
        if (isUcpStellarError(error)) throw error;
        throw notCreated("the payment from the classic account could not be built, and nothing was sent", { payer: signer.address }, error);
      }
    },
  };
}

// ---------------------------------------------------------------- policy_rail

/**
 * The authorization override that signs as `policy_rail`'s owner.
 *
 * Returns `{ signature, publicKey }` rather than bare bytes on purpose: that is the only branch of
 * `authorizeEntry` that does not try to read a signing key out of the entry's own address (a `C…` address is not
 * an Ed25519 key), and the only one that produces the `{ public_key, signature }` struct `__check_auth` decodes.
 */
export function authorizeAsRailOwner(
  sign: RailOwnerSigner,
): (entry: xdr.SorobanAuthorizationEntry, _signer: unknown, validUntilLedgerSeq: number, networkPassphrase: string) => Promise<xdr.SorobanAuthorizationEntry> {
  return (entry, _signer, validUntilLedgerSeq, networkPassphrase) =>
    authorizeEntry(
      entry,
      async (_preimage, payload) => {
        const { publicKey, signature } = await sign(payload);
        return { publicKey, signature };
      },
      validUntilLedgerSeq,
      networkPassphrase,
    );
}

/** Reads an address's balance of a SEP-41 token, in atomic units. */
export type BalanceReader = (address: string, assetContractId: string) => Promise<bigint>;

/** The token's `balance()`, simulated on testnet's RPC: no signing, no transfer. */
export const readTokenBalance: BalanceReader = async (address, assetContractId) => {
  const client = await contract.Client.from<{ balance(args: { readonly id: string }): Promise<contract.AssembledTransaction<bigint>> }>({
    contractId: assetContractId,
    rpcUrl: getRpcUrl(STELLAR_TESTNET),
    networkPassphrase: getNetworkPassphrase(STELLAR_TESTNET),
  });
  const assembled = await client.balance({ id: address });
  return BigInt(assembled.result);
};

export interface PolicyRailPayerOptions {
  /** The deployed `policy_rail` contract (`C…`): the `from` of the transfer. */
  readonly contractId: string;
  /** Signs as the rail's owner. */
  readonly signAuthPayload: RailOwnerSigner;
  /** How the rail's balance is read when a simulation fails. Defaults to {@link readTokenBalance}. */
  readonly readBalance?: BalanceReader;
}

/** What {@link describeShortfall} needs to ask "is the rail simply empty?". */
export interface InsufficientFundsProbe {
  readonly contractId: string;
  /** The asset contract the requirement named. */
  readonly asset: string;
  /** The requirement's amount, in atomic units. */
  readonly amount: string;
  readonly readBalance: BalanceReader;
}

/**
 * `{ balance, required }` (decimal strings) when the rail holds less than the transfer needs, `undefined` when it
 * holds enough, or when the balance could not be read at all: this runs while another failure is being reported,
 * and a diagnostic that throws would replace a real error with a worse one.
 */
export async function describeShortfall(probe: InsufficientFundsProbe): Promise<{ readonly balance: string; readonly required: string } | undefined> {
  let held: bigint;
  let needed: bigint;
  try {
    held = await probe.readBalance(probe.contractId, probe.asset);
    needed = BigInt(probe.amount);
  } catch {
    return undefined;
  }
  if (held < 0n || held >= needed) return undefined;
  return { balance: fromAtomic(held, STELLAR_DECIMALS), required: fromAtomic(needed, STELLAR_DECIMALS) };
}

/**
 * Refuses a simulation the payment cannot go on with. A failed simulation is first checked for the one cause with
 * a remedy a person can act on: the rail does not hold enough (`RailInsufficientFunds`). Checked by reading the
 * balance, not by matching the token's error number.
 */
export async function assertSimulationUsable(
  simulation: rpc.Api.SimulateTransactionResponse | undefined,
  details: Record<string, unknown>,
  funds: InsufficientFundsProbe,
): Promise<void> {
  if (simulation === undefined) throw rpcFailed("the transfer from policy_rail was never simulated", details);
  if (rpc.Api.isSimulationError(simulation)) {
    const shortfall = await describeShortfall(funds);
    if (shortfall !== undefined) {
      throw new UcpStellarError("RailInsufficientFunds", "this payment account does not hold enough to pay for this purchase", { details: { ...details, ...shortfall } });
    }
    // `__check_auth`'s own refusals (over the rail's limits) surface here: the network never sees them.
    throw rpcFailed("simulating the transfer from policy_rail failed", { ...details, error: simulation.error });
  }
  if (rpc.Api.isSimulationRestore(simulation)) throw rpcFailed("policy_rail's state has expired and needs restoring before it can pay", details);
}

/**
 * Pays from a `policy_rail` smart account: the same SEP-41 `transfer` and the same fee-sponsored facilitator flow
 * as a classic account, with the contract as `from` and its owner's signature in the shape `__check_auth` reads.
 */
export function policyRailPayer(options: PolicyRailPayerOptions): UcpStellarPayer {
  if (!/^C[A-Z2-7]{55}$/.test(options.contractId)) {
    throw new UcpStellarError("InvalidArguments", "a policy_rail is a contract address (C…)", { details: { contractId: options.contractId } });
  }
  const readBalance = options.readBalance ?? readTokenBalance;
  return {
    scheme: "exact",
    // Without the reverse lookup, x402's spend controls reject a requirement priced in USDC as an unknown asset.
    findDefaultAsset,
    createPaymentPayload: (x402Version, requirements) => railPayload(options.contractId, options.signAuthPayload, readBalance, x402Version, requirements),
  };
}

async function railPayload(
  contractId: string,
  sign: RailOwnerSigner,
  readBalance: BalanceReader,
  x402Version: number,
  requirements: PaymentRequirements,
): Promise<PaymentPayloadResult> {
  const { network, payTo, asset, amount, maxTimeoutSeconds } = requirements;
  const details = { contractId, asset, payTo, amount };
  const funds: InsufficientFundsProbe = { contractId, asset, amount, readBalance };
  try {
    const networkPassphrase = getNetworkPassphrase(network);
    const rpcUrl = getRpcUrl(network);
    const [{ sequence }, ledgerSeconds] = await Promise.all([getRpcClient(network).getLatestLedger(), getEstimatedLedgerCloseTimeSeconds(network)]);
    const maxLedger = sequence + Math.ceil(maxTimeoutSeconds / ledgerSeconds);

    // No source account: the facilitator rebuilds and sponsors the envelope.
    let tx: contract.AssembledTransaction<unknown>;
    try {
      tx = await contract.AssembledTransaction.build({
        contractId: asset,
        method: "transfer",
        args: [nativeToScVal(contractId, { type: "address" }), nativeToScVal(payTo, { type: "address" }), nativeToScVal(amount, { type: "i128" })],
        networkPassphrase,
        rpcUrl,
        parseResultXdr: (result: unknown) => result,
        // Legacy (v1) address credentials: the facilitator, built on stellar-sdk 16, cannot parse CAP-71 `…AddressV2`.
        useUpgradedAuth: false,
      });
    } catch (error) {
      throw rpcFailed("could not build the transfer from policy_rail", details, error);
    }
    await assertSimulationUsable(tx.simulation, details, funds);

    await tx.signAuthEntries({ address: contractId, expiration: maxLedger, authorizeEntry: authorizeAsRailOwner(sign) });

    // Simulating again with the signature in place prices `__check_auth` into the fee the facilitator sees.
    await tx.simulate({ useUpgradedAuth: false });
    await assertSimulationUsable(tx.simulation, details, funds);

    const missing = tx.needsNonInvokerSigningBy();
    if (missing.length > 0) {
      throw rpcFailed("policy_rail's authorization did not take", { ...details, stillNeedsSigningBy: missing, hint: "the rail's owner is probably another key than the one that signed" });
    }
    const xdrEnvelope = tx.built?.toXDR();
    if (xdrEnvelope === undefined) throw notCreated("the transfer from policy_rail was not built", details);
    return { x402Version, payload: { transaction: xdrEnvelope } };
  } catch (error) {
    if (isUcpStellarError(error)) throw error;
    throw notCreated("the transfer from policy_rail could not be built, and nothing was sent", details, error);
  }
}
