/**
 * @agentpey/agent — the minimal purchasing agent (phase 2).
 *
 * It consumes AgentPass rather than extending it: identity, signing and
 * revocation all stay in `@agentpass/core` and `@agentpass/sdk`. What lives
 * here is what an agent does with a credential once it has one.
 */
export {
  parseProduct,
  priceSchema,
  productIdSchema,
  productNotFound,
  productSchema,
  type CatalogAdapter,
  type Price,
  type Product,
} from "./catalog/catalog.js";

export {
  ID_SEPARATOR,
  assetIdSchema,
  makeAssetId,
  makeVenueId,
  parseAssetId,
  parseVenueId,
  venueIdSchema,
  type AssetId,
  type ParsedAssetId,
  type ParsedVenueId,
  type VenueId,
} from "./catalog/ids.js";

export {
  EURC_MOCK,
  MOCK_PRODUCTS,
  MOCK_VENUE_CONTRACT_ID,
  MOCK_VENUE_ID,
  USDC_TESTNET,
  createMockCatalog,
  type MockCatalogOptions,
} from "./catalog/mock.js";

export {
  BAZAAR_USDC,
  BAZAAR_USDC_ISSUER,
  BAZAAR_VENUE_CONTRACT_ID,
  BAZAAR_VENUE_ID,
  createBazaarCatalog,
  getBazaarServiceRoute,
  mapAssetContract,
  type BazaarCatalogOptions,
  type BazaarServiceRoute,
} from "./catalog/bazaar.js";

/**
 * The generic x402 path (F7, T53/T55), exported for the first time in T74.
 *
 * `bazaar.ts` above is one venue's spelling of this; these are the pieces
 * that work for any registered venue, and `apps/web` needs them by name now
 * that a purchase is no longer welded to a single merchant.
 */
export {
  loadVenueRegistry,
  baseUrlForVenue,
  mapAssetCodeForVenue,
  mapAssetIssuerForVenue,
  registryAssetSchema,
  registryVenueSchema,
  venueRegistrySchema,
  type RegistryVenueRow,
  type ResolvedVenue,
  type VenueRegistry,
} from "./catalog/registry.js";

export { DEFAULT_VENUE_REGISTRY } from "./catalog/default-registry.js";

export {
  createX402Catalog,
  getX402ServiceRoute,
  listX402ServiceRoutes,
  type X402CatalogOptions,
  type X402ServiceRoute,
} from "./catalog/x402-catalog.js";

export {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  MAX_CANDIDATES,
  MAX_QUERY_LENGTH,
  fetchWithTimeout,
  matchesQuery,
  parseQuery,
  registeredOnly,
  resolveCandidateVenue,
  toCandidate,
  withCatalogFallback,
  type CandidateDraft,
  type CatalogSource,
  type CatalogSourceId,
  type FallbackOptions,
  type RegisteredCandidate,
  type ServiceCandidate,
  type UnregisteredCandidate,
} from "./catalog/discovery.js";

export {
  PERIPLO_BASE_URL,
  PERIPLO_NETWORK,
  createPeriploCatalog,
  type PeriploCatalogOptions,
} from "./catalog/periplo-catalog.js";

export {
  DEFAULT_INDEX_TTL_MS,
  createAgentPeyDiscovery,
  resolvePayableService,
  type AgentPeyDiscoveryOptions,
  type PayableService,
} from "./catalog/agentpey-discovery.js";

export {
  TOOL_NAMES,
  createToolSet,
  defineTool,
  isToolName,
  type ErasedTool,
  type Tool,
  type ToolDescriptor,
  type ToolName,
  type ToolSet,
} from "./tools/tool.js";

export {
  createAgentTools,
  type AgentToolsDeps,
  type CreatePurchaseIntentResult,
  type GetProductResult,
  type ListProductsResult,
  type WireProduct,
} from "./tools/agent-tools.js";

export {
  checkOwnCredential,
  type CredentialState,
  type CredentialVerifier,
  type UnusableCredential,
  type UsableCredential,
  type VerifiedOwnCredential,
} from "./credential/verifier.js";

