# Estado del proyecto

> La memoria de trabajo entre sesiones (`P-15`). `/estado` lo lee al empezar y
> `/tarea` lo actualiza al terminar. Se mantiene corto: la narrativa vive en la
> `BITACORA.md` de la fase, la coordinación con Codex en `AGENT_LOG.md` y el
> tablero visual en Exponential (`planificacion-exponential/SYNC.md`).

**Actualizado:** 2026-09-30
**Fase actual:** Fase 7 · Estándar de comercio agéntico sobre Stellar ([spec](fase-7-estandar-comercio-agentico/SPEC.md), **borrador**)
**Última tarea terminada:** T119 (Fase 6) · tope de cuentas patrocinadas de 20 a 40
**Siguiente paso:** el usuario aprueba el spec de la Fase 7; después `/tarea T120`

## Progreso de la fase

| Tarea | Prioridad | Estado | Rama / PR |
|---|---|---|---|
| T120 Prueba técnica: payment handler de Stellar en UCP | imprescindible | ⏳ pendiente | |
| T121 Vitrinee publica `/.well-known/ucp` por comercio | imprescindible | ⏳ pendiente | |
| T122 Compra UCP pagada sobre Stellar, de punta a punta | imprescindible | ⏳ pendiente | |
| T123 Mandato exportable como mandatos AP2 | si alcanza | ⏳ pendiente | |
| T124 Disputas v0 | si alcanza | ⏳ pendiente | |
| T125 Anexo técnico para el SEP | al final | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · 👀 en revisión · ✅ terminada · ⛔ bloqueada · ✂️ cortada

## Bloqueos y pendientes del usuario

- [ ] Aprobar el spec de la Fase 7 (bloquea T120)
- [ ] Confirmar si Find Your Way se extendió más allá del 30-sep
- [ ] `deployments/testnet.json` tiene un cambio sin commitear desde el 28-sep (otro `policyRail`): decidir si se commitea o se descarta
- [ ] Antes de T124: qué hace el veredicto con la plata (a, b o c) y el nombre de las disputas

## Deuda y pendientes fuera de la fase

- `C-154`: dos comercios en una cuenta, opción (a) aprobada. Toca autorización, no delegable. Después de la Fase 7.
- `C-160`: conectar más wallets que Freighter. Toca las tres pantallas de firma. Después de la Fase 7.
- Fase 6 sigue abierta en `ROADMAP.md`: no se cerró formalmente al abrir la Fase 7.

## Notas de la última sesión

- 2026-09-30: `P-14` (reposicionamiento: UCP, AP2 y x402 sobre Stellar) y `P-15` (método fase → spec → tareas, con `/estado`, `/tarea` y `/revisar`). Spec de la Fase 7 en borrador. Exponential se mantiene como espejo.
