# Bitácora — Fase 9 (Una compra protegida, de punta a punta)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase usa T157 a T167
> (reserva hasta T170). El tablero del día a día es [`docs/ESTADO.md`](../ESTADO.md);
> aquí queda la narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-10-14 · Fase abierta (`P-19`), en paralelo con el cierre de la Fase 8. **Spec aprobado** por el
usuario el 14-oct, con sus decisiones `X-1` a `X-13`. **Chequeo del día 1 hecho:** el facilitator x402 liquida un
pago hacia un contrato, así que el pago al escrow puede ir por el mismo camino que hoy (`X-14`). Siguiente: T157, el
contrato de escrow, **cerrada** ([PR #88](https://github.com/vicentewolde/AgentPey/pull/88)): el contrato está en testnet, con un pago liberado y uno reembolsado de verdad. T159 cerrada ([PR #89](https://github.com/vicentewolde/AgentPey/pull/89)), en producción desde las 21:46 UTC. Orden nuevo, aprobado por el usuario: T159 → T160 → T158 (`X-21`). **T160 cerrada** ([PR #90](https://github.com/vicentewolde/AgentPey/pull/90)): desde el 15-oct
`agentcommerce` cobra a su escrow, y la primera compra real quedó retenida. **T158 cerrada** ([PR #91](https://github.com/vicentewolde/AgentPey/pull/91)): un
veredicto real reembolsó desde el pago retenido el 16-oct. **T161 cerrada** ([PR #92](https://github.com/vicentewolde/AgentPey/pull/92)): la orden muestra dónde está el pago en el
escrow, en producción desde las 21:43 UTC del 16-oct. Con T161 se completa el entregable D1. **T162 mergeada el
27-oct** ([PR #95](https://github.com/vicentewolde/AgentPey/pull/95)): el reclamo del chat abre la disputa en el escrow. Falta el reclamo en vivo desde Claude, grabado. **T163, código listo el 4-nov** (rama
`cc/t163-respuesta-comercio`): el comercio responde desde su página firmando con su wallet, y el árbitro decide desde la orden. Después: T164.

## Progreso

| Tarea | Estado |
|---|---|
| Chequeo del día 1 | ✅ hecho (`X-14`) |
| T157 Contrato de escrow | ✅ terminada |
| T158 El veredicto actúa sobre el pago retenido | ✅ terminada |
| T159 Un pago, un recibo, en la red | ✅ terminada |
| T160 El checkout paga al escrow | ✅ terminada |
| T161 La orden muestra el estado del escrow | ✅ terminada |
| T162 El reclamo desde el chat abre la disputa en la red | 🔨 mergeada; falta el reclamo en vivo desde Claude |
| T163 El comercio recibe el aviso y responde desde su página | 🔨 mergeada; respuesta tardía rechazada en la red (`759bc186…`); falta una respuesta a tiempo firmada por el usuario |
| T164 El despacho abre la ventana de liberación | 🔨 mergeada (PR #97); faltan los hashes de un despacho real |
| T165 Cada cambio de la disputa llega al agente | 🔨 código listo; suite UCP 49 · 8 · 20; falta el registro de una disputa real |
| T166 Corrida completa y QA | ✅ hecha el 11-nov ([evidencia](evidencia/T166.md)) |
| T167 Video, mapa de tiempos e informe final | ⏳ video grabado por el usuario; mapa y borrador del informe en [evidencia/T167.md](evidencia/T167.md); falta el minuto del video y entregar el informe |

---

## 2026-10-14 · Apertura de la fase y chequeo del día 1

**Qué quedó funcionando, en llano.** La fase tiene su plan aprobado: once tareas para que una compra hecha por un
agente quede protegida de punta a punta, con el pago retenido en un contrato hasta el despacho y el reembolso
saliendo de ese mismo pago. Antes de escribir el contrato se probó lo único que podía tumbar el diseño: si el
servicio que liquida los pagos x402 acepta pagarle a un contrato en vez de a una cuenta. Lo acepta: 0,01 USDC de
testnet llegaron a un contrato propio, y siguen siendo del usuario.

**Qué cambió del plan del 7-oct al leer el código.** La tienda tiene dos cuentas (una que firma y otra que cobra),
así que el contrato distingue quién registra la compra de quién la cobra (`X-4`). Un contrato compartido entre
tiendas habría dejado que una tienda tomara un pago ajeno, así que hay uno por tienda (`X-11`). El agente comprueba,
además del destino, que el contrato sea el escrow conocido y no una imitación (`X-9`).

**Evidencia.** [`evidencia/chequeo-dia-1.md`](evidencia/chequeo-dia-1.md): transacción
`84611558ffea12348a87aa23f9428749efcbba74e30f0d3bae04d61841cb077f`, efecto `contract_credited` sobre
`CBDRI5B7…D3YA`.

---

## 2026-10-14 · T157 · El contrato de escrow

**Qué quedó funcionando, en llano.** Existe en la red el contrato que guarda la plata de una compra hasta que la tienda
despacha. Si nadie reclama, la plata pasa sola a la tienda cuando vence el plazo. Si el comprador reclama, la plata
queda congelada hasta que el árbitro decide, y si el árbitro no decide a tiempo, vuelve completa al comprador. Para
reclamar no hace falta pedirle nada al árbitro: basta la firma de quien pagó. Se probó con dos compras de 0,05 USDC
de testnet: una terminó en la tienda y la otra volvió al rail que la pagó.

**Lo que hay que saber.** Hay dos contratos con el mismo código: el de `agentcommerce`, que usará la tienda desde T160,
y uno de ensayo con llaves del repo, porque la llave que firma por `agentcommerce` está solo en producción (`X-17`).
En el camino se precisaron cuatro cosas, todas aprobadas por el usuario: hasta cuándo se puede reclamar (`X-15`), que
un comprador con cuenta clásica también pueda reclamar (`X-16`), el ensayo (`X-17`) y el mensaje exacto que firma el
dueño del rail (`X-18`), que Rust y TypeScript comparten con un vector de prueba.

**Lo que corrigió la revisión.** Si un comprador que pagó desde una cuenta clásica quitaba después su permiso para
recibir USDC, un reembolso podía dejar la plata trabada para siempre. Ahora la compra se cierra igual, la tienda cobra
su parte y el reembolso queda guardado para el comprador, que lo recibe cuando vuelva a poder (`X-19`). Como un
contrato desplegado no se puede cambiar, se desplegaron de nuevo los dos escrows y se repitió el ensayo; los
anteriores quedaron registrados como retirados, sin plata. Un pago que llega y la tienda nunca registra queda como
límite conocido, que cubren T159 y T160 (`X-20`).

**Evidencia.** [`evidencia/T157.md`](evidencia/T157.md): 35 tests del contrato, los despliegues vigentes, y los hashes
del pago liberado (`81f106e0…` → `61ab6640…`) y del reembolsado (`97e71975…` → `3ef3185f…`).

---

## 2026-10-14 · Reorden: T158 pasa después de T160

Al planificar T158 apareció que el árbitro solo puede decidir sobre una compra con un recibo válido, y que todavía
ninguna compra real paga al escrow. El usuario eligió cambiar el orden: primero T159 (atar el recibo a su pago) y T160
(que el checkout pague al escrow), y después T158, con una compra de verdad (`X-21`). El entregable D1 sigue cerrando
al final de la semana 2.

## 2026-10-14 · T159 · Un pago, un recibo, en la red

**Qué quedó funcionando, en llano.** Cuando una tienda cobra a través de su escrow, el recibo dice en qué escrow
quedó la plata, y la tienda registra la compra en el contrato justo después del pago. Desde ahí la red no deja que
ese mismo pago respalde un segundo recibo: se probó con dinero de testnet, y la red rechazó el segundo. Cualquiera que
verifique un recibo comprueba además ese vínculo: si el recibo apunta a otro pago, o a un escrow de otra tienda, sale
inválido y dice por qué. Las tiendas que cobran directo no cambian, y sus recibos anteriores siguen verificando. La
tienda todavía no cobra al escrow; eso se enciende en T160.

**Evidencia.** [`evidencia/T159.md`](evidencia/T159.md): el recibo duplicado rechazado
(`87a80cc1…`, error `PaymentAlreadyHeld`), el chequeo "retenido" contra el escrow real y nueve recibos anteriores
válidos con el código nuevo.

## 2026-10-14 y 15 · T160 · El checkout paga al escrow

**Qué quedó funcionando, en llano.** Una tienda ya puede cobrar a su escrow en vez de a su cuenta. Lo anuncia en su
perfil con una versión nueva del medio de pago, que dice qué contrato guarda la plata, a qué cuenta la entrega y
quién arbitra. Antes de firmar, el agente lee ese contrato en la red y paga solo si:
- corre el código del escrow que conoce;
- su árbitro es el de AgentResolve;
- entrega la plata a la misma cuenta que AgentPey ya tenía registrada para esa tienda.

Una tienda tramposa (otro contrato, el escrow viejo, el de otra tienda) se rechaza sin firmar nada; se probó contra
contratos reales de testnet. La tienda también se revisa a sí misma: si su escrow no es suyo, no abre, y nunca vuelve a
cobrar directo a escondidas. Después de pagar, el agente confirma que la tienda registró la compra en el escrow y avisa
si no. En el chat, la cotización dice que la plata queda retenida hasta el despacho.

**Lo que no cambia.** Las tiendas sin escrow publican y cobran exactamente igual, y la suite oficial de UCP da lo mismo
que antes (49 · 8 · 20). El recibo sigue nombrando la cuenta de cobro, así que `get_order` y `open_claim` del MCP no
cambian. No se toca el Mandato, los topes ni el `policy_rail`.

**Cómo se enciende.** El merge no enciende nada. En la plataforma, el escrow de `agentcommerce` se asigna con la
variable `VITRINEE_COMERCIO_ESCROWS` en Render (`X-25`); se pone y se quita sin deploy. Decisiones: `X-23` (la versión nueva y
las dos puertas), `X-24` (qué comprueba el agente) y `X-25` (el interruptor y la comprobación al arrancar).

**Lo que corrigió la revisión.** Sin bloqueantes; trece hallazgos corregidos a pedido del usuario. El más importante:
la tienda escribe quién pagó cuando registra la compra, y el contrato no lo revisa, así que el agente ahora comprueba
que la compra quedó a nombre de quien pagó. Además, el escrow tiene que estar operado por la llave de recibos de la
tienda, la tienda solo abre con el árbitro de AgentResolve, y apagar o cambiar el interruptor nunca mueve una compra
pendiente a otro contrato. Antes del merge apareció otro problema: el gateway no le pasaba la variable a la tienda.
Por eso en Render se llama `VITRINEE_COMERCIO_ESCROWS`.

**Cómo se cerró.** Mergeada el 15-oct y en vivo a las 16:13 UTC, sin que nada cambiara para los compradores. El usuario
puso la variable en Render, y a las 16:22 `agentcommerce` ya declaraba su escrow. Un imán de 490 CLP (0,52 USDC de
testnet desde el rail UCP) quedó retenido en el escrow. El pago y el `hold` están en la red, y el recibo da sus cuatro
chequeos en verde. Así quedó probado también que el servicio que liquida los pagos acepta que el rail le pague a un
contrato. La plata sigue en el escrow: la liberan el despacho y la ventana (T164), o la reembolsa un veredicto (T158).

`@agentpey/ucp-stellar` queda en `0.2.0` en el repo; publicarla en npm es del usuario.

**Evidencia.** [`evidencia/T160.md`](evidencia/T160.md).

## 2026-10-15 y 16 · T158 · El veredicto actúa sobre el pago retenido

**Qué quedó funcionando, en llano.** Cuando una compra se pagó a un escrow, el reclamo, la decisión y el reembolso pasan
todos por ese contrato. El comprador abre el reclamo con su propia firma, sin pedirle nada al árbitro. La tienda tiene
el plazo que fija el contrato (15 minutos en `agentcommerce`). Claude propone un veredicto, una persona lo confirma, y
el contrato devuelve la plata desde el mismo pago retenido. Se probó de verdad: un imán comprado dos veces por error se
reclamó, el árbitro decidió reembolso completo, el usuario lo confirmó y los 0,52 USDC volvieron al rail que pagó
([`65f5f891…`](https://stellar.expert/explorer/testnet/tx/65f5f8910b549a147e438983ed16c75d35e7c0a98ea5d4d1e83f8e39fa911816)). Las disputas viejas, en
`agent-resolve`, siguen igual y siguen verificando.

**Lo que costó.** Seis corridas en dos días.
- **La primera** terminó en un veredicto en contra, que el usuario confirmó: el reclamo ("no llegó") se hizo a las dos
  horas de pagar. Antes, el árbitro había razonado sobre dos datos que le dábamos mal (un plazo de 48 horas y un número
  de orden), y eso se corrigió.
- **Las cuatro siguientes** se pasaron de la ventana del árbitro, que dura solo una hora: una caída de la RPC pública
  de Soroban, una respuesta que no llegó a tiempo, una confirmación tardía y un reinicio de la sesión. En las cuatro,
  el contrato hizo lo que promete: pasado el plazo, cualquiera puede devolverle todo al comprador (`expire`), y así se
  hizo.
- **La sexta** salió bien. De esos tropiezos quedaron reintentos y tiempos máximos en las lecturas de red, y registros
  que sobreviven a un reinicio.

**Lo que corrigió la revisión.** No hubo bloqueantes, y los quince hallazgos se corrigieron a pedido del usuario. El
más importante: un veredicto decidido con una respuesta en archivo no se ejecuta si después el comercio responde otra
cosa en la red. Además, `decide` ya no gasta una llamada cuando la ventana del árbitro cerró, `execute` vuelve a
comprobar el código del escrow, y las lecturas por el CLI de Stellar también se reintentan.

**Decisión:** `X-26`. **Evidencia:** [`evidencia/T158.md`](evidencia/T158.md). Mergeada el 16-oct ([PR #91](https://github.com/vicentewolde/AgentPey/pull/91)).

## 2026-10-16 · T161 · La orden muestra el estado del escrow

**Qué quedó funcionando, en llano.** La orden de una compra pagada a un escrow ahora dice dónde está la plata:
retenida, despachada (y cuándo se libera), liberada a la tienda, en disputa (con el plazo de la tienda y el del
árbitro), resuelta o vencida, y cuánto se reembolsó. Lo lee de la red en cada consulta. En el chat, `get_order` lo
cuenta en una frase: por ejemplo, "el pago está retenido en el escrow de la tienda y va a la tienda solo después del
despacho". Las órdenes de las tiendas que cobran directo no cambian.

**Qué compra muestra "retenido".** La de T160 ya no lo está: T158 la resolvió. La que sigue retenida es la que alguien
pagó desde el MCP el 15-oct (`ord_mv9s83yb…`); solo se lee. Leída localmente contra la red real, aparece retenida; la de
T160 y la sexta de T158, resueltas; y una de las vencidas, vencida.

**La revisión.** El chat ya no repite lo que la tienda dice del escrow: lo lee del contrato que nombra el recibo
firmado, y si la tienda muestra otra cosa, lo avisa. Las frases traen montos y fechas, la orden avisa cuando el pago
llegó al escrow pero la compra todavía no quedó registrada, y los avisos de la orden llevan el mismo estado.

**En producción.** Las cuatro órdenes del escrow de `agentcommerce` validan contra UCP `2026-08-25` y la extensión
`2026-10-16`: `ord_mv9s83yb…` retenida, la de T160 resuelta sin reembolso, la sexta de T158 resuelta con reembolso
completo (veredicto `f13730b9…`) y una de las vencidas, vencida. Smoke de producción 28/28.

**Decisión:** `X-27`. **Evidencia:** [`evidencia/T161.md`](evidencia/T161.md). Mergeada el 16-oct ([PR #92](https://github.com/vicentewolde/AgentPey/pull/92)).

## 2026-10-27 · T162 · El reclamo desde el chat abre la disputa en la red

**Qué quedó funcionando, en llano.** Hasta ahora, cuando alguien le pedía a Claude un reclamo, Claude lo firmaba y le
decía que se lo pasara al árbitro a mano. Ahora, si la compra se pagó al escrow de la tienda, Claude abre la disputa él
mismo en la red: el pago queda congelado donde está y la tienda no lo puede cobrar hasta que el árbitro decida. El chat
recibe el enlace de la transacción y hasta cuándo puede responder la tienda. Las compras pagadas directo a la tienda
siguen igual que antes.

**Antes de abrir, mira.** El MCP lee el escrow en la red y no envía nada si algo no cuadra: un contrato que no es el
escrow conocido, una compra que la tienda no registró, otro recibo, otro pago, otro monto, otro pagador, una disputa
que ya existe, o la ventana de reclamo cerrada. Cada caso tiene su error con nombre, y el chat lo puede contar.

**Otra llave no sirve.** La red solo acepta el reclamo si lo firma la dueña del rail que pagó. Se comprobó en testnet,
sin gastar: la misma llamada firmada por una llave al azar la rechaza la red, y firmada por la del MCP pasaría.

**Lo que falta.** La grabación del reclamo hecho desde Claude, con el hash de la disputa abierta. Claude habla con el
MCP de producción, así que primero hay que mergear (Render redespliega), y abrir la disputa cuesta una comisión de
testnet: los dos pasos esperan el OK del usuario. El guion está en la evidencia, sobre la compra que sigue retenida
(`ord_mv9s83yb…`, pagada desde el MCP).

**Decisión:** `X-28` (y el código de error nuevo `ResolveDisputeExists`). **Evidencia:** [`evidencia/T162.md`](evidencia/T162.md). Mergeada el 27-oct ([PR #95](https://github.com/vicentewolde/AgentPey/pull/95)), CI 4/4; producción 11/11 y 28/28 después del push.

## 2026-11-04 · T163 · El comercio recibe el aviso y responde desde su página

**Qué quedó funcionando, en llano.** Hasta ahora, una disputa obligaba a pasar archivos de mano en mano: el árbitro le
mandaba el reclamo al comercio, el comercio firmaba un mensaje y le devolvía otro archivo. Ahora todo queda junto al
pedido. Cuando Claude abre la disputa, le entrega el reclamo a la tienda, que lo guarda solo si es el mismo que quedó
registrado en la red. El portal del comercio avisa "reclamo abierto, responde antes de tal hora" con un enlace. En esa
página, el comercio lee el reclamo, escribe su versión y la firma con su wallet (Freighter o xBull): la firma es una
transacción que deja en la red la huella de su respuesta, dentro del plazo. La tienda guarda la respuesta junto al
pedido, y el árbitro decide leyendo las dos cosas desde ahí, comparadas con la red. Ningún archivo pasa de mano en mano.

**La tienda no puede cambiar nada.** Guarda los documentos, pero la red tiene sus huellas: quien los lee los compara.
Tampoco tiene la llave del comercio: arma la transacción y la manda solo después de leer que es exactamente la respuesta
de ese pedido, en su escrow, firmada por la cuenta de cobro.

**Lo que falta.** Los hashes de testnet: una respuesta a tiempo (la firma el usuario con su wallet, después del merge) y
una tardía que la red rechaza (un ensayo en el escrow de prueba, unos 8 minutos y 0,05 USDC que vuelven). Las dos
esperan el OK del usuario.

**Decisiones:** `X-29` y `VT-51`. **Evidencia:** [`evidencia/T163.md`](evidencia/T163.md).

**Merge y red (4-nov).** T163 mergeada ([PR #96](https://github.com/vicentewolde/AgentPey/pull/96), CI 4/4, `main` en
`0b205bd` a las 13:55 UTC). La respuesta tardía quedó rechazada por la red con su propio hash
([`759bc186…`](https://stellar.expert/explorer/testnet/tx/759bc186694fef49cddba622b5cb18e5b90f14f626027aad3882c35e50b6703e),
error 13 del contrato, `ResponseWindowClosed`), y los 0,05 USDC volvieron con `expire`. Para llegar ahí aparecieron dos
problemas ajenos a T163: testnet subió al protocolo 30 y las versiones de `stellar-sdk` del repo ya no podían armar
pagos (arreglado en el mismo PR, `P-22`), y el facilitator x402 respondió 504 aunque el pago sí entró (se registró con
`--paid`). Después del deploy, el MCP de producción no levantó: su credencial y su Mandato vencieron el 2-nov (duran 30
días) y el reinicio los volvió a verificar. Se renuevan con `mcp:setup --reissue`, con OK del usuario.

## 2026-11-04 · T164 · El despacho abre la ventana de liberación

**Qué quedó funcionando, en llano.** Hasta ahora, despachar un pedido no tocaba la plata retenida: el contrato esperaba
que alguien avisara del despacho, y nadie lo hacía. Ahora, cuando Shopify dice que el pedido salió completo, la tienda
avisa al contrato y empieza a correr el plazo de liberación (10 minutos en `agentcommerce`). Si en ese plazo nadie
reclama, la tienda libera sola la plata hacia su cuenta de cobro. Si alguien reclama antes, no libera nada: decide el
árbitro. Un pedido despachado en parte no abre el plazo, para que el comprador no se quede sin reclamo por lo que falta.

**Si algo falla, no se pierde.** Cada pedido guarda en qué paso está, y al reiniciar la tienda retoma los plazos
abiertos. Una llamada que falla se reintenta; si el contrato dice que todavía es temprano, espera unos segundos más.

**Lo que falta.** Los hashes de un despacho real: una compra en `agentcommerce`, que el usuario marque el envío en
Shopify, y esperar los 10 minutos. Va después del merge.

**Decisiones:** `X-30` y `VT-52`. **Evidencia:** [`evidencia/T164.md`](evidencia/T164.md).

**Merge (4-nov).** T164 mergeada ([PR #97](https://github.com/vicentewolde/AgentPey/pull/97), CI 4/4, `main` en
`44e631f` a las 14:37 UTC), después de corregir su bloqueante de revisión. La credencial y el Mandato del MCP se
renovaron en testnet (hasta el 4-dic, `mcp:setup --reissue`, con OK del usuario); faltan copiarlos a Render.

## 2026-11-04 · T165 · Cada cambio de la disputa llega al agente

**Qué quedó funcionando, en llano.** El agente que compró ya recibía un aviso firmado cuando se creaba el pedido y cuando
se despachaba. Ahora también recibe uno por cada paso de una disputa: cuando se abre, cuando el comercio responde, cuando
el árbitro decide, y cuando la plata se libera a la tienda o vuelve al comprador. La tienda se entera leyendo el contrato
en la red, así ve también lo que no hace ella (el veredicto del árbitro, o un reembolso por vencimiento). Si entre dos
lecturas pasaron varias cosas, avisa de todas, en orden. Cada aviso es la orden completa, con el estado del pago en ese
momento, firmado con la llave de la tienda.

**Del otro lado,** el receptor de agentpey.com comprueba la firma de cada aviso y lo anota con su paso y el reembolso. La
suite oficial de UCP sigue igual: 49 bien, 8 fallas y 20 omitidas, las mismas de antes.

**Lo que falta.** El registro de una disputa real, con cada aviso entregado y verificado: sale de la corrida de T166.

**Decisiones:** `X-31` y `VT-53`. **Evidencia:** [`evidencia/T165.md`](evidencia/T165.md).
