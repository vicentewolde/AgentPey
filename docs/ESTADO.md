# Estado del proyecto

> La memoria de trabajo entre sesiones (`P-15`). `/estado` lo lee al empezar y
> `/tarea` lo actualiza al terminar. Se mantiene corto: la narrativa vive en la
> `BITACORA.md` de la fase, la coordinación con Codex en `AGENT_LOG.md` y el
> tablero visual en Exponential (`planificacion-exponential/SYNC.md`).

**Actualizado:** 2026-10-02
**Fase actual:** Fase 7 · Estándar de comercio agéntico sobre Stellar ([spec](fase-7-estandar-comercio-agentico/SPEC.md), **aprobado**)
**Última tarea terminada:** T123 · el Mandato exportado como mandatos AP2 v0.2, verificado por la librería oficial de AP2
**Siguiente paso:** T126 (respuesta del comercio, `E-20` a `E-22`) del 2 al 6 de octubre, T127 (la disputa en la orden UCP, `E-23`, `E-24`) del 6 al 7 con deploy antes del 8. El 8 o 9, el reembolso real de T124 en una rama de evidencia aparte. Después: criterios de la Fase 7, cerrar la Fase 6 y el plan de demo del 11-oct

## Progreso de la fase

| Tarea | Prioridad | Estado | Rama / PR |
|---|---|---|---|
| T120 Prueba técnica: payment handler de Stellar en UCP | imprescindible | ✅ terminada | `cc/t120-handler-stellar-ucp`, mergeada |
| T121 Vitrinee publica `/.well-known/ucp` por comercio | imprescindible | ✅ terminada | `cc/t121-vitrinee-perfil-ucp`, mergeada |
| T122 Compra UCP pagada sobre Stellar, de punta a punta | imprescindible | ✅ terminada | `cc/t122-compra-ucp-stellar`, `cc/t122-evidencia`, mergeadas |
| T123 Mandato exportable como mandatos AP2 | si alcanza | ✅ terminada | `cc/t123-mandatos-ap2`, mergeada ([PR #34](https://github.com/vicentewolde/AgentPey/pull/34)) |
| T124 Disputas v0 (AgentResolve) | si alcanza | 🔨 en `main`, cuatro de cinco criterios; falta el reembolso real (8–9 oct), en una rama de evidencia aparte | `cc/t124-agentresolve`, mergeada |
| T125 Anexo técnico para el SEP | al final | ✅ terminada | `cc/t125-anexo-sep`, mergeada |
| T126 Respuesta del comercio en AgentResolve | antes del 8-oct | 👀 en `main`, seis de siete criterios; falta el ensayo con Freighter | `cc/t126-respuesta-comercio`, mergeada ([PR #36](https://github.com/vicentewolde/AgentPey/pull/36)) |
| T127 La disputa visible en la orden UCP | si alcanza | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · 👀 en revisión · ✅ terminada · ⛔ bloqueada · ✂️ cortada

## Bloqueos y pendientes del usuario

- [ ] Tras el merge de T126: ensayo con Freighter. Firmar en `agentpey.com/resolve/responder` una respuesta sobre el reclamo de T122 con la cuenta de cobro de `agentcommerce` (`GD2MC…`) y enviar el archivo
- [ ] 8 o 9 de octubre: confirmar si el pedido Shopify `18952373174578` sigue sin despacho, y después confirmar el hash del veredicto (`E-18`); el mismo día, responder como comercio desde la página


## Deuda y pendientes fuera de la fase

- T123 (brecha 14 del anexo): la misma intención se puede exportar a AP2 más de una vez mientras no vence. Cada par está acotado al mismo tope y a la vida de la intención. Hacerlo cumplir pide memoria por `intentId`.

- T126 (`/revisar`, sugerencias que quedaron): `freighter-api` se carga de unpkg sin `integrity` en `responder.html` (igual que `consent.html` y `revocar.html`; pesa más aquí porque Freighter solo muestra el hash de los descargos); y el cableado `merchantResponse` → `assertMayDecide` → `decideDispute` dentro de `scripts/resolve.ts` no tiene test propio (cada pieza sí).

- `C-154`: dos comercios en una cuenta, opción (a) aprobada. Toca autorización, no delegable. Después de la Fase 7.
- `C-160`: conectar más wallets que Freighter. Toca las tres pantallas de firma. Después de la Fase 7.
- Fase 6 sigue abierta en `ROADMAP.md`: no se cerró formalmente al abrir la Fase 7.

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
