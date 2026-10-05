# Decisiones — Fase 8 (Agentes reales comprando en Stellar)

> Prefijo `R-`. Cada decisión con su motivo y la alternativa descartada. Las
> que cruzan fases van a [`docs/DECISIONES.md`](../DECISIONES.md) con prefijo
> `P-` (la que abre esta fase es `P-16`); las que tocan Vitrinee por dentro,
> a su `DECISIONES.md` con prefijo `VT-`.

---

### R-1 · El servidor MCP guarda la llave dueña de un `policy_rail` propio, y la red aplica los topes · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T128 · Decidido por el usuario (traspaso del 3-oct, opción (a))

Los pagos que salen del servidor MCP los firma el propio servidor, con la
llave dueña de un `policy_rail` creado para el MCP, con topes bajos, que el
usuario fondea. La llave vive en el entorno del servidor (Render y
`.env.local`), nunca en el repo ni en los logs. El rail no se comparte con el
de las compras UCP de la Fase 7 (`E-5`).

**Motivo.** Un chat de Claude o de ChatGPT no puede firmar con una wallet. Que
el servidor firme es lo que permite que la compra termine dentro del chat, y
los topes del contrato acotan lo que puede perderse si la llave o el conector
se ven comprometidos: el límite lo aplica la red, no el servidor ni el prompt.

**Alternativa descartada: que la persona firme cada pago con su wallet en una
página aparte.** Es más fuerte, pero saca la compra del chat, que es justo lo
que el video tiene que mostrar. Queda como camino posible para montos sobre el
tope.

---

### R-2 · El conector MCP se autentica con OAuth 2.1 desde el inicio · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T128 · Decidido por el usuario

El servidor MCP no se publica sin autenticación. Desde su primer deploy exige
un token OAuth 2.1 (PKCE, metadatos de recurso protegido, validación de
audiencia), que es lo que aceptan Claude y ChatGPT para un conector propio.

**Motivo.** El servidor guarda una llave que paga (`R-1`). Con una URL secreta,
quien la consiga puede gastar el rail hasta su tope, y la spec de MCP pide no
llevar secretos en la URL.

**Alternativa descartada: una URL secreta para el video y OAuth después del
Bloque A.** La recomendó Claude Code porque adelantaba un día la primera compra
desde Claude y el tope del rail ya acota el daño. El usuario prefirió el día de
más. Consecuencia aceptada: T128 pasa de 14 h a 22 h y la primera compra desde
Claude se mueve del 4 al 5 de octubre.

**Lo que queda abierto.** Qué servidor de autorización se usa: un proveedor de
identidad externo o uno mínimo propio. Se propone en el plan de T128. Cerrado
por `R-7`.

---

### R-3 · El modo de conformidad de UCP vive solo en la tienda de prueba local · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T131 · Decidido por el usuario

La suite oficial de UCP paga siempre con un medio de pago de prueba y pide un
endpoint de simulación con un secreto. Eso se implementa como un modo de la
tienda de prueba, que nunca se despliega: el arranque de producción lo rechaza.
"Cumplimos UCP" se dice con su alcance: qué tests pasan, contra qué, y cuáles
se saltan.

**Motivo.** Un medio de pago que no cobra, en un servicio desplegado, es un
punto de autorización abierto; es la misma clase de riesgo que `B-25`.

**Alternativas descartadas.** Una tienda de conformidad desplegada, por ese
riesgo. Y correr la suite contra una tienda real sin el modo: todos los tests
que completan una compra fallarían, y el resultado no diría nada.

---

### R-4 · Si MPP no admite un `policy_rail` como pagador, se documenta y no se paga con una llave clásica · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T135 · Decidido por el usuario

`@stellar/mpp` 0.7.1 solo acepta una llave clásica como pagador. Si la prueba
técnica de T135 lo confirma en testnet, AgentPey no construye el pago por MPP:
la evidencia va al anexo del SEP y se redacta un issue para
`stellar/stellar-mpp-sdk`, que se publica cuando el usuario haya visto el
texto. En el video se dice "evaluamos MPP", no "soportamos MPP".

**Motivo.** Un pago desde una llave clásica no tiene topes aplicados por la
red, que es lo que AgentPey afirma. Afirmar "soportamos MPP" con ese pago
sería cierto en la letra y falso en lo que importa.

**Alternativas descartadas.** Pagar MPP con una llave clásica, marcado como
tal. Y cortar T135 entera: la prueba técnica cuesta poco y es evidencia útil
para el SEP.

---

### R-5 · Los mandatos AP2 del checkout se cierran con P-256 · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T134 · Decidido por el usuario

