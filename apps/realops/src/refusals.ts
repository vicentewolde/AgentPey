/**
 * Turning a typed refusal code into a sentence a person can act on.
 *
 * **Why this is RealOps' job and not AgentPey's.** The platform already
 * answers with both: `code`, which an integrator branches on, and `reason`,
 * which is a sentence. Keeping them separate is deliberate (`purchases.ts`
 * says so: conflating them forces one audience to live with the other's
 * needs). What the platform cannot know is *this* product's vocabulary — that
 * the venue is "SignalDesk", that the limit was set on a screen called
 * "permisos", that the person chose 0.30 with a slider ten minutes ago. So the
 * code crosses the boundary and the sentence is written here, where that
 * context exists.
 *
 * **And it does not invent.** A code this table does not know falls back to
 * the platform's own `reason`, prefixed with the code itself, rather than to a
 * cheerful guess. The brief requires every refusal to leave "un mensaje
 * comprensible"; a message that is comprehensible and wrong is worse than one
 * that is unpolished and true.
 */

export interface ExplainedRefusal {
  /** One sentence: what happened. */
  readonly what: string;
  /** One sentence: what the person can do about it, or "" when nothing. */
  readonly next: string;
}

/**
 * The refusals this pilot can actually produce, in the order a person meets
 * them. Every entry corresponds to a layer that says no, and the acceptance
 * cases of the brief § 7 are covered by this table.
 */
