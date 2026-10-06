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
   comprar; valida sus líneas con zod (las reglas de la herramienta) y corre el
   mismo `buildSignedIntent` (las dos autoridades, las dos vivas, el rail), que
   rechaza una cantidad menor que 1 antes de que el rail registre gasto. Una
   línea por `signCart` da la forma simple. El esquema del carrito exige que
   `totalAmount` sea la suma de las líneas (los tres, corregidos en `/revisar`).
5. **Antes de autorizar**, `payUcpQuote` compara las líneas del checkout con las
   de la intención, en orden (`InvalidProduct`): dos carritos pueden costar lo
   mismo. Las líneas son **las que responde la tienda** (corregido en
   `/revisar`): `quoteUcpCheckout` rechaza un checkout abierto con otras líneas
   que las pedidas, y con `recheck` (el camino del MCP) se comparan otra vez las
   que la tienda tiene ahora, porque un `PUT` puede cambiar el carrito sin
   cambiar el total ni los requisitos de pago. Por eso un checkout de dos gorros contra una intención de uno ahora se
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

### R-19 · El rail UCP sube a 5,00 por compra y 10,00 por día, en un contrato nuevo; el del MCP no cambia · `Vigente` — ajusta `E-5`
**Fecha:** 2026-10-05 · **Tarea:** T148 · Decidida por el usuario (subir el `perTx`); los valores, propuestos por Claude Code y **aprobados por el usuario**

Para la compra real de T148 ningún par de productos de `agentcommerce` cabía
bajo 3,00 USDC (el más barato, imán + taza: 3480 CLP, unos 3,66 USDC). El
contrato `policy_rail` fija `per_tx` y `per_day` en su constructor y no tiene
cómo cambiarlos, así que subirlos es desplegar otra instancia del mismo wasm
(`8690d1f5…`): `CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA`, 5,00
por compra y 10,00 por día, mismos dueño (`GAK6E5…`, el agente) y principal
(`GD2MCESI…`), fondeado con 5 USDC desde la reserva. `UCP_POLICY_RAIL_CONTRACT_ID`
y `deployments/testnet.json` (`policyRailUcp`) apuntan al nuevo. `ucp:buy` toma
los topes del Mandato del rail registrado, para que las dos barreras miren los
mismos números; por eso el archivo de despliegue valida `perTx` y `perDay` como
montos decimales (corregido en `/revisar`).

El rail viejo (`CA6P4KKV…VIYP`, 3,00 y 5,00) queda con lo que tenía (unos 1,59
USDC); solo su principal puede retirarlo. Pagó los casos de T122 a T147, y el
reembolso real de T124 (`E-25`) vuelve a él, que es quien pagó esa compra.

El rail del MCP (`R-9`) sigue en 3,00 y 5,00: su perfil ya no hereda los topes
del UCP.

**Alternativas descartadas.** Pedir al usuario un producto más barato en Shopify
(no toca contratos, pero el usuario eligió subir el tope). Un contrato con
`set_limits` (cambiar los topes sin redesplegar, pero es un contrato nuevo y un
punto más que proteger).


### R-20 · MPP charge no se construye: el SDK oficial no admite un pagador contrato; en UCP sería un medio de pago aparte · `Vigente` — aplica `R-4`
**Fecha:** 2026-10-05 · **Tarea:** T135 · Propuesta de Claude Code dentro del plan aprobado por el usuario (paquete aislado, control con llave clásica, sin modo push)

La prueba técnica de T135 confirmó en testnet lo que decía la lectura del
fuente (sección 4.1 del spec): `@stellar/mpp` 0.7.1 solo acepta un pagador
`did:pkh:stellar:…:G…`. Desde el `policy_rail`, el servidor oficial rechazó los
cuatro intentos (pull y patrocinado, con el contrato o su dueño como pagador)
antes de enviar nada a la red, y cobró un control hecho con una llave clásica.
La firma del rail no es el problema: simulada en modo estricto, la red acepta
esa transferencia (precisado en `/revisar`). Se decide, aplicando `R-4`:

