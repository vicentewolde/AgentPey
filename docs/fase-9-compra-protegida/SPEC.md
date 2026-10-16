# Spec Fase 9 · Una compra protegida, de punta a punta

- **Estado:** Aprobado (2026-10-14)
- **Rama base:** `main`
- **Tareas:** T157 a T167 (T168 a T170 reservadas si hace falta partir alguna; la Fase 8 numera desde T171)
- **Fechas:** 13-oct → 11-nov-2026 (30 días). Arranca el 14-oct, con un día de atraso
- **Referencias:** [`P-19`](../DECISIONES.md) (alcance), [`P-15`](../DECISIONES.md) (método),
  [`P-10`](../DECISIONES.md) (perímetro de "nunca Codex"),
  [anexo del SEP §6](../fase-7-estandar-comercio-agentico/ANEXO-SEP.md) (brechas 6, 10 y 18),
  [spec de la Fase 7](../fase-7-estandar-comercio-agentico/SPEC.md) (AgentResolve, `E-14` a `E-24`),
  [spec de la Fase 8](../fase-8-agentes-reales/SPEC.md) (MCP `R-1` a `R-11`, webhooks `R-17`, wallets `R-23`, un rail por persona `R-33`),
  [INSTRUCCIONES de Vitrinee](../fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md).
  Decisiones de la fase con prefijo `X-` en [`DECISIONES.md`](DECISIONES.md)

## 1. Objetivo

Hoy las piezas de una compra hecha por un agente funcionan por separado:

- el pago va directo a la tienda y el reembolso sale de una garantía aparte (`agent-resolve`, `E-14`);
- el reclamo hecho en el chat lo firma el MCP, pero lo abre el árbitro a mano (`resolve:open -- --claim`);
- la respuesta del comercio viaja como archivo (`E-21`);
- el despacho no afecta el pago;
- nada en la red ata un recibo a su pago (brecha 10).

**Al terminar la fase, una sola compra recorre todo conectado:** Claude busca y paga dentro de sus topes → se crea
el pedido → el pago queda retenido en un contrato → se despacha → se reclama desde el chat → el comercio recibe el
aviso y responde desde su página → el veredicto reembolsa desde el pago retenido. Todo queda grabado, con cada paso
mapeado a su transacción en Stellar Expert.

