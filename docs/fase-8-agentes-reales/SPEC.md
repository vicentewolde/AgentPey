# Spec Fase 8 · Agentes reales comprando en Stellar, y el estándar completo

- **Estado:** Aprobado (2026-10-03)
- **Rama base:** `main`
- **Tareas:** T128 a T146
- **Referencias:** [`P-16`](../DECISIONES.md) (alcance), [`P-15`](../DECISIONES.md) (método),
  [`P-10`](../DECISIONES.md) (perímetro de "nunca Codex"),
  el traspaso del 3-oct (`docs/traspaso-fase-8-agentes-reales.md`, archivo local sin versionar),
  [spec de la Fase 7](../fase-7-estandar-comercio-agentico/SPEC.md) y su
  [anexo para el SEP](../fase-7-estandar-comercio-agentico/ANEXO-SEP.md),
  [INSTRUCCIONES de Vitrinee](../fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md).
  Fuentes externas, con fecha de lectura, en la sección 11

## 1. Objetivo

Que un agente de verdad (Claude, y ChatGPT si la cuenta lo permite) compre en
una tienda de terceros pagando en Stellar testnet, con los topes aplicados
por la red y un recibo que cualquiera verifica; y poder decir, con evidencia
y con sus límites escritos, qué cumple AgentPey de UCP, de AP2 y de MPP.
Entrega: el video de Find Your Way, el 11-oct.

Regla de orden de la fase: **primero lo que sale en el video** (Bloque A),
después el estándar completo (Bloque B), al final las pruebas técnicas
(Bloques C y E). La línea de corte de la sección 8 está fijada de antemano.

## 2. Alcance

Lo que abre `P-16`, todo en testnet:

- Un servidor MCP remoto de AgentPey, conectado a Claude y a ChatGPT.
- Una compra desde Claude en una tienda que no es del usuario.
- La suite oficial de conformidad de UCP, y UCP `2026-08-25`.
- AP2 dentro del checkout UCP, con mandatos cerrados.
- MPP charge sobre Stellar, empezando por una prueba técnica.
- Un SDK del lado del agente publicado en npm, y un kit de conformidad del
  medio de pago de Stellar.
- Más wallets que Freighter en las pantallas de firma (`C-160`).
- Pruebas técnicas, que terminan en un documento con opciones: GenLayer y
  Trustless Work como resolutores, dots, Muse y Grok Bot como clientes, y
  pagos de servicios desde la tesorería de un equipo.
- La coherencia del recibo (brecha 10 del anexo).
- Tres capacidades de UCP en el checkout de Vitrinee (`R-12`, agregadas el
  3-oct): eventos de despacho en la orden con webhooks al agente, varios
  productos por compra, y el consentimiento del comprador hasta la tienda.

## 3. Fuera de alcance

- Mainnet, rieles fiat, tarjetas reales y cualquier cosa con dinero real.
  Cards402 y ASGCard solo existen en mainnet (sección 11): de T145 sale un
  documento, no una integración.
- Tocar `checkMandate` o el enforcement de `scope.limits` y `perDay`. AP2 y
  MPP son representaciones y formas de pago adicionales.
- Redesplegar `receipt-registry` o `agent-resolve`, o desplegar un contrato
  nuevo, sin permiso explícito del usuario. Una instancia nueva de
  `policy_rail` para el servidor MCP sí está prevista (T128), con permiso.
- Un medio de pago de prueba que no cobra, en una tienda real o desplegada
  (ver T131).
- El modo Session de MPP (`C-122`).
- Publicar el conector en el directorio de Claude: su criterio de revisión no
  acepta conectores que mueven dinero o criptoactivos. Se usa como conector
  personalizado, que no pasa por revisión.
- `C-154` (dos comercios por cuenta), AgentGuard, el modelo de cobro.
- Construir un resolutor externo (T140) sin decisión del usuario tras T138 o T139.

## 4. Diseño

### 4.1 Lo que cambió respecto del traspaso, tras leer las fuentes y el código

| Tema | Lo que decía el traspaso | Lo que dicen las fuentes (3-oct) | Consecuencia |
|---|---|---|---|
| Suite de conformidad UCP (T131) | Correrla contra una tienda de Vitrinee y corregir lo que falle | Apunta a `2026-04-08`, sin versión para `2026-08-25`. Paga siempre con `mock_payment_handler` y un token fijo, pide un endpoint `POST /testing/simulate-shipping/{id}` con un secreto, una tienda sembrada con datos fijos, y por defecto las capacidades descuento y consentimiento. No prueba catálogo. Su test de AP2 envía un mandato falso y espera que se acepte | Una tienda real no puede pasarla tal cual. Se corre contra una tienda de prueba **local**, con un modo de conformidad que nunca se despliega. La afirmación "cumplimos UCP" se escribe con su alcance exacto: qué tests pasan, cuáles se saltan y por qué |
| Orden T131 y T133 | T131 el 5, T133 el 6 | La suite solo conoce `2026-04-08` | T131 va antes de T133, y `2026-04-08` se mantiene en paralelo: sin eso, migrar deja a la suite sin nada que probar |
| MPP charge (T135) | La misma compra pagada con MPP desde `policy_rail` | `@stellar/mpp` 0.7.1 solo acepta una llave clásica como pagador; su verificación dice que un autorizador contrato no se puede verificar fuera de la red | T135 empieza como prueba técnica y **para**. Pagar con una llave clásica, sin topes en la red, contradice la tesis del proyecto: es una decisión del usuario, no un atajo |
| Llave de AP2 (T134) | Decidir entre P-256 y Ed25519 | La extensión de UCP solo admite ES256, ES384 y ES512. El issue AP2 #268 sigue abierto, sin PR | Para que un tercero lo verifique, P-256. Ed25519 queda como brecha del SEP |
| Autenticación del conector (T128) | OAuth o token | Claude admite OAuth o sin autenticación; el token fijo en un header es beta para algunas organizaciones. ChatGPT admite OAuth o sin autenticación | La opción "token" era, en la práctica, una URL secreta. El usuario eligió OAuth 2.1 desde el inicio (`R-2`) |
| dots, Muse, Grok Bot (T144) | Probar los tres | dots: planes Pro y superiores, usa "plugins soportados", sin confirmación de que acepte MCP propios. Muse: solo Estados Unidos, paga con Link de Stripe. Grok Bot: opera webs y admite conectores MCP | T144 depende de los accesos del usuario; lo más probable es que salga una tabla y no una compra |
| Tarjetas (T145) | Evaluar Cards402 y ASGCard | Las dos solo en mainnet. Cards402 emite Visa (no Mastercard). MPP Router cobra en `stellar:pubnet` | El camino de suscripciones es solo diseño. La demo de T146 usa un servicio x402 de testnet |
| Internet Court (T138) | Veredictos a Base | Contratos solo en Base Sepolia; se presenta el caso con llamadas a contrato, sin API ni SDK | Sirve para demo, no para producción, como ya decía el traspaso |
| Wallets (T143) | xBull, Albedo, Rabet, Lobstr y otras | Las pantallas de hoy usan `signMessage` y `signTransaction`, nunca `signAuthEntry`. En el kit, Albedo y Rabet no firman mensajes; xBull y Lobstr sí | El criterio (dos wallets además de Freighter) es alcanzable con xBull y Lobstr; Albedo y Rabet no sirven para estas pantallas |

