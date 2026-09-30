# Estado del proyecto

> La memoria de trabajo entre sesiones (`P-15`). `/estado` lo lee al empezar y
> `/tarea` lo actualiza al terminar. Se mantiene corto: la narrativa vive en la
> `BITACORA.md` de la fase, la coordinación con Codex en `AGENT_LOG.md` y el
> tablero visual en Exponential (`planificacion-exponential/SYNC.md`).

**Actualizado:** 2026-09-30
**Fase actual:** Fase 7 · Estándar de comercio agéntico sobre Stellar ([spec](fase-7-estandar-comercio-agentico/SPEC.md), **aprobado**)
**Última tarea terminada:** T120 · UCP admite un payment handler x402 de Stellar; opción A elegida
**Siguiente paso:** el usuario decide `VT-36`; después `/revisar` de T121, merge y `/tarea T122`

## Progreso de la fase

| Tarea | Prioridad | Estado | Rama / PR |
|---|---|---|---|
| T120 Prueba técnica: payment handler de Stellar en UCP | imprescindible | ✅ terminada | `cc/t120-handler-stellar-ucp`, mergeada |
| T121 Vitrinee publica `/.well-known/ucp` por comercio | imprescindible | 👀 en revisión | `cc/t121-vitrinee-perfil-ucp` |
| T122 Compra UCP pagada sobre Stellar, de punta a punta | imprescindible | ⏳ pendiente | |
| T123 Mandato exportable como mandatos AP2 | si alcanza | ⏳ pendiente | |
| T124 Disputas v0 | si alcanza | ⏳ pendiente | |
| T125 Anexo técnico para el SEP | al final | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · 👀 en revisión · ✅ terminada · ⛔ bloqueada · ✂️ cortada

## Bloqueos y pendientes del usuario

- [ ] `VT-36`: montos de UCP como enteros JSON en la frontera (implementado así; la alternativa es `JSON.rawJSON`)
- [ ] Deploy de Vitrinee con T121 y publicar los archivos del handler en `agentpey.com`, para correr `vitrinee:ucp:list` contra una tienda real
- [ ] `deployments/testnet.json` tiene un cambio sin commitear desde el 28-sep (otro `policyRail`): decidir si se commitea o se descarta
- [ ] Antes de T124: qué hace el veredicto con la plata (a, b o c) y el nombre de las disputas

## Deuda y pendientes fuera de la fase

- `C-154`: dos comercios en una cuenta, opción (a) aprobada. Toca autorización, no delegable. Después de la Fase 7.
- `C-160`: conectar más wallets que Freighter. Toca las tres pantallas de firma. Después de la Fase 7.
- Fase 6 sigue abierta en `ROADMAP.md`: no se cerró formalmente al abrir la Fase 7.

## Notas de la última sesión

- 2026-09-30, T120: UCP **sí** admite un handler x402 de Stellar (`com.agentpey.stellar_x402`), con el pago dentro de `complete` y sin HTTP 402. El perfil no lleva productos: T121 es perfil más catálogo. Estimación: T121 16 h, T122 29 h (opción A). Hallazgo para T123: AP2 en UCP exige ECDSA y SD-JWT; el Mandato usa Ed25519.
- 2026-09-30: `P-14` (reposicionamiento: UCP, AP2 y x402 sobre Stellar) y `P-15` (método fase → spec → tareas, con `/estado`, `/tarea` y `/revisar`). Spec de la Fase 7 **aprobado** por el usuario, que también confirmó la extensión de Find Your Way. Exponential se mantiene como espejo.
- 2026-09-30: el usuario eligió opción A, UCP `2026-04-08`, sesión en moneda de la tienda y fulfillment mínimo (`E-1` a `E-4`). Sección 4 del spec completa.
- 2026-09-30: `/revisar` de T120 sin bloqueantes. Corregido: rutas UCP bajo `/ucp/v1`, evidencia de `per_tx` con script aparte, y las dos páginas de la spec que solo se habían leído vía resumen se releyeron del fuente (confirmadas).
- 2026-09-30, T121: perfil `/.well-known/ucp` y catálogo UCP (`/ucp/v1/catalog/search`, `lookup`, `product`) en cada tienda; spec y esquemas del handler y de la extensión de recibo; cliente `pnpm run vitrinee:ucp:list`. Validado contra los esquemas oficiales sin red. Encontrado un `$ref` roto en el esquema oficial del perfil.
