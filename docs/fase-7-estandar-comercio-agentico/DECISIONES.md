# Decisiones — Fase 7 (Estándar de comercio agéntico sobre Stellar)

> Una entrada por decisión, con su motivo y la alternativa que se descartó.
> **No se borran entradas**: si una decisión se revierte, se marca `Superada`
> y se agrega la nueva.
>
> **Prefijo `E-`** (estándar). Las decisiones que abren la fase son de
> proyecto y viven en [`docs/DECISIONES.md`](../DECISIONES.md): `P-14` (el
> alcance) y `P-15` (el método de trabajo). Las que tocan Vitrinee por dentro
> siguen en su propio registro, con prefijo `VT-`.

Estados: `Vigente` · `Superada` · `Pendiente`

---

### E-1 · El pago de Stellar entra a UCP como un payment handler propio, dentro de `complete` · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T120 · Decidido por el usuario (opción A)

El handler `com.agentpey.stellar_x402` lleva la autorización x402 de Stellar
como credencial del instrumento de pago en
`POST /checkout-sessions/{id}/complete`. El comercio liquida contra el
facilitator y después crea el pedido y el recibo. El recibo viaja en la
extensión `com.agentpey.shopping.receipt`. Spec y esquemas se alojan en
`agentpey.com`, porque UCP exige que el origen coincida con el namespace.

**Motivo.** Es la tesis de `P-14` al pie de la letra y lo que un SEP puede
citar: un cliente UCP ajeno puede comprar si implementa el handler.

**Alternativa descartada: (B) sesión UCP con el pago por el camino x402
actual vía `continue_url`.** Ahorraba unas 10 horas, pero ese campo existe
para pasarle el control al comprador humano; usarlo para que pague un agente
tuerce el estándar.

**Red de seguridad, no descartada: (C) perfil y catálogo en UCP, checkout
x402 aparte.** Si en T122 liquidar fuera del middleware de `@x402/express` no
sale al segundo día, se para, se muestra y se cae a C, con la brecha
documentada para el SEP. T121 es igual en las tres opciones.

**Lo que no cambia.** `checkMandate`, `policyRail.authorise`, el contrato
`policy_rail` y `receipt-registry`. Las rutas x402 actuales siguen sirviendo a
los clientes de hoy.

---

### E-2 · Se implementa UCP `2026-04-08` · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T120 · Decidido por el usuario

**Motivo.** Es la versión que fija el traspaso y la que se leyó del
repositorio oficial para T120 (las partes de pagos, checkout, orden, catálogo
y AP2; no la spec entera). Su modelo de despacho es más simple.

**Alternativa descartada: `2026-08-25`**, publicada el 25 de agosto. Trae
cambios incompatibles en despacho y consentimiento y agrega acciones de pago
(3DS) que aquí no se usan. Subir de versión queda para después de la hackathon.

---

### E-3 · La sesión de checkout va en la moneda de la tienda; el monto en USDC viaja en el handler · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T120 · Decidido por el usuario

UCP pide un código ISO 4217 y montos en la unidad menor. La sesión usa la
moneda local del comercio (hoy CLP, como `priceLocal`). El monto exacto a
liquidar, en unidades atómicas de USDC, y el tipo de cambio usado viajan en
el `config` del handler de la respuesta.

**Motivo.** USDC no es ISO 4217 y tiene 7 decimales: no cabe en `currency`.

**Alternativa descartada: sesión en USD con centavos.** Redondea, y el total
de la sesión dejaría de calzar con lo que se liquida y con el recibo.

---

### E-4 · Despacho con la extensión de fulfillment de UCP, en su forma mínima · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T120 · Decidido por el usuario

Un método de envío y un destino por compra, con
`dev.ucp.shopping.fulfillment`.

**Motivo.** Shopify y Jumpseller necesitan una dirección para crear el pedido.

**Alternativa descartada: seguir pasando la dirección por parámetros fuera de
UCP.** La compra dejaría de ser UCP de punta a punta.

---

### E-5 · Las compras UCP pagan desde un `policy_rail` propio, de 3,00 USDC por compra y 5,00 por día · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T122 · Decidido por el usuario (opción A); la forma, de Claude Code

