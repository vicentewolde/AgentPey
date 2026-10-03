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

**Fecha:** 2026-10-03 · Fase abierta (`P-16`). **Spec aprobado** por el usuario
el 3-oct, con sus decisiones `R-1` a `R-6`. **T132 en revisión**: el
verificador rechaza un recibo que se contradice y la tienda no emite dos
recibos sobre un pago. Sigue T128 (el servidor MCP).

| Tarea | Estado |
|---|---|
| T128 Servidor MCP | pendiente |
| T129 Claude y ChatGPT conectados | pendiente |
| T130 Tienda de terceros | pendiente |
| T131 Suite de conformidad UCP | pendiente |
| T132 Coherencia del recibo | en revisión |
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

## T132 · Un recibo que no se contradice (2026-10-03, en revisión)

**Qué quedó funcionando.** Un recibo de Vitrinee dice cuánto se pagó de dos
maneras: en un número con decimales, que es el que lee una persona, y en
unidades enteras, que es el que se compara con la red. Hasta hoy nadie miraba
que los dos dijeran lo mismo, ni que el recibo nombrara el mismo USDC que el
verificador busca en el pago. Un recibo podía mostrar "0,94 USDC" a quien lo lee
y pasar los tres checks por 9,46. Ahora ese recibo sale inválido, con el motivo
escrito, y la tienda se niega a firmarlo.

Lo segundo: un pago respalda un solo recibo. La tienda ya lo cuidaba cuando el
mismo pago llegaba dos veces seguidas, pero no cuando llegaba dos veces al mismo
tiempo. Un test nuevo lo reprodujo: salían dos pedidos y dos recibos. Quedó
cerrado: la segunda solicitud espera y recibe el pedido de la primera.

**Por qué así.** Siguen siendo tres checks: el recibo incoherente falla el
primero, que ahora es "firma y contenido" (`VT-39`). Y la unicidad la garantiza
la tienda, no el verificador (`VT-40`): el único que podría firmar dos recibos
sobre un pago es el comercio, y un tercero no tiene cómo notarlo mientras el
registro en la red no guarde el hash del pago.

**Lo que no hace.** No impide, en la red, que un comercio deshonesto ancle dos
recibos sobre un mismo pago. Eso pide un contrato nuevo y quedó escrito como
brecha 10 del anexo. Tampoco comprueba que la suma de los ítems sea el total.

**La revisión.** `/revisar` no encontró bloqueantes y sí un caso que se me había
pasado: si el dueño edita su tienda justo mientras se procesa una compra, la
plataforma arma una tienda nueva que no sabía del pedido en curso, y el mismo
pago podía dar dos recibos. Corregido, junto con los otros seis hallazgos
(`VT-41`). Queda un límite escrito: la garantía vale dentro de un proceso, la
base de datos todavía no la respalda.

**Lo que falta.** El merge, que despliega Vitrinee y publica el
cambio en la spec de la extensión de recibo. Evidencia en
[`evidencia/T132.md`](evidencia/T132.md).

