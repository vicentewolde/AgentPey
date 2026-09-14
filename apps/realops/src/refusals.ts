/**
 * Turning a typed refusal code into a sentence a person can act on.
 *
 * **Why this is RealOps' job and not AgentPey's.** The platform already
 * answers with both: `code`, which an integrator branches on, and `reason`,
 * which is a sentence. Keeping them separate is deliberate (`purchases.ts`
 * says so: conflating them forces one audience to live with the other's
 * needs). What the platform cannot know is *this* product's vocabulary — that
 * the venue is "SignalDesk", that the limit was set on a screen called
 * "permissions", that the person chose 0.30 with a slider ten minutes ago. So
 * the code crosses the boundary and the sentence is written here, where that
 * context exists.
 *
 * **And it does not invent.** A code this table does not know falls back to
 * the platform's own `reason`, prefixed with the code itself, rather than to a
 * cheerful guess. The brief requires every refusal to leave "un mensaje
 * comprensible"; a message that is comprehensible and wrong is worse than one
 * that is unpolished and true.
 */
import { bilingual, type Bilingual } from "./copy.js";

export interface ExplainedRefusal {
  /** One sentence: what happened. */
  readonly what: Bilingual;
  /** One sentence: what the person can do about it. */
  readonly next: Bilingual;
}

function explained(what: Bilingual, next: Bilingual): ExplainedRefusal {
  return { what, next };
}

const RESIGN_TO_INCLUDE = bilingual(
  "Sign a new permission that includes it, if that is what you want.",
  "Firma un permiso nuevo que lo incluya, si es lo que quieres.",
);
const DAILY_RESET = bilingual(
  "The limit resets tomorrow. You can also sign a new permission with a higher daily limit.",
  "El tope se reinicia mañana. También puedes firmar un permiso nuevo con un límite diario mayor.",
);
const SAME_WALLET = bilingual(
  "Connect the same wallet you signed the permission with.",
  "Conecta la misma wallet con la que firmaste el permiso.",
);
const TRY_LATER = bilingual("Try again in a little while.", "Inténtalo de nuevo en un momento.");

/**
 * The refusals this pilot can actually produce, in the order a person meets
 * them. Every entry corresponds to a layer that says no, and the acceptance
 * cases of the brief § 7 are covered by this table.
 */
