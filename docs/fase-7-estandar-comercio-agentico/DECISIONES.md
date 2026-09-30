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
