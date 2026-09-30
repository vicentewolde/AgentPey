# T120 · Prueba técnica: payment handler de Stellar en UCP

> Investigación, sin código de producto. Fecha: 2026-09-30.
> Responde las cuatro preguntas del [spec](SPEC.md), propone opciones y
> estima T121 y T122. **Termina en una decisión del usuario** (sección 7).
>
> Fuentes: la spec de UCP leída del repositorio oficial
> `Universal-Commerce-Protocol/ucp`, tag `v2026-04-08` (texto y esquemas
> JSON, no resúmenes), y el código de este repo. Las citas exactas están en
> [`evidencia/T120.md`](evidencia/T120.md).

## 0. Respuesta corta

**Sí se puede.** UCP admite un payment handler de terceros con namespace
propio, y sus esquemas dejan viajar una autorización x402 de Stellar como
credencial de pago. No hace falta el plan B.

Tres cosas que el traspaso no anticipaba:

1. **x402 entra en UCP como formato, no como protocolo HTTP.** UCP no usa el
   código 402 (no está en la tabla de estados de `checkout-rest.md`): el pago viaja en el cuerpo de `POST /checkout-sessions/{id}/complete`.
   Lo que se reutiliza de x402 es el esquema `exact` de Stellar (la
   autorización Soroban firmada) y el facilitator. El ida y vuelta
   "402 → reintento con header" desaparece dentro de UCP.
2. **`/.well-known/ucp` no lleva productos.** Declara capacidades y handlers.
   El catálogo es otra capacidad, con `POST /catalog/search` y
   `POST /catalog/lookup`. T121 es perfil más catálogo.
3. **El checkout por `GET` no sirve tal cual.** UCP pide sesiones de checkout
   (crear, leer, actualizar, completar, cancelar). Se reutiliza casi todo lo
   de adentro, pero la puerta de entrada es nueva.

## 1. ¿Un handler propio puede transportar un pago x402 de Stellar?

Sí. Lo que dice la spec, y cómo calza:

| Lo que exige UCP | Cómo se cumple |
|---|---|
| El nombre del handler es un dominio invertido, y el origen de sus URLs `spec` y `schema` **debe** coincidir con ese dominio. La plataforma debe validarlo (overview, "Spec URL Binding") | Handler `com.agentpey.stellar_x402`, con la spec y el esquema alojados en `https://agentpey.com/ucp/handlers/stellar-x402/…`. Son dos archivos estáticos; falta confirmar que la web de `agentpey.com` los pueda servir en esa ruta sin cambios de infraestructura |
| Los handlers los escriben "típicamente" los proveedores de credenciales de pago o el órgano de gobierno de UCP (overview, "Payment Handlers") | "Típicamente", no "solamente". Un tercero puede publicar uno. AgentPey ocupa el lugar del proveedor que define el handler |
| El comercio declara el handler en su perfil, con su `config` | `config` del comercio: red (`stellar:testnet`), contrato del activo (USDC), cuenta `payTo`, esquema `exact`, URL del facilitator. Todo eso ya está en `agent-storefront.json` (`merchant`, `settlement`) |
| En la respuesta del checkout, el handler trae la configuración resuelta **para esa compra**, y la plataforma debe tratarla como autoritativa (guía de handlers, "response_schema") | Ahí viaja lo que hoy viaja en el header `PAYMENT-REQUIRED` del 402: monto exacto en unidades atómicas, `payTo`, activo, plazo y si el facilitator patrocina el fee. Es el mismo objeto `accepts[0]` de x402 |
| El instrumento de pago tiene `id`, `handler_id`, `type` y una `credential` con `type`; los dos esquemas admiten campos adicionales (`additionalProperties: true`) | Instrumento `type: "stellar_x402"`. Credencial `type: "x402_payment_payload"` con el contenido que hoy va en el header `PAYMENT-SIGNATURE`: `{x402Version, accepted, payload: {transaction: <XDR base64>}}`. El campo `resource` de x402 se omite a propósito: en UCP no hay URL de recurso. En T122 hay que revisar que el registro de liquidaciones no dependa de él |
| La credencial debe quedar atada a un checkout y a un comercio concretos ("binding"), para que no se pueda reusar en otro lado | La autorización Soroban ya firma el destinatario (`payTo`), el activo y el monto, lleva un nonce y vence en un ledger. No sirve para otro comercio ni dos veces. Ver la brecha 8.3 |
| La spec del handler debe mapear sus fallos a errores estándar de UCP | Rechazo del facilitator o de la red → `payment_failed`. Sin stock → `out_of_stock` (el chequeo ya existe antes de cobrar) |

