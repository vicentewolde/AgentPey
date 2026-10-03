# Spec Fase 7 · Estándar de comercio agéntico sobre Stellar

- **Estado:** Cerrado (2026-10-03, `E-25`). Aprobado el 2026-09-30
- **Rama base:** `main`
- **Tareas:** T120 a T127
- **Referencias:** [`P-14`](../DECISIONES.md) (alcance), [`P-15`](../DECISIONES.md) (método),
  el traspaso del 29-sep (`docs/traspaso-estandar-comercio-agentico.md`, archivo local sin versionar),
  [INSTRUCCIONES de Vitrinee](../fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md),
  spec de UCP `2026-04-08` (https://ucp.dev/2026-04-08/specification/overview/),
  mandatos AP2 en UCP (https://ucp.dev/specification/ap2-mandates/)

> "F7" ya es otra cosa en `PLATAFORMA-PARTNERS.md`. Esta fase se escribe
> siempre **Fase 7**.

## 1. Objetivo

Un agente cualquiera que hable UCP descubre una tienda real de Vitrinee, arma
un checkout y lo paga sobre Stellar testnet desde un `policy_rail`, y recibe
en la orden un recibo firmado y anclado que cualquiera puede verificar.
AgentPey pasa a ser la implementación de referencia de un futuro SEP
("Agentic Commerce on Stellar"), no un protocolo propio.

## 2. Alcance

- Cada comercio de Vitrinee publica su perfil UCP en `/.well-known/ucp`.
- Un payment handler de Stellar para UCP: x402, USDC testnet.
- Una compra UCP de punta a punta, pagada desde un `policy_rail`, con pedido
  real en la plataforma de la tienda y recibo anclado enlazado en la orden.
- Si alcanza: el Mandato exportado como mandatos AP2 (Verifiable Credentials).
- Si alcanza: disputas v0 sobre un recibo de Vitrinee.
- Un anexo técnico con los formatos exactos, para el SEP.

## 3. Fuera de alcance

- Mainnet y rieles fiat. Queda para después del Build Award.
- Reemplazar el enforcement existente: `checkMandate`, `scope.limits` y
  `perDay` no se tocan. AP2 es una representación adicional.
- Redesplegar `receipt-registry` o desplegar un contrato nuevo sin permiso
  explícito del usuario.
- Romper `agent-storefront.json` o `GET /api/discovery/search`: los clientes
  actuales siguen funcionando.
- Escribir el SEP: se hace en el chat de estrategia. Aquí solo el anexo (T125).
- `C-154` (dos comercios por cuenta) y `C-160` (más wallets): después de esta fase.
- AgentGuard.

## 4. Diseño

Sale de T120 ([documento](T120-handler-stellar-ucp.md)) y de las decisiones
`E-1` a `E-4` del usuario (2026-09-30). Versión de UCP: **`2026-04-08`**.

### 4.1 Piezas

| Pieza | Qué es |
|---|---|
| Handler `com.agentpey.stellar_x402` | El medio de pago. Spec y esquema alojados en `https://agentpey.com/ucp/handlers/stellar-x402/`, porque UCP exige que el origen coincida con el namespace |
| Extensión `com.agentpey.shopping.receipt` | Extiende `dev.ucp.shopping.checkout` y `dev.ucp.shopping.order` con el recibo firmado y su anclaje. Alojada en `agentpey.com` |
| Perfil del comercio | `GET /.well-known/ucp` en cada subdominio: servicio REST, capacidades y el handler con su `config`. Declara solo lo que ya responde: T121 publica catalog search y lookup; T122 agrega checkout, order, fulfillment y la extensión de recibo cuando existan sus rutas |
| Catálogo | `POST /ucp/v1/catalog/search`, `POST /ucp/v1/catalog/lookup` y `POST /ucp/v1/catalog/product` (el detalle de un producto, parte de la capacidad lookup), sobre la misma caché que `agent-storefront.json`. Un producto de Vitrinee es un producto UCP con una variante |
| Sesiones de checkout | Bajo `/ucp/v1`: `POST /checkout-sessions`, `GET` y `PUT /checkout-sessions/{id}`, `POST …/complete`, `POST …/cancel` |
| Orden | `GET /ucp/v1/orders/{id}` en forma UCP, con la extensión de recibo |
| Prefijo | Todas las rutas UCP de REST viven bajo `/ucp/v1`, que es el `endpoint` del servicio declarado en el perfil. Solo `/.well-known/ucp` está en la raíz |
| Perfil de la plataforma | Un JSON estático del agente de AgentPey, enviado en el header `UCP-Agent` |

Todo lo de Vitrinee se agrega en `createApp()`
(`packages/vitrinee-gateway/src/app.ts`), al lado del manifiesto. Las rutas
actuales (`agent-storefront.json`, `/api/discovery/search`,
`/checkout/:productId`, `/catalog`, `/orders`, `/orders/:orderId`,
`/orders/:orderId/fulfil`) no cambian: el prefijo evita el choque con
`GET /orders/:orderId`.

### 4.2 Contratos

- **`config` del handler en el perfil:** red (`stellar:testnet`), esquema
  `exact`, contrato del activo, decimales, `payTo` y URL del facilitator.
- **`config` del handler en la respuesta del checkout:** el requisito x402 de
  esa compra (el `accepts[0]` de hoy): monto en unidades atómicas de USDC,
  `payTo`, activo, plazo, `areFeesSponsored`, más el tipo de cambio usado.
- **Instrumento:** `type: "stellar_x402"`. **Credencial:**
  `type: "x402_payment_payload"` con `{x402_version, accepted, payload: {transaction}}`:
  lo que hoy viaja en el header `PAYMENT-SIGNATURE`, con la versión escrita al
  estilo UCP y sin `resource`, que en UCP no existe.
- **Chequeo de la plataforma:** antes de firmar, `payTo`, `asset` y `network`
  de los requisitos de la compra tienen que coincidir con el `config` del
  handler en el perfil (`/.well-known/ucp`), no solo con la respuesta del
  checkout, que la escribe el comercio. Lo implementa el cliente de T122.
- **Liquidación:** en `complete`, del lado del comercio, contra el
  facilitator. Después se crea el pedido, se firma el recibo y se encola el
  anclaje, con el código que ya existe.
- **Moneda (`E-3`):** la sesión va en la moneda de la tienda (ISO 4217, por
  ejemplo CLP) con montos en su unidad menor. El monto en USDC solo aparece
  en el handler y en el recibo.
- **Despacho (`E-4`):** extensión `dev.ucp.shopping.fulfillment` en su forma
  mínima: un método de envío y un destino.
- **Recibo:** objeto `receipt` con `format`, `jws`, `hash`, `network`,
  `settlement_tx_hash`, `anchor` y `verify_url`. `order.permalink_url` apunta
  a `/receipts/<hash>`.
- **Errores:** rechazo del facilitator o de la red → `payment_failed`; sin
  stock → `out_of_stock`; más de una línea → error `recoverable`.

### 4.3 Límites de v0

- Un producto por compra (con cantidad). No hay carrito.
- Sin webhooks de orden: el cliente lee la orden para ver el anclaje.
- El binding de la credencial al checkout es lógico (destinatario, activo y
  monto firmados, nonce y vencimiento), no incluye el `id` de la sesión.
  Queda como brecha para el SEP.

### 4.4 Decisiones

Las de esta fase van a [`DECISIONES.md`](DECISIONES.md) con prefijo `E-`.
Las que tocan Vitrinee por dentro siguen con `VT-`.

## 5. Tareas

Una tarea = una rama `cc/t<n>-<slug>` = un PR. Todas terminan con
`pnpm check` en verde (más `pnpm run vitrinee:check` si tocan Vitrinee),
bitácora, evidencia y `docs/ESTADO.md` al día.

### T120 · Prueba técnica: payment handler de Stellar en UCP
- **Prioridad:** imprescindible · **Estimación:** 4 h · **Delegable a Codex:** no
- **Depende de:** spec aprobado
- **Descripción:** investigación, sin código de producto. Leer de la spec de
  UCP: Payment Handlers, la capacidad checkout, la capacidad order y la
  extensión de mandatos AP2. Responder:
  1. ¿Un handler con namespace propio puede transportar un pago x402 de
     Stellar (la autorización Soroban firmada) desde la plataforma (el agente)
     hasta el negocio (Vitrinee)? La regla de UCP pide que el origen de la URL
     de la spec coincida con el namespace: `com.agentpey.*` exige alojar la
     spec en `agentpey.com`.
  2. ¿Dónde se liquida el pago y cómo encaja el facilitator?
  3. ¿Cómo viaja el recibo anclado dentro de la orden UCP?
  4. ¿Qué se reutiliza tal cual? `agent-storefront.json`,
     `GET /api/discovery/search`, el checkout por `GET`, `policy_rail` como pagador.
- **Archivos principales:** `docs/fase-7-estandar-comercio-agentico/T120-handler-stellar-ucp.md`
- **Hecho cuando:**
  - [x] las cuatro preguntas están respondidas, cada una con la cita de la spec (URL y sección)
  - [x] hay opciones con una recomendación, y el plan B evaluado (catálogo en UCP, checkout x402 aparte, brecha documentada para el SEP)
  - [x] T121 y T122 tienen horas estimadas y la sección 4 de este spec queda completa
  - [x] el usuario eligió una opción: A (`E-1`)

### T121 · Vitrinee publica `/.well-known/ucp` por comercio
- **Prioridad:** imprescindible · **Estimación:** 16 h (T120) · **Delegable a Codex:** solo el mapeo mecánico de campos y los tests de validación; diseño y revisión no
- **Depende de:** T120
- **Descripción:** cada subdominio de comercio (`*.vitrinee.agentpey.com`)
  publica su perfil UCP y sirve su catálogo por `POST /catalog/search` y
  `POST /catalog/lookup`, desde los mismos datos que `agent-storefront.json`,
  que se mantiene. Incluye la spec y el esquema del handler y de la extensión
  de recibo como archivos listos para `agentpey.com` (publicarlos es un
  deploy y necesita permiso del usuario).
- **Hecho cuando:**
  - [x] el perfil y las respuestas del catálogo validan contra los esquemas de UCP `2026-04-08` (test sin red, con los esquemas versionados en el repo)
  - [x] un cliente de prueba lee el perfil, valida que el origen del handler coincide con su namespace y lista los productos de una tienda real (`bazar-cordillera`, en vivo)
  - [x] la spec y el esquema del handler y de la extensión de recibo existen en el repo y se sirven en `agentpey.com/ucp/…` (`apps/web/public/ucp/`)
  - [x] `agent-storefront.json` responde igual que antes (test de no regresión)

### T122 · Compra UCP pagada sobre Stellar, de punta a punta
- **Prioridad:** imprescindible · **Estimación:** 29 h (T120, opción A) · **Delegable a Codex:** no (`P-10`)
- **Depende de:** T121
- **Descripción:** una sesión de checkout UCP termina pagando por x402 en
  USDC testnet desde un `policy_rail`. Se crea el pedido real en la plataforma
  de la tienda, y el recibo se ancla y queda enlazado en la orden UCP.
- **Hecho cuando:**
  - [x] hash de la transacción de pago en testnet
  - [x] pedido visible en el panel de la tienda (el usuario vio el pedido del imán el 2026-10-01; Shopify `18946533884210`)
  - [x] recibo con los tres checks en verde (`pnpm run vitrinee:verify`)
  - [x] un intento que excede `per_tx` es rechazado por el contrato `policy_rail` (`PerTxExceeded` en la simulación). La evidencia sale de un script de prueba aparte que firma directo contra el contrato; el camino de producción sigue cortando antes en `policyRail.authorise` y **no gana ningún modo que lo salte**
  - [x] las rutas actuales, incluida `GET /orders/:orderId`, siguen respondiendo igual (tests existentes en verde)
  - [x] si liquidar fuera del middleware no sale al segundo día: parar, mostrar y caer a la opción C (`E-1`). Salió
  - [x] todo en `evidencia/T122.md`

### T123 · Mandato exportable como mandatos AP2
- **Prioridad:** si alcanza (se corta segundo) · **Estimación:** 16 h (replanificada, `E-8`) · **Delegable a Codex:** no
- **Depende de:** T122
- **Replanteo (2026-10-01, `E-8` a `E-11`):** AP2 `v0.2` reemplazó Intent, Cart
  y Payment por mandatos de checkout y de pago, abiertos o cerrados. El Mandato
  corresponde a los dos abiertos. No se negocia AP2 en el checkout UCP.
- **Descripción:** exportar el Mandato verificado, junto con una intención de
  compra que `checkMandate` permite, a un mandato abierto de checkout
  (`mandate.checkout.open.1`) y uno de pago (`mandate.payment.open.1`) como
  SD-JWT, firmados por AgentPey como Trusted Agent Provider; y verificarlos.
  Llaves según `E-9`; `perDay` y revocación según `E-10`.
- **Hecho cuando:**
  - [x] un Mandato real (firmado y anclado en testnet) se exporta a los dos mandatos abiertos de AP2, firmados con Ed25519, y el verificador de AgentPey los acepta ([evidencia](evidencia/T123.md))
  - [x] la librería oficial de AP2 (Python, commit `e1ea56d`) acepta el mismo par exportado con llaves P-256 de un solo uso (y también el par Ed25519)
  - [x] un mandato AP2 alterado (firma, disclosure, `payment.reference`, vencimiento o restricción desconocida) es rechazado, con un error tipado
  - [x] una intención que el Mandato no permite no produce ningún mandato AP2
  - [x] el diff no toca `checkMandate` ni el enforcement de `scope.limits` o `perDay`

### T124 · Disputas v0 (AgentResolve)
- **Prioridad:** si alcanza (se corta primero) · **Estimación:** 32 h (replanificada) · **Delegable a Codex:** no
- **Depende de:** T122, y las decisiones del usuario `E-14` (garantía del comercio) y `E-15` (nombre)
- **Descripción:** AgentResolve, a partir de la idea de Fallo (`~/fallo`, que
  solo anclaba el hash de un texto con `manageData`). Quien pagó abre un
  reclamo firmado sobre su recibo de Vitrinee, con motivo y evidencia; un
  árbitro con IA (`E-17`) emite un veredicto razonado; una persona lo confirma
  (`E-18`); el contrato nuevo `agent-resolve` guarda el hash del veredicto
  ligado al recibo y paga el reembolso desde la garantía del comercio
  (`E-14`, `E-19`). Llave del árbitro según `E-16`.
- **Hecho cuando:**
  - [x] un reclamo firmado por el pagador sobre un recibo real de Vitrinee se abre en el contrato y bloquea el monto en la garantía del comercio (recibo de T122, [evidencia](evidencia/T124.md) §3)
  - [ ] el árbitro emite un veredicto razonado validado con zod; su hash queda en el contrato ligado al recibo y el reembolso llega al pagador en testnet (veredicto y hash ya probados con el rechazo del recibo de T122; falta el reembolso real, el 8 o 9 de octubre, en una rama de evidencia aparte; **pasa a la Fase 8 como pendiente con fecha**, `E-25`)
  - [x] el contrato rechaza, con su error: reembolso mayor que el recibo, recibo no anclado, garantía de otro comercio, doble resolución, fuera de plazo y quien no es el árbitro (`cargo test`, 16 tests)
  - [x] un reclamo con inyección de prompt en la evidencia no obtiene más que el monto del recibo (`decideDispute` acota y el contrato vuelve a acotar)
  - [x] `cargo test` y `pnpm check` en verde; el diff no toca el flujo de pago, `checkMandate` ni `receipt-registry`

### T125 · Anexo técnico para el SEP
- **Prioridad:** al final · **Estimación:** 3 h · **Delegable a Codex:** no (narrativa SCF)
- **Depende de:** T122 (y T123, T124 si se hicieron)
- **Descripción:** un documento en `docs/` con los formatos exactos: el
  esquema del recibo firmado, la configuración del payment handler, cómo se
  verifica un mandato y los contratos desplegados (ids de testnet).
- **Hecho cuando:**
  - [x] cada formato del anexo coincide con el código (esquemas zod citados por ruta) y con `deployments/` (`scripts/fase7-anexo.test.ts`: ejemplos JSON contra los esquemas zod, campos del recibo, funciones citadas, códigos, contratos por fila)

### T126 · Respuesta del comercio en AgentResolve
- **Prioridad:** antes del reembolso real del 8-oct · **Estimación:** 12 h · **Delegable a Codex:** no (firma de wallet, `P-10`)
- **Depende de:** T124 (en `main`)
- **Agregada:** 2026-10-02, aprobada por el usuario (brecha 15 del anexo)
- **Descripción:** hoy el árbitro oye a una sola parte. El dueño del comercio
  responde al reclamo con sus descargos y su posición (acepta todo, acepta una
  parte o rechaza), firmados con **Freighter** (SEP-53) desde la cuenta de
  cobro del recibo (`E-20`). Responde en una página estática de
  `agentpey.com`: abre el reclamo que le envía el árbitro, escribe, firma y
  descarga la respuesta, que devuelve al árbitro (`E-21`).
  `resolve:decide -- --response <archivo>` la verifica y Claude decide con las
  dos versiones. Sin respuesta, `decide` espera 48 h desde la apertura
  (`E-22`). El veredicto lleva el hash de la respuesta, así que el hash
  anclado la cubre sin tocar el contrato.
- **Hecho cuando:**
  - [x] el comercio firma su respuesta con Freighter sobre un reclamo real, y el verificador acepta solo si quien firma es la cuenta de cobro del recibo (`merchantAccount`) y la respuesta apunta al `claim_hash` de la disputa en la red (ensayo del usuario sobre el reclamo de T122, [evidencia](evidencia/T126.md) §8)
  - [x] una respuesta alterada, firmada por otra cuenta o sobre otro reclamo se rechaza con un error tipado
  - [x] el veredicto incluye `responseHash` (o `null` si no hubo respuesta) y su hash anclado la cubre; los veredictos anteriores siguen verificando igual (`resolve:verify` sobre T122)
  - [x] `decide` no corre sin respuesta antes de las 48 h; con respuesta corre de inmediato
  - [x] una respuesta con inyección de prompt no consigue más de lo que acotan `decideDispute` y el contrato; la brecha nueva (el comercio puede empujar el reembolso hacia abajo, y la defensa es la confirmación humana de `E-18`) queda en el anexo
  - [x] el mensaje que firma la página coincide byte a byte con el que reconstruye el verificador (test)
  - [x] `pnpm check` en verde; el diff no toca el contrato, el flujo de pago, `checkMandate` ni `receipt-registry`

### T127 · La disputa visible en la orden UCP
- **Prioridad:** si alcanza, antes del 11-oct · **Estimación:** 10 h · **Delegable a Codex:** solo el mapeo al esquema UCP y sus tests
- **Depende de:** T124 · **Toca Vitrinee:** sí
- **Agregada:** 2026-10-02, aprobada por el usuario (brecha 6 del anexo)
- **Descripción:** `GET /ucp/v1/orders/{id}` lee la disputa del recibo en el
  contrato `agent-resolve` (`get`, por `getLedgerEntries`, sin llave) y la
  muestra como un ajuste UCP nativo (`adjustments[]`, `type: "dispute"`) más
  un campo opcional `dispute` en la extensión `com.agentpey.shopping.receipt`
  (`E-23`). Solo lo que está en la red: estado, hash del reclamo y del
  veredicto, montos y fechas (`E-24`). UCP sigue en `2026-04-08` (`E-2`).
- **Hecho cuando:**
  - [x] la orden muestra la disputa leída del contrato, como ajuste UCP más el campo `dispute`, y valida contra los esquemas UCP `2026-04-08` versionados y el esquema de la extensión (test sin red)
  - [x] una orden sin disputa responde igual que antes; si la lectura del contrato falla, la orden responde con un aviso, nunca con un 503
  - [x] la clave de almacenamiento que lee Vitrinee está fijada por un test contra el fuente del contrato
  - [x] el id del contrato sale de `deployments/testnet.json`, sin variables nuevas en el panel de Render
  - [ ] en vivo, tras el deploy con OK del usuario: la orden de T122 muestra la disputa resuelta con reembolso 0, y `ord_muq1gqhycf4961492c` la muestra abierta el 8-oct y resuelta después (T122: ✅ en vivo el 2-oct, [evidencia](evidencia/T127.md) §6; `ord_muq1…`: el 8-oct, **pasa a la Fase 8 como pendiente con fecha**, `E-25`)
  - [x] `pnpm run vitrinee:check` y `pnpm check` en verde

## 6. Criterios de aceptación de la fase

- [x] Un cliente UCP lee el perfil de una tienda real de terceros y lista sus productos (T121 con `bazar-cordillera`; repetido el 2-oct con `agentcommerce`, [evidencia](evidencia/criterios-fase7.md) §1)
- [x] Una compra UCP se paga en USDC testnet desde un `policy_rail`, con pedido real y recibo verificable (T122, pedido Shopify `18946533884210`; segunda compra verificada el 2-oct, [evidencia](evidencia/criterios-fase7.md) §2)
- [x] La red rechaza un pago que excede `per_tx` (`PerTxExceeded`, T122, [evidencia](evidencia/criterios-fase7.md) §3)
- [x] El anexo técnico está entregado al chat de estrategia (confirmado por el usuario el 3-oct: con él se escribió el borrador del SEP "Agentic Commerce on Stellar", [evidencia](evidencia/criterios-fase7.md) §4)

## 7. Plan de demo

No se escribió en esta fase. Al cerrarla (`E-25`), la demo pasa a la Fase 8:
lo que se graba para Find Your Way es una compra hecha desde Claude en una
tienda de terceros, que todavía no existe. El guion es la tarea T142 del
[spec de la Fase 8](../fase-8-agentes-reales/SPEC.md).

## 8. Orden, fechas y cortes

| Fechas | Qué |
|---|---|
| 1 al 3 de octubre | T120 |
| 4 al 7 de octubre | T121 y T122 |
| 8 al 10 de octubre | T123 y T124, si alcanzan |
| 11 de octubre | Congelar código, grabar la compra, T125 |
| 2 al 6 de octubre (agregado el 2-oct) | T126, para que el reembolso real ya tenga las dos partes |
| 6 al 7 de octubre (agregado el 2-oct) | T127, con deploy antes del 8 |
| 8 o 9 de octubre | Reembolso real de T124 (pedido Shopify `18952373174578`), en una rama de evidencia aparte |

Si falta tiempo se corta primero T124 y después T123. T120 a T122 no se tocan.

| Riesgo | Mitigación |
|---|---|
| UCP no admite bien x402 | Plan B de T120: catálogo en UCP, checkout x402 aparte, la brecha documentada para el SEP |
| El namespace `com.agentpey.*` exige alojar la spec del handler en `agentpey.com` | Se resuelve en T120; alojar un archivo estático en el dominio es un deploy, con permiso del usuario |
| 35 h de disputas en tres días | T124 es la primera que se corta |

## 9. Preguntas abiertas

- [x] ¿Está confirmada la extensión de Find Your Way más allá del 30-sep? **Sí**, confirmado por el usuario el 2026-09-30: el calendario de la sección 8 vale
- [x] T124, qué hace el veredicto con la plata: **(a)**, decidido por el usuario el 2026-10-01 (`E-14`). (a) garantía del comercio en un contrato, de donde salen los reembolsos (recomendada para v0: no toca el flujo de pago existente); (b) retención del pago antes de liberarlo al comercio (cambia el `payTo` de x402 y el recibo); (c) solo veredicto público, sin mover fondos. Se decide antes de T124, no ahora
- [x] T124, el nombre: **AgentResolve**, decidido por el usuario el 2026-10-01 (`E-15`)

## 10. Registro de cambios del spec

| Fecha | Cambio |
|---|---|
| 2026-09-30 | Borrador, a partir del traspaso del chat de estrategia del 29-sep |
| 2026-09-30 | **Aprobado** por el usuario, sin cambios en las tareas. Extensión de Find Your Way confirmada por el usuario |
| 2026-09-30 | T120 (cerrada al mergear): sección 4 completa, opción A (`E-1` a `E-4`), T121 a 16 h y T122 a 29 h, aviso sobre AP2 en T123 |
| 2026-09-30 | Correcciones de `/revisar` sobre T120: prefijo `/ucp/v1` para no chocar con `GET /orders/:orderId`, y cómo se obtiene la evidencia de `per_tx` sin atajos en producción |
| 2026-10-01 | T125 cerrada: `ANEXO-SEP.md`, con `scripts/fase7-anexo.test.ts` |
| 2026-10-01 | T122 cerrada: compra UCP real pagada en Stellar, pedido en Shopify, recibo válido, `per_tx` rechazado por el contrato (`E-5` a `E-7`) |
| 2026-10-01 | T123 replanificada tras leer AP2 `v0.2` y UCP `2026-08-25` del fuente: mandatos abiertos de checkout y de pago, exportación fuera de línea con chequeo cruzado, 16 h (`E-8` a `E-11`) |
| 2026-10-01 | T123 cerrada: Mandato real exportado y verificado, la librería oficial de AP2 acepta el par en Ed25519 y en P-256; tras `/revisar`, tope en centavos y credencial verificada (`E-12`, `E-13`). [PR #34](https://github.com/vicentewolde/AgentPey/pull/34) |
| 2026-10-01 | T124 planificada: AgentResolve, contrato `agent-resolve` con garantía del comercio, árbitro Claude con confirmación humana, 32 h y criterios (`E-14` a `E-19`), aprobados por el usuario |
| 2026-10-02 | T124 mergeada a `main` con cuatro de cinco criterios cumplidos; el reembolso real (criterio 2) va en una rama de evidencia aparte el 8 o 9 de octubre, como `cc/t122-evidencia` (decisión del usuario) |
| 2026-10-02 | T126 (respuesta del comercio, 12 h) y T127 (la disputa en la orden UCP, 10 h) agregadas y aprobadas por el usuario, con `E-20` a `E-24` |
| 2026-10-02 | T126 mergeada a `main` ([PR #36](https://github.com/vicentewolde/AgentPey/pull/36)) con seis de siete criterios; falta la firma real con Freighter, que se ensaya con la página ya publicada |
| 2026-10-02 | T126 cerrada: el usuario firmó con Freighter en la página publicada y `resolve:check-response` lo aceptó |
| 2026-10-02 | T127 mergeada a `main` ([PR #38](https://github.com/vicentewolde/AgentPey/pull/38)) con cinco de seis criterios; falta verla en vivo tras el deploy (T122 hoy, `ord_muq1gqhycf4961492c` el 8-oct) (`VT-37`, `VT-38`) |
| 2026-10-02 | Criterios de aceptación 1 a 3 marcados con su evidencia (`evidencia/criterios-fase7.md`); el 4 queda para el usuario |
| 2026-10-03 | **Cerrado** por decisión del usuario (`E-25`): criterio 4 cumplido; los criterios 1 y 2 repetidos hoy. Pasan a la Fase 8, con fecha, el reembolso real de T124 (8 o 9 de octubre) y ver `ord_muq1gqhycf4961492c` con su disputa (T127). El plan de demo pasa a T142 |
