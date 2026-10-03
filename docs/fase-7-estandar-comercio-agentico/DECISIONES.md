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

---

### E-8 · T123 exporta el Mandato a mandatos abiertos de AP2 v0.2 y los verifica fuera de línea; no se negocia AP2 en el checkout UCP · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T123 · Decidido por el usuario

**Qué se leyó, del fuente.** La spec de AP2 `v0.2` (repo
`google-agentic-commerce/AP2`, publicada el 2026-04-28, commit `e1ea56d`) y la
extensión de AP2 en UCP, en `v2026-04-08` y en `v2026-08-25`. AP2 `v0.2` ya no
tiene mandatos Intent, Cart y Payment: tiene un mandato de checkout y uno de
pago, cada uno abierto (firmado por el usuario o por quien opera al agente, con
límites y la llave del agente en `cnf`) o cerrado (firmado por el agente al
comprar). El Mandato de AgentPey corresponde a los dos **abiertos**, en el modo
"sin humano presente" de AP2.

**Qué se hace.** El Mandato verificado se exporta a un mandato abierto de
checkout (`mandate.checkout.open.1`) y uno de pago (`mandate.payment.open.1`),
como SD-JWT. AgentPey firma como "Trusted Agent Provider" de AP2, porque la
wallet del principal firma SEP-53 y no puede producir un JWS
(`packages/mandate/src/wallet-sign.ts`). Un verificador propio los acepta o los
rechaza con un error tipado, y la librería oficial de AP2 en Python los
verifica como chequeo cruzado. 16 h.

**Alternativa descartada: negociar `dev.ucp.shopping.ap2_mandate` en el
checkout UCP de Vitrinee** (unas 50 h). Toca `complete`, que es el camino de la
grabación del 11 de octubre, exige deploy y deja la sesión "security locked".
Además, en UCP `2026-08-25` la extensión se renombró
(`dev.ucp.common.payment.ap2_mandate`, `signing_keys` → `keys`), y `E-2` fija
`2026-04-08`: se construiría sobre un nombre ya obsoleto. Queda como brecha
para el SEP. **También descartado: reconstruir mandatos cerrados para la compra
de T122**: serían firmas puestas después de la compra, no evidencia de ella.

---

### E-9 · Llaves de AP2: Ed25519 existentes en la exportación real; P-256 solo de un uso, en el chequeo cruzado · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T123 · Decidido por el usuario (`P-10`)

El código acepta `EdDSA` y `ES256`. La exportación real firma con
`ISSUER_SECRET_KEY` y pone la llave Stellar del agente en `cnf`: no se agrega
ninguna llave persistente. El chequeo cruzado genera llaves P-256 dentro del
script, las usa una vez y las descarta.

**Motivo.** AP2 `v0.2` exige ECDSA solo para el checkout que firma el comercio
(`specification.md`, líneas 155–157), y su propia sección de seguridad lo
contradice (permite Ed25519 si el checkout trae entropía). El issue AP2 #268,
abierto, propone quedarse con la regla de entropía y quien mantiene AP2 está de
acuerdo; UCP `2026-08-25` cita ese issue. La librería oficial de AP2 verifica
los mandatos abiertos firmados con Ed25519 y con `cnf` Ed25519 (comprobado al
implementar, ver la evidencia de T123); donde exige P-256 es un paso después,
al seguir el `cnf` para verificar el cierre del agente
(`ap2/sdk/sdjwt/kb_sd_jwt.py`, modelo `JsonWebKey`). El chequeo cruzado corre
sobre los dos: el export real en Ed25519 y el mismo export en P-256.

**Corrección (2026-10-01, al implementar).** El replanteo decía que la librería
oficial "solo acepta P-256". Era impreciso: la restricción aplica al `cnf` del
cierre, no a la firma de los mandatos abiertos. La decisión no cambia; queda
más respaldada.

**Alternativa descartada: un par P-256 persistente para la plataforma y otro
por agente.** Interoperable hoy, pero es custodia nueva (secreto en
`.env.local` y Render, publicación de la llave, rotación) para un formato que
nadie consume todavía. Si un socio lo pide, se decide entonces.

---

### E-10 · `perDay` y la revocación no se exportan a AP2: el mandato abierto vence pronto · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T123 · Decidido por el usuario

