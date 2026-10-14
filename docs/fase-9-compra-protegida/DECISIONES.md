# Decisiones — Fase 9 (Una compra protegida, de punta a punta)

> Prefijo `X-`. Cada decisión con su motivo y la alternativa descartada. Las
> que cruzan fases van a [`docs/DECISIONES.md`](../DECISIONES.md) con prefijo
> `P-` (la que abre esta fase es `P-19`); las que tocan Vitrinee por dentro,
> a su `DECISIONES.md` con prefijo `VT-`.

`X-1` a `X-13` las propuso Claude Code a partir del plan del 7-oct, verificado contra el código el 14-oct, y las
**decidió el usuario** el 14-oct, todas como se recomendaron.

---

### X-1 · Un solo contrato nuevo, `purchase-escrow`, que retiene el pago y guarda su vínculo con el recibo · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

**Motivo.** La compra retenida ya es el registro del pago: guardar ahí `tx_hash` y `receipt_hash` cierra la brecha 10
sin un libro de recibos aparte. Menos despliegues y menos superficie.

**Alternativa descartada: dos contratos (escrow y libro de recibos).** Duplica estado que tiene que coincidir.

---

### X-2 · El escrow es un contrato nuevo; `agent-resolve` sigue intacto · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

**Motivo.** `agent-resolve` sostiene las disputas existentes, incluido el reembolso de T124. Un contrato nuevo no
obliga a migrar nada ni a redesplegar.

**Alternativa descartada: un sucesor de `agent-resolve`.** Obliga a migrar o a mantener dos versiones del mismo
contrato con reglas distintas.

---

### X-3 · El pago entra como un `transfer` x402 normal con `payTo` = el escrow, y la tienda lo registra con `hold` · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T159, T160 · Decidido por el usuario

`policy_rail.__check_auth` solo autoriza un `transfer` de su activo y no revisa el destinatario
(`contracts/policy-rail/src/lib.rs` l.361–388): el rail puede pagarle al contrato, pero no llamar a un `deposit`.
`hold` rechaza un monto mayor que el saldo no asignado y un `tx_hash` repetido. Hay que aceptar `C…` en el handler,
el recibo y la verificación (`X-13`).

**Motivo.** No toca `policy_rail`, `checkMandate` ni el handler en su forma.

**Alternativa descartada: que el rail llame a `escrow.deposit`.** Exige cambiar y redesplegar `policy_rail`, que está
fuera de alcance.

---

### X-4 · `hold` y `mark_shipped` los firma la cuenta de firma de la tienda; `respond`, la cuenta de cobro · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157, T163 · Decidido por el usuario

El plan del 7-oct decía que todo lo firmaba la cuenta de cobro (`merchantAccount`). El código muestra dos cuentas:
la de firma, que firma y ancla los recibos y cuya llave guarda el servidor (`vitrinee-gateway/src/app.ts:130`), y la
de cobro, que en el portal es la wallet del comercio, sin llave en el servidor (`platform/portal.ts:160`). Los
pagos al comercio van a la cuenta de cobro; `respond` lo firma el comercio desde la página con Freighter o xBull.

**Motivo.** `hold` y `mark_shipped` ocurren solos, en el servidor, que solo tiene la llave de firma. La respuesta
es del comercio, y hoy ya la firma su cuenta de cobro (`verifyMerchantResponse`).

**Alternativa descartada: todo con la cuenta de cobro.** Obliga al servidor a guardar la llave de la wallet del
comercio, o al comercio a firmar cada `hold` a mano.

---

### X-5 · El escrow es opcional por tienda, encendido en `agentcommerce` · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T160 · Decidido por el usuario

La tienda lo declara en el `business_config` del handler.

**Motivo.** No rompe a clientes ni a tiendas actuales.

**Alternativa descartada: escrow obligatorio.** Rompe a toda tienda y cliente que hoy funciona.

---

### X-6 · La ventana de liberación es configurable: minutos en la demo, 7 días por defecto · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157, T164 · Decidido por el usuario

**Motivo.** La demo necesita ver la liberación en vivo; una tienda real necesita días.

**Alternativa descartada: un valor fijo.** O no se ve en la demo, o no sirve fuera de ella.

---

### X-7 · Si el árbitro no resuelve a tiempo, `expire` reembolsa completo al pagador · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

Cualquiera puede llamar `expire` pasado `response_window + resolve_window` desde la apertura. Cierra la brecha 18:
en `agent-resolve`, `resolve` no tiene plazo y una disputa puede quedar abierta para siempre.

