# Bitácora — Fase 7 (Estándar de comercio agéntico sobre Stellar)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase empieza en T120.
> El tablero del día a día es [`docs/ESTADO.md`](../ESTADO.md); aquí queda la
> narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-09-30 · Spec aprobado. **T120 investigada**, esperando cuatro
decisiones del usuario. Nada de código todavía. **Sigue:** T121, una vez elegida
la opción.

| Tarea | Estado |
|---|---|
| T120 Prueba técnica | en revisión |
| T121 a T125 | pendientes |

## Apertura de la fase (2026-09-30)

El usuario decidió cambiar cómo se presenta AgentPey (`P-14`): en vez de
competir como "identidad y permisos para agentes", un terreno que en Stellar
ya tiene varios proyectos financiados, AgentPey hace funcionar sobre Stellar
los estándares de comercio que ya están ganando (UCP, AP2, x402) y les agrega
lo que les falta: el pago en Stellar, los recibos verificables, las tiendas de
Latinoamérica y las disputas.

El mismo día cambió la forma de trabajar (`P-15`): cada fase tiene un spec que
el usuario aprueba antes de que se escriba código, y cada sesión sigue el
ciclo `/estado`, `/tarea`, `/revisar` y merge.

## T120 · ¿Cabe un pago de Stellar dentro de UCP? (2026-09-30, en revisión)

**En lenguaje llano.** UCP es el idioma común que Google, Shopify y otros
definieron para que un agente compre en una tienda. La pregunta era si ese
idioma deja pagar con Stellar. La respuesta es sí: UCP permite que cualquiera
defina un "medio de pago" propio, siempre que publique sus reglas en su
dominio. El de AgentPey se llamaría `com.agentpey.stellar_x402` y sus reglas
vivirían en `agentpey.com`. El agente firma el pago con el mismo contrato con
límites de siempre y se lo entrega a la tienda al cerrar la compra; la tienda
lo cobra, crea el pedido y devuelve el recibo verificable dentro de la orden.

Tres sorpresas: el ida y vuelta "402" de x402 no existe dentro de UCP (el pago
viaja al cerrar la compra); la ficha de la tienda no lleva productos (el
catálogo se consulta aparte); y el checkout actual de Vitrinee no sirve de
puerta de entrada, aunque casi todo lo de adentro se reutiliza.

También apareció algo para más adelante: los mandatos AP2, tal como UCP los
pide, usan un tipo de firma distinto al de Stellar. T123 es más que "exportar".

Documento completo, con opciones y horas:
[T120-handler-stellar-ucp.md](T120-handler-stellar-ucp.md). Citas:
[evidencia/T120.md](evidencia/T120.md). No hay decisiones `E-` todavía: salen
de lo que elija el usuario.