AP2 no tiene un tope diario (`payment.budget` es un total) ni revocación, y un
verificador AP2 tiene que rechazar cualquier restricción que no conozca. Por
eso `perDay` no se exporta: lo sigue aplicando el `policy_rail` en la red. El
mandato abierto vence a la hora o en el `validUntil` del Mandato, lo que llegue
primero, como recomienda AP2, y lleva el hash del Mandato y su registro para
quien quiera consultarlo en línea.

**Alternativa descartada: una restricción propia (`com.agentpey.per_day`).**
Cualquier verificador AP2 que no la conozca rechazaría el mandato entero.

---

### E-11 · La exportación es por compra: Mandato más una tarea (tienda, producto, cantidad) · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T123 · De Claude Code

El esquema del mandato abierto de checkout exige una restricción
`checkout.line_items` (`open_checkout_mandate.json`, `contains`), y el de pago
exige `payment.reference` al de checkout. AP2 pide además que un mandato abierto
no se presente otra vez sin un rechazo previo. Un mandato abierto de AP2 es una
tarea, no un permiso permanente. Por eso se exporta un par por compra, a partir
del Mandato y de la intención de compra firmada por el agente. Antes de firmar,
el exportador corre `checkMandate` (sin cambios) sobre esa intención y no emite
nada si el Mandato no la permite: la plataforma no firma más de lo que el
principal consintió.

**Alternativa descartada: un par permanente con solo `checkout.allowed_merchants`.**
La librería oficial lo acepta, pero no cumple el esquema JSON de AP2.

---

### E-12 · El tope del mandato AP2 va en centavos, redondeado hacia abajo, y es el menor de los cuatro límites · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T123 · Decidido por el usuario, tras `/revisar`

AP2 lee `payment.amount_range.max` en "minor (cents) unit of currency"
(`open_payment_mandate.json`). La primera versión escribía unidades de Stellar
(7 decimales): 3,00 USDC salía como `30000000`, que un lector de AP2 entiende
como 300.000. Ahora el tope va en centavos, redondeado hacia abajo
(3,00 → `300`; 0,0199999 → `1`), y es el menor entre `perTx` y `perDay` de la
credencial y del Mandato: con `perDay` en 0 (la pausa del gasto) no se exporta
nada (`Ap2MandateInvalid`).

**Motivo.** Un mandato exportado nunca puede permitir más de lo que AgentPey
mismo permitiría. Redondear hacia abajo pierde precisión bajo el centavo y
nunca amplía el permiso.

**Alternativa descartada: dejar las unidades de Stellar y avisarlo en el
anexo.** Cualquier verificador de AP2 que siga el esquema leería un tope
100.000 veces mayor.

---

### E-13 · La exportación AP2 también verifica la credencial y corre `checkScope` · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T123 · Decidido por el usuario, tras `/revisar`

`exportMandateAsAp2` verifica en la red la credencial AgentPass del agente,
exige que la intención nombre esa credencial, ese agente y ese principal, y
corre `checkScope` (sin cambios) antes de `checkMandate`. Así se cumple `M-4`
(las dos autoridades tienen que permitir) y revocar la credencial, el corte
desde fuera del agente, también detiene la exportación.

**Alternativa descartada: solo el Mandato, como pedía el spec.** Con la
credencial revocada el exportador seguía firmando, y con una credencial más
estrecha que el Mandato el tope exportado era el del Mandato.

**También tras `/revisar`:** la llave del agente en `cnf` ya no se puede elegir
en la exportación real; la variante con llave P-256 vive aparte
(`apps/agent/src/ap2/cross-check.ts`), fuera del índice del paquete, y su `iss`
es `urn:agentpey:ap2-cross-check:…`, nunca el `did:stellar` del emisor. El par
vence a más tardar con la intención.

---

### E-14 · El veredicto de una disputa se paga desde una garantía del comercio en un contrato · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T124 · Decidido por el usuario (opción a de la sección 9 del spec)

Cada comercio tiene una garantía en USDC dentro de un contrato. Si el veredicto
da la razón al comprador, el reembolso sale de esa garantía hacia quien pagó.
El flujo de pago existente (x402, `policy_rail`, recibo) no cambia.

**Alternativas descartadas:** (b) retener el pago antes de liberarlo al
comercio, que cambia el `payTo` de x402 y el recibo; (c) un veredicto público
sin mover fondos, que no resuelve nada para el comprador.

---

### E-15 · Las disputas se llaman AgentResolve · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T124 · Decidido por el usuario

Descartados: Veredicto, Dictamen, AgentPey Resolve.

---