const EXPLANATIONS: Readonly<Record<string, ExplainedRefusal>> = {
  // --- The registry, before any network call (case 3) -----------------------
  VenueNotRegistered: {
    what: "AgentPey no conoce ese comercio, así que no le pagó nada.",
    next: "Solo se puede comprar en comercios que AgentPey tiene registrados. No hay nada que arreglar de tu lado.",
  },
  ProductNotFound: {
    what: "El comercio no ofrece ese producto.",
    next: "Puede que lo haya dado de baja. Probá con el otro producto del catálogo.",
  },

  // --- The signed scope and mandate (cases 3 y 4) ---------------------------
  ScopeVenueNotAllowed: {
    what: "Tu permiso no autoriza compras en ese comercio.",
    next: "Firmá un permiso nuevo que lo incluya, si es lo que querés.",
  },
  MandateVenueNotAllowed: {
    what: "El Mandato que firmaste no incluye ese comercio.",
    next: "Firmá un permiso nuevo que lo incluya, si es lo que querés.",
  },
  MandateProductNotAllowed: {
    what: "Tu permiso cubre este comercio, pero no ese producto en particular.",
    next: "Cada agente puede comprar solo su propio producto. Usá el agente correspondiente, o firmá un permiso que incluya el otro.",
  },
  ScopeAssetNotAllowed: {
    what: "El pago sería en un activo que tu permiso no autoriza.",
    next: "No hace falta que hagas nada: AgentPey prefirió no pagar antes que pagar en algo que no firmaste.",
  },
  MandateAssetNotAllowed: {
    what: "El Mandato no autoriza ese activo.",
    next: "No hace falta que hagas nada: se rechazó antes de pagar.",
  },
  ScopeAmountExceeded: {
    what: "El precio supera tu máximo por compra.",
    next: "Podés firmar un permiso nuevo con un tope más alto, si de verdad querés gastar eso.",
  },
  MandateAmountExceeded: {
    what: "El precio supera el máximo por compra que firmaste.",
    next: "Podés firmar un permiso nuevo con un tope más alto.",
  },
  ScopeDailyLimitExceeded: {
    what: "Esta compra haría que superes tu tope de gasto del día.",
    next: "El tope se reinicia mañana. También podés firmar un permiso nuevo con un límite diario mayor.",
  },
  MandateDailyLimitExceeded: {
    what: "Esta compra haría que superes el tope diario que firmaste.",
    next: "El tope se reinicia mañana. También podés firmar un permiso nuevo con un límite diario mayor.",
  },

  // --- The invoice against the mandate (case 5) -----------------------------
  TermsAmountMismatch: {
    what: "El comercio pidió un precio distinto al que correspondía, así que no se le pagó.",
    next: "No hay nada que hacer de tu lado. Es exactamente lo que tiene que pasar cuando los números no coinciden.",
  },
  TermsAssetMismatch: {
    what: "El comercio pidió cobrar en un activo distinto al autorizado.",
    next: "Se rechazó antes de pagar. No hay nada que hacer de tu lado.",
  },
  TermsVenueMismatch: {
    what: "La factura no corresponde al comercio que se estaba comprando.",
    next: "Se rechazó antes de pagar.",
  },
  TermsPayeeNotAllowed: {
    what: "El comercio pidió que se le pague a una cuenta que tu permiso no autoriza.",
    next: "Esto es justamente lo que el permiso protege. No hay nada que hacer de tu lado.",
  },

  // --- Documents that stopped being valid (case 6) --------------------------
  MandateExpired: {
    what: "Tu permiso venció.",
    next: "Firmá uno nuevo desde la pantalla de tu agente.",
  },
  MandateNotYetValid: {
    what: "Tu permiso todavía no empezó a regir.",
    next: "Esperá a la fecha de inicio, o firmá uno nuevo.",
  },
  MandateRevoked: {
    what: "Revocaste este permiso.",
    next: "Si querés volver a comprar, firmá uno nuevo.",
  },
  CredentialRevoked: {
    what: "La credencial del agente fue revocada.",
    next: "Firmá un permiso nuevo para que se emita una credencial nueva.",
  },
  CredentialExpired: {
    what: "La credencial del agente venció.",
    next: "Firmá un permiso nuevo.",
  },
  MandatePrincipalMismatch: {
    what: "La wallet que firmó no es la que este permiso nombra.",
    next: "Conectá la misma wallet con la que firmaste el permiso.",
  },
  SignerMismatch: {
    what: "Quien firmó no es quien debía firmar.",
    next: "Conectá la misma wallet con la que firmaste el permiso.",
  },

  // --- Money and capacity (case 8) ------------------------------------------
  SponsoredCreditExhausted: {
    what: "Se agotó el crédito de prueba que el piloto reparte.",
    next: "No es un problema tuyo: el piloto tiene un tope de cuentas y de fondos de testnet.",
  },
  PurchaseCeilingExceeded: {
    what: "El precio superó el tope que esta plataforma puso para esta compra.",
    next: "Ese tope es de RealOps, no de tu permiso. Probá de nuevo.",
  },

  // --- The merchant, or the network (case 9) --------------------------------
  NetworkError: {
    what: "No se pudo hablar con el comercio.",
    next: "Puede estar caído. Probá de nuevo en un rato — no se pagó nada.",
  },
  CatalogUnavailable: {
    what: "Ningún catálogo respondió, así que no se intentó ninguna compra.",
    next: "Probá de nuevo en un rato.",
  },
  RouteParamMissing: {
    what: "El comercio pide un dato que esta plataforma no le mandó.",
    next: "Es un problema nuestro, no tuyo. Ya quedó registrado.",
  },
  InvalidProduct: {
    what: "El comercio respondió algo que AgentPey no pudo leer, así que no le pagó.",
    next: "Probá de nuevo en un rato.",
  },
  MerchantRejectedRequest: {
    what: "El comercio rechazó el pedido antes de cotizarlo, así que no se pagó nada.",
    next: "Es un problema entre esta plataforma y el comercio, no tuyo. Ya quedó registrado.",
  },

  // --- Nothing signed to act with (found running the suite, T85) ------------
  MandateNotFound: {
    what: "Este agente no tiene un permiso firmado que esté vigente.",
    next: "Firmá el permiso desde la pantalla de tu agente.",
  },
  CredentialNotFound: {
    what: "Este agente todavía no tiene una credencial emitida.",
    next: "Firmá el permiso desde la pantalla de tu agente: la credencial se emite en ese momento.",
  },
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
  return {
    what: platformReason ?? "AgentPey rechazó la compra.",
    next: `Código: ${code}. Si no se entiende, es una falla nuestra de redacción, no del rechazo.`,
  };
}

/** Every code this table explains — used by a test to keep it honest about its coverage. */
export const EXPLAINED_CODES: readonly string[] = Object.keys(EXPLANATIONS);
