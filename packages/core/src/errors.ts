/**
 * Typed errors for the whole project. Every failure a caller can act on has a
 * stable `code`; the HTTP status is derived from it so the gateway never
 * invents statuses route by route.
 */
export const ERROR_CODES = [
  "ConfigError",
  "ValidationError",
  "ProductNotFound",
  "OrderNotFound",
  "ReceiptNotFound",
  "OutOfStock",
  "AdapterError",
  "PaymentError",
  "ReceiptInvalid",
  "AnchorError",
  "NetworkError",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  ConfigError: 500,
  ValidationError: 400,
  ProductNotFound: 404,
  OrderNotFound: 404,
  ReceiptNotFound: 404,
  OutOfStock: 409,
  AdapterError: 502,
  PaymentError: 402,
  ReceiptInvalid: 422,
  AnchorError: 502,
  NetworkError: 503,
};

export interface VitrineeErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class VitrineeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, options: VitrineeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VitrineeError";
    this.code = code;
    this.details = options.details ?? {};
    this.httpStatus = ERROR_HTTP_STATUS[code];
  }

  /** Wire shape. Never includes `cause`, which may carry secrets or stack traces. */
  toJSON(): { error: ErrorCode; message: string; details: Record<string, unknown> } {
    return { error: this.code, message: this.message, details: this.details };
  }
}

export function isVitrineeError(value: unknown): value is VitrineeError {
  return value instanceof VitrineeError;
}