### E-16 · El árbitro de AgentResolve tiene su propia llave, `RESOLVE_ARBITER_SECRET_KEY` · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T124 · Decidido por el usuario (`P-10`)

Una cuenta de testnet nueva, solo para abrir y resolver disputas en el contrato
`agent-resolve`. Vive en `.env.local`. No firma credenciales, Mandatos ni
pagos.

**Alternativa descartada: reusar `ADMIN_SECRET_KEY`.** Mezcla la llave que
registra emisores con la que decide reembolsos: comprometer una daría las dos.

---

### E-17 · El árbitro es Claude Opus 5.5, por la API de Anthropic · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T124 · Decidido por el usuario

Salida estructurada y validada con zod. El reclamo y la evidencia son datos no
confiables: el monto que propone el modelo se recorta en el código al monto en
disputa, y el contrato lo vuelve a recortar al monto del recibo anclado.
`ANTHROPIC_API_KEY` la agrega el usuario a `.env.local`.

**Sin fallback a otro modelo** (2026-10-01, tras `/revisar`, decidido por el
usuario). La primera versión usaba el fallback de la API (`fallbacks:
"default"`), que ante una negativa de Opus deja decidir a otro modelo: eso
contradecía esta misma decisión. Ahora, si Opus se niega, no hay veredicto
(`ResolveVerdictInvalid`) y la disputa la resuelve una persona; un veredicto
que no venga de `claude-opus-5-5` se rechaza.

---

### E-18 · En v0 una persona confirma el veredicto antes de mover fondos · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T124 · Decidido por el usuario

`resolve:decide` muestra el veredicto y su razonamiento y pide confirmación
antes de llamar a `resolve` en el contrato.

**Alternativa descartada: pagar sin confirmación cuando el monto cabe en los
límites.** Los límites acotan el daño, no lo anulan: un reclamo falso dentro
del monto del recibo igual sería pagado.

---

### E-19 · El comercio retira lo que no está bloqueado; sin aviso previo en v0 · `Vigente`
**Fecha:** 2026-10-01 · **Tarea:** T124 · Decidido por el usuario

`withdraw` permite sacar el saldo de la garantía menos lo bloqueado por
disputas abiertas. Brecha que queda escrita para el SEP: un comercio podría
retirar todo antes de que llegue un reclamo.

**Alternativa descartada por ahora: retiro con aviso previo** (unas 2 h más).

---

### E-20 · El comercio firma su respuesta con Freighter, desde la cuenta de cobro del recibo · `Vigente`
**Fecha:** 2026-10-02 · **Tarea:** T126 · Decidido por el usuario (opción A)

La respuesta del comercio a un reclamo se firma con la wallet del dueño
(SEP-53, `signMessage`) sobre un mensaje legible que lleva el hash del
documento, como el Mandato firmado con wallet (`packages/mandate/src/wallet-sign.ts`).
El verificador exige que quien firma sea `merchantAccount`, la cuenta de cobro
que el comercio firmó dentro del recibo, y que la respuesta apunte al
`claim_hash` de la disputa en la red.

**Motivo.** Es la llave del dueño, la misma con la que entra al portal (`VT-29`),
y AgentPey no la custodia. Se verifica con el recibo solo, sin consultar la
base de la plataforma. La firma del recibo (`merchantDid`) y la de la respuesta
son cuentas distintas, pero el recibo firmado las une.

**Alternativa descartada: (B) la plataforma firma con la llave cifrada del
comercio** (`merchantDid`) después del login del dueño. Mismo formato JWS que el
reclamo, pero la firma probaría que firmó la plataforma, no el dueño, y le daba
un uso nuevo a una llave custodiada (`P-10`).

---

### E-21 · El comercio responde en una página estática de `agentpey.com`, y la respuesta viaja como archivo · `Vigente`
**Fecha:** 2026-10-02 · **Tarea:** T126 · Decidido por el usuario (canal 2)

Una página en `agentpey.com`, como `consent.html` y `revocar.html`: el dueño
carga el reclamo que le envía el árbitro, lo lee, escribe su posición y sus
descargos, firma con Freighter y descarga la respuesta firmada, que devuelve al
árbitro. `resolve:decide -- --response <archivo>` la verifica y la guarda junto
al reclamo.

**Motivo.** Sin base de datos ni backend nuevo, llega con holgura al reembolso
real del 8-oct. El mensaje firmado lo arma la página y lo reconstruye el
verificador; un test fija que coincidan byte a byte.