Del lado del comprador no cambia nada de fondo: `PolicyRailStellarScheme`
ya construye esa autorización a partir de un objeto de requisitos x402
(`apps/agent/src/payment/policy-rail-payer.ts`). Hoy lo saca del 402; en UCP
lo saca de la respuesta del checkout.

**La plataforma también necesita un perfil.** UCP exige que cada petición
lleve el header `UCP-Agent` con la URL del perfil de la plataforma. El agente
de AgentPey tiene que publicar uno (un JSON estático) que declare que soporta
el handler.

## 2. ¿Dónde se liquida el pago y cómo encaja el facilitator?

Se liquida del lado del comercio, al completar el checkout, igual que hoy:

1. El agente crea la sesión (`POST /checkout-sessions`) con el producto y la
   cantidad. Vitrinee responde con el total y la configuración resuelta del
   handler.
2. El agente pasa esos requisitos por el chequeo del Mandato que ya existe
   (`policyRail.authorise`, sin cambios) y firma la autorización Soroban con
   la llave dueña del `policy_rail`.
3. El agente llama a `POST /checkout-sessions/{id}/complete` con el
   instrumento.
4. Vitrinee manda la autorización al facilitator de OpenZeppelin (`/settle`),
   que arma la transacción, paga el fee y la envía. En la red, el contrato
   `policy_rail` revisa `per_tx`, `per_day` y el vencimiento en
   `__check_auth`.
5. Con la plata ya movida, Vitrinee crea el pedido en la tienda (Shopify o
   Jumpseller), firma el recibo y encola el anclaje. Responde `completed` con
   la orden.

El facilitator no aparece en UCP: es un detalle interno del handler, entre el
comercio y la red. Es exactamente el papel que UCP le da al "procesador".

**Lo que hay que construir:** hoy el cobro lo dispara el middleware de
`@x402/express` al ver el header. En UCP hay que llamar a la liquidación
desde el manejador de `complete`. `@x402/core` expone el servidor de recursos
que usa el middleware por dentro; usarlo directo es el riesgo técnico
principal de T122 (no lo probé: esta tarea es sin código).

