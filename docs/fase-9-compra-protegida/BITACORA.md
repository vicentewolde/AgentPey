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
contrato de escrow, **cerrada** ([PR #88](https://github.com/vicentewolde/AgentPey/pull/88)): el contrato está en testnet, con un pago liberado y uno reembolsado de verdad. T159 cerrada ([PR #89](https://github.com/vicentewolde/AgentPey/pull/89)), en producción desde las 21:46 UTC. Orden nuevo, aprobado por el usuario: T159 → T160 → T158 (`X-21`). **T160 en revisión**: el código está listo y
probado sin red; falta `/revisar`, el merge con OK del usuario y, ya en producción, encender el escrow de
`agentcommerce` y hacer la compra real.

## Progreso

| Tarea | Estado |
|---|---|
| Chequeo del día 1 | ✅ hecho (`X-14`) |
| T157 Contrato de escrow | ✅ terminada |
| T158 El veredicto actúa sobre el pago retenido | ⏳ pendiente, después de T160 (`X-21`) |
| T159 Un pago, un recibo, en la red | ✅ terminada |
| T160 El checkout paga al escrow | 👀 en revisión; falta la compra real después del merge |
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

---

## 2026-10-14 · T157 · El contrato de escrow

**Qué quedó funcionando, en llano.** Existe en la red el contrato que guarda la plata de una compra hasta que la tienda
despacha. Si nadie reclama, la plata pasa sola a la tienda cuando vence el plazo. Si el comprador reclama, la plata
queda congelada hasta que el árbitro decide, y si el árbitro no decide a tiempo, vuelve completa al comprador. Para
reclamar no hace falta pedirle nada al árbitro: basta la firma de quien pagó. Se probó con dos compras de 0,05 USDC
de testnet: una terminó en la tienda y la otra volvió al rail que la pagó.

**Lo que hay que saber.** Hay dos contratos con el mismo código: el de `agentcommerce`, que usará la tienda desde T160,
y uno de ensayo con llaves del repo, porque la llave que firma por `agentcommerce` está solo en producción (`X-17`).
En el camino se precisaron cuatro cosas, todas aprobadas por el usuario: hasta cuándo se puede reclamar (`X-15`), que
un comprador con cuenta clásica también pueda reclamar (`X-16`), el ensayo (`X-17`) y el mensaje exacto que firma el
dueño del rail (`X-18`), que Rust y TypeScript comparten con un vector de prueba.

**Lo que corrigió la revisión.** Si un comprador que pagó desde una cuenta clásica quitaba después su permiso para
recibir USDC, un reembolso podía dejar la plata trabada para siempre. Ahora la compra se cierra igual, la tienda cobra
su parte y el reembolso queda guardado para el comprador, que lo recibe cuando vuelva a poder (`X-19`). Como un
contrato desplegado no se puede cambiar, se desplegaron de nuevo los dos escrows y se repitió el ensayo; los
anteriores quedaron registrados como retirados, sin plata. Un pago que llega y la tienda nunca registra queda como
límite conocido, que cubren T159 y T160 (`X-20`).

**Evidencia.** [`evidencia/T157.md`](evidencia/T157.md): 35 tests del contrato, los despliegues vigentes, y los hashes
del pago liberado (`81f106e0…` → `61ab6640…`) y del reembolsado (`97e71975…` → `3ef3185f…`).

---

## 2026-10-14 · Reorden: T158 pasa después de T160

Al planificar T158 apareció que el árbitro solo puede decidir sobre una compra con un recibo válido, y que todavía
ninguna compra real paga al escrow. El usuario eligió cambiar el orden: primero T159 (atar el recibo a su pago) y T160
(que el checkout pague al escrow), y después T158, con una compra de verdad (`X-21`). El entregable D1 sigue cerrando
al final de la semana 2.

## 2026-10-14 · T159 · Un pago, un recibo, en la red

**Qué quedó funcionando, en llano.** Cuando una tienda cobra a través de su escrow, el recibo dice en qué escrow
quedó la plata, y la tienda registra la compra en el contrato justo después del pago. Desde ahí la red no deja que
ese mismo pago respalde un segundo recibo: se probó con dinero de testnet, y la red rechazó el segundo. Cualquiera que
verifique un recibo comprueba además ese vínculo: si el recibo apunta a otro pago, o a un escrow de otra tienda, sale
inválido y dice por qué. Las tiendas que cobran directo no cambian, y sus recibos anteriores siguen verificando. La
tienda todavía no cobra al escrow; eso se enciende en T160.

**Evidencia.** [`evidencia/T159.md`](evidencia/T159.md): el recibo duplicado rechazado
(`87a80cc1…`, error `PaymentAlreadyHeld`), el chequeo "retenido" contra el escrow real y nueve recibos anteriores
válidos con el código nuevo.

## 2026-10-14 · T160 · El checkout paga al escrow (en revisión)

**Qué quedó funcionando, en llano.** Una tienda ya puede cobrar a su escrow en vez de a su cuenta. Lo anuncia en su
perfil con una versión nueva del medio de pago, que dice qué contrato guarda la plata, a qué cuenta la entrega y
quién arbitra. Antes de firmar, el agente lee ese contrato en la red y paga solo si:
- corre el código del escrow que conoce;
- su árbitro es el de AgentResolve;
- entrega la plata a la misma cuenta que AgentPey ya tenía registrada para esa tienda.

Una tienda tramposa (otro contrato, el escrow viejo, el de otra tienda) se rechaza sin firmar nada; se probó contra
contratos reales de testnet. La tienda también se revisa a sí misma: si su escrow no es suyo, no abre, y nunca vuelve a
cobrar directo a escondidas. Después de pagar, el agente confirma que la tienda registró la compra en el escrow y avisa
si no. En el chat, la cotización dice que la plata queda retenida hasta el despacho.

**Lo que no cambia.** Las tiendas sin escrow publican y cobran exactamente igual, y la suite oficial de UCP da lo mismo
que antes (49 · 8 · 20). El recibo sigue nombrando la cuenta de cobro, así que `get_order` y `open_claim` del MCP no
cambian. No se toca el Mandato, los topes ni el `policy_rail`.

**Cómo se enciende.** El merge no enciende nada. En la plataforma, el escrow de `agentcommerce` se asigna con la
variable `COMERCIO_ESCROWS` en Render (`X-25`); se pone y se quita sin deploy. Decisiones: `X-23` (la versión nueva y
las dos puertas), `X-24` (qué comprueba el agente) y `X-25` (el interruptor y la comprobación al arrancar).

**Lo que falta para cerrar.** `/revisar`, el merge, el interruptor y una compra real retenida, con el hash del pago y
del `hold`. `@agentpey/ucp-stellar` queda en `0.2.0` en el repo; publicarla en npm es del usuario.

**Evidencia.** [`evidencia/T160.md`](evidencia/T160.md).