La extensión de mandatos AP2 de UCP solo admite ES256, ES384 y ES512. El
agente y la tienda usan una llave P-256 para esa firma, además de su llave
Ed25519 de Stellar. Continúa `E-9`. Ed25519 queda como brecha del SEP, con el
issue AP2 #268 (abierto, sin PR) como referencia.

**Motivo.** El criterio de T134 es que un tercero, con la librería oficial,
verifique el mandato de una compra real.

**Alternativa descartada: Ed25519**, una sola llave, pero fuera de lo que UCP
permite hoy.

---

### R-6 · Vitrinee sirve UCP `2026-08-25` y mantiene `2026-04-08` en paralelo · `Vigente` — ajusta `E-2`
**Fecha:** 2026-10-03 · **Tarea:** T133 · Decidido por el usuario

Al migrar, cada tienda sirve `2026-08-25` por defecto y declara `2026-04-08`
en `supported_versions`, con su perfil propio, como recomienda la spec de UCP.
Una versión que la tienda no conoce recibe 422 `version_unsupported`. `E-2`
fijaba `2026-04-08` como única versión; deja de ser la única, no deja de
servirse.

**Motivo.** La suite oficial de conformidad solo conoce `2026-04-08`: sin esa
versión, migrar la deja sin nada que probar. Y los clientes de la Fase 7
siguen funcionando sin cambios.

**Alternativa descartada: migrar y retirar `2026-04-08`.** Menos código que
mantener, pero se pierde la evidencia de conformidad y se rompen los clientes
actuales.

---

### R-7 · El servidor de autorización de OAuth es propio, mínimo, y se inicia sesión firmando con la wallet · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T128 · Decidido por el usuario (pregunta 6 del spec)

Cierra lo que `R-2` dejó abierto. El servidor de autorización vive dentro de
`apps/mcp`: registra clientes por CIMD y por DCR, exige PKCE S256 y emite tokens
firmados con audiencia `https://mcp.agentpey.com/mcp`, sin base de datos. La
pantalla de inicio de sesión pide firmar un mensaje con la wallet (SEP-53, como
el portal de comercios, `WalletSessions`), y solo entra la wallet configurada:
la principal del rail del MCP, la única que puede retirar sus fondos.

**Motivo.** Autoriza al agente quien controla la plata, con la misma prueba que
el resto de AgentPey, y sin una cuenta en un tercero. El alcance es chico: un
solo usuario, tokens de vida corta, testnet.

**Precisado tras `/revisar` del PR 2 (2026-10-03):** el acceso dura una hora y
la renovación una semana, y cada token de renovación sirve una vez (OAuth 2.1
§4.3.1). El desafío que se firma es un token firmado, no un registro en
memoria, y se gasta solo con una firma válida: nadie puede bloquear el inicio
de sesión pidiendo desafíos. Un retorno de loopback se compara sin el puerto
(RFC 8252 §7.3), porque Claude Code cambia de puerto en cada sesión; la única
URL de retorno de las apps alojadas de Claude es
`https://claude.ai/api/mcp/auth_callback` (su documentación, leída el 3-oct). Y
el servidor no arranca si, en la red, el rail no es de la llave del agente o
su principal no es la wallet que inicia sesión.

**Alternativa descartada: un proveedor externo (WorkOS o Auth0).** Menos código
(cerca de 4 h contra 10 h), pero inicio de sesión por email, una cuenta que el
usuario tiene que crear, y depender de que el proveedor maneje bien la audiencia
del token para MCP.

---

### R-8 · El Mandato del agente del MCP lo firma la llave del emisor, como en T122 · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T128 · Decidido por el usuario

`pnpm run mcp:setup` emite la credencial del agente del MCP y su Mandato, y los
ancla en testnet, con `ISSUER_SECRET_KEY` de `.env.local`, igual que
`ucp:buy` en T122. El Mandato lista las tiendas del directorio de Vitrinee al
momento de correrlo: una tienda nueva (T130) pide correrlo otra vez. La wallet
del usuario es la principal del rail y la que inicia sesión (`R-7`).

**Motivo.** Sale el 4-oct y reusa un camino ya probado en una compra real.

**Alternativa descartada por ahora: que el usuario firme el Mandato con
Freighter**, en una página como la de consentimiento. Más fiel a "el usuario
autoriza", medio día más.

---

### R-9 · El rail del MCP tiene 3.00 USDC por compra y 5.00 por día, con un perfil propio en `deploy:policy-rail` · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T128 · Decidido por el usuario

