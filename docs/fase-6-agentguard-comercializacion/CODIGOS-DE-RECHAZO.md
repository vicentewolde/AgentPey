# Códigos de rechazo: qué significa cada uno

> Generado desde `apps/realops/src/refusals.ts` con `pnpm run docs:refusal-codes`.
> No se edita a mano: un test falla si este archivo no coincide con el código.

Cuando AgentPey rechaza una compra, responde con un **código** (por ejemplo
`MandateDailyLimitExceeded`). El código es para quien integra: es estable y se
puede usar en un programa. La persona no ve el código como explicación: RealOps
lo traduce a las dos frases de esta tabla, en español o en inglés, y deja el
código en letra chica como detalle técnico.

Son 56 códigos, agrupados por la capa que dice que no, en el orden en que
una compra pasa por ellas. Un código que no esté acá se muestra con una frase
que dice que la página todavía no sabe explicarlo, y el motivo original queda
como detalle técnico.

## El registro de comercios y el catálogo, antes de pagar nada

| Código | Qué ve la persona | Qué puede hacer |
|---|---|---|
| `VenueNotRegistered` | AgentPey no conoce ese comercio, así que no le pagó nada. | Solo se puede comprar en comercios que AgentPey tiene registrados. No hay nada que arreglar de tu lado. |
| `ProductNotFound` | El comercio no ofrece ese producto. | Puede que lo haya dado de baja. Prueba con el otro producto del catálogo. |
| `CatalogUnavailable` | Ningún catálogo respondió, así que no se intentó ninguna compra. | Inténtalo de nuevo en un momento. |
| `InvalidProduct` | El comercio respondió algo que AgentPey no pudo leer, así que no le pagó. | Inténtalo de nuevo en un momento. |
| `MerchantRejectedRequest` | El comercio rechazó el pedido antes de cotizarlo, así que no se pagó nada. | Es un problema entre esta plataforma y el comercio, no tuyo. Ya quedó registrado. |
| `RouteParamMissing` | El comercio pide un dato que esta plataforma no le envió. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `InvalidVenueId` | El comercio está mal configurado en AgentPey, así que no se pagó nada. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `InvalidAssetId` | La moneda de pago está mal configurada en AgentPey, así que no se pagó nada. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `InvalidVenueRegistry` | La lista de comercios de AgentPey está mal configurada, así que no se pagó nada. | Es un problema nuestro, no tuyo. Ya quedó registrado. |

## La credencial del agente: quién lo opera y qué puede hacer

| Código | Qué ve la persona | Qué puede hacer |
|---|---|---|
| `CredentialRevoked` | La credencial del agente fue revocada. | Firma un permiso nuevo para que se emita una credencial nueva. |
| `CredentialExpired` | La credencial del agente venció. | Firma un permiso nuevo para obtener una credencial vigente. |
| `CredentialNotYetValid` | La credencial del agente todavía no entra en vigencia. | Inténtalo de nuevo en unos minutos. |
| `CredentialNotFound` | Este agente todavía no tiene una credencial emitida. | Firma el permiso desde la página de tu agente: la credencial se emite en ese momento. |
| `CredentialUnknown` | Stellar no tiene registro de la credencial del agente. | Firma el permiso de nuevo desde la página de tu agente. |
| `InvalidCredential` | No se pudo leer la credencial del agente. | Firma el permiso de nuevo desde la página de tu agente. |
| `IssuerInactive` | Quien emitió la credencial del agente está desactivado. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `IssuerNotRegistered` | Quien emitió la credencial del agente no está registrado en Stellar. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `RegistryMismatch` | La credencial del agente apunta a un registro distinto del que AgentPey reconoce. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `UnknownTool` | Al agente no se le permitió comprar, normalmente porque su credencial fue revocada o no es válida. | Firma el permiso de nuevo desde la página de tu agente. |
| `ScopeActionNotAllowed` | La credencial del agente no le permite crear compras. | Firma un permiso nuevo desde la página de tu agente, para que se emita una credencial que permita comprar. |
| `ScopeVenueNotAllowed` | Tu permiso no autoriza compras en ese comercio. | Firma un permiso nuevo que lo incluya, si es lo que quieres. |
| `ScopeAssetNotAllowed` | El pago sería en un activo que tu permiso no autoriza. | No necesitas hacer nada: AgentPey prefirió no pagar antes que pagar en algo que no firmaste. |
| `ScopeCurrencyMismatch` | El precio está en una moneda distinta de tu límite de gasto. | No se pagó nada, y no hay nada que hacer de tu lado. |
| `ScopeAmountExceeded` | El precio supera tu máximo por compra. | Puedes firmar un permiso nuevo con un tope más alto, si de verdad quieres gastar eso. |
| `ScopeDailyLimitExceeded` | Esta compra haría que superes tu tope de gasto del día. | El tope se reinicia mañana. También puedes firmar un permiso nuevo con un límite diario mayor. |

## El Mandato que firmaste con tu wallet

