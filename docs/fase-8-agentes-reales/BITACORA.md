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

**Fecha:** 2026-10-05 · Fase abierta (`P-16`). **Spec aprobado** por el usuario
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
la tienda avisa al agente. **T148 en revisión**: un carrito de varios productos,
en código y tests; falta `/revisar` y la compra real.

| Tarea | Estado |
|---|---|
| T128 Servidor MCP | cerrada |
| T129 Claude y ChatGPT conectados | cerrada |
| T130 Tienda de terceros | pendiente |
| T131 Suite de conformidad UCP | cerrada |
| T132 Coherencia del recibo | cerrada |
| T133 UCP `2026-08-25` | cerrada |
| T134 AP2 en el checkout | cerrada |
| T135 MPP charge (prueba técnica) | pendiente |
| T136 SDK en npm | pendiente |
| T137 Kit de conformidad de Stellar | pendiente |
| T138 Prueba técnica: GenLayer | pendiente |
| T139 Prueba técnica: Trustless Work | pendiente |
| T140 Resolutor intercambiable | pendiente (pide aprobación) |
| T141 Página de tiendas | pendiente |
| T142 Guion y grabación | pendiente |
| T143 Más wallets | pendiente |
| T144 dots, Muse y Grok Bot | pendiente |
| T145 Tesorería de equipos (prueba técnica) | pendiente |
| T146 Demo de presupuesto de equipo | pendiente (pide aprobación) |
| T147 Webhooks de orden | cerrada |
| T148 Varios productos | en revisión (falta la compra real) |
| T149 Consentimiento | pendiente |

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

## T148 · Varios productos por compra (2026-10-05, en revisión)

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

**Lo que falta.** Push, PR, merge y deploy, y después la compra real con dos
productos.

