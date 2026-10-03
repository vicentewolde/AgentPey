# Estado del proyecto

> La memoria de trabajo entre sesiones (`P-15`). `/estado` lo lee al empezar y
> `/tarea` lo actualiza al terminar. Se mantiene corto: la narrativa vive en la
> `BITACORA.md` de la fase, la coordinación con Codex en `AGENT_LOG.md` y el
> tablero visual en Exponential (`planificacion-exponential/SYNC.md`).

**Actualizado:** 2026-10-03
**Fase actual:** Fase 8 · Agentes reales comprando en Stellar, y el estándar completo ([spec](fase-8-agentes-reales/SPEC.md), **aprobado**, `P-16`). La Fase 7 se cerró el 2026-10-03 (`E-25`)
**Última tarea terminada:** T132 · el verificador rechaza un recibo que se contradice, y un pago respalda un solo recibo
**Siguiente paso:** con la wallet del usuario y su OK, correr `mcp:setup` y desplegar el rail `mcp` en testnet; el usuario agrega `mcp.agentpey.com` en Render y el DNS, copia las variables y fondea el rail; `/revisar` y merge del PR 2; compra real desde Claude. El 8 o 9 de octubre, el reembolso real de T124 (`E-25`)

## Progreso de la fase

| Tarea | Prioridad | Estado | Rama / PR |
|---|---|---|---|
| T128 Servidor MCP de AgentPey | imprescindible | 🔨 en curso: PR 1 (herramientas y pago, en local) en `main`; PR 2 (OAuth, setup, gateway) en código, sin desplegar; falta correr el setup en testnet, el deploy y la compra desde Claude | PR 1 mergeado ([PR #45](https://github.com/vicentewolde/AgentPey/pull/45)); PR 2 en `cc/t128-mcp-oauth-deploy` |
| T129 Claude y ChatGPT conectados | imprescindible | ⏳ pendiente | |
| T130 Tienda de terceros real | imprescindible | ⏳ pendiente | |
| T131 Suite oficial de conformidad UCP | imprescindible | ⏳ pendiente | |
| T132 Coherencia del recibo (brecha 10) | imprescindible | ✅ terminada | `cc/t132-coherencia-recibo`, mergeada ([PR #44](https://github.com/vicentewolde/AgentPey/pull/44)) |
| T133 UCP `2026-08-25` | si alcanza | ⏳ pendiente | |
| T134 AP2 dentro del checkout UCP | si alcanza | ⏳ pendiente | |
| T135 MPP charge sobre Stellar (prueba técnica primero) | si alcanza | ⏳ pendiente | |
| T136 SDK publicado en npm | si alcanza | ⏳ pendiente | |
| T137 Kit de conformidad del medio de pago de Stellar | si alcanza | ⏳ pendiente | |
| T138 Prueba técnica: GenLayer | si alcanza | ⏳ pendiente | |
| T139 Prueba técnica: Trustless Work | si alcanza | ⏳ pendiente | |
| T140 Resolutor intercambiable | se corta primero | ⏳ pendiente, pide aprobación tras T138 o T139 | |
| T141 Página "Tiendas comprables por agentes" | para el video | ⏳ pendiente | |
| T142 Guion y grabación de la demo | imprescindible | ⏳ pendiente | |
| T143 Más wallets que Freighter (`C-160`) | si alcanza | ⏳ pendiente | |
| T144 dots, Muse y Grok Bot | si alcanza | ⏳ pendiente | |
| T145 Tesorería de equipos SCF (prueba técnica) | si alcanza | ⏳ pendiente | |
| T146 Demo de presupuesto de equipo | se corta segundo | ⏳ pendiente, pide aprobación tras T145 | |

Línea de corte (7-oct en la noche, si el Bloque A no está completo): T140, T146, T137, T144 (salvo dots), T136, T135, T134, T143.

Leyenda: ⏳ pendiente · 🔨 en curso · 👀 en revisión · ✅ terminada · ⛔ bloqueada · ✂️ cortada

## Bloqueos y pendientes del usuario

- [ ] Para T128: dar la dirección de la wallet de Freighter (principal del rail y la única que inicia sesión); agregar `mcp.agentpey.com` en Render y un CNAME `mcp` en el DNS; copiar a Render las variables `MCP_*` que deja `mcp:setup`; fondear el rail con USDC de testnet
- [ ] Para T130: conseguir la tienda de terceros. Para T144: confirmar si hay acceso a dots, Muse y Grok Bot
- [ ] Exportar el borrador del SEP a `docs/fase-8-agentes-reales/SEP-borrador.md`
- [ ] Fuera del código: publicar el borrador del SEP en GitHub Discussions de `stellar/stellar-protocol` y avisar en el Discord; enviar las preguntas a communityfund@stellar.org; escribirles a Trustless Work, Cards402 y ASGCard
- [ ] 8 o 9 de octubre: confirmar si el pedido Shopify `18952373174578` sigue sin despacho, y después confirmar el hash del veredicto (`E-18`); el mismo día, responder como comercio desde la página; después, comprobar que `ord_muq1gqhycf4961492c` muestra la disputa abierta y luego resuelta (cierra T127)


## Deuda y pendientes fuera de la fase

- T123 (brecha 14 del anexo): la misma intención se puede exportar a AP2 más de una vez mientras no vence. Cada par está acotado al mismo tope y a la vida de la intención. Hacerlo cumplir pide memoria por `intentId`.

- T126 (`/revisar`, sugerencias que quedaron): `freighter-api` se carga de unpkg sin `integrity` en `responder.html` (igual que `consent.html` y `revocar.html`; pesa más aquí porque Freighter solo muestra el hash de los descargos); y el cableado `merchantResponse` → `assertMayDecide` → `decideDispute` dentro de `scripts/resolve.ts` no tiene test propio (cada pieza sí).

- T127 (`/revisar`, sugerencias que quedaron): la orden no cruza `dispute.merchant` con la cuenta firmante de la tienda; el esquema de la extensión no exige `verdict_hash`, `refund_atomic` y `resolved_at` cuando `status` es `resolved`; cada GET de una orden anclada lee la red sin caché (una disputa resuelta es inmutable y se podría cachear); `zod` de `vitrinee-anchor` en `^4.5.4` frente a `^4.6.0` del resto.

- `C-154`: dos comercios en una cuenta, opción (a) aprobada. Toca autorización, no delegable. Después de la Fase 7.
- `C-160`: conectar más wallets que Freighter. Toca las tres pantallas de firma. Es T143 de la Fase 8.
- Brecha 10 del anexo: la coherencia quedó hecha en T132; lo que sigue abierto es que `receipt-registry` no guarda el hash de la transacción (pide un contrato nuevo, fuera de alcance). Brecha 14: es parte de T134.
- T128 (`/revisar` del PR 1, sugerencias que quedaron): un pago incierto no se reintenta con la misma clave (la cotización ya se consumió); `recheck` apagado por defecto en `payUcpQuote`; la relectura no compara el id del checkout; una cotización con fecha inválida no vence; la tienda por primera etiqueta no avisa ambigüedad; `open_claim` no comprueba que el rail del MCP pagó el recibo (el árbitro sí); total 0 si la tienda no manda línea `total`; `start` apunta a `main.ts` (llega en el PR 2) y tres dependencias sin usar; tests con `any`.
- T132: `signReceipt` todavía lanza un error de zod, no un `VitrineeError`, cuando los datos no cumplen el esquema (ya era así). Y "un pago, un recibo" vale dentro de un proceso: `vitrinee.orders` no tiene índice único sobre el hash del pago (`VT-40`); hace falta si un comercio llega a tener más de un proceso.
- **Sin fase** (`C-161`, cierre de la Fase 6): AgentGuard (sin alcance), evaluación de mainnet, modelo de cobro (la publicación en npm entró en la Fase 8, `P-16`). Y la meta "Primer partner piloto real": el criterio de salida de F9 (una persona ajena completa sola el recorrido) quedó sin cumplir.
- Fase 6 (`C-161`): `C-122` (MPP Session) y `C-130` pendientes, `C-156` en investigación; mejora anotada en T117 (revisar el saldo de XLM antes de pedir la firma).

## Notas de la última sesión

- 2026-09-30, T120: UCP **sí** admite un handler x402 de Stellar (`com.agentpey.stellar_x402`), con el pago dentro de `complete` y sin HTTP 402. El perfil no lleva productos: T121 es perfil más catálogo. Estimación: T121 16 h, T122 29 h (opción A). Hallazgo para T123: AP2 en UCP exige ECDSA y SD-JWT; el Mandato usa Ed25519.
- 2026-09-30: `P-14` (reposicionamiento: UCP, AP2 y x402 sobre Stellar) y `P-15` (método fase → spec → tareas, con `/estado`, `/tarea` y `/revisar`). Spec de la Fase 7 **aprobado** por el usuario, que también confirmó la extensión de Find Your Way. Exponential se mantiene como espejo.
- 2026-09-30: el usuario eligió opción A, UCP `2026-04-08`, sesión en moneda de la tienda y fulfillment mínimo (`E-1` a `E-4`). Sección 4 del spec completa.
- 2026-09-30: `/revisar` de T120 sin bloqueantes. Corregido: rutas UCP bajo `/ucp/v1`, evidencia de `per_tx` con script aparte, y las dos páginas de la spec que solo se habían leído vía resumen se releyeron del fuente (confirmadas).
- 2026-09-30, T121: perfil `/.well-known/ucp` y catálogo UCP (`/ucp/v1/catalog/search`, `lookup`, `product`) en cada tienda; spec y esquemas del handler y de la extensión de recibo; cliente `pnpm run vitrinee:ucp:list`. Validado contra los esquemas oficiales sin red. Encontrado un `$ref` roto en el esquema oficial del perfil.
- 2026-09-30: T121 desplegada y verificada en vivo: `vitrinee:ucp:list` lee el perfil UCP de `bazar-cordillera` y lista sus 6 productos; los documentos del handler se sirven en `agentpey.com/ucp/…`.
- 2026-10-01, T122: compra UCP real en `agentcommerce` (Shopify) pagada desde el rail UCP `CA6P4KKV…` (`E-5`): tx `06ff47cf…`, pedido Shopify `18946533884210`, recibo con los tres checks en verde. `per_tx` rechazado por el contrato (`#7`). `/revisar` encontró tres bloqueantes en el cobro, corregidos (`E-6`).
- 2026-10-01, T125: `ANEXO-SEP.md` con formatos, verificación del Mandato, contratos y nueve brechas para el SEP; `scripts/fase7-anexo.test.ts` lo mantiene alineado con el código y `deployments/`.
- 2026-10-01, T123: replanteo leído del fuente (AP2 `v0.2`, UCP `2026-04-08` y `2026-08-25`). El usuario eligió exportar y verificar fuera de línea, llaves Ed25519 existentes con chequeo P-256 de un uso, sin `perDay` ni revocación (`E-8` a `E-11`). Paquete `@agentpey/ap2`, `exportMandateAsAp2` en el agente, `pnpm run ap2:export`. Mandato real `874339dd…` exportado y verificado; la librería oficial de AP2 verifica el par en Ed25519 y en P-256. Corregido `E-9`: la librería solo exige P-256 al cerrar el mandato.
- 2026-10-01, T123 `/revisar`: un bloqueante (el tope iba en unidades de Stellar y AP2 lo lee en centavos) y cinco importantes, todos corregidos a pedido del usuario (`E-12`, `E-13`): tope en centavos y el menor de los cuatro límites, listas de AP2 no vacías, credencial verificada con `checkScope`, `cnf` fijo en la exportación real, `exp` ≤ intención. Exportación real repetida en testnet: Mandato `e5eae6ce…`, tope `300`, la librería oficial de AP2 verifica los dos pares.
- 2026-10-01, T124: AgentResolve (`E-14` a `E-19`). Contrato `agent-resolve` desplegado (`CCYMGX56…`), árbitro `GAEB2EG3…`, garantía de `agentcommerce` con 3 USDC. Reclamo real sobre el recibo de T122: Claude lo rechazó por prematuro, el usuario confirmó y quedó resuelto en la red sin pago. Corregido: veredicto final en el prompt e historial de veredictos. Compra nueva (`0922707…`) para el reembolso real el 8–9 oct.
- 2026-10-01, T124 `/revisar`: sin bloqueantes; corregidos los cuatro importantes y las ocho sugerencias a pedido del usuario. Sin fallback a otro modelo (`E-17`), brechas 18 y 19 en el anexo.
- 2026-10-02: el usuario eligió mergear T124 ya y dejar el reembolso real en una rama de evidencia aparte (como `cc/t122-evidencia`), para que T126 y T127 salgan de `origin/main`. El reembolso del 8 corre con el código de `main`.
- 2026-10-02: T126 y T127 agregadas al spec y aprobadas. El usuario eligió firma con Freighter desde la cuenta de cobro, página estática con archivo, 48 h para responder, ajuste UCP más campo `dispute`, y solo lo que está en la red (`E-20` a `E-24`). Los pedidos de la plataforma viven en Postgres desde T103: un deploy no los borra (la nota de `INSTRUCCIONES.md` quedó vieja; se corrige en T127).
- 2026-10-02, T126: el comercio responde en `agentpey.com/resolve/responder` (página estática más `responder.js`), firma con Freighter desde `merchantAccount` y devuelve un archivo; `resolve:decide -- --response` y `resolve:check-response`. El veredicto lleva `responseHash`; el de T122 sigue verificando. Un test fija que el mensaje de la página y el del verificador coinciden byte a byte. Brechas 15 (reescrita) y 20 en el anexo.
- 2026-10-02, T126 `/revisar`: sin bloqueantes. Corregidos, a pedido del usuario, los dos importantes (la página verifica la firma de Freighter en el navegador antes de dar el archivo; cada respuesta queda en `responses/<hash>.json` y `verify` la vuelve a hashear) y cuatro sugerencias (errores tipados, el monto en disputa sale de la red en las dos rutas, normalización de la firma, reclamo validado al leerlo).
- 2026-10-02: T126 cerrada. El usuario firmó con Freighter en `agentpey.com/resolve/responder` sobre el reclamo de T122 y `resolve:check-response` lo aceptó. Siguiente: T127.
- 2026-10-02, T127: `GET /ucp/v1/orders/{id}` lee la disputa de `agent-resolve` (`AgentResolveReader`, sin llave) y la muestra como ajuste UCP más `receipt.dispute`. Versión de la extensión sin cambios (`VT-37`); reembolso en CLP en el ajuste y exacto en USDC en el recibo (`VT-38`). Leído en testnet: la disputa de T122 decodifica igual que `resolve:verify`.
- 2026-10-02, T127 `/revisar`: sin bloqueantes. Corregidos los cuatro importantes (test del layout con tipos y durabilidad, test del timeout, error tipado, variable en `.env.vitrinee.example`) y dos sugerencias (id del contrato leído con zod sin tumbar la tienda si es inválido; disputas imposibles rechazadas al decodificar, para que un dato raro dé aviso y no 500).
- 2026-10-02: T127 en vivo. La orden UCP de T122 en `agentcommerce` muestra el ajuste `dispute` (`completed`, sin montos) y `receipt.dispute` (`resolved`, reembolso 0, veredicto `ff3ef9b0…`), y valida contra UCP y la extensión.
- 2026-10-02, ordenar la casa: criterios 1 a 3 de la Fase 7 marcados con evidencia (`evidencia/criterios-fase7.md`). **Fase 6 cerrada** (T32–T119, `C-161`): T101 cortada, criterio de salida de F9 sin cumplir y pasado a la meta "Primer partner piloto real", lo no construido sin fase, ramas viejas de Codex sin tocar. ROADMAP, CLAUDE.md y la bitácora de la Fase 6 al día.
- 2026-10-03: **Fase 7 cerrada** (T120–T127, `E-25`, decisión del usuario). Criterio 4 cumplido (con el anexo se escribió el borrador del SEP); criterios 1 y 2 repetidos hoy y `pnpm check` en verde. El reembolso real de T124 y la orden `ord_muq1…` de T127 pasan a la Fase 8 con fecha; el plan de demo pasa a T142.
- 2026-10-03, `/fase-plan 8`: `P-16` y spec de la Fase 8 **en borrador** (T128–T146, `R-1`). Leídas las fuentes: la suite de UCP paga con un medio de prueba y solo conoce `2026-04-08`; `@stellar/mpp` no admite una cuenta-contrato como pagador; la extensión de AP2 en UCP solo admite ES256/384/512; Claude y ChatGPT aceptan OAuth o sin autenticación; Cards402 y ASGCard solo en mainnet. Sección 4.1 del spec.
- 2026-10-03: spec de la Fase 8 **aprobado** por el usuario. Decisiones `R-2` a `R-6`: OAuth 2.1 desde el inicio, modo de conformidad solo local, MPP se documenta si no admite `policy_rail`, P-256 para AP2, y UCP `2026-04-08` en paralelo con `2026-08-25`. Tickets T128 a T146 creados en Exponential.
- 2026-10-03, T132: `receiptIncoherence` en `@vitrinee/core` (montos decimal y atómico iguales, `asset` confiado); `signReceipt` se niega a firmar y el check 1 sale en rojo (`VT-39`). Encontrada y cerrada una ventana real: dos solicitudes simultáneas con el mismo pago daban dos pedidos y dos recibos (`VT-40`). Los recibos de T122 y T124 siguen válidos. `pnpm check` y `vitrinee:check` en verde.
- 2026-10-03, T132 `/revisar`: sin bloqueantes. Corregidos los siete hallazgos a pedido del usuario: pedidos en curso indexados por comercio y no por store, test UCP concurrente, coherencia antes de crear el pedido en la plataforma, spec pública precisada, errores tipados con `SettlementUnaccounted` (`VT-41`), y el reintento x402 vuelve a guardar y anclar.
- 2026-10-03, T128 PR 1: `apps/mcp` con las seis herramientas sobre el SDK oficial v2 (fijado en 2.2.0 y 2.0.1: pnpm no deja instalar paquetes publicados hace menos de un día, y no se le agregó la excepción), `quoteUcpCheckout` y `payUcpQuote` con relectura de la tienda antes de pagar, cliente UCP en `@vitrinee/core`, `resolve:open -- --claim`. Decisiones `R-7` a `R-10`. 15 tests nuevos.
- 2026-10-03, T128 PR 1 `/revisar`: sin bloqueantes; corregidos los ocho importantes a pedido del usuario. El cliente UCP pasó a `@vitrinee/anchor` (core es sin I/O). `R-10` aprobada.
- 2026-10-03, T128 PR 2 en código: OAuth propio (`R-7`) con login de wallet, PKCE, tokens con audiencia y sin base de datos; `main.ts` verifica credencial y Mandato al arrancar; `mcp:setup`; perfil `mcp` del rail (no lo fondea el script: lo fondea la principal); `mcp.agentpey.com` en el gateway (no crítico, variables propias) y `render.yaml`. 18 tests en la app, 4 nuevos en el gateway.