**Sobre "rechazado por la red" (criterio de T122).** Un pago que excede
`per_tx` falla en la simulación del contrato, antes de enviarse: el nodo RPC
ejecuta `__check_auth` y devuelve `PerTxExceeded` (#7). Quien rechaza es el
contrato, no el agente, pero no queda una transacción fallida en el
explorador. La evidencia de T122 será ese error de simulación. Si se quiere
además una transacción rechazada visible, hay que forzar el envío sin
simular, y eso es trabajo aparte.

**Cómo se llega a ese rechazo sin abrir un atajo.** En el camino de
producción, `policyRail.authorise` corta primero
(`apps/agent/src/payment/x402.ts:358-364`): un pago excedido nunca llega a
firmarse. La evidencia sale de un script de prueba aparte, fuera del agente,
que firma directo contra el contrato. El camino de producción no gana ningún
modo que se salte el chequeo local.

## 3. ¿Cómo viaja el recibo anclado dentro de la orden?

La orden de UCP no trae un campo para recibos ni pruebas de pago. Tiene tres
campos en la confirmación (`id`, `label`, `permalink_url`) y ninguno para
esto en la orden completa. Pero UCP sí define cómo un tercero extiende una
capacidad oficial: una extensión con namespace propio y el campo `extends`
(overview: "Vendor: `com.example.installments` extends
`dev.ucp.shopping.checkout`").

Propuesta: la extensión **`com.agentpey.shopping.receipt`**, que extiende
`dev.ucp.shopping.checkout` y `dev.ucp.shopping.order`, y agrega un objeto:

```json
"receipt": {
  "format": "jws",
  "jws": "<recibo firmado, compacto>",
  "hash": "<sha256 del jws>",
  "network": "stellar:testnet",
  "settlement_tx_hash": "<hash del pago>",
  "anchor": { "status": "pending | anchored | failed", "registry": "C…", "tx_hash": "…", "ledger": 0 },
  "verify_url": "https://<tienda>.vitrinee.agentpey.com/receipts/<hash>/verify"
}
```

Es el mismo contenido que hoy devuelve `orderResponse` en `receipt` y
`anchor`, con otros nombres. Además, `order.permalink_url` apunta a la página
del recibo que ya existe (`/receipts/<hash>`), así un cliente UCP que no
conozca la extensión igual llega a la prueba.

El anclaje es asíncrono: al completar, `anchor.status` es `pending`. El
cliente lo ve `anchored` al leer la orden después (`GET /orders/{id}`). Los
webhooks de orden de UCP son opcionales y no los propongo para v0.

Un cliente que no negocia la extensión simplemente no la recibe. No rompe a
nadie.

## 4. ¿Qué se reutiliza tal cual?

| Pieza | ¿Se reutiliza? | Detalle |
|---|---|---|
| `agent-storefront.json` | Se mantiene, sin cambios | Sus datos de comercio y liquidación alimentan el `config` del handler en el perfil UCP. Sus productos no van al perfil |
| `GET /api/discovery/search` | Se mantiene, sin cambios | El catálogo UCP son rutas nuevas (`POST /catalog/search`, `/catalog/lookup`) sobre la misma caché de catálogo y el mismo `toManifestProduct` |
| `GET /orders`, `GET /orders/:orderId`, `POST /orders/:orderId/fulfil`, `GET /catalog` | Se mantienen, sin cambios | Las rutas UCP viven bajo el prefijo `/ucp/v1` (el `endpoint` del servicio en el perfil), así `GET /ucp/v1/orders/{id}` no choca con el `GET /orders/:orderId` de hoy |
| Checkout por `GET`/`POST /checkout/:productId` | Se mantiene para los clientes actuales; **no es la puerta UCP** | UCP pide sesiones. Por dentro se reutilizan `quoteCheckout`, las reservas de stock, la idempotencia, `completeCheckout` (pedido en la tienda, recibo, anclaje) y el registro de liquidaciones |
| `policy_rail` como pagador | Tal cual | Misma firma, mismo contrato, mismos límites. Cambia de dónde saca los requisitos |
| Chequeo del Mandato antes de firmar | Tal cual, **no se toca** | `policyRail.authorise` recibe los mismos términos |
| Recibo, anclaje y los tres checks | Tal cual | Sin cambios de contrato ni redeploy de `receipt-registry` |
| Subdominios por comercio | Tal cual | Las rutas UCP se agregan en `createApp()` (`packages/vitrinee-gateway/src/app.ts`), al lado del manifiesto. Cada subdominio ya tiene su instancia |

Límite de v0: el checkout de Vitrinee vende **un producto por compra** (con
cantidad). Una sesión UCP con más de una línea se rechaza con un error
`recoverable`. Queda anotado, no se construye el carrito.

## 5. Opciones

### Opción A · UCP nativo (recomendada)

Handler `com.agentpey.stellar_x402`, pago dentro de `complete`, recibo en la
extensión `com.agentpey.shopping.receipt`. Es lo descrito en las secciones 1
a 3.

- A favor: es la tesis de `P-14` al pie de la letra, y es lo que un SEP
  puede citar. Un cliente UCP ajeno puede comprar si implementa el handler.
- En contra: es la más cara. El riesgo está en liquidar fuera del middleware.

### Opción B · Sesión UCP con el pago por el camino x402 actual

La sesión UCP existe, pero para pagar devuelve `requires_escalation` con un
`continue_url` que apunta al `/checkout/:productId` de hoy. El agente hace
ahí el 402 de siempre y la sesión pasa a `completed`.

- A favor: reutiliza el cobro tal cual, unas 10 horas menos.
- En contra: `continue_url` existe para pasarle el control **al comprador
  humano** en la web del comercio. Usarlo para que un agente pague es torcer
  el estándar, y un revisor del SEP lo va a notar.

### Opción C · Plan B del traspaso

Perfil y catálogo en UCP, checkout x402 fuera de UCP, y la brecha documentada.

- A favor: barata y sin riesgo.
- En contra: no demuestra un pago UCP sobre Stellar, que es el centro de la
  fase. Solo tiene sentido si A falla.

**Recomendación: A, con C como red de seguridad.** T121 es idéntico en las
tres, así que no se pierde nada: si al segundo día de T122 la liquidación
fuera del middleware no sale, se cae a C y la brecha va al SEP.

## 6. Estimaciones

**T121 · perfil y catálogo: 16 h** (el traspaso decía 15)

| Parte | Horas |
|---|---|
| Esquemas de UCP `2026-04-08` versionados en el repo y validación en tests | 3 |
| `/.well-known/ucp` por comercio | 3 |
| `POST /catalog/search` y `/catalog/lookup` (producto con una variante) | 5 |
| Spec y esquema del handler, y de la extensión de recibo, como archivos para `agentpey.com` | 3 |
| Cliente de prueba que lee el perfil y lista productos de una tienda real | 2 |

Delegable a Codex: el mapeo de campos de producto y los tests de validación,
con el diseño ya escrito. Publicar archivos en `agentpey.com` es un deploy y
necesita tu permiso.

**T122 · compra de punta a punta, opción A: 29 h** (el traspaso decía 25)

| Parte | Horas |
|---|---|
| Sesiones de checkout: crear, leer, actualizar, completar, cancelar, con su almacenamiento | 8 |
| Liquidar desde `complete`, fuera del middleware | 5 |
| Lado comprador: cliente UCP con `policy_rail` y perfil de plataforma | 6 |
| `GET /orders/{id}` y la extensión de recibo | 3 |
| Dirección de despacho (extensión de fulfillment, mínima) | 3 |
| Prueba en testnet con una tienda real, rechazo por `per_tx`, evidencia | 4 |

Con la opción B serían unas 19 h; con la C, unas 6.

El total de T121 + T122 sube de 40 a 45 horas. Para las fechas del spec
(4 al 7 de octubre) es apretado: si no entra, lo que se corre es T123 y T124,
como ya estaba decidido.

## 7. Decisiones que necesito del usuario

> **Resuelto el 2026-09-30:** opción A, UCP `2026-04-08`, sesión en la moneda
> de la tienda y fulfillment mínimo. Ver `E-1` a `E-4` en
> [DECISIONES.md](DECISIONES.md).

1. **Opción:** A (recomendada), B o C.
2. **Versión de UCP.** El traspaso fija `2026-04-08`, pero el 2026-08-25 salió
   una versión nueva. Trae cambios incompatibles en despacho y
   consentimiento, y agrega "acciones" de pago (3DS). Los handlers siguen
   igual en lo esencial. Recomiendo **`2026-04-08`**: es la que leí completa,
   el despacho es más simple, y UCP negocia versión por capacidad. Subir a la
   nueva queda anotado para después de la hackathon.
3. **Moneda de la sesión.** UCP pide un código ISO 4217 y montos en la unidad
   menor. USDC no es ISO 4217 y tiene 7 decimales. Recomiendo que la sesión
   vaya en la **moneda de la tienda** (CLP, como hoy en `priceLocal`) y que el
   monto exacto en USDC viaje en la configuración del handler, con el tipo de
   cambio usado. La alternativa, sesión en USD con centavos, redondea y deja
   de calzar con lo que se liquida.
4. **Despacho.** Shopify y Jumpseller necesitan dirección. Propongo soportar
   la extensión de fulfillment de UCP en su forma mínima (un método de envío,
   un destino). La alternativa es limitar la demo a lo que ya se hace hoy por
   parámetros, fuera de UCP.

## 8. Brechas para el SEP

Lo que UCP no resuelve y un SEP tendría que fijar:

1. **No hay handler de stablecoins ni de pagos en cadena.** Todos los
   ejemplos son de tarjeta y tokenización. El de Stellar sería de los primeros.
2. **Moneda de precio distinta del activo de liquidación.** UCP asume una
   moneda ISO 4217. No tiene dónde decir "cobro en CLP, liquido en USDC a
   esta tasa". Hoy solo cabe en el `config` del handler.
3. **El binding al checkout es lógico, no criptográfico.** La autorización
   Soroban firma destinatario, activo y monto, pero no el `id` de la sesión.
   Dos sesiones del mismo comercio por el mismo monto son intercambiables; el
   pago sirve una sola vez igual. Un SEP podría fijar cómo atar el `id`.
4. **No hay lugar para pruebas de pago ni recibos verificables en la orden.**
   De ahí la extensión propia.
5. **AP2 en UCP exige firmas ECDSA** (ES256, ES384 o ES512) para la
   autorización del comercio, y mandatos en formato SD-JWT. El Mandato y los
   recibos de AgentPey se firman con Ed25519, que es la curva de Stellar.
   **T123 no es solo "exportar":** hace falta un segundo par de llaves P-256
   por comercio y por agente, o que AP2 acepte EdDSA. Además, una vez
   negociado AP2 en una sesión, es obligatorio hasta el final. Esto sube el
   riesgo de T123 y conviene saberlo antes de empezarla.
6. **Las disputas** existen en UCP solo como un tipo de `adjustment` de texto
   libre en la orden. No hay proceso. Ahí entra T124.