**Motivo.** Protege al comprador, que es el punto del entregable.

**Alternativa descartada: liberar al comercio al vencer.** Premia al árbitro ausente a costa del comprador.

---

### X-8 · El contrato nuevo usa soroban-sdk 27, en el workspace principal · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

**Motivo.** Un workspace menos que mantener. Nada del contrato pide 28.

**Alternativa descartada: un workspace propio con 28, como `receipt-registry`.** Solo se justifica si algo lo pide.

---

### X-9 · El agente comprueba, antes de firmar, que el `payTo` sea el escrow declarado y que ese contrato corra el wasm conocido · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T160 · Decidido por el usuario

Se hace en la relectura del perfil que ya hace `pay()` (`ucp-stellar/src/checkout.ts:425–452`). La comprobación del
wasm se agregó al verificar el plan contra el código.

**Motivo.** Sin la primera, una tienda podría declarar escrow y cobrar directo. Sin la segunda, podría declarar un
contrato propio que imite la interfaz y reenvíe la plata.

**Alternativa descartada: confiar en lo que declara la tienda.** Deja el escrow como una promesa sin respaldo.

---

### X-10 · Sigue la confirmación humana del veredicto (`E-18`) · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T158 · Decidido por el usuario

**Motivo.** No se cambia la regla de confianza del árbitro durante la fase.

**Alternativa descartada: veredicto automático.** Cambia a la vez quién decide y cómo se paga.

---

### X-11 · Un escrow por tienda, no uno compartido · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

El constructor fija la cuenta de firma (`operator`) y la de cobro (`payee`). En la fase se despliega uno solo, para
`agentcommerce`, a mano y con el OK del usuario.

**Motivo.** En Soroban un contrato no puede leer el hash de otra transacción. Con un escrow compartido, una tienda
registrada podría hacer `hold` sobre un pago que llegó para otra y quedarse con él; el chequeo de saldo no asignado
no lo impide. Con uno por tienda, todo el saldo del contrato es de esa tienda.

**Alternativa descartada: un escrow compartido con una lista de tiendas que lleva un admin.** Un despliegue menos por
tienda, pero deja ese riesgo abierto y agrega un admin.

---

### X-12 · Se puede reclamar mientras el pago no se haya liberado · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

Como la liberación exige un despacho más la ventana, siempre hay un plazo para reclamar antes. Desaparece el
`claim_window` aparte que tiene `agent-resolve`.

**Motivo.** Un plazo menos que configurar, y ningún caso en que el comprador pierda el derecho a reclamar antes de
que el comercio cobre.

**Alternativa descartada: un `claim_window` contado desde `hold`.** Podría cerrarse antes del despacho.

---

### X-13 · El handler `stellar_x402` y la extensión del recibo pasan a una versión nueva que acepta `C…` y `escrow` · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T160, T161 · Decidido por el usuario

Hoy todo `pay_to` de tienda y el `merchantAccount` del recibo aceptan solo `G…` (`ucp-stellar/src/wire.ts:44`,
`vitrinee-core/src/ucp.ts:104`, `apps/web/public/ucp/handlers/stellar-x402/schema.json:63`). La versión
`2026-09-30` sigue válida para las tiendas sin escrow.

**Motivo.** Cambiar el esquema público sin cambiar la versión rompería a cualquier cliente que valide contra él.

**Alternativa descartada: ampliar la versión `2026-09-30`.** Cambia en silencio un contrato público.

---

### X-14 · El facilitator x402 acepta un `payTo` contrato: el pago al escrow va por el facilitator, sin plan B · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** chequeo del día 1, antes de T157 · Corrido con el OK del usuario

Con las mismas librerías que la tienda (`@x402/core` y `@x402/stellar` 2.26), OpenZeppelin Channels en testnet
dio `verify` válido y liquidó 0,01 USDC desde una cuenta `G…` hacia el contrato `policyRailUcp`, con la comisión
patrocinada (`areFeesSponsored: true`). Transacción `84611558ffea12348a87aa23f9428749efcbba74e30f0d3bae04d61841cb077f`.
El saldo del contrato subió exactamente 100000 unidades. Evidencia en
[`evidencia/chequeo-dia-1.md`](evidencia/chequeo-dia-1.md).