Una segunda instancia del mismo contrato `policy_rail`, sin cambios de código
en el contrato. `owner` es la llave del agente; `principal` es la wallet del
usuario (`GD2MCESI…`), la única que puede retirar o rotar el `owner`. Se
fondea con 5 USDC desde la cuenta del agente, que es también la reserva de las
cuentas patrocinadas (`C-159`). Se despliega con
`pnpm run deploy:policy-rail -- --profile ucp --principal G...`, y queda en su
propio registro (`policyRailUcp` en `deployments/testnet.json`,
`UCP_POLICY_RAIL_CONTRACT_ID` en `.env.local`): el rail compartido y todo lo
que paga desde él no se tocan.

**Motivo.** Los productos de las tiendas reales cuestan entre 1,5 y 3 USDC, y
el rail compartido permite 0,002 por compra. Los límites copian los de un rail
de comercio (`C-133`): cabe un producto, y uno sobre 3,00 lo rechaza la red.

**Alternativa descartada: el rail compartido con un producto de 1 CLP** creado
a propósito en la tienda. Sin contratos nuevos, pero la compra del video sería
de 0,001 USDC por un producto que no existe para nadie más.

---

### E-6 · Un pago UCP que pudo haber movido plata nunca se vuelve a cobrar: el cobro vive en la sesión y lo dudoso se retiene · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T122 · De Claude Code, a partir de `/revisar`

Las sesiones de checkout UCP viven en Postgres (`vitrinee.checkout_sessions`,
una fila por sesión, aisladas por `comercio_id`), como pidió el usuario. La
sesión es el registro del cobro:

1. Antes de liquidar, la sesión pasa a `complete_in_progress` con la
   transacción firmada. Desde ese momento nada la vuelve a liquidar.
2. Si el facilitator confirma, el cobro se guarda en la sesión **antes** de
   crear el pedido, y el pedido se arma desde la foto guardada de la cotización,
   sin volver a consultar stock. Un `complete` que falla después de cobrar
   termina en el reintento desde lo guardado, aunque llegue con otra firma.
3. Si el facilitator dice que no y no emitió transacción, la sesión vuelve a
   `ready_for_complete` y se puede firmar de nuevo.
4. **Si el resultado es dudoso** (timeout, error de red, o una transacción
   emitida que el facilitator dio por fallida), la sesión queda retenida en
   `complete_in_progress` con el mensaje `payment_pending`, y no se cobra más.

`PUT`, `cancel` y `complete` toman el mismo candado por sesión.

**Conciliación de una sesión retenida (v0, manual).** El log
`ucp settlement outcome unknown` trae el id de la sesión y, si la hubo, la
transacción. Se busca esa transacción en Horizon (o el pago del `policy_rail`
del comprador al `payTo` de la tienda). Si se liquidó, se completa la sesión a
mano con ese cobro y se crea el pedido; si no, se cancela. No hay comando para
esto todavía: se hace cuando aparezca el primer caso.

**Supuestos que quedan escritos.** El candado es por proceso: vale porque
Vitrinee corre en una sola instancia de Render. Con más de una, hay que
cambiar el guardado a una actualización condicional sobre el estado. Si el
proceso cae entre crear el pedido en la tienda y guardarlo, el reintento crea
un segundo pedido en la tienda por un solo pago, igual que en el checkout x402
de hoy (`VT-35`: Shopify no tiene clave de idempotencia).

**Alternativa descartada: confiar en el registro de liquidaciones en memoria,
como el checkout x402.** Ahí alcanza porque el middleware liquida y crea el
pedido en la misma petición; en UCP una sesión vive horas y sobrevive
reinicios, y la revisión mostró tres caminos para cobrar dos veces o perder el
rastro de un cobro.

---

### E-7 · La orden UCP muestra solo el país de destino; la credencial se ata a la sesión por `binding.checkout_id` · `Vigente`
**Fecha:** 2026-09-30 · **Tarea:** T122 · De Claude Code

El id de la orden va dentro del recibo firmado, que es público. Por eso
`GET /ucp/v1/orders/{id}` no devuelve nombre ni dirección del comprador, solo
el país: la dirección queda en la tienda. La sesión de checkout sí la muestra,
porque su id (80 bits aleatorios) solo lo conoce quien la creó.

La configuración del handler en la respuesta del checkout lleva
`binding.checkout_id`, y el comprador se niega a firmar si no coincide con la
sesión que abrió. La firma de Soroban no incluye el id de la sesión (brecha 3
de T120, para el SEP): el comercio rechaza una credencial cuyos requisitos no
son exactamente los de esa sesión.
