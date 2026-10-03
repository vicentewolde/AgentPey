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