### 4.2 El servidor MCP (T128)

| Pieza | Qué es |
|---|---|
| App nueva `apps/mcp` (`@agentpey/mcp`) | Servidor MCP por Streamable HTTP, sin estado, con el SDK oficial v2 (`@modelcontextprotocol/server` y `@modelcontextprotocol/express`). Es el primer código MCP del repo |
| Host | `mcp.agentpey.com`, como un proceso hijo más de `apps/gateway` (`hosts.ts`), en el mismo servicio de Render. Precedente: Vitrinee en T102. Pide un dominio nuevo en Render y en el DNS: lo hace el usuario |
| Pagador | Un `policy_rail` **propio del MCP**, con topes bajos, fondeado por el usuario. El servidor guarda la llave dueña (`R-1`). La red aplica los topes en `__check_auth`, y `policyRail.authorise` sigue cortando antes |
| Mandato | El agente del MCP necesita su credencial AgentPass y un Mandato, como cualquier agente: los emite y ancla `mcp:setup` con la llave del emisor, como `ucp:buy` en T122 (`R-8`). `payUcpQuote` no paga sin eso |
| Autenticación | OAuth 2.1 desde el inicio (`R-2`), con servidor de autorización propio e inicio de sesión con la wallet (`R-7`). El servidor MCP es el servidor de recursos: publica sus metadatos de recurso protegido (RFC 9728), responde 401 con `WWW-Authenticate` y valida el token y su audiencia, con los ayudantes del SDK (`requireBearerAuth`, `mcpAuthMetadataRouter`). El servidor de autorización tiene que aceptar PKCE S256, registro por CIMD y por DCR, y las URL de retorno de Claude (`https://claude.ai/api/mcp/auth_callback`, y loopback en cualquier puerto para Claude Code) y de ChatGPT (`https://chatgpt.com/connector_platform_oauth_redirect`). Es propio y mínimo, dentro de `apps/mcp`, y se inicia sesión firmando con la wallet principal del rail (`R-7`) |
| Secretos | En el entorno de Render y en `.env.local`, nunca en el repo ni en logs. Variables nuevas en `.env.example`, sin valor |

Herramientas. Las de lectura llevan `readOnlyHint`; `quote`, `pay` y
`open_claim` no (`R-10`), así que Claude y ChatGPT pueden pedir confirmación a
la persona antes de llamarlas. `pay` es la única destructiva.

| Herramienta | Qué hace | Se apoya en |
|---|---|---|
| `search_products` | Busca en las tiendas de Vitrinee por su catálogo UCP | Directorio `GET /api/comercios` (`expandPlatformVenues`); el cliente UCP de `scripts/vitrinee/lib/ucp-client.ts` pasó a `@vitrinee/core` (`searchUcpStore`) |
| `get_product` | Detalle de un producto | `POST /ucp/v1/catalog/product` (`getUcpProduct`, `@vitrinee/core`) |
| `quote` | Abre la sesión de checkout y devuelve total, tienda, destinatario y vencimiento. El agente firma la intención de compra, pero no se paga nada (`R-10`) | `quoteUcpCheckout` (`apps/agent/src/payment/ucp.ts`) y `create_purchase_intent` |
| `pay` | Paga una cotización vigente, con `confirm: true`, una sola vez | `payUcpQuote` con relectura de la tienda: `policyRail.authorise`, firma y `complete`; libera el gasto reservado si nada salió |
| `get_order` | La orden, con su recibo y sus tres checks | `GET /ucp/v1/orders/{id}`; `verifyReceipt` (`packages/vitrinee-anchor/src/verify.ts:32`) |
| `open_claim` | Firma un reclamo sobre un recibo y lo deja listo para el árbitro | `signClaim` (`packages/resolve/src/claim.ts:65`) |

Dos cambios en código existente, los dos dentro de `P-10`:

- `executeUcpPayment` hoy hace todo de una vez. Se parte en `quoteUcpCheckout`
  y `payUcpQuote`, y `executeUcpPayment` queda como la composición de las dos,
  con sus tests actuales sin cambios. `pay` vuelve a comprobar la cotización
  contra el perfil de la tienda: no confía en lo que guardó `quote`.
- `open_claim` solo firma. Abrir el reclamo en la red lo sigue haciendo el
  árbitro con su llave, a mano: `resolve:open -- --claim <archivo>` acepta un
  reclamo firmado afuera y lo comprueba igual que uno firmado ahí. Es un límite
  de v0.

### 4.3 Conformidad UCP y versiones (T131, T133)

- **Modo de conformidad.** Un interruptor de la tienda de prueba que agrega
  lo que la suite exige y una tienda real no tiene: el medio de pago de
  prueba, el endpoint de simulación y los datos sembrados. Vive en código de
  test o detrás de una variable que el arranque de producción rechaza. Toca el
  cobro, así que no es delegable y `/revisar` lo mira como punto de autorización.
- **Dos versiones en paralelo (`R-6`, ajusta `E-2`).** Cada tienda sirve
  `2026-08-25` por defecto y declara `2026-04-08` en `supported_versions`,
  como recomienda la spec. Los clientes de hoy y la suite siguen funcionando.
- **Cambios de `2026-08-25` que tocan a Vitrinee:** `keys[]` en vez de
  `signing_keys[]` en el perfil; extensiones de pago bajo
  `dev.ucp.common.payment.*`; `$requestConstraints` en vez de requisitos
  estáticos del instrumento; fulfillment (descripción como objeto, tipos de
  destino); `$id` de los esquemas.

### 4.4 AP2 en el checkout (T134)

Con la extensión negociada, la tienda firma cada respuesta del checkout
(`ap2.merchant_authorization`, JWS separado sobre el checkout canonicalizado)
y el agente envía en `complete` un mandato de checkout cerrado (SD-JWT con
key binding). Sin mandato de pago: en `stellar_x402` la credencial es la
transacción firmada (`R-15`, punto 4). La tienda verifica firma, su propia
autorización y que los términos coinciden. Implica una llave
P-256 nueva por tienda en Vitrinee (decisión `VT-`, gestión de llaves, no
delegable) y memoria por `intentId` para "un par por intención" (brecha 14).

### 4.5 Decisiones

Las de esta fase van a [`DECISIONES.md`](DECISIONES.md) con prefijo `R-`. Las
que tocan Vitrinee por dentro siguen con `VT-`.

## 5. Tareas

Una tarea = una rama `cc/t<n>-<slug>` = un PR. Todas terminan con
`pnpm check` en verde (más `pnpm run vitrinee:check` si tocan Vitrinee y
`cargo test` si tocan contratos), bitácora, evidencia y `docs/ESTADO.md` al
día. Las horas son estimaciones; en la Fase 7 el trabajo real salió bastante
más rápido que lo estimado.

### Bloque A · Lo que sale en el video (imprescindible)

