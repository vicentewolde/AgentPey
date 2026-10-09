# Bitácora — Fase 8 (Agentes reales comprando en Stellar, y el estándar completo)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase empieza en T128.
> El tablero del día a día es [`docs/ESTADO.md`](../ESTADO.md); aquí queda la
> narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-10-08 · Fase abierta (`P-16`). **Spec aprobado** por el usuario
el 3-oct, con sus decisiones `R-1` a `R-6`. **T132 cerrada**: el
verificador rechaza un recibo que se contradice y la tienda no emite dos
recibos sobre un pago. **T128 cerrada**: el servidor MCP está en vivo en
`mcp.agentpey.com` y Claude cotizó un imán en `agentcommerce` que terminó en un
pedido real y un recibo con los tres checks en verde; el pago lo apretó la
persona, porque claude.ai no ejecuta pagos (`R-11`). **T129 cerrada**:
Claude y ChatGPT conectados, y ChatGPT compró pagando él mismo tras la
confirmación.
**T131, T133 y T134 cerradas**: la suite oficial de UCP corre contra la tienda,
la tienda habla las dos versiones de UCP, y con AP2 no cobra sin un mandato
que la librería oficial de AP2 verifica sobre una compra real. **T147 cerrada**:
la tienda avisa al agente. **T148 cerrada**: un agente compra un carrito de
varios productos, con un solo cobro y un recibo de un ítem por línea.
**T149 cerrada**: el consentimiento del comprador llega al pedido de la
tienda, comprobado con una compra real. **T135 cerrada**: MPP charge no
admite pagar desde el `policy_rail`; se documenta y no se construye (`R-20`).
**T136 cerrada**: el paquete [`@agentpey/ucp-stellar`](https://www.npmjs.com/package/@agentpey/ucp-stellar)
está publicado en npm, compra desde un proyecto vacío, y el agente de AgentPey
paga a través de él (`R-21`). **T137 cerrada** ([PR #64](https://github.com/vicentewolde/AgentPey/pull/64)):
un kit abierto comprueba si cualquier tienda implementa bien el medio de pago
de Stellar (`R-22`). **T143 cerrada** ([PR #65](https://github.com/vicentewolde/AgentPey/pull/65)):
las cinco pantallas de firma aceptan Freighter y xBull, y las que solo firman
un mensaje también LOBSTR, probado por el usuario en agentpey.com (`R-23`).
El 7-oct el usuario decidió **no cortar nada** para la hackatón y dejar GenLayer y
Trustless Work (T138, T139) para el final de la fase (`R-24`). El 8-oct: el reembolso real de T124 (pedido #1006), T150 cerrada con Claude comprando un carrito, `/en-vivo` en producción y cerrada (T151), la portada al día (T152, en producción) y la página del presupuesto de equipo (T153, [PR #73](https://github.com/vicentewolde/AgentPey/pull/73)). **T145 cerrada**:
un equipo puede pagar servicios por uso desde un `policy_rail`; las
suscripciones con tarjeta quedan como diseño (`R-25`). **T146 cerrada**, adelantada al
video (`R-27`): un equipo le da a su agente un presupuesto y el agente paga créditos de
SignalDesk desde un rail ya desplegado. **T141 cerrada**: [`agentpey.com/tiendas`](https://agentpey.com/tiendas)
muestra las tiendas del directorio con su último recibo anclado, leído de la red (`R-26`).

| Tarea | Estado |
|---|---|
| T128 Servidor MCP | cerrada |
| T129 Claude y ChatGPT conectados | cerrada |
| T130 Tienda de terceros | pendiente |
| T131 Suite de conformidad UCP | cerrada |
| T132 Coherencia del recibo | cerrada |
| T133 UCP `2026-08-25` | cerrada |
| T134 AP2 en el checkout | cerrada |
| T135 MPP charge (prueba técnica) | cerrada |
| T136 SDK en npm | cerrada |
| T137 Kit de conformidad de Stellar | cerrada |
| T138 Prueba técnica: GenLayer | pendiente, al final de la fase (`R-24`) |
| T139 Prueba técnica: Trustless Work | pendiente, al final de la fase (`R-24`) |
| T140 Resolutor intercambiable | pendiente (pide aprobación) |
| T141 Página de tiendas | cerrada |
| T142 Guion y grabación | pendiente |
| T143 Más wallets | cerrada |
| T144 dots, Muse y Grok Bot | pendiente |
| T145 Tesorería de equipos (prueba técnica) | cerrada (`R-25`) |
| T146 Demo de presupuesto de equipo | cerrada |
| T147 Webhooks de orden | cerrada |
| T148 Varios productos | cerrada |
| T149 Consentimiento | cerrada |
| T150 Pulido del MCP | cerrada |
| T151 Página En vivo | cerrada |
| T152 Portada al día | cerrada |
| T153 Página del presupuesto de equipo | cerrada |

Heredado de la Fase 7 (`E-25`), con fecha: el reembolso real de T124 y ver
`ord_muq1gqhycf4961492c` con su disputa, el 8 o 9 de octubre.

## Apertura de la fase (2026-10-03)

La Fase 7 dejó la compra por UCP funcionando, pero hecha desde un programa
propio y en la tienda del usuario. Lo que el jurado de Find Your Way ve es un
video, y en ese video tiene que aparecer un agente que la gente conoce
(Claude) comprando en una tienda ajena. El usuario abrió la Fase 8 para eso
(`P-16`), y para llegar al video pudiendo decir, con evidencia, qué cumple
AgentPey de UCP, de AP2 y de MPP.

Al planificar se leyeron las fuentes oficiales y el código, y varias tareas
del traspaso cambiaron de forma: la suite oficial de UCP no se puede correr
contra una tienda real tal cual, MPP en Stellar hoy no acepta como pagador una
cuenta con límites, y UCP solo admite un tipo de llave para los mandatos AP2.
El detalle está en la sección 4.1 del spec.

## T132 · Un recibo que no se contradice (2026-10-03, cerrada)

**Qué quedó funcionando.** Un recibo de Vitrinee dice cuánto se pagó de dos
maneras: en un número con decimales, que es el que lee una persona, y en
unidades enteras, que es el que se compara con la red. Hasta hoy nadie miraba
que los dos dijeran lo mismo, ni que el recibo nombrara el mismo USDC que el
verificador busca en el pago. Un recibo podía mostrar "0,94 USDC" a quien lo lee
y pasar los tres checks por 9,46. Ahora ese recibo sale inválido, con el motivo
escrito, y la tienda se niega a firmarlo.

Lo segundo: un pago respalda un solo recibo. La tienda ya lo cuidaba cuando el
mismo pago llegaba dos veces seguidas, pero no cuando llegaba dos veces al mismo
tiempo. Un test nuevo lo reprodujo: salían dos pedidos y dos recibos. Quedó
cerrado: la segunda solicitud espera y recibe el pedido de la primera.

**Por qué así.** Siguen siendo tres checks: el recibo incoherente falla el
primero, que ahora es "firma y contenido" (`VT-39`). Y la unicidad la garantiza
la tienda, no el verificador (`VT-40`): el único que podría firmar dos recibos
sobre un pago es el comercio, y un tercero no tiene cómo notarlo mientras el
registro en la red no guarde el hash del pago.

**Lo que no hace.** No impide, en la red, que un comercio deshonesto ancle dos
recibos sobre un mismo pago. Eso pide un contrato nuevo y quedó escrito como
brecha 10 del anexo. Tampoco comprueba que la suma de los ítems sea el total.

**La revisión.** `/revisar` no encontró bloqueantes y sí un caso que se me había
pasado: si el dueño edita su tienda justo mientras se procesa una compra, la
plataforma arma una tienda nueva que no sabía del pedido en curso, y el mismo
pago podía dar dos recibos. Corregido, junto con los otros seis hallazgos
(`VT-41`). Queda un límite escrito: la garantía vale dentro de un proceso, la
base de datos todavía no la respalda.

**Cómo se cerró.** Con el OK del usuario, a `main` por fast-forward
(PR #44). El merge despliega Vitrinee y publica el cambio en la spec de la
extensión de recibo. Evidencia en
[`evidencia/T132.md`](evidencia/T132.md).

## T128 · El servidor MCP de AgentPey (2026-10-03, cerrada)

**Qué quedó funcionando (PR 1).** Existe un servidor nuevo, `apps/mcp`, que habla
MCP, el idioma con el que Claude y ChatGPT usan herramientas de terceros. Tiene
seis: buscar productos en las tiendas de Vitrinee, ver uno, cotizar, pagar, ver
la orden con su recibo verificado, y firmar un reclamo. Por ahora corre en local
y se prueba contra una tienda de Vitrinee de prueba, sin red.

Lo importante está en `pay`. Solo paga una cotización que el propio servidor
emitió, una sola vez, antes de que venza, y solo si viene con la confirmación
explícita de la persona. Justo antes de firmar vuelve a leer la tienda: si el
destinatario, el activo o el monto cambiaron desde la cotización, no paga. Y el
pago pasa por el mismo control de siempre contra el Mandato, antes de firmar
nada: una compra sobre el tope se corta ahí.

**Por qué así.** El modelo de lenguaje nunca elige a quién pagar ni cuánto: eso
sale de la tienda y se compara con lo que la tienda declara en público. Un
texto malicioso en un catálogo puede pedirle cosas al modelo, pero no cambiar la
cotización ni el tope.

**La revisión del PR 1.** `/revisar` sin bloqueantes; se corrigieron los ocho
hallazgos importantes, entre ellos que `get_order` ahora comprueba que el recibo
que muestra la tienda es de esa orden y de esa tienda. Mergeado con el OK del
usuario ([PR #45](https://github.com/vicentewolde/AgentPey/pull/45)).

**PR 2, en código.** El servidor ya exige iniciar sesión: Claude o ChatGPT abren
una página de AgentPey donde la persona firma un mensaje con Freighter, y solo
entra la wallet dueña del rail. Lo demás quedó listo para encenderlo: el
arranque real (que se niega a partir si la credencial o el Mandato no
verifican), el script que prepara al agente, el rail propio y el lugar del
servidor en `mcp.agentpey.com`.

**En testnet (3-oct).** Con la wallet del usuario como principal: el agente del
MCP tiene su credencial y su Mandato anclados, el rail propio está desplegado
con 10 USDC, y la red rechazó una compra de 6 USDC por encima del tope sin que
se enviara nada.

**La revisión del PR 2.** `/revisar` sin bloqueantes; se corrigieron los 14
hallazgos. Lo más importante: el servidor no arranca si, en la red, el rail no
es de su agente o su principal no es la wallet que inicia sesión; cada token
de renovación sirve una vez; y nadie puede bloquear el inicio de sesión
pidiendo desafíos en masa. Mergeado con el OK del usuario ([PR #46](https://github.com/vicentewolde/AgentPey/pull/46)); el
servidor queda apagado hasta que estén sus variables en Render. Falta la compra
desde Claude.

**Lo que faltaba (PR 2).** Que nadie más que el usuario pueda usarlo (OAuth con
inicio de sesión firmando con la wallet, `R-7`), preparar la llave, la
credencial, el Mandato y el rail del agente (`mcp:setup`, `R-8`, `R-9`), y
publicarlo en `mcp.agentpey.com`. Recién ahí la compra desde un chat de Claude.

**En vivo y la compra (3-oct, cierre).** El usuario puso el dominio
`mcp.agentpey.com` y las variables en Render, y el CNAME en el DNS. Desde fuera,
el servidor responde lo que esperan Claude y ChatGPT: sin sesión, 401 y dónde
iniciarla; la página de inicio de sesión carga con su política de seguridad y
Freighter fijado.

Después, la compra. En un chat de claude.ai con el conector AgentPey, "compra un
imán en agentcommerce": Claude buscó el producto y lo cotizó (1.490 CLP, 1,5684211
USDC, desde el rail del MCP a la cuenta de cobro de la tienda), y ahí se detuvo.
Se negó a pagar dos veces, también con la confirmación explícita del usuario: mover
un activo financiero, aunque sea de prueba, lo deja a la persona. No es un fallo
nuestro, es la política del modelo. Así que el usuario apretó `pay` él mismo, sobre
la cotización que dio Claude, desde el MCP Inspector oficial con el mismo inicio
de sesión. Resultado: orden `ord_muszfkwz2604255e03`, pedido real en Shopify
(`18990053523762`), y un recibo que se verificó por fuera, sin confiar en AgentPey
ni en la tienda: firma, anclaje y pago en verde. En la red, la transacción mueve
exactamente lo cotizado del rail a la tienda, dentro de los topes.

**Qué cambió del spec (`R-11`, con el OK del usuario).** "Una compra desde
Claude" ahora quiere decir: Claude busca, cotiza y verifica; la persona aprieta
pagar. Para la tesis no es una pérdida: el agente no mueve fondos sin que la
persona apriete el botón, y ni así puede salirse del tope. Aplica también a T129,
T130 y al primer criterio de la fase.

**Lo que quedó en deuda.** Las sugerencias de los dos `/revisar` que no se
corrigieron siguen en `docs/ESTADO.md`. Ninguna bloquea.

## T129 · Claude y ChatGPT conectados (2026-10-03, cerrada)

**Qué quedó funcionando.** AgentPey se puede agregar a Claude y a ChatGPT como
cualquier otra herramienta, y la guía paso a paso quedó en el README del
servidor (`apps/mcp/README.md`), con los nombres de menú que se vieron al
hacerlo. Desde los dos chats se compró un imán real en `agentcommerce`, con
pedido en Shopify y un recibo que se verifica por fuera.

**La diferencia entre los dos.** Claude busca y cotiza, pero no paga: deja ese
botón a la persona, que lo aprieta desde el MCP Inspector (`R-11`, la compra
de T128). ChatGPT, en modo desarrollador, hizo todo el recorrido: encontró el
producto, pidió el despacho, cotizó, preguntó "¿Confirmas que pague
1,5684211 USDC?", y con "confirmo el pago" llamó `pay` él mismo. En los dos
casos el dinero sale del mismo rail y la red aplica los mismos topes: entre
las dos compras el rail gastó 3,14 de los 5,00 del día.

**Lo que no hizo falta.** El plan anotaba dos riesgos con ChatGPT (dónde busca
los metadatos y qué valor manda en `resource`); la conexión funcionó a la
primera y no se tocó el servidor de autorización.

**La revisión.** `/revisar` sin bloqueantes. Lo más importante que encontró:
la evidencia mostraba salidas compactadas a mano como si fueran crudas (ya son
literales, también en T128), y faltaba ver a Claude leyendo la orden, la
tercera parte de `R-11` (ya hay captura). Se corrigieron los diez hallazgos.

## T131 · La suite oficial de conformidad de UCP (2026-10-03, cerrada)

**Qué quedó funcionando.** Con un comando, `pnpm run ucp:conformance`, se corre
la suite oficial de UCP completa contra una tienda de Vitrinee que solo existe
en la máquina de quien la corre. De 77 tests, 40 pasan, 20 la suite los salta y
17 fallan, cada uno con su motivo escrito en la evidencia.

**Cómo se hizo sin abrir un agujero.** La suite paga siempre con un medio de
pago de prueba que no cobra. Eso no puede existir en una tienda desplegada, así
que no se tocó el código de cobro: la tienda de prueba envuelve a la tienda real
desde afuera, traduce ese pago a uno que solo su propio facilitador falso
acepta, firma con llaves que se tiran al terminar y se niega a arrancar fuera de
la máquina local (`R-13`). Un test comprueba que una tienda arrancada como en
producción sigue rechazando el pago de prueba aunque su facilitador acepte todo.

**Lo que encontró la suite, y se corrigió (`VT-42`).** Cinco cosas del checkout
que usan las tiendas reales: la clave de idempotencia ahora significa lo que UCP
dice (la misma solicitud recibe la misma respuesta; otra solicitud con esa
clave, un 409), una versión de UCP que la tienda no sirve recibe 422, y tres
detalles de forma. Pasaron de 28 a 40 tests.

**Lo que encontramos en la suite.** Manda la dirección con nombres de campo que
no son los del estándar; sin corregirlo, la mitad de los tests fallaba en
cascada. Lo arreglamos solo en la tienda de prueba y lo reportamos en su
repositorio (conformance#116).

**Lo que falta.** 9 de las fallas son capacidades ya planificadas (webhooks,
varios productos, consentimiento: T147 a T149); 7 quedan fuera a propósito
(`R-12`), y 1 es el tope de 100 unidades por compra, que se deja así por decisión del
usuario: hacerlo pasar sería decir "sin stock" cuando el motivo es el tope.
**La revisión.** `/revisar` sin bloqueantes: confirmó que el pago de prueba no
tiene camino a una tienda desplegada y que nada se liquida dos veces. Se
corrigieron sus 12 hallazgos; lo más importante, que la memoria de claves de
idempotencia ahora tiene tope (las rutas no piden autenticación) y no congela
un error pasajero de `complete`. La suite dio lo mismo después.

## T133 · UCP `2026-08-25`, con `2026-04-08` al lado (2026-10-03, cerrada el 4-oct)

**Qué quedó funcionando.** Las tiendas de Vitrinee hablan las dos versiones de
UCP a la vez. Su perfil público es el de la versión nueva y apunta al de la
vieja; cada agente recibe las respuestas en la versión que declara en su propio
perfil. El agente de AgentPey y el MCP siguen declarando la vieja y reciben
exactamente lo mismo que antes; un perfil nuevo de AgentPey declara la nueva,
para comprar en ella.

**Lo delicado.** Para saber qué versión habla un agente, la tienda tiene que
leer un documento en una dirección que dicta ese agente. Eso abre la puerta a
que alguien apunte a la red interna del servidor. El lector solo acepta
`https`, revisa cada dirección a la que resuelve el nombre y se conecta a esa
misma, sin redirecciones ni documentos grandes (`R-14`). El mismo lector lo
usará T147 para los webhooks.

**Lo que decidió el usuario.** Si la versión de un agente no se puede saber, la
tienda responde en la más nueva, `2026-08-25`.

**La revisión.** `/revisar` encontró dos bloqueantes en el lector: no tenía un
plazo total (un perfil que manda un byte cada pocos segundos sostenía la
conexión horas) ni límite de lecturas (y su DNS ocupaba los mismos hilos que
usa el cobro). Se corrigieron con los otros 12 hallazgos.

**La compra (4-oct).** Ya en vivo, AgentPey compró un imán en `agentcommerce`
hablando `2026-08-25`: pedido real, pago en Stellar desde el rail UCP y recibo
válido. La misma orden se lee en la versión vieja si quien pregunta declara la
vieja, y las dos respuestas validan contra el esquema oficial de su versión.

## T134 · AP2 dentro del checkout UCP (2026-10-04, cerrada)

**Qué quedó funcionando.** Cuando un agente y una tienda acuerdan usar AP2, la
compra queda sellada: la tienda firma cada respuesta del checkout, y no cobra
hasta recibir un mandato que diga "la plataforma AgentPey respalda exactamente
este checkout, que la tienda firmó". El agente de AgentPey arma ese mandato: la
plataforma firma este producto, esta cantidad y esta tienda, y el agente lo
cierra sobre el checkout firmado, para esta tienda y este checkout. Si algo no
calza, la tienda responde con el código de error de UCP y no se mueve un peso.
Sin AP2 acordado, todo sigue igual.

Ojo con cómo se cuenta: hoy el mandato lo firma el mismo programa que paga, en
el momento de pagar. Prueba qué se iba a comprar y que AgentPey lo respaldó; no
es una autorización previa del usuario. La autorización del usuario sigue
siendo el Mandato de AgentPey, que el mandato AP2 cita (`R-16`).

**Lo que hubo que decidir.** UCP y AP2 no dicen cómo se juntan sus formatos. Se
eligió la forma que la librería oficial de AP2 entiende, y se comprobó: verifica
una cadena hecha aquí sin ninguna observación (`R-15`). La tienda usa una llave
derivada de la que ya tenía (`VT-43`); la plataforma, una llave nueva que solo
vive en `.env.local` (`R-16`).

**La revisión.** `/revisar` encontró un problema serio: el sello se decidía en
cada solicitud, así que si el último paso llegaba sin pedir AP2 (otro perfil, o
el perfil de la plataforma caído en ese momento), la tienda cobraba sin
mandato. Ahora el sello es del checkout desde que se crea y no se puede quitar.
También se corrigieron 16 hallazgos más: la plataforma solo puede firmar en su
propio nombre, la tienda compara además la dirección y el comprador (no solo el
total), dos pagos simultáneos de una misma intención ya no cierran dos mandatos,
y el agente se niega antes de autorizar o firmar nada. La tienda guarda el
mandato con que cobró.

**La compra real.** Con la tienda desplegada, dos compras reales de un imán en
`agentcommerce`. En la primera la tienda verificó el mandato y cobró, pero la
librería oficial de AP2 lo rechazó: las tres firmas estaban bien, y el problema
era un bug de la librería, que relee la llave del agente de una forma que la
rompe si trae el campo `use`. Se lo reportamos (AP2#372) y, de nuestro lado, la
llave va ahora sin ese campo. En la segunda compra la librería oficial verifica
el mandato con las llaves publicadas, como lo haría cualquier tercero. Recibo
válido en las dos.

## T147 · Eventos de despacho y webhooks de orden (2026-10-04 y 05, cerrada)

**Qué quedó funcionando.** Cuando un agente compra en una tienda Vitrinee, la
tienda ahora le avisa sola, sin que el agente tenga que preguntar: primero
"tu pedido está creado" y, cuando el comercio lo despacha, "tu pedido salió",
con el número de seguimiento si lo hay. Cada aviso es la orden completa,
firmado por la tienda; si el agente no contesta, la tienda lo reintenta con el
mismo identificador durante unas dos horas y media, y no lo olvida aunque se
reinicie. La orden también muestra el despacho cuando alguien la consulta. Del
otro lado, AgentPey tiene ahora una dirección donde recibe esos avisos
(`agentpey.com/ucp/webhooks/orders`) y solo acepta los que puede comprobar que
firmó una tienda de AgentPey, sobre una orden de esa tienda.

**Lo que hubo que decidir** (cuatro elecciones del usuario, `R-17`, `VT-44`).
La tienda firma con una llave nueva, derivada de la que ya tenía, porque es la
única clase de firma que toda plataforma UCP sabe verificar. Los avisos
pendientes se guardan en la orden misma. El despacho real se pregunta a Shopify
cada diez minutos (y al leer la orden): no hizo falta pedirle permisos nuevos a
la app. Y el receptor vive en agentpey.com para que el ciclo se cierre de
verdad, no solo en tests. Jumpseller queda sin avisos de despacho por ahora: no
hubo cómo comprobar sus campos.

**Cómo se probó.** La firma se comprobó contra los ejemplos del propio estándar
(RFC 9421). La suite oficial de UCP pasa de 40 a 47 tests: los siete de
webhooks, incluidos los de firma. Y una prueba de punta a punta sin red hace
que la tienda real firme y el receptor real de AgentPey verifique.

**La revisión.** `/revisar` no encontró nada que pudiera cobrar mal, pero sí
16 cosas para corregir, todas corregidas. Las más serias: alguien de afuera
podía hacer que se perdieran avisos llenando el cupo de conexiones de la
tienda (ahora los avisos tienen su propio cupo); una dirección mal escrita
podía trabar los avisos de una orden; y el número de seguimiento quedaba a la
vista de cualquiera que tuviera el recibo (ahora solo lo recibe la plataforma
que compró). El receptor de agentpey.com también quedó más estricto: solo
acepta avisos firmados hace menos de cinco minutos, con la llave de webhooks
de la tienda.

**El despacho real.** Con la tienda desplegada, una compra de un imán en
`agentcommerce`: el aviso "tu pedido está creado" llegó a agentpey.com un
segundo después del pago. El usuario marcó el pedido como despachado en el
admin de Shopify; al consultar la orden, la tienda le preguntó a Shopify,
registró el despacho y mandó el aviso "tu pedido salió", que agentpey.com
verificó y aceptó. Nadie tuvo que preguntar nada.

## T143 · Más wallets que Freighter (2026-10-06, cerrada)

**Qué quedó funcionando.** Las cinco pantallas donde una persona firma con su
wallet (aprobar el Mandato, revocarlo, responder una disputa, entrar al portal
de comercios y conectar Claude o ChatGPT al MCP) ya no exigen Freighter: abren
un selector con las wallets que pueden firmar lo que esa pantalla pide:
Freighter y xBull en todas, y LOBSTR donde solo se firma un mensaje. Dos wallets que el kit soporta, Albedo y Rabet, no se ofrecen,
porque no firman mensajes y toda pantalla empieza con esa firma. La librería
que habla con las wallets ya no viene de un servidor ajeno: se arma con el
resto de AgentPey y la sirve cada sitio. Lo que el servidor revisa de cada
firma no cambió.

**La prueba con wallets reales.** En una página de prueba que solo existe en
local, el usuario firmó con xBull, LOBSTR y Freighter. xBull y Freighter
firmaron todo y el servidor lo verificó. LOBSTR firma bien los mensajes, pero
firma las transacciones para mainnet: por eso cada pantalla dice qué firma, y
LOBSTR no se ofrece para aprobar ni revocar un Mandato. Hana firma los
mensajes en otro formato que el estándar, así que no se ofrece en ninguna.
Con eso, para aprobar y revocar solo queda xBull además de Freighter, y el
usuario ajustó el criterio del spec en ese sentido. El inicio de sesión del
MCP se probó en local con Freighter y funcionó. Los logos del selector se
sirven ahora desde nuestros sitios.

**La revisión.** No encontró ningún camino que firme con una cuenta distinta de
la verificada. Pidió probar las pantallas de verdad antes de dar la tarea por
hecha, y quince arreglos: la transacción de prueba ya no es válida en ninguna
red, la página de prueba no existe en agentpey.com, la del MCP es más
estricta, y más tests. Todos corregidos a pedido del usuario.

**En agentpey.com.** Justo después del merge, el usuario aprobó y revocó un
Mandato con Freighter y con xBull, y entró al portal de comercios. Todo
funcionó, y no hubo que deshacer nada.

## T137 · El kit de conformidad del medio de pago (2026-10-06, cerrada)

**Qué quedó.** Una tienda que diga "acepto pagos de agentes en Stellar" ahora
se puede comprobar con un comando: `pnpm run ucp:stellar:conformance --` y su
dirección. El kit responde, una línea por comprobación, si la tienda publica
bien su perfil, si el dinero va a la cuenta que dice, si rechaza un pago
trucado, si cobra una sola vez y si su recibo se puede verificar en la red. Por
defecto solo lee; el cobro real corre únicamente si quien lo usa pone su propia
llave de testnet. Contra nuestra tienda de Shopify pasaron las 20
comprobaciones, con una compra real de un imán pagada desde el rail. Contra una
tienda rota a propósito, el kit marcó sus seis fallas, cada una con su motivo.

**Cómo se probó.** Además de las dos corridas reales, 17 tests sin red: la
tienda de Vitrinee de verdad, en el proceso, pasa todo; y la tienda rota falla
exactamente en lo que rompe cada vez. Para el cobro, el usuario autorizó
recargar el rail con 3 USDC desde la reserva (`R-22`).

**La revisión.** `/revisar` encontró que el kit, contra una tienda tramposa,
podía cobrar dos veces: firmaba un pago de prueba que la tienda se quedaba, y
después otro. Ahora firma una sola autorización por corrida, válida dos minutos
como mucho, y la usa para todo, así que como mucho se cobra una vez. Además no
firma nada para una tienda que ya falló otra comprobación, solo paga en USDC
salvo que se le pida otro activo, y vigila el saldo del pagador para atrapar a
una tienda que cobra y dice que no. A pedido del usuario se corrigieron los
quince hallazgos y se repitió la compra real, que volvió a pasar las 20.

**Tropiezos.** La primera corrida ignoró la opción "solo perfil", porque pnpm
agrega un `--` que confundía la lectura de opciones; corrió de más la parte de
requisitos, que no mueve plata. Y el motivo de una cuenta sin línea de
confianza salía con todo el registro de diagnóstico de la red; ahora es una
frase.

## T136 · El SDK `@agentpey/ucp-stellar` (2026-10-05 y 06, cerrada)

**Qué quedó.** Cualquier programador puede ahora hacer que su propio agente
compre en una tienda UCP que acepta Stellar, con un paquete:
`@agentpey/ucp-stellar`. El paquete lee el perfil de la tienda, comprueba que
el medio de pago sea legítimo, cotiza y paga, desde una cuenta común o desde un
`policy_rail` cuyos topes aplica la red. Nunca guarda una llave: quien lo usa le
pasa una función que firma. Se probó como lo probaría un desconocido: el
paquete empaquetado, instalado en una carpeta vacía fuera del repo, y el ejemplo
del README (15 líneas) compró un imán real en `agentcommerce`, con su pedido en
Shopify y un recibo con los tres checks en verde. Falta publicarlo en npm, que
se hace solo con permiso del usuario.

**El agente usa el paquete.** El usuario eligió que no hubiera dos copias del
código que comprueba y firma un pago (opción A): el agente de AgentPey, el MCP y
`ucp:buy` pagan ahora a través del paquete, y conservan lo propio (la
intención firmada, el Mandato, AP2 y el rail), que corre en un paso justo antes
de firmar. Los tests de contrato del agente pasaron sin cambiarlos. Dos de
ellos fallaron en la primera corrida porque el paquete nombraba dos errores
distinto; se corrigió el paquete, no el test.

**Qué no entra.** El Mandato y la autorización de AgentPey se quedan en el
repo. AP2 tampoco entra, porque el mandato lo firma la llave de la plataforma y
un tercero no la tiene; una tienda solo lo exige si el perfil de la plataforma
lo declara, y el del paquete no. Solo testnet. Todo en `R-21`.

**La revisión.** `/revisar` encontró un problema serio en el paquete, que no
afecta al agente: el tope de gasto en decimales ("2.00") se convertía con los
decimales que declara la propia tienda, así que una tienda maliciosa podía
hacer que "2.00" valiera millones. Ahora se lee siempre con los 7 decimales de
Stellar, una tienda que declara otro número se rechaza, y quien paga puede
nombrar el activo que acepta. A pedido del usuario se corrigieron los once
hallazgos, entre ellos que el agente lleve su propia cuenta de si el pago ya
salió (para no devolver presupuesto de un pago que pudo cobrarse) y tests de
ese caso.

**La publicación.** El 6 de octubre el usuario creó la organización `agentpey`
en npm, inició sesión y publicó la versión 0.1.0 desde su terminal. El primer
intento lo rechazó npm porque la cuenta no tenía la verificación en dos pasos;
la activó y el segundo pasó. Unos minutos después el paquete apareció en npm,
se instaló desde ahí en una carpeta vacía y el ejemplo cotizó contra la tienda
real. Cualquier persona puede instalarlo hoy con `npm install
@agentpey/ucp-stellar`.

**Tropiezos.** El primer tarball salió sin el código compilado (un archivo de
compilación viejo engañó a `tsc`); ahora el empaquetado limpia y compila
siempre. Y el ejemplo mostraba "14.9 CLP" porque dividía por 100 un total en
pesos, que no tienen decimales; ahora muestra el monto en USDC.

## T135 · MPP charge sobre Stellar, prueba técnica (2026-10-05, cerrada)

**Qué quedó.** MPP es otra forma de cobrar por internet que Stellar ofrece con
un SDK oficial. La pregunta era si nuestro agente puede pagar con MPP desde su
`policy_rail`, la cuenta con topes que aplica la red. La respuesta es no: se
intentó en testnet de cuatro maneras y el servidor oficial de MPP rechazó las
cuatro antes de mover nada, porque solo acepta pagos desde una cuenta común. El
mismo servidor sí cobró 0,01 USDC desde una cuenta común, como control. Por la
decisión que ya existía (`R-4`) no se construye el pago por MPP: en el video se
dirá "evaluamos MPP", no "soportamos MPP". Quedaron escritos la brecha para el
SEP, el texto de un issue que propone el cambio al SDK (se publica con OK del
usuario) y la respuesta a la pregunta del SEP: MPP sería un medio de pago
aparte, no una variante del de x402 (`R-20`). Con OK del usuario, el issue se
publicó: [stellar/stellar-mpp-sdk#90](https://github.com/stellar/stellar-mpp-sdk/issues/90).

**Cómo se probó.** Un paquete aislado (`scripts/mpp-probe/`) con el SDK oficial,
fuera del workspace de AgentPey porque pide otra versión del SDK de Stellar. La
firma del rail es la misma que usa AgentPey para pagar con x402. Dos tropiezos,
contados en la evidencia: la primera corrida armaba mal la cabecera y el
servidor rechazó los intentos sin leerlos (el veredicto del script ahora exige
que el rechazo sea por el pagador), y un error de lectura que pareció un
hallazgo se descartó con un diagnóstico aparte. El modo push no se probó, por
decisión del usuario: movería plata para un cobro que se rechaza igual.

**La revisión.** `/revisar` no encontró bloqueantes, pero sí que el veredicto
del script podía decir "rechazado" ante un rechazo por otra causa (una falla de
la red, por ejemplo). Se corrigió, a pedido del usuario y sin mover plata: cada
intento exige el motivo exacto del SDK, se compara el saldo del rail antes y
después, y un paso nuevo simula la transferencia firmada por el rail en modo
estricto, que la red acepta. Eso deja probado que la firma es buena y que el
único obstáculo es que MPP no acepta un contrato como pagador. También se
aclaró que el servidor patrocinado no tuvo control, y se precisó el issue.

## T149 · El consentimiento del comprador llega a la tienda (2026-10-05, cerrada)

**Qué quedó funcionando.** Cuando un agente le dice a la tienda qué aceptó el
comprador (recibir marketing, analítica, guardar preferencias, vender o
compartir sus datos), la tienda lo guarda, se lo muestra al agente y lo pasa al
pedido real. En Shopify, el "sí" o "no" a recibir correos de la tienda va al
campo propio de Shopify para eso; lo demás, que Shopify no tiene dónde guardar,
queda escrito en el pedido, a la vista del comercio. Jumpseller no tiene dónde
recibirlo, así que una tienda Jumpseller no ofrece esta función. Un "sí" al
marketing sin el email del comprador no se cobra: la tienda pide el email
primero. Y nada de esto aparece en la orden pública que cualquiera puede leer
con el recibo.

**Lo que hubo que decidir** (`VT-47`). Al leer la spec de UCP `2026-08-25` se
vio que el modelo es distinto al de `2026-04-08`: la tienda **debe** anunciar
qué consentimientos admite, con su valor por defecto, y el agente confirma. El
plan aprobado decía no anunciar valores por defecto; se paró a mostrar la
evidencia y el usuario eligió anunciarlos solo en los checkouts nuevos, para no
romper los mandatos AP2 abiertos durante el deploy (el consentimiento queda
dentro de lo que la tienda firma). También eligió que la tienda acepte el
consentimiento al pagar y exija el email para un "sí" al marketing, y que los
consentimientos sin campo en Shopify vayan como atributos del pedido.

**Cómo se probó.** Tests sin red en los adaptadores (qué manda Shopify, que el
mock lo guarda, que Jumpseller no lo ofrece), en el perfil (lo anuncia en las
dos versiones solo donde llega) y en el checkout: las dos formas de la
extensión validadas contra los esquemas oficiales de cada versión (con control
negativo), una sesión leída en las dos versiones, propósitos ajenos ignorados,
el "sí" sin email que no se cobra, el consentimiento que llega al pedido de la
plataforma (también el confirmado al pagar, nunca un valor por defecto), que no
aparece en la orden pública ni en el webhook, y con AP2: un cambio después del
mandato se rechaza sin cobrar y una sesión de antes de T149 completa igual. La
suite oficial de UCP pasa de 48 a 49: `test_buyer_consent` pasa, y es la única
diferencia.

**La revisión.** `/revisar` no encontró bloqueantes: ningún camino cobra sin
mandato ni dos veces. Sí encontró que la tienda aceptaba el consentimiento en
la primera llamada, antes de haber mostrado qué significa cada opción, cuando
UCP `2026-08-25` le pide ignorarlo hasta haberlo anunciado. El usuario eligió
cumplir la spec: ahora ese consentimiento se ignora con un aviso, y el agente de
AgentPey lo confirma en una segunda llamada, antes de firmar el mandato.
También se corrigió que un pago mal formado dejara el consentimiento cambiado
(y con AP2, el mandato inservible), que Shopify recibiera un "no" que el
comprador no dijo, y que el nombre de la tienda estuviera dentro de lo firmado
(renombrarla rechazaba los checkouts AP2 abiertos). Se agregaron los tests que
faltaban, un test del agente real contra la tienda real, la extensión en los
perfiles de plataforma de AgentPey y el comando en el README.

**La compra real.** Con el deploy en vivo, el agente compró un imán en
`agentcommerce` con AP2 y diciendo que el comprador acepta recibir correos de la
tienda. El pedido quedó en Shopify marcado como "acepta marketing", con los
permisos que la app ya tenía; la orden pública no lo muestra; y la librería
oficial de AP2 verificó el mandato, que cubre ese consentimiento. Se pagó con
1,57 USDC del rail UCP, recargado antes con 3 USDC de la reserva.

## T148 · Varios productos por compra (2026-10-05, cerrada)

**Qué quedó funcionando.** Hasta ahora un agente podía comprar un solo producto
por vez. Con T148 arma un carrito: por ejemplo, un gorro y dos packs de
stickers. La tienda calcula el precio de cada línea, cobra una sola vez por la
suma, crea en Shopify un pedido con todas las líneas y firma un recibo con un
ítem por línea. Un recibo cuyos ítems no suman lo cobrado ahora sale en rojo al
verificarlo. Del lado de AgentPey, la intención firmada del agente dice qué
productos lleva el carrito, y las reglas del principal valen para cada uno: si
un producto no está permitido, no se compra nada, y el tope por compra se
aplica al carrito entero. Con un solo producto todo funciona igual que antes.

**Lo que hubo que decidir.** El usuario eligió que la intención lleve las
líneas (`R-18`, opción A). Para tocar lo menos posible del perímetro de
autorización, la revisión del scope de la credencial no cambia (ve el carrito
como una sola unidad al precio total), y la herramienta que usa el modelo
tampoco: el carrito se firma por un camino aparte, con las mismas
comprobaciones. En la tienda (`VT-45`, `VT-46`): cada línea con su propio
redondeo y el total como su suma, para que todo cuadre al centavo; el mismo
producto puede ir en dos líneas; y un despacho parcial del que la plataforma
no dice qué llevaba no se anota como evento, para no afirmar algo que no se
sabe.

**Cómo se probó.** Tests sin red en la tienda, los adaptadores, el agente, AP2
y el contrato entre los dos (el código real del agente contra la app real de la
tienda), más un control negativo: con la regla de suma apagada, seis tests
fallan. Se volvieron a leer los nueve recibos reales emitidos hasta hoy y todos
cumplen la regla nueva. La suite oficial de UCP pasa de 47 a 48.

**La revisión.** `/revisar` encontró una falla seria, corregida: el agente
comparaba la intención con las líneas que él había pedido, no con las que la
tienda tenía. Si alguien cambiaba el carrito por otro del mismo precio entre la
cotización y el pago, sin AP2 el agente pagaba igual, aunque el producto nuevo
no estuviera permitido. Ahora compara con lo que responde la tienda, al cotizar
y otra vez al releer antes de pagar. También se corrigieron un firmador de
carritos que no validaba su entrada (una cantidad cero dejaba presupuesto
diario ocupado), los topes del rail leídos sin validar, y seis detalles más.

**El rail nuevo** (`R-19`). Ningún par de productos de `agentcommerce` cabía
bajo 3,00 USDC por compra. Como el contrato fija sus topes al nacer, con OK del
usuario se desplegó otro rail UCP de 5,00 por compra y 10,00 por día, con 5
USDC de la reserva. El del MCP no cambió.

**La compra real.** Con la tienda desplegada, un imán y una taza en
`agentcommerce`, pagados desde el rail nuevo con AP2: un solo cobro de 3,66
USDC, un pedido en Shopify con las dos líneas, y un recibo con dos ítems que
suman lo cobrado y los tres checks en verde. La librería oficial de AP2
verificó el mandato, que nombraba las dos líneas. El primer intento cayó en la
instancia vieja mientras terminaba el deploy y se rechazó antes de cobrar nada.

---

## T145 · Equipos SCF pagando IA y servicios con Stellar (prueba técnica) — 2026-10-07

**Qué quedó.** Un documento que responde si un equipo financiado por SCF puede
dar a sus agentes un presupuesto en Stellar para pagar herramientas y servicios
([evidencia](evidencia/T145-tesoreria-equipos.md)). La respuesta corta: **para
servicios que cobran por uso, sí, hoy en testnet y con lo que ya existe**; para
suscripciones (ChatGPT, GitHub y similares), **todavía no**. Cards402 prohíbe
los cobros recurrentes en su contrato, y ASGCard no publica términos, KYC ni el
banco que emite. Además, el rail actual no puede cargar una tarjeta, y aunque
pudiera, lo que la tarjeta compra quedaría fuera del Mandato y del recibo.

**Lo que se aprendió.** SCF paga en XLM y el rail maneja un solo asset, así que
el equipo convierte antes. El rail aplica montos pero no a quién se paga, no
tiene tope mensual y tiene un solo agente; ninguna de esas brechas se construye
ahora. Para un abogado quedan cinco preguntas, entre ellas si tener la llave
del agente en la versión hospedada cuenta como custodia.

**Recomendación.** Construir T146 después del video, reutilizando un rail ya
desplegado (`policyRailUcp`) para pagar créditos de SignalDesk en testnet y
armando el resumen del mes, sin desplegar nada nuevo. **El usuario la aprobó**, y las
suscripciones quedan solo como diseño (`R-25`).

---

## T141 · Página pública "Tiendas comprables por agentes" — 2026-10-07

**Qué quedó funcionando.** En `agentpey.com/tiendas` (y `/stores`) hay una página que muestra las tiendas donde un
agente ya puede comprar: AgentCommerce, Bazar Cordillera y MycoKit. De cada una dice cuántos recibos tiene anclados
en Stellar y cuál fue el último (orden, monto, fecha), con un enlace para verificarlo y otro a la transacción en la
red. Abajo explica las tres formas de hacer que un agente compre: el conector de Claude y ChatGPT, el paquete de npm
y el kit para revisar una tienda. En inglés por defecto y en español, y se ve bien en un celular.

**Por qué se puede confiar en lo que muestra.** Nada sale de la base de datos de AgentPey: la lista es el directorio
público, la cantidad de recibos la cuenta el contrato del registro, y el último recibo se busca en el historial de la
red y se confirma en el registro antes de mostrarlo (`R-26`).

**Lo que apareció al probar contra la red real.** Una operación de despliegue de Bazar Cordillera trae un campo vacío
que el código no esperaba, y la tienda salía como "no disponible"; corregido y con test. En celular, un comando largo
estiraba las tarjetas; corregido.

Evidencia: [`evidencia/T141.md`](evidencia/T141.md).

---

## T146 · Demo: presupuesto de equipo en testnet — 2026-10-07

**Qué quedó funcionando.** Un equipo le da a su agente un presupuesto y el agente lo gasta en un servicio que cobra
por uso: créditos de IA de SignalDesk, a 0,10 USDC, pagados desde un `policy_rail` que ya estaba desplegado. El
equipo permite 0,10 por compra y 0,30 por día. Con cuatro compras en un día, tres se pagan, cada una con su recibo y
su transacción anclada, y la cuarta se rechaza antes de firmar nada. Un segundo comando muestra los gastos del mes:
cada pago con su transacción, el rechazo con su motivo, el total frente al presupuesto y los topes del rail leídos de
la red. Se adelantó al video a pedido del usuario (`R-27`).

**Lo que apareció.** SignalDesk, el comercio propio del piloto, rechazaba todo pago desde un `policy_rail`: su
facilitador aceptaba como máximo 50 000 stroops de comisión y un pago desde el rail cuesta unos 72 000, porque el
contrato revisa sus topes dentro de la transferencia. No se movió dinero. Se subió el máximo a 200 000 y se probó con
SignalDesk en local; producción queda arreglada con el merge.

Evidencia: [`evidencia/T146.md`](evidencia/T146.md).

---

## T150 · Pulido del MCP para el video — 2026-10-07

**Qué quedó funcionando.** Desde Claude o ChatGPT ahora se puede cotizar más de un producto de la misma tienda en una
sola compra: una cotización, una firma del agente y un solo pago. Y al leer una orden, el MCP entrega el enlace a la
transacción del pago, para que el chat no lo arme a mano. La firma del reclamo no cambió (`R-28`).

Evidencia: [`evidencia/T150.md`](evidencia/T150.md).

**Cierre de T150 (8-oct).** Desde Claude, en producción: cotizó un carrito de imán y posavasos y, al pedírselo, lo
pagó él mismo, en una sola transacción, con el recibo verificado. Para que entrara en el tope del MCP, el usuario
rebajó el posavasos a 990 CLP.

---

## Pendiente de la Fase 7: el reembolso real de T124 y la orden de T127 — 2026-10-08

**Qué pasó.** Una compra que la tienda nunca preparó (el imán del 1-oct, pedido #1006) recuperó su plata. El agente
firmó un reclamo y el árbitro abrió la disputa en Stellar, que congeló el monto en la garantía de la tienda. La
tienda, desde la página `agentpey.com/resolve/responder` y con la firma de su cuenta de cobro, aceptó devolver el
total. Claude, como árbitro, leyó las dos versiones y propuso un reembolso total. El usuario confirmó el hash del
veredicto, y recién entonces el contrato devolvió 1,5684211 USDC al rail que había pagado. La orden de la tienda
muestra la disputa como pendiente primero y como reembolsada después, en el formato estándar de UCP.

Evidencia: [`evidencia/T124-reembolso-real.md`](evidencia/T124-reembolso-real.md).

---

## T151 · Página "En vivo" — 2026-10-08

**Qué quedó funcionando.** `agentpey.com/en-vivo` muestra lo que los agentes compran en las tres tiendas: cada
compra con sus productos, monto y hora, con enlaces al recibo, al pago y al ancla en la red; y cada reclamo con su
estado, como el reembolso real de hoy ("Reembolsados 1,57 USDC") con el enlace al veredicto. Arriba, los totales: 31
compras, 55,84 USDC pagados por agentes, 2 disputas resueltas. Se refresca sola cada 10 segundos y resalta lo nuevo.
En inglés y español, y en celular.

**Por qué se puede confiar.** Nada sale de la base de datos de AgentPey: las compras y las disputas se leen de los
contratos en Stellar, y los productos y el pago, del recibo firmado por la tienda cuyo hash es el que está anclado
(`R-30`). La página solo muestra disputas; no abre ni resuelve ninguna.

**Cierre de T151 (8-oct).** Con la página abierta y sin recargar, Claude compró un imán en producción
(`ord_mv079z6634dbf7e9d1`, 1,5684211 USDC) y la compra apareció sola arriba de la lista. Antes hubo que arreglar el
arranque del MCP, que llegaba tarde al gateway tras cada deploy (`R-32`).

Evidencia: [`evidencia/T151.md`](evidencia/T151.md).

---

## T152 · Portada de agentpey.com al día — 2026-10-08

**Qué quedó.** La portada cuenta lo que AgentPey hace hoy: agentes de IA comprando en tiendas reales, con topes que
aplica la red. Sus números ya no se escriben a mano: tiendas, compras, USDC pagados y reclamos resueltos se leen en
vivo de la red, igual que en `/en-vivo`. Una sección nueva muestra cada pieza de la Fase 8 con su enlace (el
conector para Claude y ChatGPT, las tiendas UCP, AP2, las disputas con reembolso real, el presupuesto de equipo y
el SDK en npm), y la sección de estado dice que van siete fases listas y la octava en curso.

Evidencia: [`evidencia/T152.md`](evidencia/T152.md).

**Cierre de T152 (8-oct).** Mergeada y en vivo en agentpey.com. La revisión encontró tres frases que decían más de
lo que el proyecto respalda (el conector abierto a cualquiera, el presupuesto "en la red", el tope de "cada pago"), y
se corrigieron antes del merge.

---

## T153 · Página del presupuesto de equipo — 2026-10-08

**Qué quedó funcionando.** `pnpm run team:summary -- --html` abre una página con el mes del equipo: el tope de 0,30
USDC al día, cuánto se gastó cada día frente a ese tope, cada pago con su transacción en Stellar, los rechazos en
rojo y los topes del rail leídos de la red. Es local porque el registro del equipo es local, y muestra lo mismo que
la terminal, pero se ve en cámara.

**Revisión (8-oct).** Sin bloqueantes. La página contaba como "pagada en Stellar" toda compra que el presupuesto
contó, también las que nunca tuvieron transacción (un pago que falló no se libera, `M-15`); ahora esas salen aparte y
solo se enlaza lo que tiene transacción. También: los liberados y el motivo de un rail caído aparecen como en la
terminal, un día sobre el tope se ve en rojo, sin fuentes de Google, la cadena rota borra las páginas viejas, el
navegador se abre también fuera de macOS, y la evidencia lleva la salida cruda. Con los datos reales nada cambia a la
vista.

Evidencia: [`evidencia/T153.md`](evidencia/T153.md).

