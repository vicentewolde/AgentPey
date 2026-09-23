/**
 * Every failure AgentPass raises is an {@link AgentPassError} carrying a
 * machine-readable `code`. Callers branch on `code`, never on message text.
 *
 * New codes are added here as the tasks that need them land; the union is the
 * single source of truth for what can go wrong across core, sdk and cli.
 */
export type AgentPassErrorCode =
  /** A placeholder surface exists but its behaviour has not landed yet. */
  | "NotImplemented"
  /** Local configuration is missing, malformed or internally inconsistent. */
  | "ConfigError"
  /** A remote call failed, timed out, or answered with something unparseable. */
  | "NetworkError"
  /** A string is not a well-formed `did:stellar:<network>:<address>`. */
  | "InvalidDid"
  /** A string is not a valid Stellar Ed25519 account address (`G...`). */
  | "InvalidStellarAddress"
  /** A compact JWS is malformed, or its header is not the AgentPass profile. */
  | "InvalidJws"
  /** A credential payload does not match the AgentPass schema. */
  | "InvalidCredential"
  /** The signature does not verify against the issuer's key. */
  | "InvalidSignature"
  /** `now` is past `validUntil`. */
  | "CredentialExpired"
  /** `now` is before `validFrom`. */
  | "CredentialNotYetValid"
  /** An external command exited non-zero or produced unusable output. */
  | "CommandFailed"
  /** The registry reports this credential as revoked. */
  | "CredentialRevoked"
  /** The registry has never seen this credential hash. */
  | "CredentialUnknown"
  /** The credential's issuer exists in the registry but is deactivated. */
  | "IssuerInactive"
  /** The credential's issuer is not registered at all. */
  | "IssuerNotRegistered"
  /** The credential names a different registry than the verifier trusts. */
  | "RegistryMismatch"
  /** A CLI command's arguments are missing, malformed, or mutually exclusive. */
  | "InvalidArguments"
  /** A string is not a well-formed `<slug>:<contract id>` venue id. */
  | "InvalidVenueId"
  /** A string is not a well-formed `<CODE>:<issuer>` asset id. */
  | "InvalidAssetId"
  /** A venue registry row is malformed, or names a duplicate venue/asset. */
  | "InvalidVenueRegistry"
  /** A catalogue entry does not match the product schema. */
  | "InvalidProduct"
  /** The catalogue has no product with the requested id. */
  | "ProductNotFound"
  /** A venue answered a paid route with a `4xx` other than `402`: it read the request and declined to quote it. */
  | "MerchantRejectedRequest"
  /** No tool by that name is in the agent's tool set — including because it was withheld. */
  | "UnknownTool"
  /** A tool call's arguments do not match that tool's input schema. */
  | "InvalidToolInput"
  /** A value that should have been a non-negative decimal amount is not one. */
  | "InvalidAmount"
  /** `scope.actions` does not permit the action being attempted. */
  | "ScopeActionNotAllowed"
  /** `scope.venues` does not list the venue the purchase would happen at. */
  | "ScopeVenueNotAllowed"
  /** `scope.assets` does not list the asset the purchase would be paid in. */
  | "ScopeAssetNotAllowed"
  /** The spending limit is denominated in a different asset than the price. */
  | "ScopeCurrencyMismatch"
  /** The total would exceed `scope.limits.perTx`. */
  | "ScopeAmountExceeded"
  /** A purchase intent's payload does not match the intent schema. */
  | "InvalidIntent"
  /** `now` is past the intent's `expiresAt`. */
  | "IntentExpired"
  /** `now` is before the intent's `issuedAt`. */
  | "IntentNotYetValid"
  /** The signing key is not the one the document's subject identifies. */
  | "SignerMismatch"
  /** A natural-language purchase instruction matched no catalogue product. */
  | "InstructionNotUnderstood"
  /** A mandate's JWS is malformed, or its payload does not match the schema. */
  | "InvalidMandate"
  /** `now` is past the mandate's `validUntil`. */
  | "MandateExpired"
  /** `now` is before the mandate's `validFrom`. */
  | "MandateNotYetValid"
  /** The registry reports this mandate's anchored hash as revoked. */
  | "MandateRevoked"
  /** The registry has never seen this mandate's anchored hash. */
  | "MandateUnknown"
  /** The mandate's `credentialSubject.id` does not name the intent's agent. */
  | "MandateAgentMismatch"
  /** The mandate's `issuer` does not name the intent's principal. */
  | "MandatePrincipalMismatch"
  /** `grant.actions` does not permit the action an intent requires. */
  | "MandateActionNotAllowed"
  /** `grant.venues` does not list the venue an intent would purchase at. */
  | "MandateVenueNotAllowed"
  /** `grant.assets` does not list the asset an intent would spend. */
  | "MandateAssetNotAllowed"
  /** `grant.products` is present and does not list the product an intent would buy. */
  | "MandateProductNotAllowed"
  /** The venue this purchase names is not in the payable venue registry. */
  | "VenueNotRegistered"
  /** No discovery catalogue could answer — not "nothing is for sale", but "nobody replied". */
  | "CatalogUnavailable"
  /** The return URL's origin is not one this partner registered in advance. */
  | "ReturnUrlNotAllowed"
  /** The total exceeds the ceiling the partner itself declared for this purchase. */
  | "PurchaseCeilingExceeded"
  /** The paid route needs an input this purchase did not supply. */
  | "RouteParamMissing"
  /** A route input contradicts the purchase itself: its `quantity` is not the one the intent signs for (`C-132`). */
  | "RouteParamConflict"
  /** The pilot's sponsored testnet credit is exhausted, or its cap on sponsored rails is reached. */
  | "SponsoredCreditExhausted"
  /** The mandate's spending limit is denominated in a different asset than the price. */
  | "MandateCurrencyMismatch"
  /** An intent's `issuedAt` falls outside the mandate's validity window. */
  | "MandateWindowMismatch"
  /** The total would exceed `grant.limits.perTx`. */
  | "MandateAmountExceeded"
  /** Today's running total plus this purchase would exceed `scope.limits.perDay`. */
  | "ScopeDailyLimitExceeded"
  /** Today's running total plus this purchase would exceed `grant.limits.perDay`. */
  | "MandateDailyLimitExceeded"
  /** The venue is asking to be paid for a different venue than the intent names. */
  | "TermsVenueMismatch"
  /** The venue is asking to be paid in a different asset than the intent names. */
  | "TermsAssetMismatch"
  /** The venue is asking for a different amount than the intent's total. */
  | "TermsAmountMismatch"
  /** The mandate's `grant.payTo` does not list the account the venue asks to be paid. */
  | "TermsPayeeNotAllowed"
  /** A `MandateVault` file is not well-formed JSON Lines of vault records. */
  | "VaultCorrupted"
  /** A spend was asked to be released for an intent that has no recorded spend to give back. */
  | "SpendNotRecorded"
  /** A spend was asked to be released for an intent whose payment is already anchored on-chain. */
  | "SpendAlreadySettled"
  /** The agent's `policy_rail` does not hold enough USDC to pay for this purchase. */
  | "RailInsufficientFunds"
  /** The x402 client could not build the payment, before anything was signed or sent: nothing was paid. */
  | "PaymentNotCreated"
  /** A webhook endpoint's URL is not one this platform will send to — wrong scheme, a port, or an address that does not route publicly. */
  | "WebhookUrlNotAllowed"
  /** No webhook endpoint visible to this partner has that id. */
  | "WebhookEndpointNotFound"
  /** This API key made more requests in the current window than its tier allows. */
  | "RateLimited"
  /** The request counter could not be read, and the route is one that is refused rather than let through uncounted. */
  | "RateLimiterUnavailable"
  /** A tenant index is negative, non-integer, or outside BIP-32's hardened range. */
  | "InvalidTenantIndex"
  /** A partner-supplied external reference is malformed, or looks like personal data. */
  | "InvalidExternalRef"
  /** No partner in the directory has that id. */
  | "PartnerNotFound"
  /** No tenant in the directory has that id. */
  | "TenantNotFound"
  /** This partner already has a tenant for that external reference. */
  | "TenantAlreadyExists"
  /** No agent instance in the directory has that id. */
  | "AgentNotFound"
  /** No purchase in the directory has that id. */
  | "PurchaseNotFound"
  /** A `/v1` request carried no `Authorization` header at all. */
  | "MissingApiKey"
  /**
   * The `Authorization` header's secret is malformed, unknown, or belongs to
   * a revoked key. Deliberately one code for all three: telling a caller
   * "that key was revoked" instead of "that key is invalid" would confirm a
   * guessed secret once existed, which is a leak in itself.
   */
  | "InvalidApiKey"
  /** The API key authenticated, but its `scopes` do not cover this route. */
  | "ScopeNotGranted"
  /** A `/v1` route that creates state was called without `Idempotency-Key`. */
  | "IdempotencyKeyRequired"
  /** The same `Idempotency-Key` was replayed with a different request body. */
  | "IdempotencyKeyConflict"
  /** No mandate visible to this partner has that id. */
  | "MandateNotFound"
  /** No consent session visible to this partner has that id. */
  | "ConsentSessionNotFound"
  /** The consent session's invitation window has passed — its link can no longer be signed. */
  | "ConsentSessionExpired"
  /** The consent session was already signed; a second principal cannot complete it again. */
  | "ConsentSessionAlreadyCompleted"
  /** The server-wide cap on automatic issuer registrations (`G10`) was reached — the admin key stops paying for more until the window resets. */
  | "IssuerRegistrationRateLimited";

/** Structured, non-secret context attached to an error for logs and tests. */
export type AgentPassErrorDetails = Readonly<Record<string, unknown>>;

export interface AgentPassErrorOptions {
  readonly cause?: unknown;
  readonly details?: AgentPassErrorDetails;
}

export class AgentPassError extends Error {
  override readonly name = "AgentPassError";
  readonly code: AgentPassErrorCode;
  readonly details: AgentPassErrorDetails;

  constructor(
    code: AgentPassErrorCode,
    message: string,
    options: AgentPassErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
  }
}

/** Narrowing guard — safe against errors crossing realm or package boundaries. */
export function isAgentPassError(value: unknown): value is AgentPassError {
  return value instanceof AgentPassError;
}

/** True when `value` is an AgentPassError carrying exactly `code`. */
export function hasErrorCode<C extends AgentPassErrorCode>(
  value: unknown,
  code: C,
): value is AgentPassError & { readonly code: C } {
  return isAgentPassError(value) && value.code === code;
}