**Consecuencia para T159.** En Horizon, el abono a un contrato es `contract_credited` con el destinatario en el
campo `contract`; el campo `account` trae la cuenta que envió la transacción (la del facilitator). La verificación
del escrow tiene que leer `contract`, no `account`.

**Motivo.** Era el riesgo principal del diseño (`X-3`): si el facilitator no aceptaba un contrato, la tienda tendría
que liquidar sola.

**Alternativa descartada: plan B, que la tienda liquide directo.** Ya no hace falta, y habría sumado una forma de
liquidar que hoy no existe.

---

### X-15 · Se puede reclamar hasta que cierra la ventana de liberación; pasado el plazo del árbitro, solo vale `expire` · `Vigente` — precisa `X-12`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

`X-12` decía "mientras el pago no se haya liberado". En el contrato, `open` vale mientras la compra no esté despachada
o, si lo está, hasta un segundo antes de que cierre la ventana de liberación. Pasado ese momento solo vale `release`.
Del mismo modo, `resolve` se rechaza después de `response_window + resolve_window` desde la apertura, y entonces solo
vale `expire` (`X-7`).

**Motivo.** El resultado no depende de quién llama primero: con "hasta que alguien llame `release`", un comprador
podría abrir una disputa días después de que venció la ventana solo porque nadie había liberado todavía.

**Alternativa descartada: lo que decía `X-12` al pie de la letra.** Deja el plazo real en manos de quien llama.

---

### X-16 · Un pagador con cuenta clásica (`G…`) abre la disputa con su propia firma de Stellar · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

Si el pagador registrado en `hold` es un contrato (un `policy_rail`), `open` exige la firma Ed25519 de su `owner()`
sobre el mensaje de `X-18`. Si es una cuenta clásica, `open` pide `payer.require_auth()` y no lleva firma aparte. El
contrato distingue los dos casos con `Address::to_payload`, que en soroban-sdk 27 está detrás de la feature
`hazmat-address`. Se usa solo para saber el tipo de dirección y para leer el id del propio contrato: una cuenta nunca
se autentica por su payload.

**Motivo.** `ucp-stellar` también paga desde cuentas clásicas (`classicPayer`), y esos compradores merecen la misma
protección.

**Alternativa descartada: solo pagadores que son rails, como decía el spec.** Deja sin reclamo a cualquier compra
pagada desde una cuenta clásica.

---

### X-17 · La evidencia de T157 sale de un escrow de ensayo; el de `agentcommerce` queda desplegado con ventanas de 10, 15 y 60 minutos · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Decidido por el usuario

`hold` lo firma la cuenta de firma de la tienda (`X-4`). La de `agentcommerce` (`GAPCCUMM…5YVZ`) vive cifrada en la
base de producción y no en local, así que no se puede hacer a mano un `hold` en su escrow. Se despliegan dos
instancias del mismo wasm (`d0d1d877…`):

- **`agentcommerce`** (`CDQLUZUR…TNJH`): operador y cuenta de cobro leídos del perfil UCP en vivo, árbitro de
  AgentResolve, ventanas de 600, 900 y 3600 segundos para la corrida grabada (`X-6`). Su primer `hold` real llega
  con T160, desde la tienda.
- **`rehearsal`** (`CBKBYMWK…LYA5`): operador `ADMIN` y cuenta de cobro `ISSUER`, llaves de `.env.local`, con
  ventanas de 120, 120 y 300 segundos. El despliegue le abrió a `ISSUER` la trustline de USDC para poder recibir
  una liberación. De aquí salen el pago liberado y el reembolsado.

El mismo hash de wasm prueba que el ensayo corre el mismo código que el escrow de la tienda.

**Actualización (14-oct, `X-19`):** los dos se redesplegaron con el wasm corregido (`f5c6bbb6…`): `agentcommerce`
pasó a `CBQFELK5…DO27A` y el ensayo a `CCTVYTWF…YLDO`, con las mismas cuentas y ventanas. Los ids de arriba quedan en
`retiredPurchaseEscrows`, en cero.

**Motivo.** Saca la evidencia sin mover la llave de firma de una tienda en producción.

**Alternativas descartadas.** Descifrar en local la llave de `agentcommerce` con la `MASTER_KEY` de Render: saca una
llave de producción de su lugar. Desplegar solo el ensayo y dejar `agentcommerce` para T160: cambiaba el criterio de
T157 sin necesidad.

---

### X-18 · El mensaje que firma el dueño del rail para `open` tiene un dominio fijo, el id del contrato, el `claim_hash` y la orden · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 · Precisa el §4.3 del spec

