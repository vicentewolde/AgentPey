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
 * **Every code a purchase can come back with has a sentence** (T89). Three
 * codes reached people in production untranslated (`ScopeActionNotAllowed`,
 * `MandateActionNotAllowed`, `UnknownTool`), and what they read was the
 * platform's English reason next to the code. A code this table still does
 * not know gets a plain sentence that says so, with the platform's reason kept
 * as a technical detail: never a friendly sentence describing a different
 * failure.
 *
 * The groups below are also the source of `docs/fase-6-agentguard-comercializacion/CODIGOS-DE-RECHAZO.md`
 * (`pnpm run docs:refusal-codes`), so the table the team reads cannot drift
 * from what people see.
 */
import { bilingual, type Bilingual } from "./copy.js";

export interface ExplainedRefusal {
  /** One sentence: what happened. */
  readonly what: Bilingual;
  /** One sentence: what the person can do about it. */
  readonly next: Bilingual;
}

export interface RefusalGroup {
  /** The layer that says no, in the words of the documentation table. */
  readonly layer: Bilingual;
  readonly explanations: Readonly<Record<string, ExplainedRefusal>>;
}

function explained(what: Bilingual, next: Bilingual): ExplainedRefusal {
  return { what, next };
}

const RESIGN_TO_INCLUDE = bilingual(
  "Sign a new permission that includes it, if that is what you want.",
  "Firma un permiso nuevo que lo incluya, si es lo que quieres.",
);
const RESIGN = bilingual(
  "Sign the permission again from your agent's page.",
  "Firma el permiso de nuevo desde la página de tu agente.",
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
const OURS = bilingual(
  "The problem is ours, not yours. It has been logged.",
  "Es un problema nuestro, no tuyo. Ya quedó registrado.",
);
const NOTHING_TO_DO = bilingual(
  "Nothing was paid, and there is nothing to do on your side.",
  "No se pagó nada, y no hay nada que hacer de tu lado.",
);

/**
 * The refusals a purchase can come back with, grouped by the layer that says
 * no, in the order a purchase meets them. The acceptance cases of the brief
 * § 7 are all covered.
 */
export const REFUSAL_GROUPS: readonly RefusalGroup[] = [
  {
    layer: bilingual("The merchant registry and the catalog, before anything is paid", "El registro de comercios y el catálogo, antes de pagar nada"),
    explanations: {
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
      CatalogUnavailable: explained(
        bilingual("No catalog answered, so no purchase was attempted.", "Ningún catálogo respondió, así que no se intentó ninguna compra."),
        TRY_LATER,
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
      RouteParamMissing: explained(
        bilingual("The merchant needs a value this platform did not send.", "El comercio pide un dato que esta plataforma no le envió."),
        OURS,
      ),
      RouteParamConflict: explained(
        bilingual(
          "The quantity sent to the merchant did not match the quantity being bought, so nothing was paid.",
          "La cantidad que se le iba a mandar al comercio no coincidía con la de la compra, así que no se pagó nada.",
        ),
        OURS,
      ),
      InvalidVenueId: explained(
        bilingual("The merchant is set up wrongly on AgentPey, so nothing was paid.", "El comercio está mal configurado en AgentPey, así que no se pagó nada."),
        OURS,
      ),
      InvalidAssetId: explained(
        bilingual("The payment currency is set up wrongly on AgentPey, so nothing was paid.", "La moneda de pago está mal configurada en AgentPey, así que no se pagó nada."),
        OURS,
      ),
      InvalidVenueRegistry: explained(
        bilingual("AgentPey's list of merchants is set up wrongly, so nothing was paid.", "La lista de comercios de AgentPey está mal configurada, así que no se pagó nada."),
        OURS,
      ),
    },
  },
  {
    layer: bilingual("The agent's credential: who operates it and what it may do", "La credencial del agente: quién lo opera y qué puede hacer"),
    explanations: {
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
      CredentialNotYetValid: explained(
        bilingual("The agent's credential is not in effect yet.", "La credencial del agente todavía no entra en vigencia."),
        bilingual("Try again in a few minutes.", "Inténtalo de nuevo en unos minutos."),
      ),
      CredentialNotFound: explained(
        bilingual("This agent has no credential issued yet.", "Este agente todavía no tiene una credencial emitida."),
        bilingual(
          "Sign the permission from your agent's page: the credential is issued at that moment.",
          "Firma el permiso desde la página de tu agente: la credencial se emite en ese momento.",
        ),
      ),
      CredentialUnknown: explained(
        bilingual("Stellar has no record of the agent's credential.", "Stellar no tiene registro de la credencial del agente."),
        RESIGN,
      ),
      InvalidCredential: explained(
        bilingual("The agent's credential could not be read.", "No se pudo leer la credencial del agente."),
        RESIGN,
      ),
      IssuerInactive: explained(
        bilingual("Whoever issued the agent's credential has been deactivated.", "Quien emitió la credencial del agente está desactivado."),
        OURS,
      ),
      IssuerNotRegistered: explained(
        bilingual("Whoever issued the agent's credential is not registered on Stellar.", "Quien emitió la credencial del agente no está registrado en Stellar."),
        OURS,
      ),
      RegistryMismatch: explained(
        bilingual(
          "The agent's credential points to a different registry than the one AgentPey trusts.",
          "La credencial del agente apunta a un registro distinto del que AgentPey reconoce.",
        ),
        OURS,
      ),
      UnknownTool: explained(
        bilingual(
          "The agent was not allowed to buy, usually because its credential was revoked or is not valid.",
          "Al agente no se le permitió comprar, normalmente porque su credencial fue revocada o no es válida.",
        ),
        RESIGN,
      ),
      ScopeActionNotAllowed: explained(
        bilingual("The agent's credential does not allow it to create purchases.", "La credencial del agente no le permite crear compras."),
        bilingual(
          "Sign a new permission from your agent's page, so a credential that allows buying is issued.",
          "Firma un permiso nuevo desde la página de tu agente, para que se emita una credencial que permita comprar.",
        ),
      ),
      ScopeVenueNotAllowed: explained(
        bilingual("Your permission does not allow purchases at that merchant.", "Tu permiso no autoriza compras en ese comercio."),
        RESIGN_TO_INCLUDE,
      ),
      ScopeAssetNotAllowed: explained(
        bilingual("The payment would be in an asset your permission does not allow.", "El pago sería en un activo que tu permiso no autoriza."),
        bilingual(
          "You do not need to do anything: AgentPey chose not to pay rather than pay in something you did not sign.",
          "No necesitas hacer nada: AgentPey prefirió no pagar antes que pagar en algo que no firmaste.",
        ),
      ),
      ScopeCurrencyMismatch: explained(
        bilingual("The price is in a different currency than your spending limit.", "El precio está en una moneda distinta de tu límite de gasto."),
        NOTHING_TO_DO,
      ),
      ScopeAmountExceeded: explained(
        bilingual("The price is above your maximum per purchase.", "El precio supera tu máximo por compra."),
        bilingual(
          "You can sign a new permission with a higher limit, if you really want to spend that much.",
          "Puedes firmar un permiso nuevo con un tope más alto, si de verdad quieres gastar eso.",
        ),
      ),
      ScopeDailyLimitExceeded: explained(
        bilingual("This purchase would take you over your daily spending limit.", "Esta compra haría que superes tu tope de gasto del día."),
        DAILY_RESET,
      ),
    },
  },
  {
    layer: bilingual("The Mandate you signed with your wallet", "El Mandato que firmaste con tu wallet"),
    explanations: {
      MandateNotFound: explained(
        bilingual("This agent has no signed permission in effect.", "Este agente no tiene un permiso firmado que esté vigente."),
        bilingual("Sign the permission from your agent's page.", "Firma el permiso desde la página de tu agente."),
      ),
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
      MandateUnknown: explained(
        bilingual("AgentPey cannot find your signed permission on Stellar.", "AgentPey no encuentra tu permiso firmado en Stellar."),
        RESIGN,
      ),
      InvalidMandate: explained(
        bilingual("Your signed permission could not be read.", "No se pudo leer tu permiso firmado."),
        RESIGN,
      ),
      MandateAgentMismatch: explained(
        bilingual("Your permission names a different agent than the one trying to buy.", "Tu permiso nombra a un agente distinto del que intenta comprar."),
        bilingual("Sign the permission from this agent's page.", "Firma el permiso desde la página de este agente."),
      ),
      MandatePrincipalMismatch: explained(
        bilingual("The wallet that signed is not the one this permission names.", "La wallet que firmó no es la que nombra este permiso."),
        SAME_WALLET,
      ),
      SignerMismatch: explained(
        bilingual("Whoever signed is not who was supposed to sign.", "Quien firmó no es quien debía firmar."),
        SAME_WALLET,
      ),
      InvalidSignature: explained(
        bilingual("A signature did not check out, so nothing was paid.", "Una firma no resultó válida, así que no se pagó nada."),
        SAME_WALLET,
      ),
      MandateActionNotAllowed: explained(
        bilingual("The permission you signed does not allow creating purchases.", "El permiso que firmaste no permite crear compras."),
        bilingual(
          "Sign a new permission from your agent's page: the ones RealOps proposes allow buying.",
          "Firma un permiso nuevo desde la página de tu agente: los que propone RealOps permiten comprar.",
        ),
      ),
      MandateVenueNotAllowed: explained(
        bilingual("The Mandate you signed does not include that merchant.", "El Mandato que firmaste no incluye ese comercio."),
        RESIGN_TO_INCLUDE,
      ),
      MandateAssetNotAllowed: explained(
        bilingual("The Mandate does not allow that asset.", "El Mandato no autoriza ese activo."),
        bilingual("You do not need to do anything: it was refused before paying.", "No necesitas hacer nada: se rechazó antes de pagar."),
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
      MandateCurrencyMismatch: explained(
        bilingual("The price is in a different currency than the limit you signed.", "El precio está en una moneda distinta del límite que firmaste."),
        NOTHING_TO_DO,
      ),
      MandateWindowMismatch: explained(
        bilingual("The purchase fell outside the dates your permission is valid for.", "La compra quedó fuera de las fechas en que tu permiso es válido."),
        bilingual("Sign a new permission with current dates.", "Firma un permiso nuevo con fechas vigentes."),
      ),
      MandateAmountExceeded: explained(
        bilingual("The price is above the maximum per purchase you signed.", "El precio supera el máximo por compra que firmaste."),
        bilingual("You can sign a new permission with a higher limit.", "Puedes firmar un permiso nuevo con un tope más alto."),
      ),
      MandateDailyLimitExceeded: explained(
        bilingual("This purchase would take you over the daily limit you signed.", "Esta compra haría que superes el tope diario que firmaste."),
        DAILY_RESET,
      ),
    },
  },
  {
    layer: bilingual("The purchase request the agent signs", "La intención de compra que firma el agente"),
    explanations: {
      InvalidIntent: explained(
        bilingual("The purchase request could not be read, so nothing was paid.", "No se pudo leer la intención de compra, así que no se pagó nada."),
        OURS,
      ),
      IntentExpired: explained(
        bilingual("The purchase request expired before it could be paid.", "La intención de compra venció antes de poder pagarse."),
        bilingual("Ask for it again.", "Pídela de nuevo."),
      ),
      IntentNotYetValid: explained(
        bilingual("The purchase request is dated in the future.", "La intención de compra tiene una fecha futura."),
        OURS,
      ),
      InvalidToolInput: explained(
        bilingual("The agent sent the purchase with incomplete data.", "El agente envió la compra con datos incompletos."),
        OURS,
      ),
      InvalidAmount: explained(
        bilingual("A price or amount was not a valid number, so nothing was paid.", "Un precio o monto no era un número válido, así que no se pagó nada."),
        OURS,
      ),
    },
  },
  {
    layer: bilingual("The merchant's invoice, checked against the Mandate", "La factura del comercio, comparada con el Mandato"),
    explanations: {
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
        bilingual("It was refused before paying. There is nothing to do on your side.", "Se rechazó antes de pagar. No hay nada que hacer de tu lado."),
      ),
      TermsVenueMismatch: explained(
        bilingual(
          "The invoice does not belong to the merchant being bought from.",
          "La factura no corresponde al comercio al que se estaba comprando.",
        ),
        bilingual("It was refused before paying. There is nothing to do on your side.", "Se rechazó antes de pagar. No hay nada que hacer de tu lado."),
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
    },
  },
  {
    layer: bilingual("Money, capacity and the network", "Dinero, capacidad y red"),
    explanations: {
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
        bilingual("That cap belongs to RealOps, not to your permission. Try again.", "Ese tope es de RealOps, no de tu permiso. Inténtalo de nuevo."),
      ),
      PaymentNotCreated: explained(
        bilingual(
          "The payment could not be prepared, so nothing was sent and nothing was paid.",
          "No se pudo preparar el pago, así que no se envió nada y no se pagó nada.",
        ),
        bilingual(
          "It does not count against your daily limit. Try again; if it keeps happening, the pilot team has to look at it.",
          "No cuenta contra tu límite diario. Inténtalo de nuevo; si se repite, lo tiene que revisar el equipo del piloto.",
        ),
      ),
      RailInsufficientFunds: explained(
        bilingual(
          "Your agent's payment account does not have enough testnet USDC, so nothing was paid.",
          "La cuenta de pago de tu agente no tiene suficiente USDC de testnet, así que no se pagó nada.",
        ),
        bilingual(
          "Nothing was spent, and this purchase does not count against your daily limit. The pilot tops these accounts up; try again in a little while.",
          "No se gastó nada, y esta compra no cuenta contra tu límite diario. El piloto recarga esas cuentas; inténtalo de nuevo en un momento.",
        ),
      ),
      NetworkError: explained(
        bilingual("The payment could not go through, so nothing was paid.", "El pago no se pudo completar, así que no se pagó nada."),
        bilingual(
          "The merchant, the Stellar network or the contract that pays may be unavailable or out of funds. Try again in a little while.",
          "El comercio, la red de Stellar o el contrato que paga pueden no estar disponibles o sin saldo. Inténtalo de nuevo en un momento.",
        ),
      ),
      ConfigError: explained(
        bilingual("AgentPey is set up wrongly and could not process the purchase. Nothing was paid.", "AgentPey está mal configurado y no pudo procesar la compra. No se pagó nada."),
        OURS,
      ),
    },
  },
];

const EXPLANATIONS: Readonly<Record<string, ExplainedRefusal>> = Object.assign(
  {},
  ...REFUSAL_GROUPS.map((group) => group.explanations),
) as Record<string, ExplainedRefusal>;

/**
 * Explains one refusal.
 *
 * A code this table does not know still gets a sentence a person can read,
 * and it says plainly that the page has no words for it. `platformReason`,
 * AgentPey's own English sentence, is kept next to the code as a technical
 * detail rather than shown as if it were the explanation.
 */
export function explainRefusal(code: string, platformReason: string | null): ExplainedRefusal {
  const known = EXPLANATIONS[code];
  if (known !== undefined) return known;
  const detail = platformReason === null ? code : `${code}, "${platformReason}"`;
  return explained(
    bilingual(
      "AgentPey refused the purchase for a reason this page cannot explain yet.",
      "AgentPey rechazó la compra por un motivo que esta página todavía no sabe explicar.",
    ),
    bilingual(`Nothing was paid. Technical detail: ${detail}.`, `No se pagó nada. Detalle técnico: ${detail}.`),
  );
}

/** Every code this table explains — used by a test to keep it honest about its coverage. */
export const EXPLAINED_CODES: readonly string[] = Object.keys(EXPLANATIONS);