const EXPLANATIONS: Readonly<Record<string, ExplainedRefusal>> = {
  // --- The registry, before any network call (case 3) -----------------------
  VenueNotRegistered: explained(
    bilingual("AgentPey does not know that merchant, so it paid nothing.", "AgentPey no conoce ese comercio, así que no le pagó nada."),
    bilingual(
      "Purchases only go to merchants AgentPey has registered. There is nothing to fix on your side.",
      "Solo se puede comprar en comercios que AgentPey tiene registrados. No hay nada que arreglar de tu lado.",
    ),
  ),
  ProductNotFound: explained(
    bilingual("The merchant does not offer that product.", "El comercio no ofrece ese producto."),
    bilingual(
      "It may have been withdrawn. Try the other product in the catalog.",
      "Puede que lo haya dado de baja. Prueba con el otro producto del catálogo.",
    ),
  ),

  // --- The signed scope and mandate (cases 3 y 4) ---------------------------
  ScopeVenueNotAllowed: explained(
    bilingual("Your permission does not allow purchases at that merchant.", "Tu permiso no autoriza compras en ese comercio."),
    RESIGN_TO_INCLUDE,
  ),
  MandateVenueNotAllowed: explained(
    bilingual("The Mandate you signed does not include that merchant.", "El Mandato que firmaste no incluye ese comercio."),
    RESIGN_TO_INCLUDE,
  ),
  MandateProductNotAllowed: explained(
    bilingual(
      "Your permission covers this merchant, but not that particular product.",
      "Tu permiso cubre este comercio, pero no ese producto en particular.",
    ),
    bilingual(
      "Each agent can only buy its own product. Use the matching agent, or sign a permission that includes the other one.",
      "Cada agente puede comprar solo su propio producto. Usa el agente correspondiente, o firma un permiso que incluya el otro.",
    ),
  ),
  ScopeAssetNotAllowed: explained(
    bilingual("The payment would be in an asset your permission does not allow.", "El pago sería en un activo que tu permiso no autoriza."),
    bilingual(
      "You do not need to do anything: AgentPey chose not to pay rather than pay in something you did not sign.",
      "No necesitas hacer nada: AgentPey prefirió no pagar antes que pagar en algo que no firmaste.",
    ),
  ),
  MandateAssetNotAllowed: explained(
    bilingual("The Mandate does not allow that asset.", "El Mandato no autoriza ese activo."),
    bilingual(
      "You do not need to do anything: it was refused before paying.",
      "No necesitas hacer nada: se rechazó antes de pagar.",
    ),
  ),
  ScopeAmountExceeded: explained(
    bilingual("The price is above your maximum per purchase.", "El precio supera tu máximo por compra."),
    bilingual(
      "You can sign a new permission with a higher limit, if you really want to spend that much.",
      "Puedes firmar un permiso nuevo con un tope más alto, si de verdad quieres gastar eso.",
    ),
  ),
  MandateAmountExceeded: explained(
    bilingual("The price is above the maximum per purchase you signed.", "El precio supera el máximo por compra que firmaste."),
    bilingual("You can sign a new permission with a higher limit.", "Puedes firmar un permiso nuevo con un tope más alto."),
  ),
  ScopeDailyLimitExceeded: explained(
    bilingual("This purchase would take you over your daily spending limit.", "Esta compra haría que superes tu tope de gasto del día."),
    DAILY_RESET,
  ),
  MandateDailyLimitExceeded: explained(
    bilingual("This purchase would take you over the daily limit you signed.", "Esta compra haría que superes el tope diario que firmaste."),
    DAILY_RESET,
  ),

  // --- The invoice against the mandate (case 5) -----------------------------
  TermsAmountMismatch: explained(
    bilingual(
      "The merchant asked for a different price than expected, so it was not paid.",
      "El comercio pidió un precio distinto al que correspondía, así que no se le pagó.",
    ),
    bilingual(
      "There is nothing to do on your side. This is exactly what should happen when the numbers do not match.",
      "No hay nada que hacer de tu lado. Es exactamente lo que debe pasar cuando los números no coinciden.",
    ),
  ),
  TermsAssetMismatch: explained(
    bilingual("The merchant asked to be paid in an asset that was not allowed.", "El comercio pidió cobrar en un activo distinto al autorizado."),
    bilingual(
      "It was refused before paying. There is nothing to do on your side.",
      "Se rechazó antes de pagar. No hay nada que hacer de tu lado.",
    ),
  ),
  TermsVenueMismatch: explained(
    bilingual(
      "The invoice does not belong to the merchant being bought from.",
      "La factura no corresponde al comercio al que se estaba comprando.",
    ),
    bilingual("It was refused before paying.", "Se rechazó antes de pagar."),
  ),
  TermsPayeeNotAllowed: explained(
    bilingual(
      "The merchant asked to be paid to an account your permission does not allow.",
      "El comercio pidió que se le pague a una cuenta que tu permiso no autoriza.",
    ),
    bilingual(
      "This is exactly what the permission protects. There is nothing to do on your side.",
      "Esto es justamente lo que el permiso protege. No hay nada que hacer de tu lado.",
    ),
  ),

  // --- Documents that stopped being valid (case 6) --------------------------
  MandateExpired: explained(
    bilingual("Your permission expired.", "Tu permiso venció."),
    bilingual("Sign a new one from your agent's page.", "Firma uno nuevo desde la página de tu agente."),
  ),
  MandateNotYetValid: explained(
    bilingual("Your permission is not in effect yet.", "Tu permiso todavía no entra en vigencia."),
    bilingual("Wait for its start date, or sign a new one.", "Espera a la fecha de inicio, o firma uno nuevo."),
  ),
  MandateRevoked: explained(
    bilingual("You revoked this permission.", "Revocaste este permiso."),
    bilingual("If you want to buy again, sign a new one.", "Si quieres volver a comprar, firma uno nuevo."),
  ),
  CredentialRevoked: explained(
    bilingual("The agent's credential was revoked.", "La credencial del agente fue revocada."),
    bilingual(
      "Sign a new permission so a new credential is issued.",
      "Firma un permiso nuevo para que se emita una credencial nueva.",
    ),
  ),
  CredentialExpired: explained(
    bilingual("The agent's credential expired.", "La credencial del agente venció."),
    bilingual("Sign a new permission to get a fresh one.", "Firma un permiso nuevo para obtener una credencial vigente."),
  ),
  MandatePrincipalMismatch: explained(
    bilingual("The wallet that signed is not the one this permission names.", "La wallet que firmó no es la que nombra este permiso."),
    SAME_WALLET,
  ),
  SignerMismatch: explained(
    bilingual("Whoever signed is not who was supposed to sign.", "Quien firmó no es quien debía firmar."),
    SAME_WALLET,
  ),

  // --- Money and capacity (case 8) ------------------------------------------
  SponsoredCreditExhausted: explained(
    bilingual("The pilot's test credit has run out.", "Se agotó el crédito de prueba que reparte el piloto."),
    bilingual(
      "This is not a problem on your side: the pilot has a cap on accounts and on testnet funds.",
      "No es un problema tuyo: el piloto tiene un tope de cuentas y de fondos de testnet.",
    ),
  ),
  PurchaseCeilingExceeded: explained(
    bilingual(
      "The price went over the cap this platform set for this purchase.",
      "El precio superó el tope que esta plataforma puso para esta compra.",
    ),
    bilingual(
      "That cap belongs to RealOps, not to your permission. Try again.",
      "Ese tope es de RealOps, no de tu permiso. Inténtalo de nuevo.",
    ),
  ),

  // --- The merchant, or the network (case 9) --------------------------------
  NetworkError: explained(
    bilingual("Could not reach the merchant.", "No se pudo hablar con el comercio."),
    bilingual(
      "It may be down. Try again in a little while. Nothing was paid.",
      "Puede estar caído. Inténtalo de nuevo en un momento. No se pagó nada.",
    ),
  ),
  CatalogUnavailable: explained(
    bilingual("No catalog answered, so no purchase was attempted.", "Ningún catálogo respondió, así que no se intentó ninguna compra."),
    TRY_LATER,
  ),
  RouteParamMissing: explained(
    bilingual(
      "The merchant needs a value this platform did not send.",
      "El comercio pide un dato que esta plataforma no le envió.",
    ),
    bilingual("The problem is ours, not yours. It has been logged.", "Es un problema nuestro, no tuyo. Ya quedó registrado."),
  ),
  InvalidProduct: explained(
    bilingual(
      "The merchant answered something AgentPey could not read, so it paid nothing.",
      "El comercio respondió algo que AgentPey no pudo leer, así que no le pagó.",
    ),
    TRY_LATER,
  ),
  MerchantRejectedRequest: explained(
    bilingual(
      "The merchant rejected the request before quoting it, so nothing was paid.",
      "El comercio rechazó el pedido antes de cotizarlo, así que no se pagó nada.",
    ),
    bilingual(
      "The problem is between this platform and the merchant, not yours. It has been logged.",
      "Es un problema entre esta plataforma y el comercio, no tuyo. Ya quedó registrado.",
    ),
  ),

  // --- Nothing signed to act with (found running the suite, T85) ------------
  MandateNotFound: explained(
    bilingual("This agent has no signed permission in effect.", "Este agente no tiene un permiso firmado que esté vigente."),
    bilingual("Sign the permission from your agent's page.", "Firma el permiso desde la página de tu agente."),
  ),
  CredentialNotFound: explained(
    bilingual("This agent has no credential issued yet.", "Este agente todavía no tiene una credencial emitida."),
    bilingual(
      "Sign the permission from your agent's page: the credential is issued at that moment.",
      "Firma el permiso desde la página de tu agente: la credencial se emite en ese momento.",
    ),
  ),
};

/**
 * Explains one refusal.
 *
 * `platformReason` is AgentPey's own sentence, used verbatim when the code is
 * one this table does not know — a new refusal code appearing in production
 * must degrade to "the truth, awkwardly phrased" and never to a friendly
 * sentence that describes a different failure.
 */
export function explainRefusal(code: string, platformReason: string | null): ExplainedRefusal {
  const known = EXPLANATIONS[code];
  if (known !== undefined) return known;
  return explained(
    bilingual(platformReason ?? "AgentPey refused the purchase.", platformReason ?? "AgentPey rechazó la compra."),
    bilingual(
      `Code: ${code}. If this is unclear, the fault is in our wording, not in the refusal.`,
      `Código: ${code}. Si no se entiende, es una falla de nuestra redacción, no del rechazo.`,
    ),
  );
}

/** Every code this table explains — used by a test to keep it honest about its coverage. */
export const EXPLAINED_CODES: readonly string[] = Object.keys(EXPLANATIONS);