Son 32 bytes con el texto `agentpey/purchase-escrow/open/v1`, los 32 bytes del id del contrato, los 32 del
`claim_hash` y, al final, el `order_ref` en UTF-8 (de 1 a 64 bytes). Solo la última parte tiene largo variable, así
que no hace falta prefijo de largo. El contrato lo expone como `open_message`, y `@agentpey/resolve` lo arma con
`escrowOpenMessage`. Un vector común en los tests de Rust y de TypeScript impide que se separen.

**Motivo.** El contrato no puede leer el JSON del JWS del reclamo. Un mensaje corto y fijo que nombra el contrato y
la orden impide usar una firma en otro escrow o para otra orden.

**Alternativa descartada: el XDR de una tupla.** Es más difícil de reproducir exacto fuera de la red, y el formato
dependería de cómo cada SDK codifica los tipos.

---

### X-19 · Un reembolso que no se puede entregar queda como deuda cobrable, y no traba el resultado · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 (`/revisar`) · Decidido por el usuario

`/revisar` encontró que `close` hacía las dos transferencias en la misma llamada. Si el pagador era una cuenta clásica
que, después de reclamar, quitaba su trustline de USDC (o el emisor desautorizaba su saldo), fallaban `resolve` con
reembolso y también `expire`. Si el árbitro no resolvía con reembolso 0 a tiempo, la plata quedaba trabada para
siempre y un comprador podía bloquearle el cobro a la tienda.

**Se decide.**
1. El reembolso se intenta con `try_transfer`. Si no se puede entregar, la compra igual se cierra, la tienda cobra su
   parte, y el reembolso queda asignado en el contrato como `refund_owed`.
2. `claim_refund(order_ref)` lo entrega más tarde. Cualquiera puede llamarlo, y solo paga a ese pagador.
3. Las fallas del token salen con códigos propios del escrow (`RefundUndeliverable`, `PayeeCannotReceive`). Sin eso,
   el número de error del token se leía como uno del escrow: en un test, un reembolso sin entregar aparecía como
   `MissingSignature`.
4. Si la cuenta de cobro no puede recibir, la llamada falla sin cambiar nada: solo espera el cobro de la tienda, y
   `expire` igual le devuelve todo al comprador.
5. Como el contrato no se puede actualizar, se redesplegaron los dos escrows (`X-17`) y se repitió el ensayo.
   `deploy:purchase-escrow` ahora guarda el escrow reemplazado en `retiredPurchaseEscrows`, y no da por bueno uno
   registrado con otras cuentas o ventanas.

**Motivo.** Ningún participante puede trabar la plata del otro: quien no puede recibir solo demora lo suyo.

**Alternativas descartadas.**
- **Reembolso siempre por retiro:** la devolución necesitaría dos transacciones aun en el caso normal.
- **Dejarlo como límite de v0:** el riesgo era de fondos y el arreglo cabía en la misma tarea.

---

### X-20 · Un pago que llega sin `hold` es un límite de v0, y T159 y T160 lo cubren desde la tienda · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T157 (`/revisar`), T159, T160 · Decidido por el usuario

Si la tienda nunca llama `hold` (el servidor se cae entre la liquidación y el registro), o si llega un sobrepago, la
plata queda como no asignada. El comprador no puede reclamarla (`open` exige una compra registrada) y solo el operador
puede asignarla. En la red no hay forma de saber de quién es un pago sin `hold`, así que el contrato no lo resuelve.

**Se decide.** Queda escrito como límite en el README del contrato y en el §4.2 del spec. T159 registra la compra
justo después de liquidar y reintenta el `hold`. T160 hace que el agente avise si `by_tx` no encuentra la compra de su
pago.

**Alternativa descartada: una función para que el operador devuelva saldo no asignado a una dirección.** Le daría al
operador un camino para mandar plata a cualquier lado.

---

### X-21 · T158 va después de T160: el veredicto necesita una compra real retenida, con su recibo · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T158, T159, T160 · Decidido por el usuario

Al planificar T158 apareció que el árbitro solo decide sobre una compra con un recibo válido, y que hasta T160
ninguna compra real paga al escrow. Además, hasta T159 el verificador rechazaba un pago abonado a un contrato. Las
compras del ensayo de T157 no tienen recibo de tienda. El orden pasa a ser T159 → T160 → T158: la semana 1 queda con
T157 y T159, y la semana 2 con T160, T158 y T161. El entregable D1 sigue cerrando al final de la semana 2.

