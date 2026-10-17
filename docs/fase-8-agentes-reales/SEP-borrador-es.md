> **Copia en el repo del borrador del SEP** (pendiente de la Fase 8, `P-16`), exportada el 2026-10-17 desde el
> documento de Claude Docs "SEP draft — Agentic Commerce on Stellar"
> (https://claude.ai/artifact/LrSQVsgyWqC8ULBJ5ZAweQ), pestaña "Borrador en castellano"; si difiere de [`SEP-borrador.md`](SEP-borrador.md), manda la inglesa. Es la versión 0.0.1 del 2026-10-03, sin cambios: el
> texto que se presentaría sigue en ese documento, y esta copia sirve para que el SEP y su anexo no se separen.
>
> **Desde entonces cambió lo siguiente**, y no está en el texto de abajo:
> - **El modelo de reembolso "escrow por compra" (§4.3) ya existe en AgentPey**, como un contrato propio por tienda,
>   el `purchase-escrow` de la Fase 9: el pagador abre el reclamo con su firma, la tienda responde, el árbitro decide y
>   el reembolso sale del pago retenido, con plazos y `expire` en la red (`X-26`, `X-7`). El anexo lo describe:
>   [`ANEXO-SEP.md`](../fase-7-estandar-comercio-agentico/ANEXO-SEP.md).
> - **Trustless Work se evaluó (T139)** y no sirve como escrow de las compras desde un `policy_rail`; queda como
>   candidato para pagos por hitos (`R-39`).
> - **GenLayer se evaluó (T138)** como resolutor posible detrás de la misma interfaz de veredicto (`R-38`).

# Borrador de SEP: Comercio agéntico sobre Stellar

Traducción de trabajo de la pestaña en inglés, que es la versión que se presenta. Si las dos difieren, manda la inglesa.

## Preámbulo

Borrador de trabajo para la discusión previa. Todavía no se presenta en `stellar/stellar-protocol`; el número lo asignan los mantenedores del repositorio al abrir el pull request.

```text
SEP: Por asignar
Título: Agentic Commerce on Stellar
Autor: Vicente Wolde (@vicentewolde)
Track: Standard
Estado: Draft
Creado: 2026-10-03
Actualizado: 2026-10-03
Versión: 0.0.1
Discusión: por definir (hilo en GitHub Discussions)
```

## Resumen simple

Este SEP define cómo un agente de IA le compra a un comercio y paga en Stellar, usando estándares de comercio que ya se adoptan fuera de Stellar: UCP para descubrir y comprar, AP2 para los permisos firmados por el usuario y x402 para el pago. Agrega lo que esos estándares dejan abierto: un medio de pago de UCP para activos de Stellar, un recibo de compra firmado y anclado, y un registro de disputa que cualquier resolutor puede producir.

## Motivación

- **Los agentes encuentran productos, pero no pueden pagarle a un comercio real en Stellar.** UCP deja que terceros definan medios de pago, pero no define ninguno para stablecoins ni pagos en cadena.
- **Sin un medio de pago común, cada proyecto inventa el suyo.** Cada wallet de agente y cada pasarela de comercio necesitaría una integración a medida con las demás.
- **Los pagos en cadena no tienen contracargos.** El comprador necesita una prueba de compra que cualquiera pueda verificar, y una forma definida de pedir un reembolso.
- **Stellar ya tiene los rieles.** La documentación oficial recomienda x402 y MPP para pagos de agentes. Este SEP conecta esos rieles con los estándares del lado del comercio, para que un comercio que habla UCP pueda cobrar en Stellar.

## Dependencias

- UCP `2026-04-08`: el perfil en `/.well-known/ucp`, las capacidades de checkout y orden, y los medios de pago y extensiones de terceros.
- x402 versión 2, esquema `exact` en Stellar, con liquidación a través de un facilitator.
- AP2 `v0.2`, mandatos abiertos como SD-JWT.
- SEP-41, la interfaz de tokens, para el contrato del activo.
- SEP-53, para mensajes firmados por una wallet.

## Resumen técnico

El estándar tiene cuatro partes. Cada una se puede adoptar por separado, y la implementación de referencia usa las cuatro.

1. **Medio de pago.** Un payment handler de UCP que lleva una autorización x402 `exact` firmada, para un activo de Stellar, dentro del checkout de UCP. El comercio lo declara en su perfil; un agente que lo soporte le puede pagar.
2. **Recibo.** Un recibo de compra firmado por el comercio, cuyo hash queda anclado en un contrato de Soroban. Cualquiera puede comprobar tres cosas sin confiar en el comercio: la firma, el anclaje y el pago.
3. **Mandatos.** Una correspondencia entre la política de gasto del usuario y los mandatos abiertos de AP2 `v0.2`, para que verificadores fuera de Stellar puedan comprobar qué podía comprar el agente.
4. **Disputas.** Un reclamo, una respuesta del comercio y un veredicto, cada uno firmado o con hash, enlazados al recibo y visibles en la orden de UCP. El formato no fija quién decide: un árbitro con IA, una persona o el resolutor de un escrow.

## Especificación 1: el medio de pago x402 de Stellar

Las palabras DEBE, DEBERÍA y PUEDE se leen como en el RFC 2119. En este borrador el medio de pago se llama `<namespace>.stellar_x402`. UCP exige que las URLs `spec` y `schema` de un medio de pago estén en el dominio de su namespace; la implementación de referencia usa `com.agentpey.stellar_x402` en `agentpey.com`. Un namespace neutral es una pregunta abierta.

### 1.1 Configuración del comercio

El comercio declara el medio de pago en su perfil UCP. Tipo de instrumento `stellar_x402`, tipo de credencial `x402_payment_payload`. El JSON es el mismo de la pestaña en inglés: `id`, `version`, `spec`, `schema`, `available_instruments` y un `config` con `x402_version`, `scheme`, `network`, `asset` (código, contrato y decimales), `pay_to` y `facilitator`.

### 1.2 Configuración resuelta en la respuesta del checkout

Cuando la sesión está `ready_for_complete`, el medio de pago DEBE traer los `PaymentRequirements` de x402 v2 de esa sesión, sin cambios. `amount` va en unidades atómicas del activo. También trae `fx`, la tasa con que se convirtió el total, y `binding.checkout_id`.

El total de la sesión queda en la moneda ISO 4217 del comercio. El monto en el activo de Stellar solo existe aquí.

### 1.3 La credencial que se envía en `complete`

La plataforma envía la autorización firmada como credencial del instrumento: `accepted` (los requisitos de la sesión, sin cambios) y `payload.transaction` (el XDR en base64 con la entrada de autorización de Soroban firmada). Es lo que x402 lleva en el header `PAYMENT-SIGNATURE`, sin `resource`, que UCP no tiene. Dentro de UCP no hay ida y vuelta HTTP 402: el pago viaja en el cuerpo de `POST /checkout-sessions/{id}/complete`.

### 1.4 Lo que la plataforma DEBE comprobar antes de firmar

1. Que `spec` y `schema` estén en el dominio del namespace; rechazar el perfil si falta alguno.
2. Que la sesión esté `ready_for_complete` y `binding.checkout_id` sea la sesión que abrió.
3. Que `payTo`, `asset` y `network` de los requisitos sean iguales a lo que el comercio publicó en su perfil. La respuesta del checkout la escribe el comercio; el perfil es lo que publicó.
4. Su propia política de gasto (por ejemplo, el mandato de la Especificación 3). DEBERÍA firmar con un tope igual al monto autorizado.

### 1.5 Lo que el comercio DEBE hacer en `complete`

1. Volver a cotizar; si el total cambió, no cobrar y devolver los requisitos nuevos.
2. Exigir que `accepted` sea igual a los requisitos guardados, y liquidar siempre los guardados, nunca los de la credencial.
3. Guardar la liquidación antes de crear el pedido.
4. Si el resultado del facilitator es dudoso (timeout, o falla después de enviar una transacción), no volver a liquidar: dejar la sesión `complete_in_progress` con `payment_pending` hasta conciliar.

| Resultado del facilitator | Qué pasa con la sesión | Error UCP |
| --- | --- | --- |
| Éxito | Pedido creado, `completed` | — |
| Falla sin transacción enviada | Vuelve a `ready_for_complete` | `payment_failed` |
| Timeout, o falla después de enviar | Retenida en `complete_in_progress` | `payment_pending` |
| Sin stock antes de cobrar | No se cobra | `out_of_stock` |

## Especificación 2: recibos firmados y anclados

Después de un cobro exitoso, el comercio DEBE emitir un recibo, firmarlo y anclar su hash en Stellar. Así cualquiera verifica la compra sin confiar en el comercio.

### 2.1 Formato

Un JWS compacto, `alg: EdDSA` (Ed25519 de Stellar), firmado con la llave de firma del comercio. Esa llave DEBERÍA ser distinta de la cuenta que cobra. Los campos son los de la tabla de la pestaña en inglés: tipo y versión del recibo, ids del pedido, plataforma, identificador del firmante, cuenta que cobra, cuenta que pagó, red, contrato del activo, montos decimal y atómico, hash de la transacción de pago, productos, fecha de emisión y fin de la ventana de reembolso.

El **hash del recibo** es el `sha256` del JWS compacto en UTF-8, en hexadecimal minúscula.

### 2.2 Anclaje

El contrato de registro DEBE ofrecer `anchor(hash, merchant, amount, order_ref)` y `get(hash)`. `anchor` DEBE exigir la firma del comercio, rechazar montos menores o iguales a cero, rechazar un `order_ref` vacío o de más de 64 bytes, y no aceptar dos veces el mismo hash.

### 2.3 Verificación

Un recibo es válido solo si pasa los tres checks:

1. **Firma.** El cuerpo cumple el esquema, el `kid` identifica al firmante y la firma Ed25519 verifica. No necesita red.
2. **Anclaje.** `get(hash del recibo)` existe, con el comercio, el monto atómico y el id del pedido iguales a los del recibo.
3. **Pago.** La transacción de pago existe, fue exitosa y movió exactamente el monto atómico desde quien pagó hacia quien cobró. El verificador DEBE usar el activo en que confía, no el que dice el recibo.

Este borrador exige además dos cosas que la implementación de referencia todavía no comprueba: que los montos decimal y atómico digan lo mismo, y que una transacción de pago respalde a lo más un recibo.

### 2.4 El recibo en la orden de UCP

Una extensión de UCP sobre las capacidades de checkout y orden agrega un objeto `receipt`, con el JWS, su hash, la red, la transacción de pago, el estado del anclaje y una URL para verificar. Un cliente que no negocia la extensión no lo recibe; por eso `order.permalink_url` DEBERÍA apuntar a una página pública del recibo. El anclaje PUEDE ser asíncrono: pasa de `pending` a `anchored`, o a `failed` después de los reintentos.

## Especificación 3: mandatos como mandatos abiertos de AP2

La política de gasto que el usuario le da a su agente DEBERÍA poder exportarse como un par de mandatos abiertos de AP2 `v0.2` (checkout y pago), para que verificadores fuera de Stellar puedan comprobarla. Exportar no reemplaza el control en la red: la cuenta pagadora sigue aplicando sus límites.

| Política de gasto en Stellar | Mandato abierto de AP2 |
| --- | --- |
| Identidad del agente | `cnf.jwk`, la llave Ed25519 del agente |
| Límites por compra y por día | `payment.amount_range.max`: el menor límite aplicable, en centavos, redondeado hacia abajo |
| Moneda del límite | `payment.amount_range.currency` |
| Gasto acumulado del día | No se exporta; lo aplica la cuenta pagadora en la red |
| Comercio permitido | `checkout.allowed_merchants` y `payment.allowed_payees` |
| Activo permitido | `payment.allowed_payment_instruments`, `type: "stellar_x402"` |
| Producto y cantidad | `checkout.line_items` |
| Vencimiento | `exp`: lo primero entre la intención de compra, la credencial, la política y una hora |
| Referencia a la política | Un claim propio con el id de la política, su hash y su registro |

Reglas: verificar antes de exportar que la credencial y la política están ancladas y no revocadas, y que la compra cabe en ambas; un par por compra; `conditional_transaction_id` es el `sd_hash` del token de checkout; montos en centavos redondeados hacia abajo (3,00 USDC es `300`, nunca `30000000`); firmar con Ed25519 para que una sola llave de Stellar sirva en la red y en AP2.

Queda fuera de esta versión: negociar AP2 dentro del checkout de UCP y los mandatos cerrados. En UCP `2026-08-25` la extensión de AP2 se renombró a `dev.ucp.common.payment.ap2_mandate`.

## Especificación 4: registros de disputa

Quien pagó PUEDE abrir un reclamo sobre un recibo. Esta sección fija los formatos y el registro en la red, no quién decide: cualquier resolutor que produzca un veredicto con este formato cumple.

### 4.1 Los tres documentos

1. **Reclamo.** Un JWS firmado por quien pagó (o por la llave dueña, si pagó una cuenta-contrato), con el recibo entero, un motivo (`not_delivered`, `not_as_described`, `damaged`, `unauthorized`, `other`), una descripción, hasta cinco evidencias y el monto pedido.
2. **Respuesta del comercio.** Una posición (`accept_full`, `accept_partial` con monto, o `contest`), sus descargos y hasta cinco evidencias, firmada con SEP-53 desde la cuenta que cobró. DEBE nombrar el `claim_hash` que responde.
3. **Veredicto.** Un resultado (`refund_full`, `refund_partial`, `rejected`), el monto, el razonamiento y el hash de la respuesta (o `null`). El `verdict_hash` anclado cubre también la respuesta.

### 4.2 Registro en la red

El contrato DEBE ofrecer `get(receipt_hash)` con el estado, el reclamo, el monto en disputa y, una vez resuelta, el veredicto y el reembolso. DEBE exigir: recibo anclado; reclamo dentro de la ventana; monto en disputa no mayor que el recibo, leído del registro; una disputa por recibo; reembolso no mayor que lo disputado; y que solo un resolutor autorizado abra y resuelva.

### 4.3 De dónde sale el reembolso

| Modelo | Cómo funciona | Gana | Cuesta |
| --- | --- | --- | --- |
| **Garantía del comercio** (implementación de referencia) | El comercio deposita una garantía; lo disputado se bloquea al abrir el reclamo | El flujo de pago no cambia | El comercio inmoviliza capital y puede retirar lo no bloqueado antes de un reclamo |
| **Escrow por compra**, por ejemplo Trustless Work, cuyo rol Dispute Resolver puede redirigir fondos | El pago queda retenido hasta liberarse | Más protección para el comprador | El `payTo` de x402 pasa a ser el escrow, y el recibo debe nombrarlo |

### 4.4 La disputa en la orden de UCP

La orden DEBERÍA mostrar la disputa como un ajuste nativo de tipo `dispute`, que cualquier cliente entiende, y como `receipt.dispute`, con los datos para comprobarla en la red.

## Justificación del diseño

- **Componer, no inventar.** UCP, AP2 y x402 ya tienen comercios, wallets y librerías. Un protocolo de comercio solo para Stellar le pediría a cada comercio una integración más. Este SEP solo llena los espacios que esos estándares dejan a terceros.
- **x402 como formato de credencial dentro de UCP, no como flujo HTTP.** UCP no tiene el estado 402. Reusar el payload `exact` y el facilitator mantiene las herramientas de Stellar, y el pago viaja donde UCP lo espera: en `complete`.
- **Moneda del comercio en la sesión, activo de Stellar en el medio de pago.** Los comercios cobran en su moneda ISO 4217, y UCP asume una. Así la sesión se lee bien en cualquier cliente UCP.
- **Un recibo anclado en la red.** La orden de UCP no tiene dónde poner una prueba de pago. Un recibo firmado y anclado deja que el comprador, un resolutor o un auditor comprueben la compra sin confiar en el servidor del comercio.
- **Disputas definidas por formato, no por resolutor.** En Stellar ya hay escrows con roles de disputa. Fijar los formatos deja que cualquiera de ellos, o un árbitro con IA, se conecte sin cambiar la orden ni el recibo.
- **Ed25519 en todo.** Una sola llave de Stellar firma la autorización, el recibo y los mandatos de AP2.

## Seguridad

Cada punto es un límite real encontrado al construir la implementación de referencia.

| Problema | Efecto hoy | Posible solución en este SEP |
| --- | --- | --- |
| El vínculo con el checkout es lógico, no criptográfico | La autorización firma destinatario, activo, monto, nonce y vencimiento, pero no la sesión; aunque cada credencial se liquida una vez | Atar la autorización a la sesión, por ejemplo con un nonce derivado del `checkout_id` |
| Resultado dudoso del cobro | Ni UCP ni x402 dicen qué hacer si el facilitator no responde después de enviar; hoy se retiene y se concilia a mano | Definir cómo consultar al facilitator y cerrar la sesión |
| Revocar el mandato no detiene la cuenta pagadora | La cuenta aplica límites por compra y por día, pero no lee el registro de mandatos ni fija el destinatario | Que la cuenta consulte el estado del mandato o fije destinatarios, con una lectura más por pago |
| El comercio puede vaciar su garantía antes de un reclamo | Solo está protegido lo bloqueado por una disputa abierta | Exigir aviso previo para retirar |
| El resolutor es un punto único de confianza | El registro no guarda quién pagó, así que el resolutor nombra a quién se reembolsa; una disputa abierta no vence | Guardar el pagador en el registro; agregar un plazo a la disputa |
| El veredicto de una IA no es determinista | Pedirlo otra vez puede dar otro resultado | Archivar cada veredicto y exigir confirmación humana antes de mover fondos |
| Reclamos y respuestas son datos no confiables para el árbitro | Una inyección de prompt podría intentar torcer el veredicto | Tratarlos como datos y acotar el reembolso en el código y en el contrato |
| Los activos no tienen código ISO 4217 | AP2 lee las unidades menores como centavos; 3,00 USDC en unidades de Stellar se leería como 300.000 | Fijar la unidad de los activos de Stellar en los mandatos de AP2 |

## Preguntas abiertas

- [ ] **Namespace neutral.** UCP ata el nombre del medio de pago al dominio que aloja su especificación. ¿Debería vivir en un dominio neutral (por ejemplo, uno que aloje SDF) en vez de `com.agentpey.*`?
- [ ] **Uno o varios SEPs.** ¿Medio de pago, recibo y disputas deberían ser tres SEPs separados, para adoptarlos y versionarlos por separado?
- [ ] **Identificador del firmante.** ¿Mantener `did:stellar:…` en el `kid` del recibo, o usar una cuenta `G…`, ya que ningún SEP define un método DID para Stellar?
- [ ] **MPP.** ¿El medio de pago debería aceptar también una credencial MPP charge, o MPP debería ser un segundo medio de pago?
- [ ] **Nombre del tipo de recibo.** Reemplazar `vitrinee-receipt/0.1` por un nombre neutral.
- [ ] **Versión de UCP.** Pasar a `2026-08-25` antes de salir de Draft.
- [ ] **Modelo de reembolso por defecto.** ¿El SEP debería recomendar la garantía del comercio o el escrow por compra?

## Implementación de referencia

AgentPey ([vicentewolde/AgentPey](https://github.com/vicentewolde/AgentPey)) implementa las cuatro partes en testnet. El 1 de octubre de 2026 un agente compró por UCP en una tienda Shopify de prueba, pagó 1,5684211 USDC desde una cuenta-contrato y recibió un recibo que pasó los tres checks. Un segundo pago sobre el límite por compra lo rechazó el contrato (`PerTxExceeded`). Los ids de los contratos y las transacciones están en la pestaña en inglés.

## Registro de cambios

| Fecha | Versión | Cambio |
| --- | --- | --- |
| 2026-10-03 | v0.0.1 | Primer borrador para la discusión previa |

## Fuentes

- [UCP, visión general de la especificación `2026-04-08`](https://ucp.dev/2026-04-08/specification/overview/)
- [AP2](https://ap2-protocol.org/)
- [Pagos agénticos en Stellar (x402 y MPP)](https://developers.stellar.org/docs/build/agentic-payments)
- [Proceso de los SEPs](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/README.md)
- [Trustless Work, diseño del escrow](https://docs.trustlesswork.com/trustless-work/introduction/technology-overview.md)