Los mismos topes que el rail UCP de T122 y que el de un tenant (`C-133`): cabe
el imán (1,57 USDC) y casi todo `agentcommerce`. `deploy:policy-rail` gana un
perfil `mcp` cuyo dueño es la llave del agente del MCP, registrado aparte; los
perfiles `shared` y `ucp` no cambian. El spec decía que el script "se usa, no se
cambia": no alcanzaba, porque hoy el dueño del rail siempre es
`AGENT_SECRET_KEY`.

**Alternativa descartada: 2.00 por compra y 4.00 por día.** Deja fuera la taza
(cerca de 2,09 USDC).

---

### R-10 · `quote` no se declara de solo lectura · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T128 · Propuesta de Claude Code, **aprobada por el usuario** tras `/revisar` del PR 1

El spec decía que solo `pay` y `open_claim` piden confirmación. `quote` no mueve
plata, pero abre una sesión de checkout en la tienda y el agente firma una
intención de compra: declararla de solo lectura sería falso, y los clientes la ejecutarían
sin preguntar. Lleva `readOnlyHint: false` y `destructiveHint: false`; `pay` es
la única destructiva. En la práctica Claude puede pedir permiso también antes de
cotizar.

**Alternativa descartada: `readOnlyHint: true` para que cotizar no interrumpa.**


### R-11 · Desde Claude, el agente busca, cotiza y verifica; la persona aprieta `pay` · `Vigente` — precisa los criterios de T128, T129, T130 y el 1 de la fase
**Fecha:** 2026-10-03 · **Tarea:** T128 · Propuesta de Claude Code, **aprobada por el usuario** al cerrar T128

El spec pedía que "desde un chat de Claude, compra un imán" terminara en un
pedido real. En la prueba real, Claude en claude.ai buscó y cotizó con el
conector, pero se negó a llamar `pay` dos veces, también con la confirmación
explícita del usuario: ejecutar un pago mueve un activo financiero, aunque sea
en testnet, y esa acción la deja a la persona (`evidencia/T128.md` §7.1). Es la
política del modelo, no un fallo del servidor.

Desde ahora, "una compra hecha desde un chat de Claude" significa: Claude
busca, cotiza y lee la orden con su recibo; la persona aprieta `pay` sobre esa
misma cotización, con `confirm: true`, desde un cliente MCP donde ella misma
invoca la herramienta (el MCP Inspector oficial, con el mismo OAuth y la misma
wallet). Nada más cambia: `pay` sigue exigiendo una cotización vigente que el
servidor emitió y la confirmación, y la red aplica los topes del rail igual.
Aplica a los criterios de T128, T129 y T130 y al criterio 1 de la fase. Si
ChatGPT (T129) sí llama `pay`, se registra como tal.

Para la tesis no es una pérdida: el agente no mueve fondos sin que la persona
apriete el botón, y ni así puede salirse del tope.

**Alternativa descartada: reescribir la descripción de `pay` para que no
parezca un pago.** Sería engañar al modelo y le quitaría sentido a la demo.
**Alternativa descartada: dar el criterio por no cumplido y esperar a ChatGPT.**
El pedido, el recibo y el pago en la red son los mismos; lo único que cambia es
quién aprieta el botón.

### R-12 · Tres capacidades de UCP entran a la fase: webhooks de orden, varios productos y consentimiento · `Vigente`
**Fecha:** 2026-10-03 · **Tarea:** T131 · Propuesta de Claude Code, **decidida por el usuario**

Al planificar T131 se vio que la suite oficial prueba capacidades que Vitrinee
no tiene. Se eligieron las que sirven a una tienda o a un agente real, no las
que solo suman tests: eventos de despacho en la orden con webhooks al agente
(T147; cierra el ciclo compra, recibo y disputa sin que el agente pregunte),
varios productos por compra (T148; un carrito real), y el consentimiento del
comprador, solo donde llega a la tienda (T149). Van en el Bloque B, después de
T133, porque tocan los mismos archivos que la migración a `2026-08-25`.

**Alternativas descartadas, con su motivo, y que la tabla de T131 declara
fuera:** descuentos (cambian el monto cobrado y cada plataforma valida cupones
distinto; el riesgo en el cobro no paga el beneficio hoy); que el agente edite
la orden con `PUT` (el estado de la orden lo maneja la tienda, no el agente);
tarjeta en claro y token con binding (no se aceptan números de tarjeta; el
único medio es `stellar_x402`); cliente conocido, envío dinámico y envío
gratis (Vitrinee no maneja cuentas de cliente ni tarifas; la tienda coordina el
envío). AP2 en el checkout ya es T134. Y guardar el consentimiento sin pasarlo
a la tienda: pasaría el test sin significar nada.


