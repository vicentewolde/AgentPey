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

---

### X-23 · La tienda con escrow declara el handler `2026-10-15` y cobra al escrow por las dos puertas · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T160 · Plan aprobado por el usuario

1. **Versión nueva del handler (`X-13`).** `2026-10-15`, publicada en
   `agentpey.com/ucp/handlers/stellar-x402/2026-10-15/{spec,schema.json}`. `pay_to` es el contrato del escrow y un
   bloque `escrow` dice de quién es: `contract`, `payee` (la cuenta de cobro), `arbiter` y las tres ventanas, tal como
   las devuelve el `config()` del contrato. `pay_to` tiene que ser `escrow.contract`; un `C…` sin bloque, o un bloque en
   `2026-09-30`, se rechaza. La `2026-09-30` queda igual, en su ruta de siempre, para las tiendas que cobran directo.
2. **Las dos puertas cobran al escrow.** El checkout UCP y el x402 (`/checkout/:productId`) piden `payTo` = escrow. El
   manifest suma `settlement.escrow`, opcional. Un cliente x402 que fija la cuenta de la tienda rechaza ese cobro antes
   de firmar, sin perder plata. El agente de AgentPey compra por UCP.
3. **El recibo no cambia de cobrador.** `merchantAccount` sigue siendo la cuenta de cobro, y el recibo nombra el
   escrow (`X-22`). Por eso `get_order` y `open_claim` del MCP, que atan el recibo a la tienda por `merchantAccount`,
   siguen funcionando sin cambios.

**Motivo.** Un solo camino de pago por tienda: todos sus recibos quedan protegidos, y el `hold` de T159 vale para las dos
puertas.

**Alternativas descartadas.**
- **Que la puerta x402 siga cobrando directo:** dos clases de recibo en la misma tienda, y una rama por puerta en el
  recibo y en el `hold`.
- **Ampliar `2026-09-30` para aceptar `C…`:** cambia en silencio un contrato público (`X-13`).

---

### X-24 · Qué comprueba el agente antes de pagar a un escrow, y qué hace después · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T160 · Precisa `X-9`, plan aprobado por el usuario

Antes de firmar, el agente lee el contrato en la red y paga solo si:
- corre el wasm de `purchase-escrow` que conoce (`PURCHASE_ESCROW_WASM_HASHES`, `f5c6bbb6…`);
- su árbitro es uno que acepta: el de AgentResolve (`GAEB2EG3…`, de `deployments/testnet.json`);
- su operador es la llave con que la tienda firma sus recibos (el `did:stellar` de las `keys` de su perfil);
- su `config()` dice lo mismo que la tienda declara (`payee`, árbitro y ventanas) y su token es el activo que se paga;
- su `payee` es **la misma cuenta que el directorio fija para esa tienda** (`C-141`).

Con eso, `toPaymentTerms` acepta como destinatario ese escrow y nada más. Lo recibe como `VerifiedEscrow`, un tipo que
solo arma la verificación, para que ningún llamador futuro pueda saltársela (la lección de `B-25`). El escrow pasa a ser la cuenta de la tienda
bajo las reglas del contrato: una liberación le paga a la misma cuenta que antes cobraba directo, y un reembolso
vuelve al rail. El Mandato del MCP no fija destinatarios (`grant.payTo` vacío), así que no hace falta otro Mandato ni
tocar `checkMandate`, `scope.limits` ni el `policy_rail`. Un Mandato que sí fije destinatarios (`M-14`) rechazaría el
escrow al reconciliar, que es lo correcto: el mandante consintió otra cuenta.

`@agentpey/ucp-stellar` pasa a `0.2.0` con la opción `verifyEscrow`. Sin ella, pagarle a una tienda con escrow, o a
un contrato que la tienda no declara como escrow, se rechaza con `EscrowUnverified`, un código nuevo en los dos
paquetes. La comprobación en la red queda en quien paga (el agente, el kit, `ucp:buy`), con el lector de
`@vitrinee/anchor` (`escrowPolicy`): una sola decodificación del contrato. La `0.1.0` publicada lee el perfil nuevo
como mal formado y no paga. Publicar la `0.2.0` en npm le queda al usuario.

**Después de pagar (`X-20`).** El agente busca la compra con `by_tx` (30 s; 15 en el MCP, para que el chat no corte
antes). Si no la encuentra, o la encuentra con otra orden, otro monto, otro recibo **u otro pagador**, la respuesta trae
un aviso y no falla: la plata ya salió. El pagador importa porque `hold` lo escribe la tienda y el contrato no lo
comprueba: registrado a otra cuenta, un reclamo o un reembolso no le llegarían a quien pagó (`/revisar`). `pay` del MCP lo
devuelve en `escrow.held` y `escrow.warning`, y `quote` muestra la protección (`protection`) para que el chat la
explique antes de pagar.

**Motivo.** Fijar el `payee` a la cuenta que el directorio ya conocía hace que la única diferencia con hoy sean las
reglas del contrato. Exigir el árbitro conocido impide un escrow con el código bueno pero con la tienda como árbitro.

**Alternativas descartadas.**
- **Que `@agentpey/ucp-stellar` lea la red por su cuenta:** duplicaba la decodificación del contrato en un paquete
  publicado, y aun así no conoce la cuenta que fija el directorio.
- **Fallar el pago si no aparece el `hold`:** el pago ya salió, así que fallar solo confunde a quien reintenta.

---