#### T128 · Servidor MCP de AgentPey
- **Prioridad:** imprescindible · **Estimación:** 22 h, en dos PR: primero las herramientas y el pago, probados en local; después OAuth y el deploy (es una app nueva, un cambio en el flujo de pago, autenticación y un deploy; nada de eso sirve por separado) · **Delegable a Codex:** no (`P-10`: llave, firma, fondos, autenticación)
- **Depende de:** spec aprobado; del usuario: fondear el rail del MCP (su wallet es la principal, `R-8`), y el dominio en Render y DNS
- **Descripción:** lo de la sección 4.2.
- **Archivos principales:** `apps/mcp/` (nuevo), `apps/agent/src/payment/ucp.ts`, `apps/gateway/src/hosts.ts`, `render.yaml`, `.env.example`, `scripts/deploy-policy-rail.ts` (gana un perfil `mcp`, `R-9`; los otros dos no cambian)
- **Hecho cuando:**
  - [x] las seis herramientas responden por Streamable HTTP y sus entradas y salidas pasan por zod (tests sin red, con la tienda de prueba; PR 1, [evidencia](evidencia/T128.md) §1)
  - [x] `pay` rechaza, con error tipado: una cotización vencida o desconocida, la falta de `confirm`, y una cotización cuyo destinatario, activo o monto ya no coinciden con el perfil de la tienda (PR 1)
  - [x] un intento sobre el tope es rechazado antes de firmar (PR 1), y el rail del MCP lo rechaza también en la red: `PerTxExceeded` (#7) en simulación, sin enviar nada ([evidencia](evidencia/T128.md) §4)
  - [x] sin token, con un token vencido o con un token emitido para otro recurso, el servidor responde 401 con sus metadatos y no ejecuta ninguna herramienta (tests; PR 2, [evidencia](evidencia/T128.md) §3)
  - [x] la llave y los tokens no aparecen en logs ni en respuestas (tests que buscan los secretos en la salida: la llave en el PR 1, los tokens y el secreto de OAuth en el PR 2)
  - [x] `executeUcpPayment` se comporta igual que antes (sus tests y `ucp-contract.test.ts` sin cambios, en verde)
  - [x] desplegado con OK del usuario: desde un chat de Claude, "compra un imán en agentcommerce" termina en un pedido real y un recibo con los tres checks en verde. Precisado por `R-11` con el OK del usuario: Claude busca y cotiza, y la persona aprieta `pay`, porque claude.ai no ejecuta pagos. Orden `ord_muszfkwz2604255e03`, pedido Shopify `18990053523762`, tx `ba3abab7…6f70` ([evidencia](evidencia/T128.md) §6 y §7)
  - [x] todo en `evidencia/T128.md`

#### T129 · Claude y ChatGPT conectados
- **Prioridad:** imprescindible (Claude); ChatGPT, si la cuenta lo permite · **Estimación:** 3 h · **Delegable a Codex:** no (lo hace el usuario en sus cuentas)
- **Depende de:** T128
- **Descripción:** agregar el conector en Claude (Settings → Connectors → conector personalizado) y en ChatGPT (modo desarrollador, planes Plus y superiores). Guía paso a paso en el README.
- **Hecho cuando:**
  - [x] una compra real desde Claude, con capturas (lo que es "desde Claude": `R-11`): la de T128, `ord_muszfkwz2604255e03` ([evidencia](evidencia/T129.md) §1)
  - [x] una compra real desde ChatGPT, con capturas; o, si la cuenta no tiene el modo desarrollador, el motivo documentado: ChatGPT llamó `pay` él mismo tras la confirmación, `ord_mut0b5rm04b66bd5de` ([evidencia](evidencia/T129.md) §2)
  - [x] el README dice el paso exacto para conectar cada uno (`apps/mcp/README.md`, y un resumen en el README raíz)

#### T130 · Tienda de terceros real
- **Prioridad:** imprescindible · **Estimación:** 4 h · **Delegable a Codex:** no
- **Depende de:** T128; del usuario: conseguir la tienda
- **Descripción:** dar de alta por el portal (T105) una tienda que no es del usuario. Si es Jumpseller, confirmar antes que su plan crea pedidos por API (`C-151`).
- **Hecho cuando:**
  - [ ] la tienda aparece en el directorio y publica su perfil UCP
  - [ ] una compra hecha desde Claude en esa tienda (`R-11`), con el pedido visto por el dueño del comercio
  - [ ] recibo con los tres checks en verde

#### T131 · Suite oficial de conformidad UCP
- **Prioridad:** imprescindible · **Estimación:** 8 h · **Delegable a Codex:** solo sembrar los datos de la tienda de prueba y el archivo de configuración de la suite; el modo de conformidad no (toca el cobro)
- **Depende de:** spec aprobado. Va **antes** de T133. El modo de conformidad es solo local (`R-3`)
- **Descripción:** correr `Universal-Commerce-Protocol/conformance` (Python, `uv`, pytest) contra una tienda de prueba de Vitrinee en `2026-04-08`, con el modo de conformidad de la sección 4.3. Corregir lo que falle en Vitrinee. Lo que no aplica (descuentos, consentimiento, webhooks, si no se implementan) se declara fuera en la configuración de la suite, y queda escrito.
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/`, `packages/vitrinee-gateway/src/test/`, `scripts/vitrinee/` (comando nuevo `pnpm run ucp:conformance`)
- **Hecho cuando:**
  - [x] la salida cruda de la suite está en `evidencia/T131.md`, con el commit de la suite (`016ecbc`; [evidencia](evidencia/T131.md) §1 y §2, logs en `evidencia/T131/suite/`)
  - [x] una tabla dice, test por test, si pasa, si se saltó y por qué, o si falla y por qué ([evidencia](evidencia/T131.md) §3: 40 pasan, 17 fallan, 20 se saltan)
  - [x] el modo de conformidad no se puede encender en producción (test: el arranque lo rechaza; [evidencia](evidencia/T131.md) §6, `R-13`)
  - [x] la frase que se puede decir en el video está escrita con su alcance exacto ([evidencia](evidencia/T131.md) §7)

#### T132 · Coherencia del recibo (brecha 10 del anexo)
- **Prioridad:** imprescindible · **Estimación:** 4 h · **Delegable a Codex:** no (verificación de pagos) · **Toca Vitrinee:** sí
- **Depende de:** spec aprobado
- **Descripción:** hoy el verificador solo usa `amountUSDCAtomic`, ignora `claims.asset` y no mira si una transacción respalda más de un recibo. `verifyReceipt` pasa a exigir que `amountUSDC` y `amountUSDCAtomic` digan lo mismo (también el precio de cada ítem) y que `asset` sea el USDC confiado, dentro del check 1 (`VT-39`). "Una transacción, un recibo" lo garantiza la tienda al emitir, también con solicitudes simultáneas; el verificador no lo comprueba, porque `receipt-registry` no guarda el hash de la transacción (`VT-40`). El límite se escribe en el anexo.
- **Archivos principales:** `packages/vitrinee-core/src/receipt.ts`, `packages/vitrinee-anchor/src/verify.ts`, `packages/vitrinee-anchor/src/settlement.ts`, `ANEXO-SEP.md`
- **Hecho cuando:**
  - [x] un recibo con montos que no coinciden, o con otro `asset`, se rechaza: el verificador lo da inválido con el motivo, y la tienda se niega a firmarlo con un error tipado (`VitrineeError`, `ReceiptInvalid`) ([evidencia](evidencia/T132.md) §1)
  - [x] la tienda no emite un segundo recibo sobre la misma transacción, tampoco con dos solicitudes simultáneas (test; [evidencia](evidencia/T132.md) §2)
  - [x] los recibos reales de T122 y T124 siguen verificando ([evidencia](evidencia/T132.md) §3)
  - [x] el diff no toca `receipt-registry`; la brecha 10 del anexo queda reescrita con lo que la red todavía no impide

### Bloque B · El estándar completo (si alcanza, en este orden)

#### T133 · UCP `2026-08-25`
- **Prioridad:** si alcanza · **Estimación:** 10 h · **Delegable a Codex:** el mapeo mecánico de campos y traer los esquemas oficiales; diseño y revisión no
- **Depende de:** T131
- **Descripción:** perfil, esquemas y extensiones en `2026-08-25`, con `2026-04-08` en paralelo (sección 4.3). `UCP_VERSION` está duplicada en `packages/vitrinee-core/src/ucp.ts:11` y `apps/agent/src/payment/ucp.ts:43`: se unifica.
- **Hecho cuando:**
  - [x] perfil, catálogo, checkout y orden validan contra los esquemas de `2026-08-25` versionados en el repo (test sin red; [evidencia](evidencia/T133.md) §3)
  - [x] un cliente que pide `2026-04-08` recibe lo mismo que hoy (tests de la Fase 7 en verde) y la suite de T131 sigue dando el mismo resultado (40/17/20; [evidencia](evidencia/T133.md) §4)
  - [x] una versión desconocida recibe 422 `version_unsupported` (hecho en T131 para el header; en T133 también para la versión que declara el perfil, `R-14`)
  - [x] una compra real en `2026-08-25` con recibo válido, con OK del usuario: `ord_muu8xxcdbbc5bc4a54`, tx `2a30d8f0…8799` ([evidencia](evidencia/T133.md) §6)

#### T134 · AP2 dentro del checkout UCP
- **Prioridad:** si alcanza · **Estimación:** 16 h (se parte en dos PR: la tienda firma y verifica; el agente cierra el mandato) · **Delegable a Codex:** no (llaves y autorización)
- **Depende de:** T133. Llave P-256 (`R-5`)
- **Descripción:** lo de la sección 4.4.
- **Hecho cuando:**
  - [x] con la extensión negociada, un `complete` sin mandato, con mandato vencido, con firma inválida o con términos que no coinciden se rechaza con el código de UCP que corresponde ([evidencia](evidencia/T134.md) §2)
  - [x] la misma intención no produce un segundo par (brecha 14): el agente no cierra un segundo mandato para el mismo `intentId` (test de contrato)
  - [x] la librería oficial de AP2 verifica el mandato cerrado de una compra real (`ord_muudx8kyda00e05b33`, [evidencia](evidencia/T134.md) §4.2; la primera compra destapó un bug del SDK, [AP2#372](https://github.com/google-agentic-commerce/AP2/issues/372), §4.1)
  - [x] sin la extensión negociada, la compra funciona igual que hoy (test; suite 40/17/20)
  - [x] el diff no toca `checkMandate` ni el enforcement de `scope.limits` o `perDay` ([evidencia](evidencia/T134.md) §2)

#### T147 · Eventos de despacho en la orden y webhooks al agente (`R-12`)
- **Prioridad:** si alcanza · **Estimación:** 10 h · **Delegable a Codex:** no (lectura de URL dictadas por terceros, firma con la llave de la tienda)
- **Depende de:** T131 y T133
- **Descripción:** la orden UCP gana `fulfillment.events` (despachado; la disputa de T127 sigue en `adjustments`, que es donde UCP la pone: `R-17`), y la tienda avisa al agente con un webhook de orden. La URL sale del perfil que el agente declara en `UCP-Agent` (`capabilities["dev.ucp.shopping.order"][0].config.webhook_url`), así que se lee como una URL hostil: solo `https` (salvo el modo de conformidad local), nunca una dirección privada o de enlace local, con tope de bytes y de tiempo, y sin seguir redirecciones a otro host. Cada entrega lleva `Webhook-Id` y `Webhook-Timestamp`, va firmada con la llave de la tienda y se reintenta con el mismo id y el mismo cuerpo. En una tienda real el despacho sale de la plataforma (Shopify; Jumpseller queda pendiente, `R-17`); en la tienda de prueba, del endpoint de simulación de T131. AgentPey recibe y verifica los webhooks en `agentpey.com/ucp/webhooks/orders`, que sus perfiles de plataforma declaran (`R-17`, decisión del usuario).
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/order.ts`, `packages/vitrinee-gateway/src/ucp/` (`order-events.ts`, `webhook-key.ts`, nuevos), `packages/vitrinee-core/src/http-signatures.ts` (nuevo), `packages/vitrinee-adapters/src/shopify/`, `apps/web/src/ucp-webhooks.ts` (nuevo), `apps/web/public/ucp/platform/`
- **Hecho cuando:**
  - [x] la orden muestra el evento de despacho y valida contra el esquema de orden (test sin red; [evidencia](evidencia/T147.md) §2)
  - [x] la tienda entrega el webhook, firmado, y lo reintenta ante un 500 con el mismo id (test con un receptor local; [evidencia](evidencia/T147.md) §2)
  - [x] una URL de webhook `http`, privada, de enlace local o que redirige a otro host se rechaza sin pedirla (tests; una redirección solo se sabe al responder: se envía una vez, nunca se sigue y se da por perdida; [evidencia](evidencia/T147.md) §2)
  - [x] los tests de webhook de la suite de T131 pasan en el modo de conformidad, y la tabla de T131 se actualiza (47/10/20; [evidencia](evidencia/T147.md) §3)
  - [x] un despacho real en una tienda de testnet llega como evento, con OK del usuario (`ord_muv8xjmi1a53efae61`, pedido Shopify `19009954578738`: el evento en la orden y el aviso verificado en agentpey.com; [evidencia](evidencia/T147.md) §5)

#### T148 · Varios productos por compra (`R-12`)
- **Prioridad:** si alcanza · **Estimación:** 6 h · **Delegable a Codex:** no (monto cobrado)
- **Depende de:** T131 y T133
- **Descripción:** un checkout UCP con más de una línea. El total, la cotización x402, el pedido en la plataforma y los ítems del recibo cuadran entre sí al centavo; la coherencia de T132 se extiende a varias líneas. Hoy más de una línea da 400.
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/checkout.ts`, `packages/vitrinee-core/src/receipt.ts`, `packages/vitrinee-adapters/src/`, `apps/agent/src/payment/ucp.ts`
- **Hecho cuando:**
  - [x] un checkout con dos productos cotiza, cobra una vez y crea un pedido con dos líneas (test sin red) ([evidencia](evidencia/T148.md) §3)
  - [x] el verificador rechaza un recibo cuyas líneas no suman el total (test) ([evidencia](evidencia/T148.md) §3 y §4, `VT-45`)
  - [x] `executeUcpPayment` y `ucp-contract.test.ts` siguen en verde con una línea ([evidencia](evidencia/T148.md) §3)
  - [x] una compra real con dos productos y recibo con los tres checks en verde, con OK del usuario (`ord_muvewqqmddbf40c81d`, [evidencia](evidencia/T148.md) §9)

#### T149 · Consentimiento del comprador hasta la tienda (`R-12`)
- **Prioridad:** si alcanza · **Estimación:** 2 h · **Delegable a Codex:** no
- **Depende de:** T131
- **Descripción:** `dev.ucp.shopping.buyer_consent`: el checkout guarda `buyer.consent` y lo pasa a la plataforma (`buyer_accepts_marketing` en Shopify). Si Jumpseller no tiene un campo equivalente, en Jumpseller no se anuncia la capacidad y queda escrito. No se anuncia en una tienda donde el consentimiento no llega a ningún lado.
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/`, `packages/vitrinee-adapters/src/shopify/`
- **Hecho cuando:**
  - [x] el consentimiento llega al pedido de Shopify (test con el adaptador) ([evidencia](evidencia/T149.md) §3, `VT-47`)
  - [x] el perfil solo anuncia la capacidad donde llega (test) ([evidencia](evidencia/T149.md) §3)
  - [x] el test de consentimiento de la suite pasa, y la tabla de T131 se actualiza (49/8/20, [evidencia](evidencia/T149.md) §4)

#### T135 · MPP charge sobre Stellar · empieza como prueba técnica, parar y mostrar
- **Prioridad:** si alcanza · **Estimación:** 4 h · **Delegable a Codex:** no
- **Depende de:** spec aprobado
- **Descripción:** comprobar con código, en testnet, si un pago MPP charge puede salir de un `policy_rail`. La lectura del fuente dice que no (sección 4.1). Si se confirma, no se construye el pago (`R-4`): la evidencia va al anexo del SEP y se redacta un issue para `stellar/stellar-mpp-sdk`, que se publica solo cuando el usuario haya visto el texto. Si resulta que sí se puede, parar y mostrar. También responder la pregunta del SEP: segunda credencial del mismo medio de pago, o medio de pago aparte.
- **Hecho cuando:**
  - [x] `T135-mpp-charge.md` con la evidencia del intento desde un `policy_rail` en testnet ([evidencia](evidencia/T135-mpp-charge.md), `R-20`)
  - [x] la brecha está en el anexo del SEP y el texto del issue, listo; publicado con el OK del usuario (brecha 21 en el anexo; [texto](evidencia/T135-issue-mpp.md) publicado el 2026-10-05 con OK del usuario: [stellar/stellar-mpp-sdk#90](https://github.com/stellar/stellar-mpp-sdk/issues/90))
  - [x] la frase que se puede decir en el video ("evaluamos MPP", no "soportamos MPP") está escrita con su evidencia ([evidencia](evidencia/T135-mpp-charge.md) §7)

#### T136 · SDK publicado en npm
- **Prioridad:** si alcanza · **Estimación:** 8 h · **Delegable a Codex:** el README y el ejemplo; el paquete y la publicación no
- **Depende de:** T128 (reusa la separación cotizar y pagar)
- **Descripción:** paquete del lado del agente (nombre provisional `@agentpey/ucp-stellar`): leer un perfil UCP, validar el medio de pago de Stellar, cotizar y pagar. Hoy todos los paquetes son `private` en `0.1.0` y no hay configuración de publicación.
- **Hecho cuando:**
  - [x] el paquete se instala desde un tarball en un proyecto vacío y el ejemplo del README, de menos de 30 líneas, corre contra una tienda real (15 líneas; compra real `ord_muvqqsth2fb48d4110` en `agentcommerce`, `evidencia/T136.md`)
  - [x] no arrastra dependencias privadas del monorepo (`R-21`; lo exige `manifest.test.ts`)
  - [x] publicado en npm, **con permiso explícito del usuario para esa publicación** (el usuario publicó `@agentpey/ucp-stellar@0.1.0` el 2026-10-06; [npmjs.com/package/@agentpey/ucp-stellar](https://www.npmjs.com/package/@agentpey/ucp-stellar))

#### T137 · Kit de conformidad del medio de pago de Stellar
- **Prioridad:** si alcanza · **Estimación:** 8 h · **Delegable a Codex:** los tests de perfil y de esquema; los de cobro y recibo no
- **Depende de:** T131, T132
- **Descripción:** tests abiertos que comprueban cualquier tienda que declare `com.agentpey.stellar_x402`: perfil, dominio del namespace, requisitos, cobro y recibo. Las comprobaciones de solo lectura corren contra cualquier URL; las de cobro, solo con una llave de testnet que pone quien lo corre.
- **Hecho cuando:**
  - [x] `pnpm run ucp:stellar:conformance -- <url>` da un informe por comprobación (20 comprobaciones en cuatro grupos, `R-22`)
  - [x] pasa contra una tienda de Vitrinee y falla, con un mensaje claro, contra una tienda de prueba rota a propósito (agentcommerce 20 de 20 con un cobro real, `ord_muwqcvf16d7c595e74`; la tienda rota, 6 fallas con su motivo; `evidencia/T137.md`)

### Bloque C · Resolutores externos (si alcanza; primero pruebas técnicas)

> Desde el 7-oct (`R-24`): este bloque va al final de la fase, después del video.

#### T138 · Prueba técnica: GenLayer como jurado de AgentResolve · parar y mostrar
- **Prioridad:** si alcanza · **Estimación:** 4 h · **Delegable a Codex:** no (narrativa y fondos)
- **Descripción:** investigación, sin código de producto. Responder: cómo se presenta un reclamo de AgentResolve como caso de Internet Court; cómo se expresa un reembolso parcial con un veredicto de tres valores; cuál de las tres opciones de relevo (único auditable, varios con multifirma, puente); costo y tiempo.
- **Hecho cuando:**
  - [ ] `T138-genlayer.md` con las respuestas citadas, opciones, recomendación y horas
  - [ ] el usuario decidió si se construye

#### T139 · Prueba técnica: Trustless Work como escrow por compra · parar y mostrar
- **Prioridad:** si alcanza · **Estimación:** 4 h · **Delegable a Codex:** no
- **Descripción:** responder: si el `payTo` de x402 pasa a ser el escrow; qué cambia en el recibo; si el árbitro de AgentResolve puede ser el Dispute Resolver; qué pediría una postulación al Integration Track de SCF.
- **Hecho cuando:**
  - [ ] `T139-trustless-work.md` con las respuestas citadas, opciones, recomendación y horas
  - [ ] el usuario decidió si se construye

#### T140 · Resolutor intercambiable en AgentResolve
- **Prioridad:** se corta primero · **Estimación:** 8 h · **Delegable a Codex:** no
- **Depende de:** T138 o T139, **y la aprobación del usuario**
- **Descripción:** una interfaz de resolutor con la implementación actual (Claude más confirmación humana) y la elegida. Los criterios se escriben cuando el usuario elija.

### Bloque E · Más wallets, más agentes y pagos de servicios

#### T143 · Más wallets que Freighter (`C-160`)
- **Prioridad:** si alcanza · **Estimación:** 8 h · **Delegable a Codex:** no (firma de wallet)
- **Depende de:** spec aprobado
- **Descripción:** Stellar Wallets Kit en `consent.html`, `revocar.html`, `resolve/responder.html`, el portal de comercios y el inicio de sesión OAuth del servidor MCP (`apps/mcp/src/oauth/login-page.ts`, agregado a pedido del usuario el 6-oct). Primero comprobar en la práctica, wallet por wallet, que la firma de mensajes cumple SEP-53 y verifica en `packages/core/src/sep53.ts`. De paso, cargar la librería con `integrity` (deuda de T126).
- **Hecho cuando:**
  - [x] una tabla wallet por wallet: firma mensaje, firma transacción, verifica en el servidor (`evidencia/T143.md` §4 y §6: Freighter, xBull, LOBSTR, Hana)
  - [x] las pantallas que solo firman un mensaje funcionan con al menos dos wallets además de Freighter, y las que firman una transacción de testnet, con todas las que la firman bien (hoy xBull), probadas por el usuario (**ajustado por el usuario el 6-oct**, opción A: LOBSTR firma transacciones para mainnet y Hana no firma SEP-53; antes decía "las tres pantallas funcionan con al menos dos wallets además de Freighter")
  - [x] una wallet que no firma mensajes no se ofrece donde hace falta (Albedo y Rabet en ninguna; Hana tampoco, por no firmar SEP-53; LOBSTR no donde se firma una transacción de testnet; `data-needs`, `R-23`)
  - [x] la verificación del lado del servidor no cambia (`sep53.ts`, `WalletSessions` y los endpoints de cada pantalla, sin cambios)

#### T144 · dots, Muse y Grok Bot como agentes de AgentPey · prueba técnica
- **Prioridad:** si alcanza; solo dots sobrevive al corte · **Estimación:** 5 h · **Delegable a Codex:** no
- **Depende de:** T128; de los accesos del usuario
- **Hecho cuando:**
  - [ ] `T144-agentes.md` con una tabla agente por agente: qué funciona, qué falta, evidencia
  - [ ] una compra real desde dots, si el usuario tiene acceso y dots acepta el conector

#### T145 · Equipos SCF pagando IA y servicios con Stellar · prueba técnica, parar y mostrar
- **Prioridad:** si alcanza · **Estimación:** 5 h · **Delegable a Codex:** no (regulación, `P-10`)
- **Descripción:** dos caminos: servicios que cobran por uso (x402 o MPP desde un `policy_rail` del equipo) y suscripciones (tarjeta virtual fondeada con USDC). Responder quién hace el KYC, quién es titular, cómo se ata el gasto al Mandato y al recibo, y qué toca regulación. Nada con dinero real.
- **Hecho cuando:**
  - [x] `T145-tesoreria-equipos.md` con opciones, recomendación y lo que requiere revisión legal ([evidencia](evidencia/T145-tesoreria-equipos.md))

#### T146 · Demo: presupuesto de equipo en testnet
- **Prioridad:** se corta segundo · **Estimación:** 6 h · **Delegable a Codex:** no
- **Depende de:** T145, **y la aprobación del usuario**
- **Hecho cuando:**
  - [ ] un `policy_rail` con topes paga un servicio x402 en testnet, con recibo y un resumen de gastos del mes

### Bloque D · Cierre

#### T141 · Página pública "Tiendas comprables por agentes"
- **Prioridad:** para el video · **Estimación:** 5 h · **Delegable a Codex:** sí, el HTML y sus tests, con el diseño decidido; el texto lo revisa Claude Code
- **Depende de:** T128 (para la sección del conector)
- **Descripción:** en `agentpey.com`: las tiendas del directorio (`GET /api/comercios`) con su perfil UCP, el último recibo verificado de cada una y cómo conectar el conector. En inglés por defecto y español neutro.
- **Hecho cuando:**
  - [ ] la página lista las tiendas reales y cada recibo enlaza a su verificación
  - [ ] no muestra nada que no salga del directorio o de la red

#### T142 · Guion y grabación de la demo
- **Prioridad:** imprescindible · **Estimación:** 4 h · **Delegable a Codex:** no (narrativa)
- **Depende de:** Bloque A
- **Descripción:** guion de unos 3:30 minutos: el problema, el estándar, Claude comprando en la tienda de terceros, el recibo verificado, una disputa y el SEP. Es el plan de demo de la sección 7. Congelar el código el 10-oct.
- **Hecho cuando:**
  - [ ] el guion está escrito como pasos exactos y cada afirmación tiene su evidencia en el repo
  - [ ] el usuario grabó el video

### Pendientes con fecha, heredados de la Fase 7 (`E-25`)

No son tareas: no hay nada que construir. Su evidencia va a la carpeta de la Fase 7.

- [ ] **8 o 9 de octubre:** reembolso real de T124 sobre el pedido Shopify `18952373174578`, en una rama de evidencia, con el código de `main`
- [ ] **El mismo día:** `ord_muq1gqhycf4961492c` muestra la disputa abierta y después resuelta (T127)

## 6. Criterios de aceptación de la fase

- [ ] Una compra hecha desde un chat de Claude (`R-11`), en una tienda que no es del usuario, pagada en USDC testnet desde un `policy_rail`, con pedido real y recibo con los tres checks en verde (T128, T129, T130)
- [x] La red rechaza un pago del servidor MCP que excede su tope (T128, [evidencia](evidencia/T128.md) §4)
- [x] La salida de la suite oficial de conformidad de UCP está en el repo, con su alcance escrito (T131, [evidencia](evidencia/T131.md); hoy 49/8/20)
- [x] El verificador rechaza un recibo incoherente (T132, [evidencia](evidencia/T132.md))
- [ ] El video está grabado y entregado (T142; lo hace el usuario)

Lo del Bloque B, C y E no es criterio de cierre: lo que no alcance queda
cortado con su motivo.

## 7. Plan de demo

Es la tarea T142. Se escribe al cerrar el Bloque A.

## 8. Orden, fechas y cortes

| Fecha | Qué |
|---|---|
| 3–4 oct | `P-16`, spec aprobado, T132 y el primer PR de T128 (herramientas y pago, en local) |
| 5 oct | Segundo PR de T128 (OAuth y deploy), T129 (Claude) y T131 |
| 6 oct | T130, T133 y T143 |
| 7 oct | T134, T135, T144 y T147 |
| 8 oct | Reembolso real de T124; T136, T148 y T149; T138, T139 y T145 (pruebas técnicas) |
| 9 oct | T137, T141, T146 si T145 lo permite, y T140 si el usuario la aprobó |
| 10 oct | Congelar código; T142, grabación |
| 11 oct | Edición y entrega del video |

**Línea de corte.** Si el 7-oct en la noche el Bloque A no está completo, se
corta en este orden: T140, T146, T137, T144 (salvo dots), T136, T135, T134,
T149, T148, T147, T143. T128 a T132 y el reembolso real no se tocan. Las pruebas técnicas T138,
T139 y T145 quedan como documentos aunque no se construya nada. **Esto no se
renegocia el 10-oct.**

**Ajuste del 7-oct (`R-24`, decidido por el usuario).** La línea de corte no se
aplica: no se corta ninguna tarea. T138 y T139 pasan al final de la fase,
después del video, y T140 queda detrás de ellas. El orden de lo que queda:
T145, reembolso real de T124, T141, T130 cuando haya tienda, T142 (código
congelado el 10-oct); después T146 y T144 si alcanzan; al final T138, T139 y T140.

| Riesgo | Mitigación |
|---|---|
| Veintidós tareas y unas 153 h estimadas en siete días | El orden por bloques y la línea de corte. El Bloque A solo son unas 41 h |
| OAuth desde el inicio (`R-2`) mueve la primera compra desde Claude del 4 al 5 de octubre | T128 en dos PR: el pago se prueba en local el 4, sin esperar a OAuth. Si OAuth no está el 6-oct en la noche, parar y mostrar |
| El Bloque A depende del usuario: dominio y DNS, fondear el rail, conseguir la tienda, conectar sus cuentas | Lista de pendientes del usuario en `docs/ESTADO.md` desde el primer día; T128 se prueba primero contra `agentcommerce` |
| Un servidor en internet que guarda una llave que paga | Rail propio con topes bajos aplicados por la red, solo testnet, OAuth 2.1 con validación de audiencia (`R-2`), y `pay` exige cotización vigente y confirmación |
| Un texto malicioso en el catálogo de una tienda intenta que el agente compre otra cosa | El modelo no elige destinatario ni monto: salen de la cotización, que `pay` vuelve a comprobar contra el perfil. El tope de la red acota el daño |
| El modo de conformidad es un medio de pago que no cobra | Solo en la tienda de prueba local; el arranque de producción lo rechaza; `/revisar` lo trata como punto de autorización |
| La suite de UCP y la verificación real de AP2 se contradicen (la suite espera que un mandato falso se acepte) | El test de AP2 de la suite se corre solo en modo de conformidad y se documenta; T134 se prueba con la librería oficial de AP2 |
| MPP no admite cuentas-contrato | T135 es prueba técnica primero; el resultado es evidencia para el SEP aunque no se construya |
| ChatGPT, dots, Muse o Grok Bot no están disponibles para la cuenta del usuario | Se documenta y se sigue; el criterio de la fase solo exige Claude |
| Migrar a `2026-08-25` rompe clientes | Dos versiones en paralelo, y los tests de la Fase 7 como red |

## 9. Preguntas abiertas

- [x] **1. Cómo se autentica el conector MCP:** OAuth 2.1 desde el inicio, decidido por el usuario el 3-oct (`R-2`). Recomendé empezar con una URL secreta y agregar OAuth después; el usuario prefirió no publicar un servidor que paga sin autenticación
- [x] **2. Dónde vive el modo de conformidad de T131:** solo local, nunca desplegado (`R-3`)
- [x] **3. MPP, si se confirma que no admite `policy_rail`:** documentar la brecha y abrir un issue; no pagar con una llave clásica (`R-4`)
- [x] **4. Llave para cerrar mandatos AP2:** P-256; Ed25519 queda como brecha del SEP (`R-5`)
- [x] **5. Dos versiones de UCP en paralelo:** sí, aprobado por el usuario el 3-oct (`R-6`, ajusta `E-2`)
- [x] **6. Servidor de autorización de OAuth:** propio, mínimo, con inicio de sesión firmando con la wallet (`R-7`), decidido por el usuario el 3-oct
- [x] Quién firma los pagos del servidor MCP: **opción (a)**, decidido por el usuario el 3-oct (`R-1`)

## 10. Registro de cambios del spec

| Fecha | Cambio |
|---|---|
| 2026-10-03 | Borrador, a partir del traspaso del chat de estrategia del 3-oct, con las fuentes oficiales leídas ese día y el código revisado. Cambios frente al traspaso en la sección 4.1 |
| 2026-10-03 | Respuestas del usuario a las preguntas 1 a 4 (`R-2` a `R-5`): OAuth desde el inicio (T128 pasa de 14 h a 22 h, en dos PR), modo de conformidad solo local, MPP se documenta y no se paga con llave clásica, P-256 para AP2. Sigue en borrador |
| 2026-10-03 | **Aprobado** por el usuario, con las dos versiones de UCP en paralelo (`R-6`). Queda abierta la pregunta 6 (servidor de autorización de OAuth), que se resuelve en el plan de T128 |
| 2026-10-03 | T132: con el plan aprobado por el usuario, el verificador no comprueba la unicidad "contra los recibos que conoce" (`VT-40`); se agrega la coherencia del precio por ítem (`VT-39`). Criterios marcados; falta `/revisar` |
| 2026-10-03 | T132 cerrada: `/revisar` sin bloqueantes, siete hallazgos corregidos (`VT-41`), [PR #44](https://github.com/vicentewolde/AgentPey/pull/44) |
| 2026-10-03 | T128, PR 1: respuestas del usuario a la pregunta 6 y al plan (`R-7` a `R-9`); `quote` no es de solo lectura (`R-10`); `resolve:open -- --claim`; el cliente UCP pasa a `@vitrinee/core`. Cinco criterios marcados, los otros tres van en el PR 2 |
| 2026-10-03 | T128, PR 1, `/revisar`: sin bloqueantes; corregidos los ocho importantes a pedido del usuario (confirmación ausente tipada, gasto liberado, directorio leído antes de tomar la cotización, recibo atado a su orden y su tienda, tests de cambios coherentes de perfil y checkout, cliente UCP en `@vitrinee/anchor`, spec al día). `R-10` aprobada por el usuario |
| 2026-10-03 | T128, PR 2 en código: OAuth propio con inicio de sesión de wallet, `main.ts`, `mcp:setup`, perfil `mcp` de `deploy:policy-rail`, host `mcp.agentpey.com` en el gateway y `render.yaml`, `ucp:probe-per-tx -- --rail mcp`. Dos criterios marcados |
| 2026-10-03 | T128 en testnet con OK del usuario: agente, credencial y Mandato, rail `mcp` con 10 USDC, y la red rechaza sobre el tope. Tercer criterio marcado; falta la compra desde Claude |
| 2026-10-03 | T128, PR 2, `/revisar`: sin bloqueantes; corregidos los 14 hallazgos a pedido del usuario (renovación de un uso, wallet comprobada contra el rail en la red, desafío sin estado, retorno de loopback sin puerto, errores en JSON, CSP exacta, entre otros). El hallazgo de una URL de retorno en `claude.com` no aplica: la documentación de Claude solo lista `claude.ai` |
| 2026-10-03 | T128 cerrada: en vivo en `mcp.agentpey.com` y compra real en `agentcommerce` (orden `ord_muszfkwz2604255e03`, recibo con los tres checks en verde). Claude en claude.ai no ejecuta `pay`; con el OK del usuario, `R-11` precisa qué es "una compra desde Claude" en T128, T129, T130 y el criterio 1 de la fase. Criterio 2 de la fase marcado |
| 2026-10-03 | T129: Claude y ChatGPT conectados y comprando; guía en `apps/mcp/README.md`. ChatGPT sí llama `pay` tras la confirmación de la persona. Tres criterios marcados. `/revisar` sin bloqueantes, diez hallazgos corregidos; cerrada |
| 2026-10-03 | T147, T148 y T149 agregadas a pedido del usuario (`R-12`): eventos de despacho y webhooks, varios productos por compra, consentimiento hasta la tienda. Bloque B, después de T133; en la línea de corte van después de T134 |
| 2026-10-03 | T131: tienda de conformidad local (`R-13`), `pnpm run ucp:conformance`, cinco arreglos en el checkout UCP (`VT-42`). Corrida final: 40 pasan, 17 fallan, 20 se saltan. El 422 `version_unsupported` que pide T133 quedó hecho aquí. Error de la suite reportado (conformance#116). Cuatro criterios marcados. `/revisar` sin bloqueantes, 12 hallazgos corregidos; cerrada |
| 2026-10-03 | T133: perfil `2026-08-25` con la hoja `2026-04-08` en `supported_versions`, negociación por el perfil del agente con un lector endurecido (`R-14`, defecto `2026-08-25` por decisión del usuario), respuestas según la versión, perfil de plataforma `agentpey-2026-08-25.json`. Tres criterios marcados; falta la compra real tras el deploy |
| 2026-10-03 | T133, `/revisar`: dos bloqueantes en el lector de perfiles (sin plazo total, sin límite de lecturas) y 12 hallazgos más, corregidos a pedido del usuario; `R-14` precisada (límites exactos y la desviación de los códigos de error de UCP) |
| 2026-10-04 | T133 cerrada: mergeada ([PR #50](https://github.com/vicentewolde/AgentPey/pull/50)) y compra real en `2026-08-25` con recibo válido; cuarto criterio marcado |
| 2026-10-05 | T147 cerrada: mergeada ([PR #55](https://github.com/vicentewolde/AgentPey/pull/55)) y en vivo. Compra real en `agentcommerce`; el usuario marcó el pedido como despachado en Shopify, la orden mostró el evento y los dos avisos ("creada" y "despachada") llegaron verificados a agentpey.com. Quinto criterio marcado |
| 2026-10-05 | T147, `/revisar`: sin bloqueantes; 16 hallazgos corregidos a pedido del usuario (`R-17` precisada; el criterio de las redirecciones queda como "se envía una vez y no se sigue") |
| 2026-10-04 | T147: plan con cuatro decisiones del usuario (llave P-256 propia, cola en la orden, lectura lenta del despacho, receptor en agentpey.com; `R-17`, `VT-44`). Se ajusta la descripción: la disputa sigue en `adjustments`, Jumpseller queda sin despacho, y entra el receptor de agentpey.com. Cuatro criterios marcados; falta el despacho real tras el deploy |
| 2026-10-04 | T134 cerrada: mergeada ([PR #52](https://github.com/vicentewolde/AgentPey/pull/52)) y en vivo. Dos compras reales con AP2 en `agentcommerce`: la primera la aceptó la tienda pero el SDK de AP2 la rechazó por un bug suyo (`use` como enum al releer `cnf.jwk`, reportado como AP2#372); con `cnf.jwk` reducido a sus miembros públicos, la segunda la verifica la librería oficial. Quinto criterio marcado |
| 2026-10-04 | T134, `/revisar`: un bloqueante (el bloqueo AP2 se calculaba por solicitud, así que un `complete` que ya no negociaba AP2 cobraba sin mandato) y 16 hallazgos más, corregidos a pedido del usuario. El bloqueo pasa a ser de la sesión; el `iss` del mandato abierto queda atado al perfil de la plataforma; los términos comparados incluyen destino y comprador. `R-15` y `R-16` precisadas; §4.4 alineada con `R-15` (sin mandato de pago) |
| 2026-10-04 | T134: la tienda firma cada checkout y verifica el mandato AP2 antes de cobrar; el agente lo cierra (`abierto~~cierre`, `R-15`), con la llave de la plataforma (`R-16`) y la de la tienda derivada (`VT-43`). La librería oficial de AP2 verifica una cadena de muestra. Cuatro criterios marcados; falta la compra real tras el deploy. Se hizo en una rama con los dos lados en vez de dos PR |
| 2026-10-05 | T136: `@agentpey/ucp-stellar` en `packages/ucp-stellar`, con la opción A del usuario (el agente lo usa, `R-21`). Dos criterios marcados; la publicación en npm espera el permiso del usuario |
| 2026-10-06 | T136 cerrada: publicada en npm por el usuario (`@agentpey/ucp-stellar@0.1.0`), instalada desde npm en un proyecto vacío y el ejemplo cotiza contra `agentcommerce`. Tercer criterio marcado |
| 2026-10-06 | T137: kit de conformidad del medio de pago como script del repo (`R-22`), 20 comprobaciones; pasa contra agentcommerce con un cobro real desde el rail UCP y falla contra la tienda rota. Dos criterios marcados |
| 2026-10-06 | T143: a pedido del usuario, el inicio de sesión OAuth del MCP entra en la tarea (también firmaba solo con Freighter) |
| 2026-10-06 | T143: el usuario ajustó el criterio 2 (opción A): donde se firma una transacción de testnet bastan las wallets que la firman bien (hoy xBull), porque LOBSTR firma para mainnet y Hana no firma SEP-53. Criterios 1, 3 y 4 marcados |
| 2026-10-06 | T143 cerrada: el usuario probó en agentpey.com aprobar y revocar un Mandato con Freighter y con xBull, y entrar al portal; criterio 2 marcado ([PR #65](https://github.com/vicentewolde/AgentPey/pull/65)) |

## 11. Fuentes externas

Leídas el 2026-10-03, varias a través de un resumen: se vuelven a leer del
fuente al empezar la tarea que las usa, como en T120.

| Tema | Fuente |
|---|---|
| Conectores personalizados de Claude: planes, transporte, autenticación, límites | https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp · https://claude.com/docs/connectors/building · https://claude.com/docs/connectors/building/authentication · https://claude.com/docs/connectors/building/review-criteria |
| Modo desarrollador de ChatGPT y autenticación | https://developers.openai.com/api/docs/guides/developer-mode · https://developers.openai.com/apps-sdk/build/auth |
| SDK de MCP para TypeScript (v2, 2.3.0) | https://github.com/modelcontextprotocol/typescript-sdk/releases · https://ts.sdk.modelcontextprotocol.io/v2/serving/express.html |
| Autorización en MCP | https://modelcontextprotocol.io/specification/latest/basic/authorization |
| Suite de conformidad de UCP (último commit 2026-09-07) | https://github.com/Universal-Commerce-Protocol/conformance |
| UCP `2026-08-25` y versiones en paralelo | https://github.com/Universal-Commerce-Protocol/ucp/releases/tag/v2026-08-25 · https://ucp.dev/specification/overview/ |
| Mandatos AP2 en UCP | https://ucp.dev/specification/payment/extensions/ap2-mandates/ |
| AP2 `v0.2.0` e issue #268 | https://github.com/google-agentic-commerce/AP2/issues/268 |
| `@stellar/mpp` 0.7.1 | https://registry.npmjs.org/@stellar/mpp · https://github.com/stellar/stellar-mpp-sdk |
| MPP Router (de un tercero, solo `stellar:pubnet`) | https://www.mpprouter.dev/ |
| Stellar Wallets Kit 2.7.0 | https://stellarwalletskit.dev/installation.html |
| dots (OpenAI) | https://learn.chatgpt.com/docs/dots |
| Muse (Meta) | https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ |
| Grok Bot (xAI) | https://x.ai/news/introducing-grok-bot |
| GenLayer e Internet Court | https://genlayer.com/ |
| Trustless Work | https://docs.trustlesswork.com/trustless-work/introduction/technology-overview · https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/integration-track |
| Cards402 y ASGCard (solo mainnet) | https://cards402.com/docs · https://asgcard.dev/docs |

**Sin confirmar** en una fuente oficial: si dots acepta conectores MCP propios
y cómo compra; si los conectores de Muse son MCP; si la suite de UCP permite
reemplazar el medio de pago de prueba; el nombre exacto de la extensión de AP2
bajo `2026-04-08`; si la librería de AP2 acepta Ed25519 al cerrar un mandato;
si la firma de mensajes de cada wallet cumple SEP-53; quién es el titular y
quién hace el KYC en Cards402 y ASGCard.