**Alternativa descartada por ahora: (1) bandeja de reclamos en el portal de
Vitrinee** (unas 22 h: tabla nueva, endpoints, pantalla y deploy, y Vitrinee no
tiene notificaciones). Es la evolución natural; queda para después de la fase.
Brecha que queda escrita: el ida y vuelta entre árbitro y comercio es a mano.

---

### E-22 · El comercio tiene 48 h desde la apertura para responder · `Vigente`
**Fecha:** 2026-10-02 · **Tarea:** T126 · Decidido por el usuario

`resolve:decide` corre de inmediato si hay respuesta. Sin respuesta, se niega
con un error tipado hasta que pasan 48 h desde `opened_at` (la hora que guarda
el contrato); después decide con una sola parte y el veredicto lo dice
(`responseHash: null`). El plazo no vive en el contrato, que sigue igual.

**Motivo.** Da al comercio un tiempo razonable sin que una disputa quede abierta
indefinidamente, y en el caso real del 8-oct permite `open`, respuesta y
`decide` el mismo día.

**Alternativa descartada: 24 h**, demasiado corto para un comercio pequeño sin
notificaciones. **Y: plazo en el contrato**, que obliga a redesplegarlo.

---

### E-23 · La disputa se muestra en la orden UCP como ajuste nativo más un campo `dispute` en la extensión de recibo · `Vigente`
**Fecha:** 2026-10-02 · **Tarea:** T127 · Decidido por el usuario

`GET /ucp/v1/orders/{id}` agrega un elemento a `adjustments[]` (el campo de UCP
para "refunds, returns, credits, disputes"): `type: "dispute"`, `pending`
mientras está abierta, `completed` al resolverse, con el reembolso como monto
negativo. Y la extensión `com.agentpey.shopping.receipt` gana un campo opcional
`dispute` con lo que un verificador necesita: contrato, estado, `claim_hash`,
`verdict_hash`, montos y fechas. Compatible hacia atrás.

**Motivo.** Un cliente UCP cualquiera entiende el ajuste sin conocer AgentPey,
y uno que sí lo conoce tiene los hashes para verificar contra la red.

**Alternativa descartada: una extensión nueva solo para disputas.** Duplicaba
la relación con el recibo, que ya vive en su extensión.

---

### E-24 · La orden muestra solo lo que está en la red, no el razonamiento del veredicto · `Vigente`
**Fecha:** 2026-10-02 · **Tarea:** T127 · Decidido por el usuario

El estado, el hash del veredicto y el reembolso se leen del contrato. El
razonamiento de Claude vive en la máquina del árbitro (`verdict.json`) y no se
publica en v0. Límite que queda escrito para el SEP.

**Alternativa descartada por ahora: publicar el veredicto completo**, que pide
dónde alojarlo y decidir qué partes del caso son públicas.

---

### E-25 · La Fase 7 se cierra con dos comprobaciones pendientes, que pasan a la Fase 8 con fecha · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** cierre de la fase · Decidido por el usuario

La Fase 7 se cierra el 2026-10-03 con sus ocho tareas (T120 a T127) en `main` y
sus cuatro criterios de aceptación cumplidos. Quedan dos casillas de "Hecho
cuando" sin marcar, las dos atadas a una fecha y no a código:

- T124: el reembolso real en testnet, el 8 o 9 de octubre, sobre el pedido
  Shopify `18952373174578`, en una rama de evidencia aparte.
- T127: ver `ord_muq1gqhycf4961492c` con su disputa abierta ese día y resuelta
  después.

Las dos pasan a la Fase 8 como pendientes con fecha, y su evidencia se sigue
guardando en `evidencia/T124.md` y `evidencia/T127.md` de esta fase. El plan de
demo (sección 7 del spec), que nunca se escribió, pasa a la tarea T142 de la
Fase 8.

**Motivo.** El reembolso espera a que venza el plazo de despacho del pedido: no
hay nada que construir antes del 8. Mantener la fase abierta cinco días solo
por eso impedía abrir la Fase 8, que es la que produce lo que se graba para
Find Your Way (entrega el 11-oct). Es lo mismo que se hizo al cerrar la Fase 6
(`C-161`): se cierra diciendo qué quedó sin cumplir y a dónde va.

**Alternativa descartada: cerrar la Fase 7 después del reembolso**, como pide
la precondición de `/fase-cerrar` (todas las tareas ✅ o ✂️). Dejaba dos fases
abiertas a la vez, que es lo que la retro de la Fase 6 pidió no repetir.

