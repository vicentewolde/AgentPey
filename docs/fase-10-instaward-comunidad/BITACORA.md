# Bitácora — Fase 10 (Compras protegidas con la comunidad y tótem de llegada)

> Qué se hizo, qué falta, y qué significa cada cosa en lenguaje llano.
> Spec: [SPEC.md](SPEC.md) · Decisiones: [DECISIONES.md](DECISIONES.md) ·
> Salidas crudas de cada tarea: `evidencia/T<n>.md`
>
> La numeración continúa la de las fases anteriores: esta fase usa T182 a T206. El tablero del día a día es
> [`docs/ESTADO.md`](../ESTADO.md); aquí queda la narrativa de cada tarea cerrada.

---

## Estado actual

**Fecha:** 2026-11-10 · **Spec aprobado** por el usuario (`P-15`); anexo A con el texto exacto enviado. El sprint parte el 11-nov (hasta el 10-dic, lo indica el usuario) solo si el capítulo aprueba el Instaward enviado el 9-nov. Nada de esta fase está construido.

Pendiente: que Tellus confirme la fecha por escrito. Antes del sprint y fuera de esta fase: cerrar la Fase 9 en vivo, la tienda Tapline y su catálogo, pedir el hardware del tótem.

## Progreso

| Tarea | Estado |
|---|---|
| T207 Todas las páginas con el diseño de las publicaciones | ✅ en producción el 11-nov (PR #106, [evidencia](evidencia/T207.md)) |
| T182 `confirm` en el contrato de escrow | ✅ en `main` ([PR #107](https://github.com/vicentewolde/AgentPey/pull/107), [evidencia](evidencia/T182.md)); el contrato se despliega en T183 |
| T183 Escrow v2 en testnet | 👀 desplegado `CDSCZJEM…E3UML` y ensayado ([evidencia](evidencia/T183.md)); el de Tapline va con T191 (`Y-9`) |
| T184 Evidencia sellada | ✅ en `main` ([PR #110](https://github.com/vicentewolde/AgentPey/pull/110)) y corrida en testnet con foto ([evidencia](evidencia/T184.md)) |
| T185 Acciones del asistente | 👀 `confirm_purchase` y `attach_evidence` en `main` ([PR #114](https://github.com/vicentewolde/AgentPey/pull/114)); falta la prueba en vivo con una wallet (el conector de claude.ai no conecta desde el 13-nov) |
| T186 Una cuenta de gasto por persona | 👀 script, lista y pruebas en `cc/t186-cuenta-por-persona`; primer rail por persona en testnet (`CBWBQVI5…GI374`, fondeado con 2 USDC) ([evidencia](evidencia/T186.md)); falta el merge |
| T189 Un pago sobre el tope, rechazado por la red | 👀 hecho en testnet: 1,5 USDC contra un `per_tx` de 1, transacción fallida [`3f81fe8f…`](https://stellar.expert/explorer/testnet/tx/3f81fe8f407106876e6ef44bab327a8bb69d452717c12e0fe8a7a1ca76717c3f) ([evidencia](evidencia/T189.md)); en `cc/t189-sobre-el-tope`, sin mergear |
| T187 El MCP elige el rail según la wallet | 👀 código y pruebas en `cc/t187-mcp-por-wallet`; corrida local: el comprador de prueba inició sesión y pagó el imán desde su propio rail (`ord_mwi71o5s46dbef233d`, [tx](https://stellar.expert/explorer/testnet/tx/81db5b000787e89f7be1a7dc74f9856c109e5407b5ac9553c7a4f14f7a64128c)) ([evidencia](evidencia/T187.md)); revisión independiente sin hallazgos graves; falta probar la wallet original en producción tras el merge |
| T188 La entrega de un producto digital | 👀 código y pruebas en `cc/t188-entrega-digital` ([evidencia](evidencia/T188.md), `Y-11` aprobada); la corrida en vivo va con el catálogo de Tapline (T193) |
| T190 Corrida de D1 y evidencia | 👀 [evidencia](evidencia/T190.md): contrato, tests y los cuatro hashes prometidos, releídos en Horizon el 21-nov; abiertos para la semana 2: confirmar con wallet desde el chat y la entrega digital en vivo |
| T191 a T206 | ⏳ pendientes (T201 es un extra) |

## Bitácora

- 2026-11-10: spec escrito y **aprobado por el usuario**, hecho a partir del encargo de la sesión de investigación y de leer el código de la Fase 9. El
  usuario decidió `confirm` (`Y-1`), la cuenta por persona (`Y-4`), la entrega digital (`Y-5`) y la suscripción de Tapline.

## 2026-11-11 · T207 y T182

**T207.** Las 13 páginas de AgentPey siguen el diseño de las publicaciones de la marca, con una hoja de estilos única (`Y-7`). Revisada
por un agente independiente en dos pasadas, corregida y en producción el 11-nov.

**T182.** El comprador ya puede confirmar que está conforme: en el contrato, `confirm` paga a la tienda en el acto, desde una compra
retenida o despachada. Solo lo firma la wallet de la persona (o la cuenta que pagó, si es una cuenta normal); ni el agente, ni la tienda,
ni el árbitro pueden. Con una disputa abierta no se puede. 42 pruebas del escrow en verde. Falta desplegarlo para Tapline (T183, con OK).


## 2026-11-11 · T183

**T183.** El contrato nuevo del escrow, el que deja al comprador confirmar, ya está en testnet (`CDSCZJEM…E3UML`) y el
verificador de recibos lo acepta. Se ensayó con dos compras: una que el comprador confirmó y se pagó al tiro, y otra que
se liberó sola al vencer su plazo. El contrato propio de Tapline se despliega cuando Tapline entre a Vitrinee (T191),
porque su cuenta firmante nace en ese alta (`Y-9`); el cobro irá a la wallet que dio el usuario, con los plazos de
`agentcommerce`. La confirmación desde la wallet de una persona se prueba con la página de firma (T185).

## 2026-11-11 · T184

**T184.** Un reclamo ya puede traer fotos o PDF. El archivo no va a la red: el reclamo firmado guarda su huella y la red
guarda la huella del reclamo, así que si alguien cambia la foto después, deja de calzar. La tienda guarda el archivo solo
si el reclamo sellado lo nombra, y se lo entrega solo al árbitro, al comercio o al comprador, con un enlace que firman con
su propia llave y que vence en minutos, porque una foto de un paquete puede mostrar una dirección. El árbitro revisa cada
archivo antes de decidir y le dice al modelo cuáles calzan. La corrida en testnet salió bien: un reclamo con una foto quedó abierto en la red, la tienda la guardó, y el árbitro la leyó, comprobó su huella y rechazó el reclamo (era una prueba, sin daño real).

## 2026-11-13 · T185 (segunda mitad)

**T185, `attach_evidence`.** Claude ya puede ayudar a sumar una foto a un reclamo sin que la foto pase por el chat. La
herramienta da un enlace (`agentpey.com/resolve/evidencia?order=…`); ahí la persona elige la foto o el PDF, el navegador
achica la foto (y le quita la ubicación) y muestra un código que la persona pega en el chat. El reclamo sella ese código, y
en cuanto el reclamo está abierto, la misma página le envía el archivo a la tienda, que lo guarda solo si calza (`Y-10`).
Probado de punta a punta en un Chrome sin pantalla con una foto de 26 MB, que quedó en 1,7 MB. También se arregló un test
del MCP que seguía esperando seis herramientas. Falta la prueba en vivo: confirmar una compra con una wallet real y abrir un
reclamo con foto desde Claude.

## 2026-11-12 · T185 (primera mitad)

**T185, `confirm_purchase`.** Claude ya puede ayudar a confirmar una compra, pero no puede confirmarla él: la herramienta le
da a la persona un enlace (`agentpey.com/resolve/confirmar?order=…`) y ahí conecta su wallet y firma. La tienda arma la
transacción solo para la cuenta que corresponde (la que pagó, o la wallet a la que responde su rail, nunca la llave del
agente) y la envía solo si es exactamente `confirm` de esa orden. Al firmar, la tienda cobra al tiro. Falta `attach_evidence`.
Un detalle de diseño: la foto de un reclamo se sella al firmarlo, así que hay que subirla antes de abrir el reclamo;
eso se resuelve con una página de subida (la segunda mitad de T185).

## 2026-11-13 · T186

**T186.** Ya se le puede dar a una persona su propia cuenta de gasto con un solo comando. El comando le crea una llave de
agente que es solo suya (sale de una frase maestra que nunca se publica), despliega su `policy_rail` con su wallet como
dueña de la plata y con los topes que se elijan, lo relee de la red para confirmar que quedó como se pidió, y la anota en
la lista del MCP (`apps/mcp/wallets.testnet.json`, sin secretos). No mueve plata: el fondeo sigue siendo un paso aparte,
con `rail:topup`. Las pruebas del contrato muestran que la llave de una persona no puede gastar del rail de otra, que el
rail de una persona no aprueba mover la plata de otra, y que el tope diario de una no consume el de otra. Topes: por pago
hasta el diario, y el diario hasta 50 USDC. El 15-nov, con OK del usuario, se desplegó el primer rail por persona en testnet
para un comprador de prueba (1 USDC por pago, 2 por día) y se fondeó con 2 USDC de la reserva. El MCP empieza a leer la
lista en T187.

## 2026-11-15 · T189

**T189.** Hay una prueba en la red de que el tope lo pone la red y no el agente. Al rail del comprador de prueba (tope de
1 USDC por pago) se le pidió pagar 1,5 USDC con la firma de su propia llave, y la red lo rechazó: la transacción quedó en
el ledger como fallida ([`3f81fe8f…`](https://stellar.expert/explorer/testnet/tx/3f81fe8f407106876e6ef44bab327a8bb69d452717c12e0fe8a7a1ca76717c3f))
y el saldo del rail siguió en 2 USDC. Hasta ahora estos rechazos se mostraban solo simulados, sin hash; para enviarlo de
verdad, el script arma el pago con la huella de uno válido y, antes de enviar, comprueba que el mismo camino con
exactamente el tope sí pasa y que el motivo del rechazo es el tope (`PerTxExceeded`).

## 2026-11-15 · T187

**T187.** El servidor MCP ya atiende a varias personas, cada una con su propia cuenta. Inicia sesión cualquier wallet de
la lista cerrada, y todo lo que pide su chat (buscar, cotizar, pagar, reclamar) sale de su propio rail, con su propia
llave de agente, su credencial y su Mandato; nunca de la cuenta de otra persona. Al arrancar, el servidor revisa en la red
cada cuenta: si la original falla, no arranca (como antes); si falla una de la lista, la deja fuera y lo anota, y las
demás siguen. Con varias wallets, la página de inicio de sesión ya no muestra cuál puede entrar, para no listar a las
personas. `mcp:setup` emite la credencial y el Mandato de cada persona con los topes de su rail. Probado en local contra
testnet: el comprador de prueba inició sesión firmando con su wallet y su cotización sale de su rail
(`CBWBQVI5…GI374`); una wallet fuera de la lista recibió 403. Con OK del usuario pagó el imán (0,52 USDC de testnet) desde
ese rail: el escrow de `agentcommerce` guarda la compra con su rail como pagador. Una revisión independiente no encontró
cruces entre cuentas ni filtraciones; se corrigieron tres observaciones menores. Falta comprobar en producción, tras el
merge y con `MCP_AGENT_MNEMONIC` en Render, que la wallet original sigue comprando.

## 2026-11-15 · T188

**T188.** Una tienda ya puede vender un producto digital y entregarlo sin Shopify de por medio. La tienda dice qué
productos son digitales y dónde guarda cada archivo. Cuando alguien compra solo productos digitales, su asistente le da un
enlace de descarga que firma con la llave de esa persona y que dura unos minutos: solo quien pagó puede usarlo, porque la
página del pedido es pública y un enlace secreto ahí se filtraría. La primera descarga cuenta como la entrega: abre la
ventana del escrow igual que un paquete despachado, y desde ahí la persona confirma o reclama. Bajarlo de nuevo no cambia
nada. Las compras físicas siguen igual. Probado con la app entera y un escrow falso; la corrida en vivo necesita un producto
digital real en Shopify, que llega con el catálogo de Tapline (T193). Cómo se resolvió quién descarga y dónde vive el
archivo quedó como `Y-11`, aprobada por el usuario el 15-nov.

## 2026-11-21 · T190

**T190.** La semana 1 tiene su evidencia completa en un solo lugar: el contrato del escrow con sus tests, una compra
liberada cuando el comprador confirmó, una liberada al cerrar la ventana, un reclamo con una foto sellada en la red y un
pago sobre el tope que la red rechazó, cada uno con su enlace a Stellar Expert y releído en Horizon. Además, la cuenta de
gasto por persona (con una compra pagada desde ella) y las dos acciones nuevas del asistente. Quedan para la semana 2, con
Tapline, confirmar desde el chat con una wallet real (el escrow de `agentcommerce` no tiene `confirm`) y la entrega
digital en vivo. Para Passport se armó un resumen de una página en inglés, el hilo para X y el guion del video.

