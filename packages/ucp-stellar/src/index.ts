/**
 * @agentpey/ucp-stellar: buy from a UCP store that accepts Stellar (T136).
 *
 * `quote()` opens a checkout and checks it against the store's public profile, signing nothing; `pay()` signs
 * exactly that and completes it. Payers take a function that signs: this package never stores a key.
 * Stellar testnet only.
 */
export { UCP_STELLAR_ERROR_CODES, UcpStellarError, isUcpStellarError, type UcpStellarErrorCode, type UcpStellarErrorOptions } from "./errors.js";
export { fromAtomic, toAtomic } from "./amount.js";
export {
  MAX_UCP_LINES,
  STELLAR_TESTNET,
  STELLAR_X402_HANDLER,
  type StellarX402HandlerConfig,
  type UcpBusinessProfile,
  type UcpBuyer,
  type UcpDestination,
  type UcpLine,
  type UcpReceipt,
} from "./wire.js";
export {
  DEFAULT_PLATFORM_PROFILE,
  originMatchesNamespace,
  pay,
  quote,
  readStoreProfile,
  type BeforeSignContext,
  type BeforeSignResult,
  type PayOptions,
  type PayableQuote,
  type QuoteInput,
  type UcpClientOptions,
  type UcpStellarPayer,
  type UcpStellarQuote,
  type UcpStellarReceipt,
  type UcpStoreProfile,
} from "./checkout.js";
export {
  assertSimulationUsable,
  authorizeAsRailOwner,
  classicPayer,
  describeShortfall,
  keypairSigner,
  policyRailPayer,
  railOwnerSigner,
  readTokenBalance,
  type BalanceReader,
  type ClientStellarSigner,
  type InsufficientFundsProbe,
  type PolicyRailPayerOptions,
  type RailOwnerSigner,
} from "./payers.js";