1. **No se construye el pago por MPP.** En el video: "evaluamos MPP", no
   "soportamos MPP". La brecha va al anexo del SEP (brecha 21) y el texto del
   issue para `stellar/stellar-mpp-sdk` queda listo; se publica solo con el OK
   del usuario.
2. **Respuesta a la pregunta del SEP: medio de pago aparte.** MPP trae su propio
   desafío, credencial (`did:pkh`), recibo y verificación. Como segunda
   credencial de `com.agentpey.stellar_x402`, un mismo id de handler significaría
   dos protocolos, y un comercio no sabría cuál acepta el otro lado.
3. **La prueba vive aparte**, en `scripts/mpp-probe/`, su propio workspace de
   pnpm (pide `@stellar/stellar-sdk` 15, `mppx` y `viem`; AgentPey usa la 17), y
   `tsconfig.scripts.json` la excluye.

**Motivo.** Pagar con MPP desde una llave clásica quitaría los topes que aplica
la red (`R-4`); y separar los handlers deja que cada uno se declare, se negocie y
se rechace por su cuenta.

**Alternativas descartadas.** Pagar MPP con una llave clásica marcada como tal
(`R-4`). Probar el modo push desde el rail (decisión del usuario: la plata se
movería y el cobro se rechazaría igual). MPP como segunda credencial del handler
x402 (un id, dos protocolos). Instalar `@stellar/mpp` en el workspace (dos
versiones del SDK de Stellar y `viem` en el lockfile de AgentPey por una prueba).

---

### R-21 · El SDK público `@agentpey/ucp-stellar` tiene el protocolo y los pagadores; el agente lo usa y conserva su autorización · `Vigente`
**Fecha:** 2026-10-05 · **Tarea:** T136 · Propuesta de Claude Code; la opción A y los valores por defecto, **decididos por el usuario**

T136 pide un paquete del lado del agente, publicable en npm, que no arrastre
dependencias privadas. Se decide:

1. **Qué entra:** leer `/.well-known/ucp` y comprobar el handler
   `com.agentpey.stellar_x402` (spec y esquema en agentpey.com, endpoint en el
   mismo origen, red `stellar:testnet`); `quote()` con un producto o un carrito
   de 1 a 10 líneas y el consentimiento en un `PUT` tras el create (T148,
   T149); `pay()` con relectura, tope, firma y `complete`; dos pagadores,
   `classicPayer` (cuenta `G…`, signer SEP-43) y `policyRailPayer` (contrato
   `C…`, el dueño firma). **Qué queda fuera:** la intención firmada, el
   Mandato, `policyRail.authorise`, AP2 (el mandato abierto lo firma la llave de
   la plataforma, `R-16`) y la verificación del recibo (depende de
   `@vitrinee/*`). Mainnet se rechaza con `UnsupportedNetwork`.
2. **El agente usa el paquete (opción A, del usuario).** `quoteUcpCheckout`,
   `payUcpQuote` y `executeUcpPayment` mantienen su API; por dentro llaman a
   `quote()` y `pay()`, y lo propio de AgentPey (las líneas de la intención,
   AP2, `toPaymentTerms` y `authorise`) corre en el hook `beforeSign`, después
   de los chequeos del paquete y antes de firmar, en el mismo orden que antes.
   `PolicyRailStellarScheme` pasa a ser un adaptador de `policyRailPayer`. Los
   códigos de error son los mismos: los del paquete son un subconjunto de
   `AgentPassErrorCode`, al que se agregan dos (`UnsupportedNetwork`,
   `AmountAboveLimit`). Cambia, para el agente: una tienda cuyo handler no está
   en testnet, o cuyo activo no tiene 7 decimales, se rechaza al cotizar; la
   tienda se nombra por su origen (un path en la URL se descarta); el comprador
   y el destino se validan (email, país ISO de dos letras, campos no vacíos);
   la relectura también compara el id del checkout (deuda de T128); y lo que el
   cliente x402 lanza al armar el pago llega tipado como `PaymentNotCreated`.
   El requisito se firma tal como lo mandó la tienda, sin agregarle miembros.
   **Precisado tras `/revisar`:** el agente lleva su propia puerta: si el
   pagador ya firmó, un error que no sea del paquete cuenta como posiblemente
   enviado (`C-113`, `M-15`), sin depender de cómo esté escrito el paquete.
