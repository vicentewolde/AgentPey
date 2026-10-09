# Demo Day de Tellus · escaleta paso a paso

> **Viernes 9-oct, en la tarde (hora de Chile).** Presencial, con el wifi del lugar y una sala mixta (mentores,
> inversionistas, otros founders) que habla español. Compra y reclamo en vivo, cada uno con plan B. La duración total
> se ajusta después (pedido del usuario el 9-oct); las del §1 son estimaciones del ensayo.
>
> Cada afirmación de la voz tiene su evidencia en el repo (**Respaldo**). Lo que no se puede decir está en §5: incluye
> lo que se corrigió en la revisión de T152.
>
> **Deploy:** Render despliega con cada push a `main` (sin filtro de rutas en `render.yaml`), también si solo cambia
> un documento. No se mergea nada a `main` entre el chequeo previo y el final de la presentación. Si hubo un merge
> después del chequeo, vuelve a correr §2.2.
>
> El texto de pantalla, lo que escribes en Claude y la voz van en **español** (decisión del usuario, 9-oct: la sala
> habla español). Las páginas de AgentPey quedan en **ES** (botón arriba a la derecha).

## 1. Cómo se ve

| Bloque | Aprox. | Pestaña | Idea |
|---|---|---|---|
| 1 · El problema | 0:40 | Portada | Un agente con tu tarjeta gasta lo que quiera |
| 2 · La tienda | 0:20 | Tienda en Shopify | Una tienda que existe, con el imán a $490 |
| 3 · Claude compra | 1:30 | claude.ai | El agente cotiza, tú dices sí, el contrato paga |
| 4 · Aparece sola | 0:30 | `/en-vivo` | La red lo registra, nadie actualiza nada |
| 5 · El recibo | 0:30 | Página del recibo | Firmado, anclado y pagado, en verde |
| 6 · El reclamo en vivo | 3:30 | claude.ai, pantalla del árbitro, página de la tienda, `/en-vivo` | Si sale mal, el dinero vuelve, y se ve cómo |
| 7 · El presupuesto | 0:30 | Página del equipo | Un equipo pone el tope; la cuarta compra no pasa |
| 8 · Cierre | 0:30 | Portada | Estándar abierto, en testnet, lo que sigue |

### Pestañas, en este orden, en una sola ventana

1. `https://agentpey.com` (en ES)
2. `https://agenticom.myshopify.com/products/iman-de-cobre-atacama` (la tienda en Shopify)
3. `https://claude.ai`, chat nuevo, con el conector **AgentPey** activo en el menú de herramientas
4. `https://agentpey.com/en-vivo` (en ES, abierta **antes** de la compra, para que la compra aparezca sola)
5. `https://agentpey.com/resolve/responder` (la página donde la tienda responde un reclamo)
6. La pantalla del árbitro, `http://127.0.0.1:4747` (§2.6)
7. `.team-budget/resumen-2026-10.html` (la abre `team:summary -- --html`, §2.7)

Pestañas de plan B, en otra ventana (§3):

8. `https://agentcommerce.vitrinee.agentpey.com/receipts/75559088467f4b465976bca459813dc53ede5f4d96e46369288202450377ac7c`
   (recibo de la compra de Claude del 8-oct, `ord_mv079z6634dbf7e9d1`)
9. [ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md) en el editor: el reclamo del ensayo, paso a paso, con el veredicto completo
10. El video del ensayo (§2.8) y la carpeta de capturas, en el escritorio

## 2. Chequeo previo

Corre todo desde `~/dev/AgentPay`. Ningún comando de esta lista mueve dinero, salvo la compra de §2.5 (un imán desde
el rail del MCP), §2.7 (0,30 USDC del rail UCP) y la recarga de §2.4 si hiciera falta. Al final de cada paso está la
respuesta esperada (medida el 8 y el 9 de octubre).

### 2.1 ¿Hubo un deploy desde la última vez?

```bash
git fetch -q && git log --oneline -3 origin/main
```

Espera: el último commit es el que viste antes (el 9-oct en la madrugada era `825682e`). Si hay uno nuevo, espera a
que Render termine el deploy y entonces sigue con 2.2.