**Motivo.** El veredicto real de T158 reembolsa una compra de verdad, con su recibo y su pago, sin recibos de ensayo
en el registro público.

**Alternativas descartadas.**
- **T158 con un recibo de ensayo firmado y anclado por `ADMIN`:** cerraba la tarea esa semana, pero dejaba un recibo
  falso en el `receipt-registry` que ven los jueces, y adelantaba trabajo de T159.
- **T158 con solo código y tests, y el criterio del veredicto pendiente:** dejaba la tarea abierta sin necesidad.

---

### X-22 · Cómo se ata un recibo a su pago: campo `escrow` en el recibo, cuarto chequeo y `hold` antes del anclaje · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T159 · Plan aprobado por el usuario

1. **El recibo** suma un campo opcional, `escrow: { contract }`. Los recibos sin él no cambian, y todos los anteriores
   siguen verificando (evidencia de T159: nueve recibos reales de las tres tiendas).
2. **El verificador** pide, para un recibo con escrow, que el pago abone al contrato (`contract_credited`, leyendo
   el campo `contract`, `X-14`), y suma un cuarto chequeo, **retenido**: `by_tx` del pago devuelve este recibo, esta
   orden, este pagador y este monto. Además, el escrow tiene que ser de la tienda que firmó: su operador es la cuenta
   del DID y su cuenta de cobro es `merchantAccount`. Sin eso, un recibo podría declarar el escrow de otra tienda.
   Sin lector de escrows, el chequeo falla cerrado; los seis lugares que verifican recibos reciben uno.
3. **La tienda**, con `ESCROW_CONTRACT_ID`, nombra el escrow en el recibo y registra la compra con `hold` en la
   misma cola del anclaje, primero el `hold` (`X-20`). Va en una sola cola porque los dos firman con la misma cuenta y
   chocarían en el número de secuencia. Cada paso tiene sus propios reintentos y su estado en la orden. `hold` es
   idempotente si la misma compra ya estaba retenida.
4. **En modo plataforma**, `ESCROW_CONTRACT_ID` es una variable de comercio: nunca se hereda del entorno de la
   plataforma, porque si no todas las tiendas nombrarían el mismo escrow. Cómo se le asigna a `agentcommerce` es de
   T160, junto con el `payTo`, el perfil y la comprobación del agente.

**Ajustes de `/revisar` (14-oct, aprobados por el usuario).**
- **El cuarto chequeo exige el código conocido.** El contrato que el recibo nombra tiene que correr el wasm de
  `purchase-escrow` (`PURCHASE_ESCROW_WASM_HASHES`, `f5c6bbb6…`, fijado contra `deployments/testnet.json` por un test).
  Sin eso, un contrato que imitara el formato pasaría como "retenido" sin las reglas del escrow. El wasm retirado
  (`d0d1d877…`) no se acepta.
- **Reintentos al reiniciar.** Al reiniciar, la cola vuelve a intentar todo lo no retenido y todo lo no anclado,
  incluido lo que quedó `failed`, como antes de T159. Un `hold` que se va a reintentar espera su reintento antes de
  que salga el anclaje, para no chocar en el número de secuencia. Uno que falló del todo no frena el anclaje.
- **`ESCROW_CONTRACT_ID` se rechaza en la configuración hasta T160**, porque hasta entonces el checkout cobra a la
  cuenta de la tienda y cada recibo fallaría el cuarto chequeo. T160 levanta la guarda junto con el `payTo`, y al
  arrancar comprueba que el operador y la cuenta de cobro del escrow sean los de la tienda.
- **El cuarto chequeo se ve donde se ven los otros tres:** `get_order` del MCP, el panel de Vitrinee y el kit de
  conformidad. Solo aparece cuando el recibo tiene escrow, así que para las órdenes de hoy nada cambia.
- **El lector de escrows no guarda caché:** cualquiera puede pedir verificar un recibo que nombre cualquier contrato.

**Motivo.** Cierra la brecha 10 para los recibos con escrow, con la red imponiendo la unicidad y cualquiera pudiendo
comprobarla, sin cambiar nada para las tiendas que cobran directo.

**Alternativa descartada: un recibo nuevo (`vitrinee-receipt/0.2`) para las compras con escrow.** Obligaba a todos
los verificadores a conocer dos tipos para agregar un solo campo opcional.
