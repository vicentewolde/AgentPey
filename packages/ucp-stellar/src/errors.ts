/**
 * Every failure this package raises is a {@link UcpStellarError} with a
 * machine-readable `code`. Branch on `code`, never on the message.
 *
 * `paymentSent` answers the one question a caller must answer before retrying
 * or giving money back: could a signed payment have left this process? It is
 * `false` only when the failure happened before the payment was handed to the
 * store. When it is `true`, the store may have settled the payment: read the
 * checkout before trying again.
 */
export const UCP_STELLAR_ERROR_CODES = [
  /** The input to a call is missing, malformed, or names two forms at once. */
  "InvalidArguments",
  /** The store's handler, or its checkout, is on a network other than Stellar testnet. */
  "UnsupportedNetwork",
  /** The store does not publish a usable UCP profile or Stellar handler, or did not open a payable checkout. */
  "MerchantRejectedRequest",
  /** The checkout asks to pay someone or something other than the store declares, or is for other lines. */
  "InvalidProduct",
  /** Read again before paying, the store's profile or checkout no longer says what it quoted. */
  "QuoteChanged",
  /** The checkout costs more than the `maxAmount` the caller allowed. */
  "AmountAboveLimit",
  /** The payment could not be built or signed; nothing was sent. */
  "PaymentNotCreated",
  /** The paying `policy_rail` does not hold enough of the asset. */
  "RailInsufficientFunds",
  /** A remote call failed, or the store did not confirm the completed checkout. */
  "NetworkError",
] as const;

export type UcpStellarErrorCode = (typeof UCP_STELLAR_ERROR_CODES)[number];

export interface UcpStellarErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly paymentSent?: boolean;
}

export class UcpStellarError extends Error {
  override readonly name = "UcpStellarError";
  readonly code: UcpStellarErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  /** Whether a signed payment may have reached the store. `false` means nothing was sent. */
  readonly paymentSent: boolean;

  constructor(code: UcpStellarErrorCode, message: string, options: UcpStellarErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
    this.paymentSent = options.paymentSent ?? false;
  }

  /** The same error, stamped with whether the payment was sent. */
  withPaymentSent(paymentSent: boolean): UcpStellarError {
    if (paymentSent === this.paymentSent) return this;
    return new UcpStellarError(this.code, this.message, { cause: this.cause, details: this.details, paymentSent });
  }
}

/** Also true for an error from another copy of this package in the same process (two versions installed side by side). */
export function isUcpStellarError(error: unknown): error is UcpStellarError {
  if (error instanceof UcpStellarError) return true;
  if (!(error instanceof Error) || error.name !== "UcpStellarError") return false;
  const { code, paymentSent } = error as Partial<UcpStellarError>;
  return typeof paymentSent === "boolean" && (UCP_STELLAR_ERROR_CODES as readonly unknown[]).includes(code);
}
