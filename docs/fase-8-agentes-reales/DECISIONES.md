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

**Lo que queda abierto.** Cómo se autentica el conector (pregunta abierta 1
del spec).