3. **La firma sin llaves en el paquete.** Los pagadores reciben funciones que
   firman: un signer SEP-43, o `signAuthPayload(payload) → { publicKey,
   signature }` para el dueño del rail. `keypairSigner` y `railOwnerSigner` las
   arman desde un secreto que el llamador ya tiene; el paquete no lee el
   entorno ni escribe en disco.
4. **Errores propios: `UcpStellarError`** con `code`, `details` y
   `paymentSent` (`C-113`). `AgentPassError` vive en `@agentpass/core`, y el
   scope `@agentpass` de npm es de otra persona (`@agentpass/cli`, de OwnID):
   no se puede publicar. Lo que lanzan el pagador o el `beforeSign` del
   llamador le llega tal cual (nada se envió); después de la puerta, todo error
   lleva `paymentSent: true`.
5. **Valores por defecto (del usuario):** el perfil de plataforma en
   `UCP-Agent` es el público de AgentPey (`agentpey.json`, UCP `2026-04-08`,
   sin AP2), reemplazable; `recheck` encendido; `maxAmount` obligatorio
   (decimal o `bigint` atómico). El agente pasa como `maxAmount` el monto
   cotizado y `recheck` como antes (apagado salvo en el MCP): su tope es
   `authorise()`, que concilia contra la intención. **Precisado tras
   `/revisar`:** el decimal se lee siempre con los 7 decimales de Stellar, nunca
   con los que declara la tienda (si no, una tienda que declara 14 convertía
   "2.00" en 2e14 unidades), y una opción `asset` deja nombrar el contrato que
   se acepta (`USDC_TESTNET`). El hook recibe una copia congelada del requisito
   y de las líneas, y sin relectura ve los bytes del checkout tal como llegaron.
   Una cotización guardada solo paga en el origen de su tienda.
6. **Dependencias:** `@x402/core` y `@x402/stellar` `~2.24.0`,
   `@stellar/stellar-sdk` `~17.0.1` y `zod` `~4.5.4`, las versiones que el
   agente ya usa y que ya pagaron en testnet (con `^17.0.1` pnpm resolvía la
   17.1.0 para el paquete y los tipos chocaban con los del agente; con `^4.5.4`
   resolvía zod 4.6.5 y el agente cargaba dos copias, corregido en `/revisar`). Todas
   publicadas hace más de un día (`minimumReleaseAge`, 1440 min). Un test lee
   el `package.json` y falla con un `workspace:` o un scope interno, y otro
   busca en el código fuente imports de `@agentpass/`, `@agentpey/` o `@vitrinee/`.
7. **Nombre:** `@agentpey/ucp-stellar`, confirmado por el usuario. El scope
   `@agentpey` no existía en npm el 5-oct ("Scope not found"): la organización
   la crea el usuario antes de publicar.

**Motivo.** Una sola copia de los chequeos antes de firmar: los tests de
contrato del agente (UCP y MCP) pasan sin cambios sobre el paquete, y los de
la tienda vigilan a los dos. La autorización de AgentPey no sale del repo.

**Alternativas descartadas.** Paquete aparte con el agente igual y un test de
paridad (opción B, la que recomendé por el riesgo cerca del congelamiento;
deja dos copias del código que firma). Publicar `AgentPassError` (scope
ajeno, y arrastra el resto de `@agentpass/core`). AP2 en el paquete (pide la
llave de una plataforma). `maxAmount` opcional (un pago sin tope del llamador).

---

### R-22 · El kit de conformidad del medio de pago es un script abierto del repo, que solo cobra con una llave de quien lo corre · `Vigente`
**Fecha:** 2026-10-06 · **Tarea:** T137 · Propuesta de Claude Code; los cuatro puntos abiertos, **decididos por el usuario**

T137 pide tests abiertos que comprueben cualquier tienda que declare
`com.agentpey.stellar_x402`. Se decide:

