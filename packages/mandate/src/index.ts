/**
 * `@agentpey/mandate` — the principal's signed consent.
 *
 * Phase 3, T16. A consumer of AgentPass, not an extension of it (`B-2`): it
 * imports `@agentpass/core` for `did:stellar` and the JWS machinery, and
 * nothing in `@agentpass/*` knows this package exists.
 */
export {
  AGENTPAY_MANDATE_TYPE,
  agentPayMandateSchema,
  grantToScope,
  mandateGrantSchema,
  mandateSubjectSchema,
  type AgentPayMandate,
  type MandateGrant,
  type MandateSubject,
} from "./mandate.js";

export {
  createMandate,
  mandateRequestSchema,
  type CreateMandateOptions,
  type MandateRequest,
} from "./create.js";

export {
  AGENTPAY_MANDATE_TYP,
  mandateHash,
  mandateProfile,
  signMandate,
  verifyMandate,
  type SignedMandate,
  type VerifiedMandate,
  type VerifyMandateOptions,
} from "./sign.js";

export {
  anchorMandate,
  prepareWalletAnchor,
  prepareWalletRevoke,
  revokeMandate,
  verifyMandateOnChain,
  verifyWalletSignedMandateOnChain,
  type AnchorMandateParams,
  type AnchoredMandate,
  type FullyVerifiedMandate,
  type FullyVerifiedWalletMandate,
  type PrepareWalletAnchorParams,
  type PrepareWalletRevokeParams,
  type PreparedRegistryWrite,
  type PreparedWalletAnchor,
  type RegistryAccess,
  type RevokeMandateParams,
} from "./anchor.js";

export {
  canonicalMandateJson,
  mandateChallengeMessage,
  verifyWalletSignedMandate,
  walletMandateHash,
  type VerifyWalletSignedMandateOptions,
  type WalletVerifiedMandate,
} from "./wallet-sign.js";
