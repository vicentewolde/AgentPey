/**
 * What a person reads when the wallet layer fails, in the pages' two languages (English by default, neutral Latin
 * American Spanish). One place for the five signing screens, so they say the same thing.
 */
import type { WalletErrorCode } from "./errors.js";

export type Lang = "en" | "es";

const MESSAGES: Record<WalletErrorCode, Record<Lang, string>> = {
  Declined: { en: "You declined in the wallet. Nothing was signed.", es: "Lo rechazaste en la wallet. No se firmó nada." },
  WalletUnavailable: { en: "That wallet is not installed or does not answer. Install it, or choose another one.", es: "Esa wallet no está instalada o no responde. Instálala o elige otra." },
  MessagesUnsupported: { en: "That wallet cannot sign messages, and this page needs it to. Choose another wallet.", es: "Esa wallet no puede firmar mensajes, y esta página lo necesita. Elige otra wallet." },
  WrongAccount: { en: "The wallet signed with another account. Pick the right account in the wallet and try again.", es: "La wallet firmó con otra cuenta. Elige la cuenta correcta en la wallet y vuelve a intentarlo." },
  SignatureMalformed: { en: "The wallet returned a signature we cannot read. Try again, or choose another wallet.", es: "La wallet devolvió una firma que no podemos leer. Vuelve a intentarlo o elige otra wallet." },
  WalletFailed: { en: "The wallet reported an error: ", es: "La wallet informó un error: " },
};

/** The message for a wallet-layer error, or `undefined` for anything else (the page shows its own). */
export function describe(error: unknown, lang: Lang): string | undefined {
  if (typeof error !== "object" || error === null || (error as { name?: unknown }).name !== "WalletError") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in MESSAGES)) return undefined;
  const text = MESSAGES[code as WalletErrorCode][lang === "es" ? "es" : "en"];
  return code === "WalletFailed" ? `${text}${String((error as { message?: unknown }).message ?? "")}` : text;
}