1. **Vive en el repo** (`scripts/ucp-stellar-conformance/`,
   `pnpm run ucp:stellar:conformance`), abierto bajo Apache-2.0, no dentro de
   `@agentpey/ucp-stellar`: no pide publicar otra versión. Reusa el paquete para
   pagar y `verifyReceipt` de `@vitrinee/anchor` para el recibo.
2. **Cuatro grupos, cada uno pide más que el anterior:** perfil (solo GETs,
   contra cualquier URL, `--profile-only`); requisitos (abre un checkout y manda
   un `complete` con una transacción basura, sin plata); cobro (solo con
   `--pay` y una llave de testnet en `UCP_STELLAR_CONFORMANCE_SECRET`, con tope
   `--max-amount`); recibo (solo si la tienda declara
   `com.agentpey.shopping.receipt`). Los requisitos corren aunque el perfil
   tenga errores, para informarlos todos; el cobro solo sobre un perfil que una
   plataforma podría pagar (P3 y P5 sin fallas, R4 y R5 bien).
   **Precisado tras `/revisar`:** no se firma nada para una tienda que ya falló
   P3, P5, P6, R2, R3, R4, R5 o R6, ni para un checkout en otro activo que
   `--asset` (USDC de testnet por defecto) o por encima de `--max-amount`. La
   corrida firma **una sola** autorización, válida 120 s como mucho aunque la
   tienda pida más, y la usa en C1, C2 y C3: por su nonce se liquida una vez a
   lo sumo, mienta la tienda o no. El peor caso es un pago de hasta
   `--max-amount`. El saldo del pagador se lee antes y después de C1 (una
   tienda que liquida y contesta que no queda en `fail`) y al final (bajó
   exactamente un pago). Si C1 no llega a la tienda, la corrida se corta.
3. **El cobro real de la evidencia sale del rail UCP** (`R-19`), recargado con
   3 USDC desde la reserva, con autorización del usuario: los topes de la red
   siguen valiendo. Descartado: la llave clásica de la reserva (sin topes y con
   una cuenta de cientos de USDC expuesta) y una cuenta nueva de un solo uso.
4. **El recibo se confía al receipt-registry de AgentPey**
   (`CADILO6Q…ZTM5`) por defecto; un recibo anclado en otro contrato falla
   salvo `--registry`. Si no, una tienda tramposa anclaría en un contrato suyo.
5. **Se prueba el rechazo de una credencial con `accepted` alterado** (la spec
   dice DEBE), dos veces: con una transacción basura, que no puede mover plata
   aunque la tienda ignore el chequeo, y con `--pay`, con una transacción
   firmada de verdad. Una tienda que completa con la basura no liquidó nada,
   así que el primero solo atrapa a la que completa sin cobrar; el segundo
   atrapa a la que cobra igual. **Precisado tras `/revisar`:** el `pass` de R6
   lo dice en su detalle (la basura también era inválida); solo C1 prueba que
   la tienda compara `accepted`.
6. **Ninguna comprobación lanza:** una falla de red es un `fail` con su motivo,
   y una comprobación que no puede correr dice por qué se saltó. Sale con
   código 1 si alguna falla.

**Motivo.** Que un tercero pueda comprobar su tienda antes de decir que
acepta el medio de pago, sin tener que creerle a AgentPey, y sin mover plata
salvo que él ponga su llave.

**Alternativas descartadas.** El kit dentro del paquete publicado (pide una
0.2.0 y su publicación). Saltarse los requisitos cuando el perfil falla
(escondía las fallas del checkout de una tienda con varias a la vez). Probar
la credencial alterada solo con `--pay` (sin llave no se probaba nada).

---

### R-23 · Las pantallas de firma usan una capa de wallets propia sobre Stellar Wallets Kit, empaquetada y servida desde cada dominio · `Vigente`
**Fecha:** 2026-10-06 · **Tarea:** T143 · Propuesta de Claude Code; la forma de cargarla y el alcance, **decididos por el usuario**

`C-160` decidió Stellar Wallets Kit. Se decide cómo:

