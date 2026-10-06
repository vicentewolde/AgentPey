/**
 * The one wallet interface AgentPey's signing screens use (T143): connect, sign a SEP-53 message, sign a
 * transaction. Written against the small part of Stellar Wallets Kit it needs, so it is tested without a browser;
 * `browser.ts` hands it the real kit.
 */
import { WalletError } from "./errors.js";
import { normalizeSignature } from "./signature.js";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/** What this layer uses of Stellar Wallets Kit's static API. */
export interface KitLike {
  authModal(): Promise<{ address: string }>;
  readonly selectedModule: { readonly productId: string; readonly productName: string };
  signMessage(message: string, opts: { address: string; networkPassphrase: string }): Promise<{ signedMessage: unknown; signerAddress?: string }>;
  signTransaction(xdr: string, opts: { address: string; networkPassphrase: string }): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  disconnect(): Promise<void>;
}

export interface Connected {
  readonly address: string;
  readonly walletId: string;
  readonly walletName: string;
}

/** The kit rejects with `{ code, message }`; code -3 is "this wallet does not support that function". */
export function toWalletError(error: unknown, during: "connect" | "message" | "transaction"): WalletError {
  if (error instanceof WalletError) return error;
  const message = typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : String(error);
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === -3 && during === "message") return new WalletError("MessagesUnsupported", "this wallet cannot sign messages, which this page needs", { cause: error });
  if (/reject|declin|denied|cancel|closed|dismiss/i.test(message)) return new WalletError("Declined", "the request was declined in the wallet", { cause: error });
  if (/not (installed|available|found|connected)|no wallet|unavailable/i.test(message)) return new WalletError("WalletUnavailable", message, { cause: error });
  return new WalletError("WalletFailed", message, { cause: error });
}

export function createWallet(kit: KitLike) {
  return {
    /** Opens the wallet picker and returns the account the person connected. */
    async connect(): Promise<Connected> {
      try {
        const { address } = await kit.authModal();
        return { address, walletId: kit.selectedModule.productId, walletName: kit.selectedModule.productName };
      } catch (error) {
        throw toWalletError(error, "connect");
      }
    },

    /**
     * Signs `message` (SEP-53) with `address`, and returns the signature as base64.
     * @throws WalletError `WrongAccount` when the wallet signed with another account (LOBSTR cannot be told which)
     */
    async signMessage(message: string, address: string): Promise<{ signature: string; signerAddress: string }> {
      let answer: { signedMessage: unknown; signerAddress?: string };
      try {
        answer = await kit.signMessage(message, { address, networkPassphrase: TESTNET_PASSPHRASE });
      } catch (error) {
        throw toWalletError(error, "message");
      }
      const signerAddress = answer.signerAddress ?? address;
      if (signerAddress !== address) throw new WalletError("WrongAccount", `the wallet signed with ${signerAddress}, not ${address}`);
      return { signature: normalizeSignature(answer.signedMessage), signerAddress };
    },

    /** Signs a transaction envelope (base64 XDR) on testnet with `address`. */
    async signTransaction(xdr: string, address: string): Promise<string> {
      let answer: { signedTxXdr: string; signerAddress?: string };
      try {
        answer = await kit.signTransaction(xdr, { address, networkPassphrase: TESTNET_PASSPHRASE });
      } catch (error) {
        throw toWalletError(error, "transaction");
      }
      if (answer.signerAddress !== undefined && answer.signerAddress !== address) throw new WalletError("WrongAccount", `the wallet signed with ${answer.signerAddress}, not ${address}`);
      if (typeof answer.signedTxXdr !== "string" || answer.signedTxXdr === "") throw new WalletError("WalletFailed", "the wallet returned no signed transaction");
      return answer.signedTxXdr;
    },

    async disconnect(): Promise<void> {
      await kit.disconnect().catch(() => undefined);
    },
  };
}