La fase cumple los tres entregables del **Instaward** enviado a Stellar Chile el 7-oct-2026 (Stellar Passport,
USD 4.000, inicio sugerido el 13-oct). El texto enviado está en el [anexo A](#anexo-a--texto-enviado-al-instaward-7-oct-2026-sin-cambios):
**lo que dice el anexo es el compromiso**, y este spec no promete más ni menos.

## 2. Alcance

| Entregable | Semanas | Tareas |
|---|---|---|
| **D1** · Pago y postventa conectados en la red | 1 y 2 | T157–T161 |
| **D2** · Chat, comercio y despacho en un solo flujo de postventa | 3 | T162–T165 |
| **D3** · Una compra protegida, grabada de punta a punta | 4 | T166–T167 |

Todo en testnet, sin terceros nuevos. Las compras y disputas que ya existen siguen funcionando como hoy.

## 3. Fuera de alcance (igual que lo enviado)

- Mainnet, dinero real, rieles fiat o tarjetas.
- Sumar comercios o compradores reales, y pilotos comerciales.
- Cualquier actividad regulada por la CMF (Ley Fintech 21.521).
- **Áreas de producto nuevas:** solo se conecta lo que existe. Quedan fuera, entre otras, el MCP con varias wallets
  (`R-33`, que diseña la Fase 8 respetando la interfaz de la sección 4.6), la revocación que llega al rail y el portal
  conectado al kit.
- Resolutores externos (GenLayer, Internet Court, Trustless Work) y cualquier integración con terceros. T140 queda
  cortada; T138 y T139 siguen en la Fase 8 solo como evaluaciones para después de esta fase.
- Plataformas de tienda nuevas: solo Shopify y Jumpseller.
- Auditoría externa, apps móviles y publicar el conector en directorios.
- Tocar `checkMandate`, el enforcement de `scope.limits`/`perDay` o el contrato `policy_rail`.
- **Redesplegar `agent-resolve` o `receipt-registry`:** siguen vivos para las compras y disputas existentes,
  incluido el reembolso de T124.
- Alta de escrow desde el portal: el escrow de esta fase se despliega a mano para `agentcommerce` (`X-11`).

## 4. Diseño

### 4.1 Hechos del código que fijan el diseño (verificados el 14-oct sobre `cdde180`)

| Hecho | Dónde | Consecuencia |
|---|---|---|
| `policy_rail.__check_auth` autoriza **una sola cosa**: un `transfer` de su activo, desde sí mismo, con 3 argumentos y monto positivo, dentro de `per_tx`, `per_day` y `valid_until`. **El destinatario no se revisa** | `contracts/policy-rail/src/lib.rs` l.361–426 | El rail no puede llamar a `deposit` de otro contrato, pero sí pagarle a una cuenta-contrato. El pago entra al escrow como un `transfer` x402 normal con `payTo` = el escrow (`X-3`) |
| `owner()` del rail devuelve la llave pública Ed25519 cruda (`BytesN<32>`), no un `Address` | `policy-rail/src/lib.rs` l.145–148, l.207–209 | El escrow puede verificar en la red una firma Ed25519 del dueño del rail que pagó |
| **Todo `pay_to` del lado de la tienda acepta solo cuentas `G…`:** esquema público del handler, `wire.ts`, `stellarX402BusinessConfigSchema`, el directorio de tiendas, `merchantAccount` del recibo y la configuración del gateway | `ucp-stellar/src/wire.ts:44`, `vitrinee-core/src/ucp.ts:104`, `apps/web/public/ucp/handlers/stellar-x402/schema.json:63`, `apps/agent/src/catalog/platforms.ts:105`, `vitrinee-gateway/src/config.ts:28` | T160 abre `C…` solo cuando la tienda declara escrow, en una versión nueva del handler (`X-13`) |
| `checkSettlement` exige `account_credited` sobre `merchantAccount` | `vitrinee-anchor/src/settlement.ts:64` | Con escrow, la verificación busca `contract_credited` sobre el contrato declarado (T159) |
| Hay **dos cuentas de comercio**: la de **firma** (firma y ancla recibos; su llave la guarda el servidor) y la de **cobro** (`merchantAccount`; en el portal es la wallet del comercio, sin llave en el servidor) | `vitrinee-gateway/src/app.ts:130`, `ucp/checkout.ts:356–382`, `platform/portal.ts:160` | `hold` y `mark_shipped` los firma la cuenta de firma; `respond`, la de cobro (`X-4`) |
| En Soroban un contrato no puede leer el hash de otra transacción | — | Un escrow compartido dejaría que una tienda haga `hold` sobre un pago ajeno; un escrow por tienda lo impide (`X-11`) |
| `agent-resolve.open` y `resolve` exigen la firma del árbitro; `open` no verifica la firma del reclamo y `resolve` no tiene plazo | `contracts/agent-resolve/src/lib.rs` l.246–324 | El escrow tiene su propio `open` (firma del pagador) y su propio plazo de resolución con `expire` (`X-7`). `agent-resolve` no se toca |
| `open_claim` del MCP firma un JWS EdDSA sobre el JSON del reclamo con la llave dueña del rail, y devuelve el paso `resolve:open` | `apps/mcp/src/shopper.ts:360–397` | El contrato no puede leer JSON: el MCP firma además un mensaje corto para la red (sección 4.3) |
| La página `responder` firma un mensaje SEP-53 con la wallet y baja un archivo | `apps/web/public/resolve/responder.html` l.446–457 | Con wallet-kit (T143) el comercio firma una **transacción** `respond` (Freighter o xBull) |
| Los webhooks de la orden (RFC 9421, cola en la orden) solo tienen `created` y `shipped` | `vitrinee-gateway/src/ucp/order-events.ts`, `orders.ts:65` | Se agregan eventos de disputa y escrow a la misma cola (T165) |
| Shopify informa despachos (`reportsShipments`, revisión cada 10 min); Jumpseller no | `vitrinee-adapters/src/shopify/index.ts:134`, `R-17` | La demo es en `agentcommerce` (Shopify); Jumpseller queda documentado |
| `pay()` relee el perfil y la sesión antes de firmar cuando `recheck` está activo (el MCP lo activa) | `ucp-stellar/src/checkout.ts:425–452`, `shopper.ts:295` | Ahí se agrega la comprobación del escrow (`X-9`) |
| soroban-sdk: 27.0.6 en `contracts/`, 28.0.0 en `receipt-registry` (workspace propio) | `contracts/Cargo.toml:15` | El contrato nuevo entra al workspace principal (`X-8`) |

### 4.2 El contrato `purchase-escrow`

Un contrato **por tienda** (`X-11`), en `contracts/purchase-escrow/`, miembro del workspace principal (soroban-sdk 27).
Tiempo leído del ledger, montos en `i128` (unidades atómicas), errores tipados con `contracterror`, un evento por
cada cambio de estado.

| Función | Quién la firma | Qué hace |
|---|---|---|
| `__constructor(operator, payee, arbiter, token, release_window, response_window, resolve_window)` | Quien lo despliega | `operator` = cuenta de firma de la tienda; `payee` = cuenta de cobro; `arbiter` = el árbitro de hoy |
| `hold(order_ref, payer, amount, tx_hash, receipt_hash)` | `operator` | Registra una compra pagada al escrow. Rechaza un `tx_hash` repetido (un pago, un recibo), un `order_ref` repetido y un monto mayor que el saldo no asignado del contrato |
| `mark_shipped(order_ref)` | `operator` | Abre la ventana de liberación |
| `release(order_ref)` | Cualquiera | Paga `amount` a `payee` si la compra está despachada, la ventana cerró y no hay reclamo |
| `open(order_ref, claim_hash, sig)` | Nadie en particular: `sig` es la firma Ed25519 de `payer.owner()` sobre el mensaje de 4.3; un pagador con cuenta clásica firma la llamada (`X-16`) | Abre la disputa y congela la liberación. Vale hasta que cierra la ventana de liberación (`X-12`, `X-15`) |
| `respond(order_ref, response_hash)` | `payee`, dentro de `response_window` desde la apertura | Una respuesta tardía se rechaza en la red |
| `resolve(order_ref, verdict_hash, refund)` | `arbiter` | Reembolsa `refund` al pagador (el rail que pagó) y paga el resto a `payee`. Se rechaza si el comercio no respondió y `response_window` sigue abierta |
| `expire(order_ref)` | Cualquiera | Si el árbitro no resolvió dentro de `response_window + resolve_window` desde la apertura: reembolso completo al pagador (`X-7`) |
| `claim_refund(order_ref)` | Cualquiera | Entrega al pagador un reembolso que no se pudo entregar al cerrar (`X-19`) |
| Lecturas: `config()`, `get(order_ref)`, `by_tx(tx_hash)`, `unallocated()`, `open_message(...)` | — | Para el verificador, la orden UCP, el MCP y el agente |

Estados: `Held → Shipped → Released`, o `Held|Shipped → Disputed → (Responded) → Resolved|Expired`.
Una compra admite una sola disputa, como en `agent-resolve`.

Con esto el recibo queda atado a su pago en la red (`tx_hash` → compra → `receipt_hash`) sin redesplegar
`receipt-registry`, que sigue anclando el recibo como hoy.

**Límites de v0, a la vista:**
- Si la tienda nunca despacha, el pago queda retenido hasta que el comprador reclame (`not_delivered`). No hay
  liberación ni reembolso automáticos sin despacho.
- Un pago que llega sin `hold`, o un sobrepago, queda como no asignado: el comprador no puede reclamarlo y solo el
  operador puede asignarlo (`X-20`). T159 y T160 lo cubren desde la tienda y el agente.
- Quien no puede recibir (sin trustline, saldo desautorizado) solo demora lo suyo: un reembolso queda como deuda
  cobrable con `claim_refund`, y una tienda que no puede cobrar no impide `expire` (`X-19`).

### 4.3 El reclamo en la red

El JWS del reclamo no cambia (`AgentResolveClaim`, firmado por la llave dueña del rail). Para la red, el MCP firma
con esa misma llave un mensaje corto con dominio fijo, `agentpey/purchase-escrow/open/v1`, la dirección del
contrato, `order_ref` y `claim_hash` (SHA-256 del JWS compacto, como hoy). El contrato llama `owner()` del `payer`
registrado en `hold` y verifica la firma con `ed25519_verify`. El formato exacto de los bytes se fija en T157 y se
documenta en el README del contrato.

### 4.4 Cómo entra el pago (`X-3`, `X-5`, `X-9`, `X-13`)

1. La tienda con escrow declara en el `business_config` del handler un bloque `escrow` (contrato, ventanas y
   árbitro) y pone `pay_to` = el contrato. Versión nueva del handler y de la extensión del recibo; la
   `2026-09-30` sigue válida para las tiendas sin escrow.
2. El agente, al releer el perfil antes de firmar, exige que el `payTo` del requisito x402 sea el contrato
   declarado, y que ese contrato corra el código conocido de `purchase-escrow` (hash del wasm fijado en el agente).
   Si no, rechaza antes de firmar.
3. El facilitator liquida el `transfer` del rail al contrato.
4. La tienda firma el recibo (con `merchantAccount` = la cuenta de cobro y el contrato del escrow en los claims),
   lo ancla en `receipt-registry` como hoy, y llama `hold` con `tx_hash`, pagador, monto y `receipt_hash`.
5. El verificador, cuando el recibo declara escrow, comprueba `contract_credited` sobre el contrato y que
   `by_tx(tx_hash)` devuelva la misma compra, el mismo pagador, el mismo monto y el mismo `receipt_hash`.

Sin cambios en `policy_rail`, `checkMandate` ni los topes.

### 4.5 Chequeo del día 1 (antes de T157)

**¿El facilitator x402 (OpenZeppelin Channels, testnet) acepta un `payTo` que es una cuenta-contrato (`C…`)?**
`@x402/stellar` 2.26 acepta `G`, `C` y `M` en el destino, pero el facilitator no se ha probado. Se prueba con
0,01 USDC hacia un contrato propio, con el OK del usuario. Si lo rechaza:

- **Plan B:** la tienda liquida directo (envía la transacción firmada sin facilitator).
- **Plan C:** se le pide al usuario una decisión.

El resultado se registra como decisión de la fase.

**Resultado (14-oct, `X-14`): lo acepta.** `verify` dio válido y `settle` liquidó 0,01 USDC desde una cuenta `G…`
hacia el contrato `policyRailUcp` (`CBDRI5B7…D3YA`), con comisión patrocinada: transacción
[`84611558…077f`](https://stellar.expert/explorer/testnet/tx/84611558ffea12348a87aa23f9428749efcbba74e30f0d3bae04d61841cb077f),
ledger 5194404. El efecto en Horizon es `contract_credited` con el contrato en el campo `contract` (el campo
`account` trae la cuenta que envió la transacción, no el destinatario). No hace falta plan B. Evidencia en
[`evidencia/chequeo-dia-1.md`](evidencia/chequeo-dia-1.md).

### 4.6 La interfaz que respeta `R-33`

El escrow verifica el reclamo contra `owner()` del rail **que pagó**, leído en la red. Con un rail por persona
(`R-33`), el MCP firma con la llave dueña del rail de esa persona y nada del escrow cambia. La Fase 8 diseña `R-33`
sin tocar esta interfaz.

### 4.7 Decisiones

Las de esta fase van a [`DECISIONES.md`](DECISIONES.md) con prefijo `X-` (`X-1` a `X-13`, respondidas por el
usuario el 14-oct; `X-14`, el resultado del chequeo del día 1; `X-15` a `X-20`, precisiones de T157 aprobadas por el
usuario). Las que tocan Vitrinee por dentro siguen con `VT-`.

## 5. Tareas

Todas: rama `cc/t<n>-<slug>` desde `origin/main`; `pnpm check` en verde, más `vitrinee:check` si toca Vitrinee y
`cargo test` si toca contratos; bitácora, evidencia en `evidencia/T<n>.md` y `ESTADO.md`. **Ninguna se delega a
Codex** (`P-10`: contrato, fondos, firma, autorización). Cada despliegue en testnet y cada gasto necesitan el OK
explícito del usuario.

### Semana 1 (13–19 oct) · D1, primera parte

#### T157 · Contrato de escrow: retener, liberar, reembolsar y plazos
- **Estimación:** 14 h (más de medio día: el contrato y sus tests no se parten sin dejar un contrato a medias en testnet) · **Delegable a Codex:** no · **Depende de:** el chequeo 4.5
- **Archivos principales:** `contracts/purchase-escrow/`, `contracts/Cargo.toml`, `deployments/testnet.json`, un script de despliegue
- **Descripción:** el contrato de 4.2 y el mensaje de 4.3.
- **Hecho cuando:**
  - [x] hay tests de liberación al vencer, reembolso total y parcial, respuesta tardía rechazada, `release` antes de tiempo rechazado, `open` con firma inválida o de otra llave rechazado, `hold` duplicado (mismo `tx_hash` o mismo `order_ref`) rechazado, `hold` sin saldo rechazado, `resolve` antes de tiempo rechazado, `expire` y llamadas sin autorización rechazadas
  - [x] el contrato está desplegado en testnet para `agentcommerce` con el OK del usuario y registrado en `deployments/testnet.json` (`CBQFELK5…DO27A`, más un escrow de ensayo del mismo wasm, `X-17`; redesplegados por `X-19`)
  - [x] hay hashes de **un pago liberado y uno reembolsado** (todavía con un `hold` manual), en el escrow de ensayo (`X-17`, [evidencia](evidencia/T157.md))

#### T158 · El veredicto actúa sobre el pago retenido
- **Estimación:** 8 h · **Delegable a Codex:** no · **Depende de:** T157, T159 y T160: necesita una compra real retenida, con su recibo (`X-21`)
- **Archivos principales:** `scripts/resolve.ts`, `packages/resolve/`, `scripts/arbiter-console.ts`
- **Descripción:** `resolve:decide` y `resolve:verify` reconocen las compras con escrow y resuelven en `purchase-escrow`. Las compras sin escrow siguen en `agent-resolve`. El veredicto, el `verdict_hash` y la confirmación humana (`E-18`, `X-10`) no cambian.
- **Hecho cuando:**
  - [x] un veredicto real reembolsa desde el pago retenido, con su hash: [`65f5f891…`](https://stellar.expert/explorer/testnet/tx/65f5f8910b549a147e438983ed16c75d35e7c0a98ea5d4d1e83f8e39fa911816) ([evidencia](evidencia/T158.md), `X-26`)
  - [x] una disputa vieja de `agent-resolve` sigue verificando (la de T124, `0922707…`)
  - [x] el anexo del SEP §6 queda al día (brechas 6 y 18)

### Semana 2 (20–26 oct) · D1, segunda parte

#### T159 · Un pago, un recibo, en la red
- **Estimación:** 6 h · **Delegable a Codex:** no · **Depende de:** T157
- **Archivos principales:** `packages/vitrinee-gateway/` (`hold` tras liquidar), `packages/vitrinee-anchor/src/verify.ts` y `settlement.ts`, `packages/vitrinee-core/src/receipt.ts`
- **Descripción:** la tienda llama `hold` con `tx_hash`, pagador y `receipt_hash` justo después de liquidar, y lo reintenta si falla (`X-20`). `verifyReceipt` suma la comprobación del vínculo cuando el recibo declara escrow (4.4, paso 5).
- **Hecho cuando:**
  - [x] hay un hash de un **recibo duplicado rechazado** por la red ([`87a80cc1…`](https://stellar.expert/explorer/testnet/tx/87a80cc144eb35a12b5112fa1be01afd24d38d27ab3e5b8e0af5f0beb142b102), `PaymentAlreadyHeld`; [evidencia](evidencia/T159.md))
  - [x] el verificador da inválido un recibo cuyo `tx_hash` no coincide, con el motivo
  - [x] los recibos anteriores siguen verificando
  - [x] la brecha 10 queda cerrada en el anexo (para recibos pagados a un escrow)

#### T160 · El checkout paga al escrow
- **Estimación:** 12 h · **Delegable a Codex:** no · **Depende de:** T157, T159
- **Archivos principales:** `packages/ucp-stellar/` (`wire.ts`, `checkout.ts`), `packages/vitrinee-core/src/ucp.ts`, `packages/vitrinee-gateway/src/ucp/`, `apps/web/public/ucp/handlers/stellar-x402/`, `apps/agent/src/catalog/platforms.ts`, `apps/agent/src/payment/`
- **Descripción:** 4.4, pasos 1 a 4:
  - la tienda con escrow declara el contrato en el handler (versión nueva) y pone `payTo` = escrow;
  - registra la compra con `hold` después de liquidar;
  - el agente, al releer el perfil, exige que el `payTo` sea el escrow declarado y que corra el wasm conocido;
  - después de pagar, el agente avisa si `by_tx` no encuentra la compra de su pago (`X-20`).
  Sin cambios en `policy_rail`, `checkMandate` ni los topes.
- **Hecho cuando:**
  - [x] **una compra real en testnet queda retenida** en el escrow: pago [`ed11e866…`](https://stellar.expert/explorer/testnet/tx/ed11e866b57004827165f3d7b8fd204f8f9df0cb12314c2894bd8ba970a0b754), `hold` [`6ae292d4…`](https://stellar.expert/explorer/testnet/tx/6ae292d4870d869446cb0bc9e88321e326662037043d0dd7362998222e1ef09f) ([evidencia](evidencia/T160.md))
  - [x] una tienda que declara escrow pero cobra a otra cuenta, o declara un contrato con otro wasm, es rechazada por el agente antes de firmar ([evidencia](evidencia/T160.md), `X-24`)
  - [x] las tiendas sin escrow compran igual que hoy, y la suite UCP sigue igual o mejor (49/8/20, [evidencia](evidencia/T160.md))

#### T161 · La orden muestra el estado del escrow
- **Estimación:** 4 h · **Delegable a Codex:** no · **Depende de:** T160
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/order.ts`, `apps/mcp/src/shopper.ts` (`get_order`)
- **Descripción:** la orden UCP y `get_order` del MCP muestran retenido, despachado, liberado, en disputa o reembolsado, en la extensión del recibo (versión nueva, `X-13`).
- **Hecho cuando:**
  - [ ] la orden de la compra de T160 valida contra los esquemas y muestra "retenido"

### Semana 3 (27-oct – 2-nov) · D2

#### T162 · El reclamo desde el chat abre la disputa en la red
- **Estimación:** 8 h · **Delegable a Codex:** no · **Depende de:** T157, T160
- **Archivos principales:** `apps/mcp/src/shopper.ts`, `apps/mcp/src/tools.ts`
- **Descripción:** si la compra tiene escrow, `open_claim` firma el mensaje de 4.3 y envía `open`. Sigue sin ser de solo lectura y pide confirmación (`R-10`). Las compras sin escrow siguen como hoy.
- **Hecho cuando:**
  - [ ] hay una **grabación de un reclamo hecho desde Claude** o ChatGPT y el hash de la disputa abierta
  - [ ] un reclamo firmado por otra llave se rechaza en la red

#### T163 · El comercio recibe el aviso y responde desde su página
- **Estimación:** 10 h · **Delegable a Codex:** no · **Depende de:** T162
- **Archivos principales:** `apps/web/public/resolve/`, `apps/vitrinee-portal/`, `packages/vitrinee-gateway/`, `packages/resolve/src/response.ts`
- **Descripción:**
  - aviso al comercio en su panel y como evento de la orden;
  - `responder` firma la transacción `respond` con wallet-kit (Freighter o xBull) dentro del plazo y deja de bajar un archivo; el documento de la respuesta se publica junto a la orden y la red guarda su hash;
  - el árbitro lee la respuesta de la orden y comprueba su hash contra la red.
- **Hecho cuando:**
  - [ ] hay hash de una respuesta en plazo
  - [ ] hay hash de una respuesta tardía rechazada
  - [ ] el árbitro decide con la respuesta sin intercambiar archivos

#### T164 · El despacho abre la ventana de liberación
- **Estimación:** 6 h · **Delegable a Codex:** no · **Depende de:** T160
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/order-events.ts`
- **Descripción:** cuando la orden pasa a `shipped` (Shopify, T147), la tienda llama `mark_shipped`, y una tarea de la tienda llama `release` al vencer la ventana. Jumpseller no informa despachos (`R-17`) y queda documentado.
- **Hecho cuando:**
  - [ ] un despacho marcado en Shopify abre la ventana (hash)
  - [ ] la liberación ocurre sola al vencer (hash)

#### T165 · Cada cambio de la disputa llega al agente
- **Estimación:** 6 h · **Delegable a Codex:** no · **Depende de:** T162–T164
- **Archivos principales:** `packages/vitrinee-gateway/src/ucp/order-events.ts`, `orders.ts`
- **Descripción:** eventos `dispute.opened`, `dispute.responded`, `dispute.resolved`, `escrow.released` y `escrow.refunded` en la cola de webhooks firmados (RFC 9421). El receptor de agentpey.com los verifica.
- **Hecho cuando:**
  - [ ] hay un **registro de avisos entregados y verificados** para una disputa completa
  - [ ] la suite UCP sigue igual o mejor (hoy 49/8/20)

### Semana 4 (3–11 nov) · D3

#### T166 · Corrida completa y QA
- **Estimación:** 8 h · **Delegable a Codex:** no · **Depende de:** T157–T165
- **Descripción:** la compra entera en testnet: Claude busca → paga dentro de sus topes → pedido → retenido → despacho → reclamo desde el chat → aviso y respuesta → veredicto → reembolso. Se corrigen los errores que aparezcan y se congela el código. Antes de correr, aviso al usuario para que el chat de la Fase 8 no mergee.
- **Hecho cuando:**
  - [ ] la corrida completa está en `evidencia/T166.md`, con cada hash
  - [ ] `pnpm check` y `cargo test` están en verde

#### T167 · Video, mapa de tiempos e informe final
- **Estimación:** 6 h (el usuario graba) · **Delegable a Codex:** no · **Depende de:** T166
- **Descripción:** guion de la corrida, video narrado, mapa "minuto → paso → hash en Stellar Expert", informe final para el líder del capítulo.
- **Hecho cuando:**
  - [ ] el video está grabado
  - [ ] el mapa de tiempos está completo
  - [ ] el informe final está entregado

**Total estimado:** unas 88 h en 30 días.

## 6. Criterios de aceptación de la fase (la evidencia que se prometió)

| Entregable | Evidencia | Tareas |
|---|---|---|
| D1 | Contract ID en Stellar Expert; hashes de un pago retenido, liberado y reembolsado; un recibo duplicado rechazado | T157–T161 |
| D2 | Grabación de un reclamo desde el chat; hashes de la disputa abierta y resuelta; registro de avisos entregados | T162–T165 |
| D3 | Video, mapa de tiempos con hashes, historial en Stellar Expert | T166–T167 |

## 7. Plan de demo

La corrida de T166 en `agentcommerce` (Shopify), desde Claude con el MCP de `mcp.agentpey.com`, con ventanas de
minutos (`X-6`). El usuario la graba en T167. Cada push a `main` despliega en Render: antes de correr o grabar se
avisa para que el chat de la Fase 8 no mergee.

## 8. Orden, fechas y cortes

| Semana | Tareas |
|---|---|
| 1 (13–19 oct) | Chequeo 4.5, T157, T159 |
| 2 (20–26 oct) | T160, T158, T161 (`X-21`) |
| 3 (27-oct – 2-nov) | T162, T163, T164, T165 |
| 4 (3–11 nov) | T166, T167 |

**Línea de corte:** si al final de la semana 3 falta algo, se corta primero T165 y después T161. **D1 y la corrida
de D3 no se cortan.**

**Convivencia con el cierre de la Fase 8.** Las dos fases están en curso. Esta fase es dueña de `contracts/*`, el
contrato nuevo y `deployments/*.json`; de `apps/mcp/src/shopper.ts` y `tools.ts` (`open_claim`); de
`packages/resolve/`, `scripts/resolve*` y `apps/web/public/resolve/`; y en `packages/vitrinee-*`, del `payTo`, `hold`,
los webhooks y el despacho. La Fase 8 es dueña de `docs/fase-8-agentes-reales/*` y del borrador del SEP. Son
compartidos `ESTADO.md`, `AGENT_LOG.md`, `ROADMAP.md`, `CLAUDE.md`, `SYNC.md` y `docs/DECISIONES.md`: antes de cada
push, `git fetch` y rebase sobre `origin/main`. El rail del MCP (tope 5 USDC por día) es compartido.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| El facilitator no acepta `payTo` contrato | Chequeo del día 1 (4.5), con plan B: liquidar directo |
| Una tienda registra en `hold` plata que no llegó | Chequeo de saldo no asignado + `tx_hash` único; un escrow por tienda, así que no puede tomar un pago ajeno (`X-11`) |
| Una tienda declara escrow pero cobra directo, o declara un contrato falso | El agente rechaza antes de firmar: `payTo` = contrato declarado y wasm conocido (`X-9`) |
| El escrow rompe compras o disputas existentes | Escrow opcional por tienda; handler y recibo `2026-09-30` siguen válidos; `agent-resolve` y `receipt-registry` intactos; tests de regresión con recibos viejos |
| El rail del MCP llega a su tope diario (5 USDC) | Compras de la demo baratas; el chat de la Fase 8 no compra sin preguntar |
| Jumpseller no informa despachos | Demo en `agentcommerce` (Shopify); Jumpseller documentado |
| Trabajo para una sola persona, con un día de atraso | Línea de corte de la sección 8 |

## 10. Preguntas abiertas

- [x] Las diez decisiones del borrador y tres nuevas (`X-1` a `X-13`): respondidas por el usuario el 14-oct, todas como se recomendaron
- [x] ¿El spec puede nombrar el Instaward? **Sí**, decidido por el usuario el 14-oct
- [x] Prefijo de decisiones y carpeta: `X-` y `docs/fase-9-compra-protegida/`, decidido por el usuario el 14-oct
- [x] Resultado del chequeo del día 1 (4.5): el facilitator acepta un `payTo` contrato (`X-14`), corrido con el OK del usuario el 14-oct

## 11. Registro de cambios del spec

| Fecha | Cambio |
|---|---|
| 2026-10-14 | Borrador a partir del plan del 7-oct (tareas renumeradas a T157–T167), verificado contra el código: dos cuentas de comercio, `pay_to` solo `G…` hoy, un escrow por tienda, mensaje corto para `open`, comprobación del wasm del escrow. Decisiones `X-1` a `X-13` respondidas por el usuario |
| 2026-10-14 | **Aprobado** por el usuario, sin cambios en las tareas. Tickets T157 a T167 en Exponential |
| 2026-10-14 | Chequeo del día 1 con OK del usuario: el facilitator liquida hacia un contrato (`X-14`) |
| 2026-10-14 | T157 en revisión: contrato `purchase-escrow` con 28 tests, desplegado para `agentcommerce` y como ensayo; un pago liberado y uno reembolsado en testnet. Precisiones aprobadas por el usuario: `X-15` a `X-18` |
| 2026-10-14 | `/revisar` de T157: reembolso no entregable como deuda cobrable y escrows redesplegados (`X-19`); el pago sin `hold` queda como límite, cubierto en T159 y T160 (`X-20`) |
| 2026-10-14 | Reorden aprobado por el usuario: T159 → T160 → T158, porque el veredicto necesita una compra real retenida con su recibo (`X-21`) |
| 2026-10-14 | T159 en revisión: recibo con `escrow`, cuarto chequeo «retenido», `hold` antes del anclaje; recibo duplicado rechazado por la red (`X-22`) |
| 2026-10-14 | T160 en revisión: handler `2026-10-15` con `pay_to` = escrow, las dos puertas cobran al escrow, el agente comprueba el escrow en la red antes de firmar y avisa si no hay `hold`, interruptor `COMERCIO_ESCROWS` (`X-23` a `X-25`). Criterios 2 y 3 demostrados; el 1 (compra real) después del merge |
| 2026-10-16 | T158 en revisión: el árbitro resuelve en el escrow las compras pagadas a un escrow; la disputa la abre el pagador, el plazo es el del contrato y el reembolso sale del pago retenido (`X-26`). Veredicto real con reembolso completo ejecutado |
| 2026-10-15 | T160 cerrada: mergeada ([PR #90](https://github.com/vicentewolde/AgentPey/pull/90)), escrow encendido en `agentcommerce` con `VITRINEE_COMERCIO_ESCROWS` y una compra real retenida en el escrow |

---

## Anexo A · Texto enviado al Instaward (7-oct-2026), sin cambios

**Project scope:** AgentPey · USD 4,000 · start 13-10-2026 · supporting docs: github.com/vicentewolde/AgentPey, agentpey.com, apps/mcp/README.md.

**Problem statement & objective:**
AI agents are starting to shop. Google's Universal Commerce Protocol (UCP), co-developed with Shopify, Walmart and Target and backed by Visa and Mastercard, defines how an agent finds, buys and tracks a product. AP2 defines the signed mandate, and x402, documented by Stellar, moves the money.
AgentPey already has every piece of an agent purchase working on Stellar testnet: Claude and ChatGPT buy from a real Shopify store within on-chain spending limits, receipts are signed and anchored, shipping is tracked, and disputes are resolved on-chain. But they run as separate pieces. The payment goes straight to the merchant while refunds come from a separate deposit, a claim made in the chat is still opened by hand, shipping does not affect the payment, and nothing on-chain ties a receipt to its payment.
This sprint does not introduce new ideas. It connects these pieces into one protected purchase: the buyer's payment is held until delivery, a claim from the chat reaches the merchant and resolves on-chain, and the refund comes from the held payment. It will be recorded end to end, with every step mapped to a Stellar transaction.

**Deliverables:**
1. *Payment and post-sale, connected on-chain.* The checkout pays into an escrow instead of straight to the merchant, and the dispute verdict releases or refunds that same payment, with deadlines enforced by the contract. Each receipt is bound to its payment: one payment, one receipt. Evidence: contract IDs on Stellar Expert; transaction hashes of a payment held, released and refunded, and of a duplicate receipt rejected.
2. *Chat, merchant and shipping in one post-sale flow.* A claim made from Claude or ChatGPT opens the dispute on-chain. The merchant is notified and answers from its page, a shipping event starts the release window, and every dispute update reaches the agent as a notification. Evidence: a recording of a claim made from the chat; transaction hashes of the dispute opened and resolved; the log of delivered notifications.
3. *One protected purchase, recorded end to end.* On testnet, Claude finds the product and pays within its limits, the order is created, the payment waits in escrow, the item ships, a claim is opened from the chat and the refund arrives from the held payment. A narrated video and a timestamp map that links each step to its transaction. Evidence: the video, the timestamp map and the transaction history on Stellar Expert.

**Out of scope:** mainnet or real money; onboarding real merchants or buyers; fiat or card rails or activity regulated in Chile; new product areas; external arbitration or other third-party integrations; new store platforms; an external security audit; mobile apps and app-directory listings.

**Budget:** D1 USD 1,800 · D2 USD 1,200 · D3 USD 400 · Infrastructure and tooling USD 600 (always-on hosting and database, Soroban RPC, domains, development tools). Team work 85% · infrastructure 15%.

**30-day plan:**
- **Week 1:** escrow contract (hold, release, refund, deadlines), connected to the dispute verdict, with tests, on testnet.
- **Week 2:** receipts bound to payments; checkout pays into the escrow; store and verifier connected; first purchase held in escrow.
- **Week 3:** claim from the chat opens the dispute on-chain; merchant notified and answering from its page; shipping starts the release window; dispute updates sent to the agent.
- **Week 4:** full end-to-end run, QA, narrated demo, timestamp map, final review with the Ambassador Chapter Lead.

**After the sprint:** Apply to SCF Build Award.