1. **Una capa propia, `packages/wallet-kit`**, encima del kit (`@creit.tech/stellar-wallets-kit` **2.7.0**, versión
   exacta): `connect()` (el selector del kit), `signMessage()` (SEP-53, firma devuelta siempre en base64 de 64 bytes,
   venga en base64, bytes, hex o un `Buffer` serializado) y `signTransaction()`, ambas en testnet y para la cuenta
   conectada (una firma de otra cuenta es `WrongAccount`, que importa con LOBSTR, que no deja elegir cuenta). Errores
   propios, `WalletError`, con mensajes en inglés y español en un solo lugar (`describe`).
2. **Se empaqueta con esbuild dentro de `pnpm build`** (`dist/wallet-kit.js`, unos 190 KB) y **cada app lo sirve
   desde su propio dominio**: `agentpey.com/wallet-kit.js`, `vitrinee.agentpey.com/portal/wallet-kit.js`,
   `mcp.agentpey.com/wallet-kit.js`. Ninguna pantalla carga un script de un CDN; eso cierra la deuda de T126 mejor que
   un `integrity`. El inicio de sesión del MCP, que tiene CSP estricta, fija además el `integrity` del archivo que
   sirve, calculado al arrancar, y no muestra la página si el archivo no existe. **Precisado tras `/revisar`:** el
   script se autoriza por el `nonce` de la página (sin `'self'` en `script-src`) y se pide como
   `/wallet-kit.js?v=<huella>`, para que un archivo nuevo nunca se cruce con uno viejo en caché.
3. **Solo se ofrecen wallets que firman mensajes**, porque toda pantalla empieza con un inicio de sesión SEP-53:
   Freighter, xBull, LOBSTR y Hana. Fuera: Albedo y Rabet (el kit lanza "does not support signMessage"), HOT (solo
   mainnet), y WalletConnect, Ledger y Trezor (pesan mucho y no hacen falta hoy). La lista final sale de la tabla de
   T143, wallet por wallet. **Precisado tras la prueba del usuario:** LOBSTR firma mensajes SEP-53 que verifican,
   pero no deja elegir la red y firmó la transacción de testnet para otra; por eso **cada pantalla declara qué firma**
   (`<script … data-needs="message transaction">`, sin declarar son las dos) y el selector ofrece solo las wallets que
   pueden. LOBSTR queda fuera de `consent.html` y `revocar.html`. Hana, también, hasta que el laboratorio muestre que
   firma transacciones de testnet: que el kit lo diga es la suposición que LOBSTR desmintió.
4. **La verificación del servidor no cambia:** `sep53.ts`, `WalletSessions` y los endpoints de cada pantalla siguen
   iguales. El laboratorio (`/wallet-lab.html`) usa el mismo almacén de desafíos y el mismo `verifyStellarMessage`,
   en un endpoint que no crea inquilinos; su transacción de prueba se arma y se verifica, nunca se envía.
   **Precisado tras `/revisar`:** la transacción de prueba lleva secuencia 0 y el servidor no le pregunta nada a
   Horizon, así que no es válida en ninguna red; y el laboratorio (página y endpoints) solo existe en un servidor
   local: en agentpey.com es un 404.
5. **Cuatro dependencias del kit traen scripts de instalación** (`@reown/appkit`, `bufferutil`, `secp256k1`,
   `utf-8-validate`): se revisaron y se niegan en `pnpm-workspace.yaml`. Ninguno hace falta para un archivo de
   navegador.
6. **El inicio de sesión del MCP entra en T143** a pedido del usuario (spec actualizado el 6-oct).

**Motivo.** Una sola forma de hablar con las wallets en cinco pantallas, sin código de terceros que cambie al
cargar la página, y sin tocar lo que verifica el servidor.

**Alternativas descartadas.** El kit desde un CDN con `integrity` (el kit carga muchos módulos y un CDN los sirve en
varios archivos: el `integrity` cubriría solo el primero). Un adaptador propio por wallet sin el kit (más código de
firma nuestro, y `C-160` ya eligió el kit). El selector con todas las wallets del kit (ofrecería wallets que no
pueden iniciar sesión). Guardar el archivo empaquetado en git (190 KB generados en cada cambio).
