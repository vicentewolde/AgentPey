# Bitácora — Fase 8 (Agentes reales comprando en Stellar, y el estándar completo)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase empieza en T128.
> El tablero del día a día es [`docs/ESTADO.md`](../ESTADO.md); aquí queda la
> narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-10-03 · Fase abierta (`P-16`). **Spec en borrador**, a la
espera de las respuestas y la aprobación del usuario. No hay nada construido.

| Tarea | Estado |
|---|---|
| T128 Servidor MCP | pendiente |
| T129 Claude y ChatGPT conectados | pendiente |
| T130 Tienda de terceros | pendiente |
| T131 Suite de conformidad UCP | pendiente |
| T132 Coherencia del recibo | pendiente |
| T133 UCP `2026-08-25` | pendiente |
| T134 AP2 en el checkout | pendiente |
| T135 MPP charge (prueba técnica) | pendiente |
| T136 SDK en npm | pendiente |
| T137 Kit de conformidad de Stellar | pendiente |
| T138 Prueba técnica: GenLayer | pendiente |
| T139 Prueba técnica: Trustless Work | pendiente |
| T140 Resolutor intercambiable | pendiente (pide aprobación) |
| T141 Página de tiendas | pendiente |
| T142 Guion y grabación | pendiente |
| T143 Más wallets | pendiente |
| T144 dots, Muse y Grok Bot | pendiente |
| T145 Tesorería de equipos (prueba técnica) | pendiente |
| T146 Demo de presupuesto de equipo | pendiente (pide aprobación) |

Heredado de la Fase 7 (`E-25`), con fecha: el reembolso real de T124 y ver
`ord_muq1gqhycf4961492c` con su disputa, el 8 o 9 de octubre.

## Apertura de la fase (2026-10-03)

La Fase 7 dejó la compra por UCP funcionando, pero hecha desde un programa
propio y en la tienda del usuario. Lo que el jurado de Find Your Way ve es un
video, y en ese video tiene que aparecer un agente que la gente conoce
(Claude) comprando en una tienda ajena. El usuario abrió la Fase 8 para eso
(`P-16`), y para llegar al video pudiendo decir, con evidencia, qué cumple
AgentPey de UCP, de AP2 y de MPP.

Al planificar se leyeron las fuentes oficiales y el código, y varias tareas
del traspaso cambiaron de forma: la suite oficial de UCP no se puede correr
contra una tienda real tal cual, MPP en Stellar hoy no acepta como pagador una
cuenta con límites, y UCP solo admite un tipo de llave para los mandatos AP2.
El detalle está en la sección 4.1 del spec.