### X-25 · El escrow se enciende con una variable de la plataforma, y una tienda con un escrow que no calza no abre · `Vigente`
**Fecha:** 2026-10-14 · **Tarea:** T160 · Plan aprobado por el usuario (completa el punto 4 de `X-22`)

- **El interruptor es `COMERCIO_ESCROWS`**, con pares `<slug>=<C…>` separados por coma, en el entorno de la
  plataforma. Le asigna un escrow a esa tienda y a ninguna otra. Se pone y se quita en Render sin deploy, así que el
  merge de T160 no enciende nada. Un valor mal formado, una tienda repetida o un escrow para dos tiendas (`X-11`)
  impiden que la plataforma arranque. `ESCROW_CONTRACT_ID` sigue sin heredarse; en el modo de una tienda se usa
  directo. En producción la variable va en el servicio `AgentPey` de Render como `VITRINEE_COMERCIO_ESCROWS`: el
  gateway solo le pasa a Vitrinee sus variables con prefijo, y se la entrega como `COMERCIO_ESCROWS`
  (`apps/gateway/src/hosts.ts`).
- **La tienda comprueba su escrow al armarse** (`verifyStoreEscrow`): wasm conocido, operador = cuenta de firma,
  `payee` = cuenta de cobro, token USDC y árbitro de AgentResolve (con otro, todo comprador lo rechazaría). Si no calza, la tienda no abre y dice por qué; nunca cae en silencio a
  cobrar directo. Si la RPC de Soroban no responde, el armado falla, no queda guardado y el próximo request lo
  reintenta. `createApp` rechaza un `ESCROW_CONTRACT_ID` sin esa comprobación.
- **Una orden se registra solo en el escrow al que se pagó.** Si el interruptor se apaga o apunta a otro contrato,
  los `hold` pendientes fallan con el motivo, en vez de ir al contrato nuevo, donde podrían tomar saldo de otras
  compras. El pago queda sin asignar en el escrow viejo (`X-20`): antes de apagar o cambiar el interruptor, conviene
  que no queden `hold` pendientes.

**Motivo.** Encender el escrow para un comprador real es un cambio visible y reversible por separado del código. Una
tienda que cobra a un contrato equivocado emitiría recibos que fallan el cuarto chequeo y `hold` sin fondos.

**Alternativas descartadas.**
- **Una columna en la base de comercios:** pide migrar producción para un solo comercio, y el alta de escrow desde
  el portal está fuera de alcance.
- **Leerlo de `deployments/testnet.json`:** se encendería con el merge, sin interruptor.
- **Volver a cobrar directo si la comprobación falla:** esconde el error y deja a la tienda prometiendo una protección
  que no da.

---

### X-26 · Una disputa sobre una compra con escrow vive en el escrow: la abre el pagador, el plazo es del contrato y el reembolso sale del pago retenido · `Vigente`
**Fecha:** 2026-10-15 · **Tarea:** T158 · Plan aprobado por el usuario

El árbitro (`scripts/resolve.ts`) elige el contrato por el recibo: si nombra un escrow (`X-22`), la disputa vive ahí,
identificada por la orden; si no, en `agent-resolve`, como desde T124. El veredicto, su hash y la confirmación humana
(`E-18`, `X-10`) no cambian.

1. **La abre el pagador, sin el árbitro.** `resolve:open` firma el reclamo y, con la misma llave dueña del rail, el
   mensaje de `open` (`X-18`), y lo envía al escrow. El escrow compara la firma con el pagador que registró en el `hold`.
   T162 hará lo mismo desde el chat. Por ahora, el script solo abre disputas de compras pagadas desde un rail cuya llave
   tiene esta máquina (`AGENT_SECRET_KEY` o `MCP_AGENT_SECRET_KEY`).
2. **El plazo del comercio es el del contrato.** `resolve:decide` no decide sin respuesta antes de que venza el
   `response_window` del escrow (15 minutos en `agentcommerce`). Las 48 h de `E-22` quedan para `agent-resolve`
   (`assertMayDecide` y `responseDeadline` reciben el plazo). Si el comercio respondió en la red, la respuesta que se
   escucha es la del archivo cuyo hash guarda el escrow, y ninguna otra.
3. **El reembolso sale del pago retenido.** `resolve:execute` llama `resolve` en el escrow, firmado por el árbitro. Antes
   comprueba las ventanas del contrato (`X-7`, `X-15`): después de la respuesta o de su plazo, y antes de que cierre la
   del árbitro. Pasado ese momento se niega con `ResolveWindowClosed` y avisa que solo vale `expire`, que le devuelve
   todo al comprador. No se agrega un comando `resolve:expire` en esta tarea.
4. **El veredicto real de T158 se toma sin respuesta del comercio**, porque responder en la red llega con T163.

**Motivo.** El reembolso sale de la misma plata que pagó el comprador, con los plazos que impone la red. El árbitro deja
de ser quien abre la disputa y quien pone el destinatario del reembolso (brecha 18).

**Alternativas descartadas.**
- **Que el árbitro abra también las disputas del escrow:** el escrow no lo necesita, y volvería a poner al árbitro en
  medio de lo que el comprador puede hacer solo.
- **Las mismas 48 h para todo:** el escrow ya fija su propio plazo, y la decisión no puede llegar después de que el
  contrato cierre la ventana del árbitro.
- **Esperar a T163 para el veredicto real:** atrasaba D1 sin cambiar lo que se prueba del pago retenido.