### 2.2 Páginas, MCP y tienda

```bash
for u in https://agentpey.com/ https://agentpey.com/en-vivo https://agentpey.com/tiendas https://agentpey.com/api/live https://agentpey.com/resolve/responder https://mcp.agentpey.com/.well-known/oauth-protected-resource/mcp https://mcp.agentpey.com/mcp https://agentcommerce.vitrinee.agentpey.com/.well-known/ucp https://agenticom.myshopify.com/products/iman-de-cobre-atacama; do printf "%s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$u")" "$u"; done
```

Espera:

| Código | URL | Si no |
|---|---|---|
| 200 | `agentpey.com/`, `/en-vivo`, `/tiendas`, `/api/live`, `/resolve/responder` | Plan B de cada bloque (§3) |
| 200 | `mcp.agentpey.com/.well-known/oauth-protected-resource/mcp` | El MCP está caído: ver §3, bloque 3 |
| 401 | `mcp.agentpey.com/mcp` | Es lo correcto: pide inicio de sesión, así que está arriba |
| 200 | `agentcommerce.vitrinee.agentpey.com/.well-known/ucp` | La tienda no responde a agentes: compra de plan B |
| 200 | `agenticom.myshopify.com/products/iman-de-cobre-atacama` | Usa la captura de la tienda |

La ruta `/.well-known/oauth-protected-resource` **sin** `/mcp` da 404 aunque el MCP esté arriba. No sirve como
chequeo. Si el MCP da 503 justo después de un deploy, espera un par de minutos: desde `R-32`, una app que arranca
tarde se suma cuando responde.

### 2.3 Lo que muestra `/en-vivo`

```bash
curl -s https://agentpey.com/api/live | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['totals']);print([(s['slug'],s['ok']) for s in d['stores']])"
```

Espera las tres tiendas en `True` y `disputes_open` en 0. El 9-oct a las 14:30: `purchases` 27 (desde el 9-oct
`/api/live` cuenta solo compras con pago comprobado; antes decía 33), `disputes_resolved` 4 y `refunded_usdc` 2.60
(crecen con cada compra y cada reembolso).

### 2.4 Saldo de los rails y de la garantía

El comando de recarga sin `--yes` no envía nada: solo muestra el saldo de la reserva y del rail.

```bash
pnpm -s run rail:topup -- CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L 1
```

```bash
pnpm -s run rail:topup -- CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA 1
```

Espera `Nothing was sent.` y:

- **Rail del MCP (`CB4WVTJ4…FRQ6L`): 5,00 USDC o más.** El 8-oct en la noche se recargó con 20 USDC de testnet
  (quedó en 22,6842103, tx `14bf6c51…4eec`) y el reembolso del ensayo devolvió 0,5157895.
- **Rail UCP (`CBDRI5B7…D3YA`): 0,30 o más** para §2.7. Quedó en 30,4631577 (tx `d69de28e…b038`).

Si alguno bajara de 5,00, recárgalo (el comando permite hasta 20 por vez):

```bash
pnpm run rail:topup -- CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L 20 --yes
```

**La garantía de la tienda en AgentResolve** paga los reembolsos. Se lee con la verificación de la disputa del ensayo:

```bash
pnpm -s run resolve:verify -- --receipt 713447e843396dfed591b7b1554d9cc9c821ba5718d928b6411bde7ff5e9958a
```

Espera en la última línea `garantía 2.9157894 USDC (bloqueado 0.0000000 USDC)`: alcanza para el reclamo en vivo
(0,52) y varios más.

**Para ver cuánto cupo queda, doble clic en `Cupo del día` del escritorio:** lee el gasto de hoy en la red, dice cuántos imanes caben y en cuánto se reinicia (a las 21:00 de Chile). No envía nada.

**El tope del rail del MCP no cambia con plata: 3,00 por compra y 5,00 por día UTC.** Desde el 8-oct en la noche el
imán cuesta **490 CLP** (0,5157895 USDC) y la taza 1.490 CLP (1,5684211 USDC). El usuario bajó los precios en Shopify
para que el tope no corte la demo ni las tomas del video.