| Código | Qué ve la persona | Qué puede hacer |
|---|---|---|
| `MandateNotFound` | Este agente no tiene un permiso firmado que esté vigente. | Firma el permiso desde la página de tu agente. |
| `MandateExpired` | Tu permiso venció. | Firma uno nuevo desde la página de tu agente. |
| `MandateNotYetValid` | Tu permiso todavía no entra en vigencia. | Espera a la fecha de inicio, o firma uno nuevo. |
| `MandateRevoked` | Revocaste este permiso. | Si quieres volver a comprar, firma uno nuevo. |
| `MandateUnknown` | AgentPey no encuentra tu permiso firmado en Stellar. | Firma el permiso de nuevo desde la página de tu agente. |
| `InvalidMandate` | No se pudo leer tu permiso firmado. | Firma el permiso de nuevo desde la página de tu agente. |
| `MandateAgentMismatch` | Tu permiso nombra a un agente distinto del que intenta comprar. | Firma el permiso desde la página de este agente. |
| `MandatePrincipalMismatch` | La wallet que firmó no es la que nombra este permiso. | Conecta la misma wallet con la que firmaste el permiso. |
| `SignerMismatch` | Quien firmó no es quien debía firmar. | Conecta la misma wallet con la que firmaste el permiso. |
| `InvalidSignature` | Una firma no resultó válida, así que no se pagó nada. | Conecta la misma wallet con la que firmaste el permiso. |
| `MandateActionNotAllowed` | El permiso que firmaste no permite crear compras. | Firma un permiso nuevo desde la página de tu agente: los que propone RealOps permiten comprar. |
| `MandateVenueNotAllowed` | El Mandato que firmaste no incluye ese comercio. | Firma un permiso nuevo que lo incluya, si es lo que quieres. |
| `MandateAssetNotAllowed` | El Mandato no autoriza ese activo. | No necesitas hacer nada: se rechazó antes de pagar. |
| `MandateProductNotAllowed` | Tu permiso cubre este comercio, pero no ese producto en particular. | Cada agente puede comprar solo su propio producto. Usa el agente correspondiente, o firma un permiso que incluya el otro. |
| `MandateCurrencyMismatch` | El precio está en una moneda distinta del límite que firmaste. | No se pagó nada, y no hay nada que hacer de tu lado. |
| `MandateWindowMismatch` | La compra quedó fuera de las fechas en que tu permiso es válido. | Firma un permiso nuevo con fechas vigentes. |
| `MandateAmountExceeded` | El precio supera el máximo por compra que firmaste. | Puedes firmar un permiso nuevo con un tope más alto. |
| `MandateDailyLimitExceeded` | Esta compra haría que superes el tope diario que firmaste. | El tope se reinicia mañana. También puedes firmar un permiso nuevo con un límite diario mayor. |

## La intención de compra que firma el agente

| Código | Qué ve la persona | Qué puede hacer |
|---|---|---|
| `InvalidIntent` | No se pudo leer la intención de compra, así que no se pagó nada. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `IntentExpired` | La intención de compra venció antes de poder pagarse. | Pídela de nuevo. |
| `IntentNotYetValid` | La intención de compra tiene una fecha futura. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `InvalidToolInput` | El agente envió la compra con datos incompletos. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
| `InvalidAmount` | Un precio o monto no era un número válido, así que no se pagó nada. | Es un problema nuestro, no tuyo. Ya quedó registrado. |

## La factura del comercio, comparada con el Mandato

| Código | Qué ve la persona | Qué puede hacer |
|---|---|---|
| `TermsAmountMismatch` | El comercio pidió un precio distinto al que correspondía, así que no se le pagó. | No hay nada que hacer de tu lado. Es exactamente lo que debe pasar cuando los números no coinciden. |
| `TermsAssetMismatch` | El comercio pidió cobrar en un activo distinto al autorizado. | Se rechazó antes de pagar. No hay nada que hacer de tu lado. |
| `TermsVenueMismatch` | La factura no corresponde al comercio al que se estaba comprando. | Se rechazó antes de pagar. No hay nada que hacer de tu lado. |
| `TermsPayeeNotAllowed` | El comercio pidió que se le pague a una cuenta que tu permiso no autoriza. | Esto es justamente lo que el permiso protege. No hay nada que hacer de tu lado. |

## Dinero, capacidad y red

| Código | Qué ve la persona | Qué puede hacer |
|---|---|---|
| `SponsoredCreditExhausted` | Se agotó el crédito de prueba que reparte el piloto. | No es un problema tuyo: el piloto tiene un tope de cuentas y de fondos de testnet. |
| `PurchaseCeilingExceeded` | El precio superó el tope que esta plataforma puso para esta compra. | Ese tope es de RealOps, no de tu permiso. Inténtalo de nuevo. |
| `NetworkError` | El pago no se pudo completar, así que no se pagó nada. | El comercio, la red de Stellar o el contrato que paga pueden no estar disponibles o sin saldo. Inténtalo de nuevo en un momento. |
| `ConfigError` | AgentPey está mal configurado y no pudo procesar la compra. No se pagó nada. | Es un problema nuestro, no tuyo. Ya quedó registrado. |
