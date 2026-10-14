# Bitácora — Fase 9 (Una compra protegida, de punta a punta)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase usa T157 a T167
> (reserva hasta T170). El tablero del día a día es [`docs/ESTADO.md`](../ESTADO.md);
> aquí queda la narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-10-14 · Fase abierta (`P-19`), en paralelo con el cierre de la Fase 8. **Spec aprobado** por el
usuario el 14-oct, con sus decisiones `X-1` a `X-13`. **Chequeo del día 1 hecho:** el facilitator x402 liquida un
pago hacia un contrato, así que el pago al escrow puede ir por el mismo camino que hoy (`X-14`). Siguiente: T157, el
contrato de escrow.

## Progreso

| Tarea | Estado |
|---|---|
| Chequeo del día 1 | ✅ hecho (`X-14`) |
| T157 Contrato de escrow | ⏳ pendiente |
| T158 El veredicto actúa sobre el pago retenido | ⏳ pendiente |
| T159 Un pago, un recibo, en la red | ⏳ pendiente |
| T160 El checkout paga al escrow | ⏳ pendiente |
| T161 La orden muestra el estado del escrow | ⏳ pendiente |
| T162 El reclamo desde el chat abre la disputa en la red | ⏳ pendiente |
| T163 El comercio recibe el aviso y responde desde su página | ⏳ pendiente |
| T164 El despacho abre la ventana de liberación | ⏳ pendiente |
| T165 Cada cambio de la disputa llega al agente | ⏳ pendiente |
| T166 Corrida completa y QA | ⏳ pendiente |
| T167 Video, mapa de tiempos e informe final | ⏳ pendiente |

---

## 2026-10-14 · Apertura de la fase y chequeo del día 1

**Qué quedó funcionando, en llano.** La fase tiene su plan aprobado: once tareas para que una compra hecha por un
agente quede protegida de punta a punta, con el pago retenido en un contrato hasta el despacho y el reembolso
saliendo de ese mismo pago. Antes de escribir el contrato se probó lo único que podía tumbar el diseño: si el
servicio que liquida los pagos x402 acepta pagarle a un contrato en vez de a una cuenta. Lo acepta: 0,01 USDC de
testnet llegaron a un contrato propio, y siguen siendo del usuario.

**Qué cambió del plan del 7-oct al leer el código.** La tienda tiene dos cuentas (una que firma y otra que cobra),
así que el contrato distingue quién registra la compra de quién la cobra (`X-4`). Un contrato compartido entre
tiendas habría dejado que una tienda tomara un pago ajeno, así que hay uno por tienda (`X-11`). El agente comprueba,
además del destino, que el contrato sea el escrow conocido y no una imitación (`X-9`).

**Evidencia.** [`evidencia/chequeo-dia-1.md`](evidencia/chequeo-dia-1.md): transacción
`84611558ffea12348a87aa23f9428749efcbba74e30f0d3bae04d61841cb077f`, efecto `contract_credited` sobre
`CBDRI5B7…D3YA`.
