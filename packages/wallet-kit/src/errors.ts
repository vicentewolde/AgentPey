/**
 * Every failure the wallet layer reports, with a `code` the screens turn into a message for the person. Thrown in
 * the browser, where `AgentPassError` (a server package) is not loaded.
 */
export type WalletErrorCode =
  /** The person closed the wallet picker or declined in the wallet. */
  | "Declined"
  /** The chosen wallet is not installed or not reachable. */
  | "WalletUnavailable"
  /** The wallet cannot sign messages, which this screen needs. */
  | "MessagesUnsupported"
  /** The wallet signed with another account than the one asked for. */
  | "WrongAccount"
  /** The wallet's signature is not a 64-byte signature in a shape we know. */
  | "SignatureMalformed"
  /** Anything else the wallet reported. */
  | "WalletFailed";

export class WalletError extends Error {
  override readonly name = "WalletError";
  constructor(
    readonly code: WalletErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}