| Producto | Precio | USDC | Compras por día con el tope de 5,00 |
|---|---|---|---|
| Imán | 490 CLP | 0,52 | 9 |
| Posavasos | 990 CLP | 1,04 | 4 |
| Taza | 1.490 CLP | 1,57 | 3 |

Un reembolso vuelve al rail, pero no descuenta el gasto del día. Una cotización sin pagar reserva su monto del día
durante 10 minutos. El día UTC empieza a las 21:00 de Chile (UTC-3).

### 2.5 Claude, su conector y la compra para el reclamo

1. En claude.ai: Settings → Connectors. **AgentPey** dice conectado.
2. Freighter desbloqueado, en **Testnet**, con la cuenta `GD2MCESI…K5GN` seleccionada: es la única wallet que inicia
   sesión en el MCP, y también la cuenta de cobro de la tienda que firma la respuesta del bloque 6.
2b. **El modo de permisos del chat no puede ser Auto.** En el ensayo del 9-oct, con el chat en Auto, claude.ai
   bloqueó la llamada a `pay` ("la transacción real no cumplía el requisito de confirmación explícita con los datos
   exactos"), aunque el monto ya estaba a la vista y el usuario había dicho "Sí, paga": no se movió dinero. Cambia el
   modo del chat (selector abajo a la derecha) a uno que no use el clasificador automático y repite el ensayo de
   §2.5.3 en ese mismo modo. Con el modo cambiado, Claude pagó al pedirle "Reintenta el pago de esa cotización" y
   no apareció ningún cuadro de permiso. Si en vivo vuelve a bloquearse, es el plan B del bloque 3.
3. **En la mañana, la compra que vas a reclamar en vivo.** En un chat nuevo con el conector:

   > Con AgentPey, compra un imán de cobre Atacama en agentcommerce. Envíalo a Vicente Wolde, Carmen 123, Ñuñoa, Región Metropolitana, Chile; cantidad 1, sin email. Muéstrame el monto exacto antes de pagar.

   Y después: "Sí, paga." Anota el número de orden (`ord_…`): es el que reclamas en el bloque 6. Esta compra es
   también el ensayo del bloque 3. No reclames esta compra antes de la demo: cada recibo admite un solo reclamo.

### 2.6 La pantalla del árbitro

Es una página en tu propio computador (T155, `R-34`) con los pasos del árbitro, para no mostrar una terminal. Por
detrás ejecuta los mismos comandos; las llaves siguen en tu `.env.local`.

**Para encenderla: doble clic en `Árbitro AgentPey` del escritorio.** No abre ninguna ventana de terminal: en unos 3
segundos se abre sola la página en el navegador, con una dirección como `http://127.0.0.1:4747/?k=…` (la clave cambia
cada vez). Si la abres otra vez, reinicia el servidor y abre una página nueva (la anterior ya no sirve). Déjala en la
pestaña 6. Comprueba que carga: debe decir "Una disputa, paso a paso." y los pasos 2 a 4 se ven apagados. Si no se
abre, el registro está en `/tmp/arbiter-console.log`.

La app arranca la pantalla desde `~/dev/AgentPay-t155`, que ya tiene el enlace a tu `.env.local`. Si ese worktree
cambia de lugar, la app deja de funcionar. Sin la app, lo mismo desde una terminal:

```bash
cd ~/dev/AgentPay-t155 && pnpm run arbiter:console
```

Si la pantalla falla, queda el plan antiguo: los mismos pasos con los atajos de [reclamo.zsh](reclamo.zsh) (`source
…/reclamo.zsh`, después `reclamo_guardar`, `reclamo_abrir`, `reclamo_decidir` y `reclamo_pagar <hash>`).

### 2.7 El presupuesto del equipo de hoy

Paga 0,30 USDC del rail UCP a SignalDesk en producción. El tope del equipo se reinicia a medianoche UTC, así que hoy
hay presupuesto nuevo.

```bash
pnpm run team:pay -- --times 4
```

Espera tres compras con `pagada sí` y su transacción, y la cuarta:
`rechazada ScopeDailyLimitExceeded: the total for today would exceed the per-day limit` con `firmado nada`.

```bash
pnpm run team:summary -- --html
```

Espera que se abra `.team-budget/resumen-2026-10.html` con los pagos de hoy y el rechazo destacado. Es un archivo
local: se ve igual sin internet. Déjalo en la pestaña 7.

### 2.8 El ensayo grabado (tu plan B sin internet)

Con la grabación de pantalla de macOS (Cmd+Shift+5, "Grabar pantalla completa"), graba la compra de §2.5.3 y su
llegada a `/en-vivo`. Guarda el video en el escritorio. El reclamo completo ya está ensayado y escrito en
[ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md).

Saca también una captura de cada pestaña (Cmd+Shift+4) a una carpeta `demo-day` en el escritorio.

### 2.9 La sala

- Prueba el wifi del lugar con 2.2. Ten el hotspot del celular listo y probado: si el wifi falla, cambias de red y
  sigues.
- Cargador, "No molestar" activado, notificaciones de Slack y correo cerradas.
- Zoom del navegador en 125 %. La ventana de la terminal que inició la pantalla del árbitro, detrás del navegador.
- `/en-vivo` y la portada en ES.

## 3. Escaleta

**Pantalla** es lo que haces. **Voz** es lo que dices. **Respaldo** es la evidencia de cada afirmación.
**Plan B** es qué haces si ese paso falla.

### Bloque 1 · El problema

**Pantalla:** pestaña 1, la portada en ES, quieta en el titular *"Agentes de IA comprando en tiendas reales, con
límites que aplica la red."*

**Voz:**

> Hola, soy Vicente y esto es AgentPey: pagos para agentes de inteligencia artificial, sobre Stellar.
>
> Los agentes de IA ya pueden comprar por nosotros. El problema es la confianza. Si le das tu tarjeta a un agente,
> puede gastar lo que quiera. Y si las reglas están escritas en su prompt, una sola línea inyectada las cambia.
> AgentPey pone los límites en Stellar, en un contrato que el agente no puede tocar. Les muestro lo que ya
> funciona, en vivo, en testnet.

**Respaldo:** la tesis, en `docs/fase-1-agentpass/CONTEXTO.md`; la portada al día, en
[evidencia/T152.md](../evidencia/T152.md).

**Plan B:** si la portada no carga, empieza con la captura y pasa al bloque 2.

### Bloque 2 · La tienda

**Pantalla:** pestaña 2, el imán en la tienda de Shopify: foto, nombre y precio ($490).

**Voz:**

> Esta es la tienda donde va a comprar el agente. Es una tienda en Shopify, de prueba y nuestra, con productos y
> precios en pesos chilenos. Este imán cuesta 490 pesos. Una persona la ve así. Un agente la ve por el estándar
> abierto de comercio para agentes, UCP.

**Respaldo:** la tienda, rediseñada el 8-oct (`docs/AGENT_LOG.md`, entrada 14 del 8-oct); su perfil UCP responde en
`agentcommerce.vitrinee.agentpey.com/.well-known/ucp` (§2.2).

**Plan B:** la captura de la tienda.

### Bloque 3 · Claude compra

**Pantalla:** pestaña 3, claude.ai. Escribe (los datos de envío van en el primer mensaje: si no, Claude los pide antes de cotizar, como en el ensayo del 9-oct):

> Con AgentPey, compra un imán de cobre Atacama en agentcommerce. Envíalo a Vicente Wolde, Carmen 123, Ñuñoa, Región Metropolitana, Chile; cantidad 1, sin email. Muéstrame el monto exacto antes de pagar.

**Voz, mientras Claude busca y cotiza:**

> Ahora le pido a Claude que compre ese imán. Claude busca el producto y le pide una cotización a la tienda.
> Fíjense en algo: Claude no decide a quién pagarle ni cuánto. Eso viene de la cotización de la tienda, y el
> servidor la vuelve a revisar justo antes de pagar.

**Pantalla:** Claude muestra el monto (0,5157895 USDC por 490 CLP). Escribe:

> Sí, paga.

**Voz:**

> Yo digo que sí, sobre ese monto exacto: unos cincuenta centavos de dólar, en USDC. El pago sale de un contrato
> en Stellar con un tope por compra y otro por día. Si se intenta pagar más que el tope, la red lo rechaza, diga lo
> que diga el agente.

**Pantalla:** Claude responde con la orden (`ord_…`).

**Respaldo:**

- Claude busca, cotiza y paga después del sí de la persona: [evidencia/T150.md](../evidencia/T150.md) §5 y
  [evidencia/T151.md](../evidencia/T151.md) §6; `R-28` lo registra como observación, `R-11` sigue vigente.
- El agente no elige destinatario ni monto, y `pay` revisa la cotización otra vez: `SPEC.md` §8 (riesgos) y los tests
  de [evidencia/T128.md](../evidencia/T128.md) ("refuses a quote whose amount / payTo / asset the store changed").
- La red rechaza un pago sobre el tope (`PerTxExceeded`, en simulación y sin enviar nada):
  [evidencia/T128.md](../evidencia/T128.md) §4.
- El monto: el imán a 490 CLP se cobró en 0,5157895 USDC ([ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md)).

**Plan B:**

| Si pasa esto | Haz esto y di esto |
|---|---|
| Claude no cotiza en 60 s, o el conector pide iniciar sesión y no entra | Sigue con la compra de la mañana (§2.5): "Esta compra la hizo Claude esta mañana, con este mismo conector." |
| Claude cotiza pero no quiere pagar | "Esto también es diseño: el agente no mueve dinero sin que una persona apriete el botón." Sigue con la compra de la mañana (`R-11`) |
| Claude responde que "el clasificador de permisos del modo automático bloqueó `pay`" | Cambia el modo de permisos del chat (§2.5 paso 2b) y escribe "Reintenta el pago de esa cotización". Si pasa de 10 minutos la cotización vence: Claude genera otra y la muestra antes |
| `pay` falla con `RailInsufficientFunds` o un tope | "El contrato acaba de decir que no: así se ve un límite que pone la red." Sigue con la compra de la mañana |
| No hay internet | Video del ensayo (§2.8) |

### Bloque 4 · La compra aparece sola

**Pantalla:** pestaña 4, `/en-vivo`. La compra nueva está arriba (o aparece en los próximos segundos).

**Voz:**

> Esta página lee la red cada diez segundos. Nadie la actualizó: la compra que acabo de hacer apareció sola, con el
> producto, el monto y la hora.

**Respaldo:** [evidencia/T151.md](../evidencia/T151.md) §6; de dónde sale cada dato, `R-30`.

**Plan B:** si a los 20 s no aparece, muestra la compra de la mañana: "Así se ve la de esta mañana; la de ahora
aparece en unos segundos más."

### Bloque 5 · El recibo

**Pantalla:** en la fila de la compra, clic en **Recibo**. Se abre, en una pestaña nueva, la página del recibo de la
tienda, con la verificación en verde y las tres pruebas. Abre en inglés ("Valid receipt: all three checks pass"):
pulsa **ES** arriba a la derecha.

**Voz:**

> La tienda firma un recibo de cada venta y lo ancla en Stellar. Esta página lo comprueba contra la red: la firma de
> la tienda, el ancla y el pago. Las tres, en verde. Y cualquiera puede hacer esta misma comprobación por su cuenta,
> sin confiar en nosotros.

**Respaldo:** la página del recibo (`/receipts/<hash>`) muestra las tres pruebas; el verificador independiente
(`pnpm run vitrinee:verify`, `apps/vitrinee-agent/src/verify-cli.ts`) revisa firma, ancla y pago sin pasar por la
tienda: corrida real el 8-oct sobre `ord_mv079z6634dbf7e9d1`.

**Plan B:** pestaña 8, el recibo de la compra del 8-oct.

### Bloque 6 · El reclamo en vivo

Sobre la compra de la mañana (§2.5.3), no sobre la que se acaba de hacer. Ensayado el 9-oct de punta a punta
([ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md)).

**Los tres papeles, para que los expliques:** el **comprador** es Claude, que firma el reclamo con la llave del agente
que pagó. La **tienda** responde en su página, con su wallet. El **árbitro** revisa, pide un veredicto y, con la
confirmación de una persona, hace que el contrato devuelva el dinero: hoy es una persona con esta pantalla. La tienda no
puede entrar al chat del comprador: el árbitro le entrega el reclamo firmado, y como está firmado nadie puede cambiarlo
en el camino.

**6a · Claude firma el reclamo.** Pestaña 3, claude.ai, en el mismo chat o en uno nuevo. Escribe, con la orden de la
mañana:

> Con AgentPey, abre un reclamo de reembolso por mi orden ord_… en agentcommerce. Motivo: no me llegó; la tienda me
> avisó que no tiene stock. Pide el monto completo.

Si Claude pregunta antes de firmar, dile que sí. Claude firma el reclamo y dice que no lo abre (lo abre el árbitro).
Después:

> Muéstrame el claim_jws completo en un bloque de código.

Copia el bloque con su botón de copiar (arriba a la derecha del bloque). En el ensayo del 9-oct tardó unos 30 s en
escribirlo entero.

**Voz:**

> Ahora lo más importante: ¿qué pasa si una compra sale mal? Esta mañana Claude compró otro imán, y la tienda me
> avisó que no tiene stock. Le pido a Claude que abra un reclamo. Claude lo firma con la llave del agente que pagó:
> nadie más puede reclamar por esta compra.

**6b · El árbitro abre la disputa.** Pestaña 6, la pantalla del árbitro. En el paso 1, pega el reclamo (`Cmd+V`) y
pulsa **Abrir la disputa**. Tarda unos 20 s. Salen tres ✅ (recibo, firmante, plazo), el monto bloqueado y la garantía
de la tienda. Pasa a la pestaña 4, `/en-vivo`: la compra de la mañana muestra **Disputa abierta · 0,52 USDC
bloqueados** (aparece en unos segundos).

**Voz:**

> Hoy el árbitro soy yo, con esta pantalla. Revisa que el recibo sea válido, que quien reclama controle la cuenta
> que pagó y que esté dentro del plazo. Y abre la disputa en Stellar: el monto queda bloqueado en una garantía que la
> tienda dejó en el contrato.

**6c · La tienda responde.** Pestaña 5, `agentpey.com/resolve/responder` (también la abre el botón del paso 2 de la
pantalla del árbitro):

1. Pega el reclamo en el cuadro "O pega el reclamo aquí" (`Cmd+V`: sigue en tu portapapeles) y pulsa **Leer el
   reclamo**. La página muestra el motivo, lo que dice el comprador, la evidencia y el monto.
2. Pulsa **Conectar wallet** (arriba a la derecha) y aprueba en Freighter, con la cuenta `GD2MCESI…K5GN`, que es la
   de cobro de la tienda.
3. Elige "Lo acepto completo" y escribe: "Confirmo que no tengo stock del imán y que el pedido no se despachó. Acepto
   devolver el monto completo."
4. **Firmar con tu wallet**, aprueba en Freighter y descarga el archivo de respuesta.

**Voz:**

> Ahora soy la tienda. Yo no puedo entrar al chat del comprador: el árbitro me entrega su reclamo firmado, y como
> está firmado nadie pudo cambiarlo. Lo leo y respondo con mi propia firma, desde la cuenta que recibió el pago:
> acepto, no tengo stock.

**6d · El árbitro de IA decide.** Pestaña 6. En el paso 2 pulsa **Usar la última descarga**: sale ✅ la firma de la
tienda, ✅ que responde a esa disputa, su posición y sus descargos. En el paso 3 pulsa **Pedir el veredicto**. Tarda
entre 30 y 90 segundos. Sale **"Reembolso completo"**, el razonamiento del árbitro y el hash del veredicto.

**Voz, mientras piensa:**

> Un árbitro de IA lee el recibo, el reclamo y la respuesta firmada, y escribe un veredicto con sus razones. No mueve
> dinero: solo propone.

**Voz, cuando sale:** lee en voz alta una o dos frases del razonamiento (en el ensayo: "No entregar un producto ya
pagado es una falla de la que responde el comercio, así que corresponde el reembolso total").

**6e · Una persona confirma y el contrato paga.** En el paso 3 pulsa **Copiar el hash**; en el paso 4 pégalo
(`Cmd+V`). El botón **Confirmar y pagar el reembolso** se activa solo cuando el hash es el exacto. Púlsalo (unos 20 s).
Sale "Reembolso pagado", el estado `Resolved` y las comprobaciones en la red. Pestaña 4, `/en-vivo`: la compra muestra
**Reembolsados 0,52 USDC**.

**Voz:**

> Una persona confirma el veredicto escribiendo su hash, y recién ahí el contrato devuelve el dinero a la cuenta que
> pagó. Todo quedó en la red: la disputa, el veredicto y el reembolso.

**Respaldo:** [ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md) (los pasos, con sus salidas y transacciones; la pantalla ejecuta
los mismos comandos, [evidencia/T155.md](../evidencia/T155.md)); el reembolso real del 8-oct,
[evidencia/T124-reembolso-real.md](../evidencia/T124-reembolso-real.md); la confirmación humana antes de pagar, `E-18`;
el plazo de 48 h para la tienda, `E-22`; que la respuesta de la tienda viaja como archivo firmado, `E-21`.

**Plan B:**

| Si pasa esto | Haz esto y di esto |
|---|---|
| Claude no firma el reclamo | Pestaña 4, la fila de `ord_mv17vh…` con **Reembolsados 0,52 USDC**: "Este es el mismo reclamo, hecho hoy desde Claude." Cuenta los pasos con la pestaña 9 |
| La pantalla del árbitro no abre la disputa | Lee el error que muestra (dice qué prueba falló) y sigue con el plan B de arriba |
| Freighter no firma | El plan B de arriba |
| El veredicto tarda más de 90 s o falla | Pestaña 9, el veredicto del ensayo: "Así razonó el árbitro hoy" |
| El pago falla | La disputa queda abierta y con el monto bloqueado: no se pierde nada. Muestra el reembolso del ensayo |
| La pantalla del árbitro no carga | Los mismos pasos con los atajos de `reclamo.zsh` (§2.6), sin mostrar la terminal hasta el veredicto |

### Bloque 7 · Un equipo pone el presupuesto

**Pantalla:** pestaña 7, la página del presupuesto del equipo: el día de hoy, tres pagos y el rechazo destacado.

**Voz:**

> Lo mismo sirve para una empresa. Este equipo le da a su agente treinta centavos de dólar al día para comprar
> créditos de IA. Hace un rato, el agente intentó cuatro compras. Tres se pagaron en Stellar. La cuarta se rechazó
> antes de firmar nada. Y el contrato que paga tiene, además, sus propios topes en la red.

**Respaldo:** [evidencia/T146.md](../evidencia/T146.md) §6 (en producción) y [evidencia/T153.md](../evidencia/T153.md);
quién aplica cada tope, `R-27`: el 0,30 diario lo revisa PolicyRail antes de firmar, y la red aplica los topes del
rail.

**Plan B:** es un archivo local, no depende de la red. Si no se abrió, la captura.

### Bloque 8 · Cierre

**Pantalla:** pestaña 1, la portada, en la sección *"Lo que los agentes ya pueden hacer"*.

**Voz:**

> ¿Por qué Stellar? Porque el límite vive fuera del agente: el contrato revisa el tope en la misma transacción que
> mueve el dinero. No lo cumple nuestro software, lo cumple la red. Y el pago en USDC se confirma en segundos.
>
> Todo esto habla estándares abiertos: UCP, para que un agente compre en cualquier tienda que lo hable, y los
> mandatos de AP2. ChatGPT también compró por el mismo conector. Y publicamos un paquete en npm para que cualquier
> agente pague así en Stellar.
>
> Hoy es testnet, con tres tiendas nuestras y más de veinte compras hechas por agentes, cada una con su recibo
> anclado en la red. Lo que sigue es una tienda que no es nuestra, vendiéndoles a agentes. Si tienes un comercio y
> quieres probarlo, hablemos.
>
> AgentPey: agentes que compran, con límites que pone la red. Gracias.

**Respaldo:** el tope dentro de la transferencia, `__check_auth` del `policy_rail`
([evidencia/T128.md](../evidencia/T128.md) §7); UCP en dos versiones ([evidencia/T133.md](../evidencia/T133.md)); AP2
verificado por la librería oficial ([evidencia/T134.md](../evidencia/T134.md)); ChatGPT llamó `pay` tras la
confirmación ([evidencia/T129.md](../evidencia/T129.md) §2); `@agentpey/ucp-stellar` en npm
([evidencia/T136.md](../evidencia/T136.md)); "más de veinte compras", `GET /api/live` (§2.3; si da menos de 20, di
"decenas de compras"); la tienda de terceros es T130, pendiente (`SPEC.md`).

## 4. Preguntas probables

| Pregunta | Respuesta corta | Respaldo |
|---|---|---|
| ¿Es dinero real? | No: USDC de testnet. Mainnet está fuera de alcance por ahora | `CLAUDE.md`, regla 5 |
| ¿Puedo conectar mi Claude? | En el piloto solo entra la wallet dueña del rail; la guía para conectar está en el README del MCP | `R-11`, revisión de T152 |
| ¿Qué pasa si el agente intenta gastar más? | El contrato rechaza la transferencia: la red rechazó un pago sobre el tope, en simulación y sin enviar nada | [evidencia/T128.md](../evidencia/T128.md) §4 |
| ¿Por qué la tienda recibe el reclamo como un texto o un archivo? | La tienda no entra al chat del comprador: el árbitro le entrega el reclamo firmado, y la firma impide que alguien lo cambie. Hoy se pega a mano; una bandeja automática de reclamos está anotada para después | `E-21` |
| ¿Quién decide una disputa? | Un árbitro de IA propone un veredicto con sus razones y una persona lo confirma antes de pagar | `E-18`, [ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md) |
| ¿De dónde sale el reembolso? | De una garantía que la tienda deja en el contrato de disputas | [ENSAYO-RECLAMO.md](ENSAYO-RECLAMO.md) §0 y §5 |
| ¿Y si la tienda no responde? | Tiene 48 horas; después, el árbitro decide sin su respuesta | `E-22` |
| ¿Funciona con otros agentes? | ChatGPT compró por el mismo conector. Grok Bot pide un plan pago, dots no acepta conectores propios y Muse solo funciona en EE. UU. | [evidencia/T129.md](../evidencia/T129.md), `R-29` |
| ¿La suite oficial de UCP pasa? | 49 de 77 tests, en local contra una tienda de prueba; 8 fallan y 20 se saltan, cada uno con su motivo | [evidencia/T131.md](../evidencia/T131.md), portada |

## 5. Lo que no se dice

- **Que cualquiera puede conectar su Claude o ChatGPT.** En el piloto solo inicia sesión la wallet dueña del rail
  (revisión de T152).
- **Que la red aplica el presupuesto del equipo.** El 0,30 diario lo revisa PolicyRail antes de firmar; la red aplica
  los topes del rail (`R-27`, revisión de T152).
- **Que un contrato pone tope a todo pago.** Vale para Claude y ChatGPT, que pagan desde un `policy_rail`; el SDK
  también puede pagar desde una cuenta clásica (revisión de T152).
- **Que Claude siempre paga solo.** Pagó él mismo **después del sí de la persona** (`R-28`), y antes se negaba
  (`R-11`). Si hoy se niega, es el diseño, no una falla.
- **Que Claude abre la disputa.** Claude **firma** el reclamo; la disputa la abre el árbitro, que hoy es una persona
  con su pantalla. Lo mismo con la respuesta de la tienda: se sube como archivo en la página.
- **Que el pago quedó retenido.** El pago fue directo a la tienda; el reembolso sale de una garantía que la tienda
  dejó en el contrato de disputas.
- **Que la compra recién hecha es la del reclamo.** El reclamo es sobre la compra de la mañana. Cada pieza se muestra
  funcionando por separado.
- **Que la suite de UCP "pasa" sin su alcance** (49 de 77, local, tienda de prueba).
- **Que hay una tienda de terceros.** T130 sigue pendiente; la tienda de Shopify es nuestra.
- **Números de la portada escritos a mano.** Los del hero se leen en vivo; si dicen "n/a", no los cites.