### R-13 · La tienda de conformidad envuelve la app real desde afuera; `complete` no se toca · `Vigente` — implementa `R-3`
**Fecha:** 2026-10-03 · **Tarea:** T131 · Diseño de Claude Code dentro del plan aprobado por el usuario; el último punto, decidido por el usuario

El medio de pago de prueba de la suite no existe en ningún código que se
despliega. `scripts/vitrinee/ucp-conformance/store.ts` arranca el `createApp`
real con el adaptador `mock` y, delante, traduce el instrumento
`mock_payment_handler` a una credencial `stellar_x402` para los requisitos que
la propia sesión guardó; solo el facilitador falso de esa tienda la liquida
(`success_token` sí, cualquier otro token no). La llave de firma y la cuenta de
cobro son aleatorias en cada corrida, los anclajes van a memoria, escucha en
`127.0.0.1` y no arranca con `RENDER`, la base o la llave maestra de la
plataforma, ni una URL pública que no sea loopback. `loadConfig` rechaza
`UCP_CONFORMANCE`. La simulación de despacho existe solo ahí. También renombra
`locality`/`region` a los nombres estándar, por un error de la suite
(reportado, conformance#116).

**Motivo.** Que el punto de autorización no exista, en vez de que exista
apagado: no hay una rama de `complete` que un día se pueda encender por error.

**Alternativa descartada.** Una dependencia inyectable en `complete` que acepte
el pago de prueba: más simple, pero deja en el código desplegado un camino que
cobra cero si alguien la inyecta.

**El test del tope queda fallando, por decisión del usuario.** `test_update_inventory_validation`:
Vitrinee topa en 100 unidades por compra y responde 400 `invalid_request`
diciéndolo, y la suite (que pide 10.001) espera la palabra "stock". Hacerlo
pasar sería decir "sin stock" cuando el motivo es el tope.

### R-14 · La versión de UCP de cada solicitud sale del perfil del agente; si no se puede saber, `2026-08-25` · `Vigente` — precisa `R-6`
**Fecha:** 2026-10-03 · **Tarea:** T133 · Propuesta de Claude Code; el defecto, **decidido por el usuario**

UCP no pone la versión en un header: el agente la declara en el `ucp.version`
de su perfil, al que apunta `UCP-Agent: profile="…"`. La tienda lee ese perfil
con un lector que trata la URL como hostil, porque llega en rutas sin
autenticación y en el mismo proceso que cobra:

- solo `https` al puerto 443, a un nombre (nunca a una IP literal), sin
  credenciales en la URL;
- el nombre se resuelve con un resolvedor propio (c-ares, no los hilos de
  libuv que comparten las llamadas al facilitador y a Horizon), y se rechaza
  si alguna dirección no es pública: IPv4 fuera de los rangos especiales, IPv6
  solo dentro de `2000::/3` y fuera de los que llevan o relevan IPv4;
- la conexión va a esa misma dirección, con TLS comprobado contra el nombre;
- **un plazo total de 3 s** cubre resolver, conectar, TLS y cuerpo (un
  servidor que gotea bytes se corta ahí), con tope de 128 KiB contado en
  bytes y sin redirecciones;
- **un solo lector por proceso**, compartido por todas las tiendas: como
  máximo 6 lecturas a la vez y un ritmo de 5 por segundo (ráfaga de 20);
  pasado eso no lee, y la tienda responde en su versión por defecto;
- un host que falló espera antes de volver a leerse, más cada vez (1 a 10 min);
- guarda solo la versión, nunca el documento (desde T134, también los nombres
  de las capacidades que declara y sus llaves P-256, acotados: ver `R-15`).

Si un cliente cierra la conexión, la lectura compartida sigue hasta el plazo
(otra solicitud puede estar esperando el mismo perfil): el costo queda acotado
por el plazo y el límite de lecturas. El mismo lector lo usa T147 para la URL
del webhook. Si el header trae
un parámetro `version="…"` (no es de la spec, pero la suite oficial lo usa), se
respeta. Una versión declarada que la tienda no sirve recibe 422
`version_unsupported`.

**Cuando la versión no se puede saber** (sin `UCP-Agent`, perfil que no
responde, que no cumple o que no se leyó por los límites), la tienda responde
en **`2026-08-25`**, la más nueva. Lo decidió el usuario; la propuesta era
`2026-04-08`, para no cambiar nada a un cliente actual que no declare versión.
**Esto se aparta de UCP:** la spec responde un perfil ilegible con
`invalid_profile_url` (400), `profile_unreachable` (424) o `profile_malformed`
(422). Cada vez que pasa, la tienda lo deja en el log (host y motivo, a lo más
una línea por minuto y host), para que nadie vea derivar en silencio al agente
de AgentPey si agentpey.com no responde. Los clientes de AgentPey
declaran su perfil y siguen recibiendo `2026-04-08` mientras ese perfil diga
`2026-04-08`.

**Alternativa descartada.** Leer solo el parámetro `version=` del header: más
simple, pero no es la spec, y un agente que declara `2026-08-25` en su perfil
recibiría respuestas viejas.

### R-15 · Cómo encajan UCP y AP2 en el checkout: la cadena `abierto~~cierre`, `aud` y `nonce`, y el alcance · `Vigente`
**Fecha:** 2026-10-04 · **Tarea:** T134 · Propuesta de Claude Code, **aprobada por el usuario**

UCP `2026-08-25` pide que la tienda firme cada respuesta del checkout
(`ap2.merchant_authorization`, JWS separado ES256 sobre el checkout
canonicalizado con JCS, sin el campo `ap2`) y que el agente mande en `complete`
un `ap2.checkout_mandate` que "contiene el checkout completo con esa firma".
AP2 v0.2 define el mandato cerrado como el último salto de una cadena
`abierto~~cierre`: el mandato abierto (firmado por la plataforma, con `cnf` =
llave del agente) y un salto `kb+sd-jwt` firmado por el agente, con `aud`,
`nonce`, `sd_hash` del abierto y, adentro, `mandate.checkout.1` con
`checkout_jwt` (JWS compacto) y `checkout_hash`. Ninguna de las dos specs dice
cómo se juntan. Se decide:

1. **`checkout_jwt` es la firma de la tienda con el payload reinsertado:**
   `header.base64url(JCS(checkout sin ap2)).firma`. Es un JWS compacto que la
   librería oficial de AP2 lee, y la tienda lo verifica con su propia llave.
   `checkout_hash` es su SHA-256 en base64url.
2. **`aud` es el origen de la tienda y `nonce` el id del checkout.** El mandato
   sirve para un solo checkout de una sola tienda, sin un paso extra para
   acordar el `nonce` (UCP no define cómo). El `complete` de un checkout solo se
   cobra una vez.
3. **El mandato abierto** es el `mandate.checkout.open.1` de T123, firmado por
   la plataforma AgentPey (`R-16`), con sus restricciones de producto, cantidad
   y tienda; la tienda las evalúa contra el checkout firmado, y una restricción
   que no conoce cuenta como no cumplida (AP2).
4. **Alcance:** AP2 solo en UCP `2026-08-25` y solo si los dos perfiles
   declaran `dev.ucp.common.payment.ap2_mandate`. **Sin mandato de pago:** en
   `stellar_x402` la credencial es la transacción firmada y el tope lo aplica la
   red; el mandato de pago abierto de T123 sigue existiendo aparte.
   **El bloqueo es de la sesión** (corregido en `/revisar`): AP2 se negocia una
   vez, al crear el checkout, y la sesión guarda la URL del perfil de la
   plataforma. Desde ahí cada respuesta en `2026-08-25` va firmada y `complete`
   exige un mandato de esa misma plataforma, negocie lo que negocie la
   solicitud (otro perfil, `version=` en el header, un perfil que no responde):
   UCP pide que ninguna de las partes vuelva atrás. Un checkout creado sin AP2
   no lo gana después. La tienda guarda en la sesión el mandato con que cobró.
5. **Un cierre por intención (brecha 14):** el agente no cierra un segundo
   mandato para el mismo `intentId`. Toma la intención antes de cualquier
   espera (dos pagos simultáneos no cierran dos) y antes de que el rail
   autorice o se firme el pago; no la devuelve aunque la tienda rechace. Un
   rechazo recuperable deja esa intención gastada: otra compra necesita otra
   intención. La memoria vive en el proceso que la tiene (`ucp:buy`).
6. **La tienda se nombra por su origen.** Con AP2 activo, el checkout lleva
   `merchant: {id: <origen>, name, website: <origen>}`: UCP no tiene ese campo,
   pero permite campos extra, y el evaluador de AP2 (`merchant_matches`) compara
   la tienda del checkout con las permitidas por `id`. El mandato abierto la
   nombra con el mismo origen que usa `aud`. En modo plataforma, ese origen
   sale del `Host` de la solicitud (cada comercio no tiene un `publicBaseUrl`
   fijo); no abre un cruce entre tiendas porque cada una firma con su propia
   llave derivada (`VT-43`), y un `checkout_jwt` de una no verifica en otra.
7. **La plataforma firma solo en su nombre** (corregido en `/revisar`): la
   llave sale del perfil que la plataforma presenta, así que el `iss` del
   mandato abierto tiene que ser el origen de ese perfil, y un `kid` que sea
   una URL tiene que estar en ese origen. Sin eso, cualquiera publicaba su
   propia llave con un `kid` de agentpey.com y firmaba "como AgentPey". Lo que
   AP2 prueba ante la tienda es "la plataforma de este origen lo autorizó"; la
   tienda no lleva una lista de plataformas confiables.
8. **Los términos que se comparan** antes de cobrar son todo lo que dice qué se
   compra, a quién, por cuánto y adónde va: id, tienda, moneda, líneas,
   comprador, despacho, totales y el handler de pago, contra lo que la sesión
   cobraría ahora. Las líneas del checkout y las del mandato abierto se
   emparejan una a una.

Queda como brecha para el SEP: las specs no dicen cómo se mapea el JWS separado
de UCP al `checkout_jwt` compacto de AP2, ni cómo se acuerdan `aud` y `nonce`.

**Alternativa descartada.** Un mandato cerrado suelto (sin el abierto) firmado
por la plataforma: más simple, pero no es la forma de AP2 v0.2 y la librería
oficial no lo verificaría como cadena.

### R-16 · La plataforma AgentPey firma mandatos AP2 con una llave P-256 propia, publicada en un perfil aparte · `Vigente`
**Fecha:** 2026-10-04 · **Tarea:** T134 · Propuesta de Claude Code, **aprobada por el usuario**

UCP pide que, en el modelo de proveedor de plataforma, la tienda encuentre la
llave que firmó el mandato en `keys` del perfil de la plataforma. AgentPey
tiene un secreto nuevo, `AGENTPEY_PLATFORM_AP2_SECRET` (P-256), solo en
`.env.local`; lo genera un script y la llave pública se publica en
`agentpey-ap2.json`, un perfil de plataforma aparte que declara la extensión
AP2. `agentpey.json` y `agentpey-2026-08-25.json` no la declaran, así que las
compras sin AP2 siguen igual. El MCP no usa AP2 por ahora: no hay nada que
cargar en Render. La llave del agente para el key binding (`cnf`) es P-256
derivada de su llave de Stellar (como `VT-43`). En el `cnf.jwk` del mandato
abierto va solo con sus miembros públicos (`kty`, `crv`, `x`, `y`, `kid`): con
`use` adentro, el SDK de AP2 no la puede releer (AP2#372, visto en la primera
compra real de T134).

**Qué prueba y qué no.** Hoy el mandato abierto lo firma el mismo proceso del
agente (`ucp:buy`), en el momento de pagar y a partir de la cotización. Prueba
qué iba a comprar el agente y que la plataforma AgentPey lo respaldó; **no** es
una autorización previa e independiente del usuario, y el `cnf` no separa nada
mientras plataforma y agente vivan en el mismo proceso. La autorización del
usuario sigue siendo el Mandato de AgentPey (firmado por el emisor, anclado y
revocable), del que el abierto cita hash y registro. No se presenta como "el
usuario autorizó en AP2".

**Alternativa descartada.** Declarar AP2 en `agentpey-2026-08-25.json`: toda
compra en esa versión quedaría obligada a mandar mandato.

### R-17 · Cómo avisa la tienda: la orden entera, firmada con RFC 9421, con una cola guardada en la orden; el despacho real se pregunta a la plataforma, y AgentPey recibe en agentpey.com · `Vigente`
**Fecha:** 2026-10-04 · **Tarea:** T147 · Propuesta de Claude Code; las cuatro elecciones, **decididas por el usuario**

UCP (`2026-04-08` y `2026-08-25`, mismo texto) pide que la tienda haga POST a la
`webhook_url` que la plataforma declara en su perfil, con la **orden entera**
como cuerpo (nunca un delta), `Webhook-Id`, `Webhook-Timestamp` y una firma
**RFC 9421** (`Signature`, `Signature-Input`, `Content-Digest`, `UCP-Agent`). La
suite oficial además exige que un reintento lleve el mismo id, el mismo
timestamp y el mismo cuerpo, y que llegue en unos 5 s. Se decide:

1. **Firma.** ES256 con la llave de webhooks de la tienda (`VT-44`). Cubre
   `@method`, `@authority`, `@path`, `content-digest`, `content-type`,
   `ucp-agent`, `idempotency-key` (igual al `Webhook-Id`, que `2026-04-08` exige
   en un POST firmado) y además `webhook-id` y `webhook-timestamp`, para que un
   reintento no pueda hacerse pasar por otro evento. Está en `@vitrinee/core`
   (`http-signatures.ts`, sin I/O), comprobada contra los vectores del RFC.
2. **Cola persistida en la orden** (decisión del usuario). Cada entrega
   (id, timestamp, cuerpo, intentos, próximo intento) vive en el registro de la
   orden, en el mismo `jsonb` de siempre: sobrevive a un deploy, sin migración.
   Reintentos a los 2 s, 10 s, 1 min, 5 min, 30 min y 2 h; después se da por
   perdida. Un 5xx, 408, 429, un receptor que no responde o el límite del
   proceso se reintentan; un 3xx (nunca se sigue), otro 4xx o una URL que no
   pasa el control se dan por perdidos al primer intento.
3. **URL hostil.** La `webhook_url` sale del perfil que el agente dicta, así que
   cada entrega pasa por el mismo cliente único del proceso que lee perfiles
   (`R-14`): `https` al 443, solo direcciones públicas, IP fijada, sin
   redirecciones, plazo de 5 s, con los mismos límites de concurrencia y ritmo,
   y vuelta a revisar en cada intento. `http` a localhost solo en la tienda de
   conformidad local.
4. **Despacho real** (decisión del usuario): una lectura lenta. Cada 10 min,
   para las órdenes UCP sin despachar de los últimos 30 días, el adaptador lee
   los despachos de la plataforma; leer la orden también pregunta, como mucho
   una vez por minuto. Shopify informa cada `fulfillment` en estado `SUCCESS`
   con su seguimiento; los permisos actuales de la app alcanzan (comprobado con
   un pedido real). **Jumpseller no informa despachos todavía**
   (`reportsShipments` en falso): su documentación no se pudo leer y no hay un
   pedido Jumpseller de testnet donde comprobar los campos; queda pendiente.
   Una tienda se arma la primera vez que recibe tráfico tras un deploy, y desde
   ahí corre su lectura; una tienda sin tráfico no se lee hasta entonces.
5. **Receptor de AgentPey** (decisión del usuario): `POST
   https://agentpey.com/ucp/webhooks/orders`, declarado como `webhook_url` en
   los tres perfiles de plataforma de AgentPey. Verifica como UCP manda (llave
   del perfil que nombra `UCP-Agent`, firma, cobertura, `Content-Digest`) y que
   la orden es de esa tienda (su `permalink_url` está en el mismo origen). Solo
   lee perfiles de tiendas que AgentPey corre (`*.vitrinee.agentpey.com`), para
   no abrir una lectura a URLs de terceros desde agentpey.com. Un mismo
   `Webhook-Id` se acepta una vez. Guarda en memoria los últimos 50, sin cuerpo,
   y los lista en `GET /ucp/webhooks/orders`. Sin ventana de frescura del
   timestamp: los reintentos de UCP conservan el timestamp original.
6. **Las disputas no son eventos de despacho.** El vocabulario de
   `fulfillment_event` de UCP no las tiene; ya se muestran como `adjustments`
   desde T127. El spec de T147 decía "y lo que llegue de la disputa"; se ajusta.
   Que un cambio de disputa dispare un webhook queda fuera de T147.

**Alternativas descartadas.** Cola solo en memoria (un deploy perdía avisos que
UCP obliga a reintentar). Webhooks de Shopify hacia la tienda (inmediato, pero
una ruta entrante nueva, con su HMAC, y solo para Shopify). Probar la entrega
real solo leyendo la orden (más barato, pero no prueba que el aviso llega al
agente). Reusar `@agentpey/webhooks` (firma HMAC y `fetch` sin IP fijada: no es
lo que UCP pide).

**Precisado tras `/revisar` (2026-10-05, a pedido del usuario).**

- Las entregas tienen **un cupo propio** (6 a la vez, 5 por segundo, ráfaga de
  20), aparte de las lecturas de perfiles: cualquiera puede gastar el cupo de
  lecturas nombrando perfiles al azar en `UCP-Agent`, y eso no puede dejar sin
  avisos a las órdenes. Si el cupo de entregas está lleno, la entrega espera 5 s
  y no cuenta como intento.
- Solo se guarda una `webhook_url` que es una URL `http(s)` de hasta 2048
  caracteres (con el perfil y el origen dentro de esos límites); si no, la orden
  queda sin webhook y `complete` responde igual. Una entrega que no se puede
  firmar se da por perdida al primer intento, nunca traba la cola.
- La firma cubre `@query` cuando la URL lo trae.
- **El número y el enlace de seguimiento van solo en el webhook**, a la
  plataforma que compró. La orden pública (`GET`) muestra que salió y con qué
  transportista, no el seguimiento, que lleva a la página del courier sobre el
  comprador (misma regla que el destino de T127: solo el país).
- La línea queda `fulfilled` cuando la plataforma dice que salió todo; un
  despacho parcial se registra como evento y se sigue preguntando. *(Precisado
  por `VT-46` en T148: con varias líneas, un parcial sin el detalle de qué líneas
  salieron no se registra como evento.)* Un pedido
  cancelado deja de preguntarse. Una sola pregunta a la vez por orden, y una sola
  pasada del vigilante a la vez.
- **El receptor de agentpey.com** acota sus lecturas de perfiles (4 a la vez, 2
  por segundo, una por perfil en curso, fallas recordadas 1 minuto), exige que la
  firma cubra `webhook-id`, `webhook-timestamp`, `content-digest`, `content-type`
  y `ucp-agent` y que tenga menos de 5 minutos (cada reintento se firma de nuevo,
  así que es compatible con los reintentos de UCP), solo acepta la llave
  `…#ucp-p256` (nunca la de AP2), responde 503 a una copia que llega mientras se
  revisa la primera, y lista lo recibido con un resumen del id de la orden, no el
  id.
- **El criterio de las redirecciones.** Una redirección solo se sabe al
  responder: la entrega se envía una vez, la redirección nunca se sigue y la
  entrega se da por perdida. Así queda el tercer criterio de T147, aceptado por el
  usuario al pedir corregir los 16 hallazgos de `/revisar`.

### R-18 · Un carrito es una intención con líneas; `checkScope` no cambia y la herramienta del modelo tampoco · `Vigente`
**Fecha:** 2026-10-05 · **Tarea:** T148 · Propuesta de Claude Code; la forma (opción A), **decidida por el usuario**

Para que AgentPey pague un checkout con varias líneas, la intención que firma el
agente tiene que decir qué compra. Se decide:

1. **`PurchaseIntent.purchase` tiene dos formas.** La de siempre (un producto,
   byte por byte igual) y un carrito: `lines` (2 a 10, cada una con `productId`,
   `quantity` y `unitAmount`), `totalAmount` y `asset`. Las intenciones ya
   firmadas siguen verificando. Como en la forma simple, ninguna decisión lee
   `totalAmount`: el total se deriva de las líneas (`intentTotal`).
2. **`checkMandate`** revisa el producto de **cada** línea contra
   `grant.products` (uno no consentido rechaza todo el carrito) y compara la suma
   con `perTx`. **`reconcileTerms`** compara el pago con la suma.
3. **`checkScope` no se toca.** Un carrito se le presenta como una unidad cuyo
   precio es el total (`scopeRequestOf`), así que `perTx` del scope se aplica a
   la compra entera. Sigue sin recibir un producto. `perDay` (rail y ledger)
   suma el total una vez.
4. **La herramienta `create_purchase_intent` no cambia** (mismo esquema, misma
   respuesta): es lo que el modelo puede llamar. El carrito se firma con
   `agent.signCart`, que no es una herramienta y existe solo si el agente puede
   comprar; corre el mismo `buildSignedIntent` (las dos autoridades, las dos
   vivas, el rail). Una línea por `signCart` da la forma simple.
5. **Antes de autorizar**, `payUcpQuote` compara las líneas del checkout con las
   de la intención, en orden (`InvalidProduct`): dos carritos pueden costar lo
   mismo. Por eso un checkout de dos gorros contra una intención de uno ahora se
   rechaza con `InvalidProduct` y no con `TermsAmountMismatch`; sigue siendo
   antes de firmar nada.
6. **AP2:** el mandato abierto lleva una entrada `checkout.line_items` por línea
   (`line_1…line_n`); con una línea queda igual que en T134. El agente exige que
   las líneas firmadas por la tienda sean las cotizadas. Un mandato por
   intención, como siempre (brecha 14). `ap2:export` (T123) sigue con un
   producto y rechaza un carrito con un error tipado.
7. **Fuera de T148:** el `quote` del MCP sigue con un producto (no está en el
   spec); `ucp:buy` acepta `--product id:n` repetido.

**Motivo.** El total solo no dice qué se compra, y el producto consentido
(`grant.products`) tiene que valer para cada línea. Dejar `checkScope` y la
herramienta del modelo como estaban reduce lo que cambia en el perímetro de
autorización a dos funciones (`checkMandate`, `reconcileTerms`).

**Alternativas descartadas.** Una intención por línea y un solo pago (no toca
`checkMandate`, pero obliga a sumar N intenciones contra `perTx` en código nuevo
y deja sin sentido "un mandato AP2 por intención"). Solo la tienda (la suite
pasa, pero AgentPey no podría comprar un carrito). Agregar `lines` a la
herramienta del modelo (su esquema JSON quedaba con `product_id` y `quantity`
opcionales).