export {
  checkOwnMandate,
  createOnChainMandateVerifier,
  type MandateSource,
  type MandateState,
  type MandateVerifier,
  type UnusableMandate,
  type UsableMandate,
  type VerifiedOwnMandate,
} from "./mandate/verifier.js";

export {
  toCredentialReport,
  type ActiveCredentialReport,
  type CheckCredentialResult,
  type UnusableCredentialReport,
} from "./tools/agent-tools.js";

export { createAgent, type Agent, type AgentConfig } from "./agent.js";

export {
  AMOUNT_DECIMALS,
  fromScaledAmount,
  multiplyAmount,
  toScaledAmount,
} from "./scope/amount.js";

export {
  INTENT_CREATE_ACTION,
  checkScope,
  scopeError,
  type ScopeAllowed,
  type ScopeDecision,
  type ScopeDenied,
  type ScopeRejectionCode,
  type ScopeRequest,
} from "./scope/scope.js";

export {
  AGENTPAY_INTENT_FAMILY,
  AGENTPAY_INTENT_TYPE,
  DEFAULT_INTENT_TTL_SECONDS,
  intentAuthorisationSchema,
  intentCredentialRefSchema,
  intentPurchaseSchema,
  purchaseIntentSchema,
  type IntentAuthorisation,
  type IntentCredentialRef,
  type IntentPurchase,
  type PurchaseIntent,
} from "./intent/intent.js";

export {
  AGENTPAY_INTENT_TYP,
  intentHash,
  signIntent,
  verifyIntent,
  type SignedIntent,
  type VerifiedIntent,
  type VerifyIntentOptions,
} from "./intent/sign.js";

export { interpretPurchase, type PurchaseInterpretation } from "./interpret.js";

// T17 and T18 left these unexported: nothing outside the package needed them
// yet. PolicyRail changes that — `LocalPolicyRailDeps` names a `SpendLedger`,
// so a consumer that cannot see the type cannot build a rail at all.
export {
  checkMandate,
  mandateCheckError,
  type MandateAllowed,
  type MandateDecision,
  type MandateDenied,
  type MandateRejectionCode,
} from "./mandate/check-mandate.js";

export {
  checkDailyLimit,
  dailyLimitError,
  type DailyLimitAllowed,
  type DailyLimitDecision,
  type DailyLimitDenied,
  type DailyLimitRejectionCode,
} from "./ledger/check-daily-limit.js";

export {
  createInMemorySpendLedger,
  utcDayKey,
  type SpendLedger,
  type SpendLedgerEntry,
} from "./ledger/spend-ledger.js";

export {
  createLocalPolicyRail,
  policyRailError,
  type AuthorisationDecision,
  type AuthorisationGranted,
  type AuthorisationRefused,
  type AuthorisationRejectionCode,
  type AuthorisationRequest,
  type LocalPolicyRailDeps,
  type PolicyRail,
} from "./policy/policy-rail.js";

export { withVault } from "./policy/with-vault.js";

export { readRailUsdcBalance } from "./policy/rail-balance.js";

export {
  anchorPaymentDecision,
  paymentLinkHash,
  verifyPaymentAnchor,
  type AnchorPaymentDecisionParams,
  type AnchoredPaymentDecision,
  type RegistryAnchor,
  type RegistryAnchorStatus,
} from "./vault/anchor-payment.js";

export {
  reconcileTerms,
  termsError,
  type PaymentTerms,
  type TermsDecision,
  type TermsDenied,
  type TermsRejectionCode,
} from "./policy/terms.js";

export {
  executeBazaarPayment,
  fillRouteTemplate,
  requestPaymentChallenge,
  toPaymentTerms,
  type BazaarPaymentReceipt,
  type ExecuteBazaarPaymentDeps,
  type ExecuteBazaarPaymentInput,
} from "./payment/x402.js";

export {
  PolicyRailStellarScheme,
  authorizeAsPolicyRailOwner,
  type PolicyRailPayer,
} from "./payment/policy-rail-payer.js";
