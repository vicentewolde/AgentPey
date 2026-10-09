# Demo Day de Tellus · escaleta minuto a minuto

> **Viernes 9-oct, en la tarde (hora de Chile).** 5 minutos sin contar preguntas, presencial, con el wifi del
> lugar y una sala mixta (mentores, inversionistas, otros founders). Compra en vivo con plan B.
>
> Cada afirmación de la voz tiene su evidencia en el repo (columna **Respaldo**). Lo que no se puede decir está en
> §5: incluye lo que se corrigió en la revisión de T152.
>
> **Deploy:** Render despliega con cada push a `main` (sin filtro de rutas en `render.yaml`), también si solo cambia
> un documento. No se mergea nada a `main` entre el chequeo previo y el final de la presentación. Si hubo un merge
> después del chequeo, vuelve a correr §2.2.

## 1. Cómo se ve

| Bloque | Tiempo | Pestaña | Idea |
|---|---|---|---|
| 1 · El problema | 0:00 a 0:40 | Portada | Un agente con tu tarjeta gasta lo que quiera |
| 2 · Claude compra | 0:40 a 2:10 | claude.ai | El agente cotiza, tú dices sí, el contrato paga |
| 3 · Aparece sola | 2:10 a 2:40 | `/en-vivo` | La red lo registra, nadie actualiza nada |
| 4 · El recibo | 2:40 a 3:20 | Terminal | Cualquiera lo verifica; si lo tocas, se rompe |
| 5 · La disputa | 3:20 a 4:00 | `/en-vivo` | Si sale mal, el dinero vuelve |
| 6 · El presupuesto | 4:00 a 4:30 | Página del equipo | Un equipo pone el tope; la cuarta compra no pasa |
| 7 · Cierre | 4:30 a 5:00 | Portada | Estándar abierto, en testnet, lo que sigue |

Unas 450 palabras de voz en 5 minutos: hay aire para lo que tarde Claude. Si vas atrasado al llegar al bloque 6,
sáltalo y di su frase en el cierre.

### Pestañas, en este orden, en una sola ventana

1. `https://agentpey.com` (en EN, botón arriba a la derecha)
2. `https://claude.ai`, chat nuevo, con el conector **AgentPey** activo en el menú de herramientas
3. `https://agentpey.com/en-vivo` (abierta **antes** de la compra, para que la compra aparezca sola)
4. Terminal en `~/dev/AgentPay`, letra grande, con la función `verificar` cargada (§2.6)
5. `.team-budget/resumen-2026-10.html` (la abre `team:summary -- --html`, §2.7)

Pestañas de plan B, a la derecha, en otra ventana (§3):

6. `https://agentcommerce.vitrinee.agentpey.com/receipts/75559088467f4b465976bca459813dc53ede5f4d96e46369288202450377ac7c`
   (recibo de la compra de Claude del 8-oct, `ord_mv079z6634dbf7e9d1`)
7. `https://stellar.expert/explorer/testnet/tx/4ae1024f85fcda83441e19871bf71cbcd107b9bbdfaaa9b6957f28a20e869240`
   (su pago en Stellar)
8. `https://stellar.expert/explorer/testnet/tx/fbdd6e741ba92122fd3c5221b429048787166d8b9bdfacaececc6c6d917ee22a`
   (el reembolso del 8-oct)
9. El video del ensayo (§2.8) y la carpeta de capturas, abiertos en el escritorio

## 2. Chequeo previo: una hora antes

Corre todo desde `~/dev/AgentPay`. Ningún comando de esta lista mueve dinero, salvo §2.4 (recarga, solo si hace
falta) y §2.7 (el presupuesto del equipo, 0,30 USDC del rail UCP). Al final de cada paso está la respuesta esperada
(medida el 8-oct en la tarde).

### 2.1 ¿Hubo un deploy desde la última vez?

```bash
git fetch -q && git log --oneline -3 origin/main
```

Espera: el último commit es el que viste el día anterior (el 8-oct era `825682e`). Si hay uno nuevo, espera a que
Render termine el deploy y entonces sigue con 2.2.

### 2.2 Páginas y MCP

```bash
for u in https://agentpey.com/ https://agentpey.com/en-vivo https://agentpey.com/tiendas https://agentpey.com/api/live https://mcp.agentpey.com/.well-known/oauth-protected-resource/mcp https://mcp.agentpey.com/mcp https://agentcommerce.vitrinee.agentpey.com/.well-known/ucp; do printf "%s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$u")" "$u"; done
```

Espera:

| Código | URL | Si no |
|---|---|---|
| 200 | `agentpey.com/`, `/en-vivo`, `/tiendas`, `/api/live` | Plan B de cada bloque (§3) |
| 200 | `mcp.agentpey.com/.well-known/oauth-protected-resource/mcp` | El MCP está caído: ver §3, bloque 2 |
| 401 | `mcp.agentpey.com/mcp` | Es lo correcto: pide inicio de sesión, así que está arriba |
| 200 | `agentcommerce.vitrinee.agentpey.com/.well-known/ucp` | La tienda no responde: compra de plan B |

La ruta `/.well-known/oauth-protected-resource` **sin** `/mcp` da 404 aunque el MCP esté arriba. No sirve como
chequeo. Si el MCP da 503 justo después de un deploy, espera un par de minutos: desde `R-32`, una app que arranca
tarde se suma cuando responde.

### 2.3 Lo que muestra `/en-vivo`

```bash
curl -s https://agentpey.com/api/live | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['totals']);print([(s['slug'],s['ok']) for s in d['stores']])"
```

Espera las tres tiendas en `True`, `disputes_resolved` en 2 y `refunded_usdc` en `1.5684211`. El 8-oct:
`purchases` 32 y `usdc` 57.4125273 (crecen con cada compra).

### 2.4 Saldo de los rails

El comando de recarga sin `--yes` no envía nada: solo muestra el saldo de la reserva y del rail.

```bash
pnpm -s run rail:topup -- CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L 1
```

```bash
pnpm -s run rail:topup -- CBDRI5B72VWNZGRVUXNMUNOSYWXGB7RZLK5ITRVOVSGOS4VXPCRMD3YA 1
```

Espera `Nothing was sent.` y:

- **Rail del MCP (`CB4WVTJ4…FRQ6L`): 5,00 USDC o más.** Desde el 8-oct en la noche el imán cuesta **490 CLP**, unos
  0,52 USDC (antes 1.490 CLP, 1,5684211 USDC), y la taza 1.490 CLP, unos 1,57 USDC. El usuario bajó los precios en
  Shopify para que el tope del rail no corte la demo ni las tomas del video.
- **Rail UCP (`CBDRI5B7…D3YA`): 0,30 o más** para §2.7.

El 8-oct en la noche se recargaron los dos con 20 USDC de testnet desde la reserva: el del MCP quedó en
**22,6842103** (tx `14bf6c51…4eec`) y el UCP en **30,4631577** (tx `d69de28e…b038`). Con eso el saldo no debería ser
un problema hasta el 12-oct. Si alguno bajara de 5,00, recárgalo (el comando permite hasta 20 por vez):

```bash
pnpm run rail:topup -- CB4WVTJ4LVB6GUWSTJE4FQ2MH364Q2HW3FHXGSZF4KJ55SGEBIFGRQ6L 20 --yes
```

Espera `sent. rail now … USDC` con su `tx`.

**El saldo no es lo único: el rail del MCP tiene un tope de 3,00 por compra y 5,00 por día UTC**, que la plata no
cambia. Cuenta las compras del día:

| Producto | Precio | USDC aprox. | Compras por día con el tope de 5,00 |
|---|---|---|---|
| Imán | 490 CLP | 0,52 | 9 |
| Posavasos | 990 CLP | 1,04 | 4 |
| Taza | 1.490 CLP | 1,57 | 3 |

Con el imán caben el ensayo, la compra en vivo y varios reintentos. Una cotización sin pagar también reserva su
monto del día durante 10 minutos.

El día UTC empieza a las 21:00 de Chile (UTC-3). Una presentación entre las 15:00 y las 21:00 cae en el mismo día UTC
que el ensayo de una hora antes.

### 2.5 Claude y su conector

1. En claude.ai: Settings → Connectors. **AgentPey** dice conectado.
2. Freighter desbloqueado, en **Testnet**, con la cuenta `GD2MCESI…K5GN` seleccionada: es la única wallet que inicia
   sesión en el MCP. Si el conector pide iniciar sesión otra vez, firmas con ella.
3. En un chat nuevo, con el conector activo, escribe:

   > Using AgentPey, search agentcommerce for a magnet. Don't quote anything.
   >
   > *(en español: Con AgentPey, busca un imán en agentcommerce. No cotices nada.)*

   Espera: el **Imán de cobre Atacama** a 490 CLP. Solo busca: una cotización sin pagar reserva el presupuesto del
   día durante 10 minutos.

### 2.6 La terminal

Carga una vez la función que baja el recibo de una orden y lo verifica sin pasar por la tienda:

```bash
verificar() { curl -s "https://agentcommerce.vitrinee.agentpey.com/ucp/v1/orders/$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["receipt"]["jws"])' > /tmp/recibo.jws && pnpm -s run vitrinee:verify -- /tmp/recibo.jws "${@:2}"; }
```

```bash
verificar ord_mv079z6634dbf7e9d1
```

Espera tres ✅ (`firma`, `anclaje`, `pago`) y `✅ RECIBO VÁLIDO`. Con `--tamper` al final, cuatro ❌ y
`❌ RECIBO INVÁLIDO`, seguido de `[ELIFECYCLE] Command failed with exit code 1`: es lo esperado (el comando sale con
error porque el recibo es inválido). Después, `clear`.

La salida del verificador está en español: es la del CLI y no se cambia antes de la demo (el código se congela el
10-oct).

### 2.7 El presupuesto del equipo de hoy

Paga 0,30 USDC del rail UCP a SignalDesk en producción. El tope del equipo se reinicia a medianoche UTC, así que el
viernes hay presupuesto nuevo.

```bash
pnpm run team:pay -- --times 4
```

Espera tres compras con `pagada sí` y su transacción, y la cuarta:
`rechazada ScopeDailyLimitExceeded: the total for today would exceed the per-day limit` con `firmado nada`.

```bash
pnpm run team:summary -- --html
```

Espera que se abra `.team-budget/resumen-2026-10.html` con los pagos de hoy y el rechazo destacado. Es un archivo
local: se ve igual sin internet. Déjalo en la pestaña 5.

### 2.8 El ensayo grabado (tu plan B sin internet)

Con la grabación de pantalla de macOS (Cmd+Shift+5, "Grabar pantalla completa"), haz los bloques 2 a 4 una vez, de
verdad: la compra en claude.ai, `/en-vivo` y `verificar <orden>`. Guarda el video en el escritorio. Gasta un imán del
rail del MCP (unos 0,52 USDC, §2.4).

Saca también una captura de cada pestaña (Cmd+Shift+4) a una carpeta `demo-day` en el escritorio.

### 2.9 La sala

- Prueba el wifi del lugar con 2.2. Ten el hotspot del celular listo y probado: si el wifi falla, cambias de red y
  sigues.
- Cargador, "No molestar" activado, notificaciones de Slack y correo cerradas.
- Zoom del navegador en 125 % y la terminal con letra grande.
- `/en-vivo` abierta y en EN. La portada en EN.

## 3. Escaleta

**Pantalla** es lo que haces. **Voz** es lo que dices. **Respaldo** es la evidencia de cada afirmación.
**Plan B** es qué haces si ese paso falla.

### Bloque 1 · El problema (0:00 a 0:40)

**Pantalla:** pestaña 1, la portada, quieta en el titular
*"AI agents buying at real stores, with limits the network enforces."*
(*"Agentes de IA comprando en tiendas reales, con límites que aplica la red."*)

**Voz:**

> Los agentes de IA ya pueden comprar por nosotros. El problema es la confianza. Si le das tu tarjeta a un agente,
> puede gastar lo que quiera. Y si las reglas están escritas en su prompt, una sola línea inyectada las cambia.
> AgentPey pone los límites en Stellar, en un contrato que el agente no puede tocar. Les voy a mostrar lo que ya
> funciona, en vivo, en testnet.

**Respaldo:** la tesis, en `docs/fase-1-agentpass/CONTEXTO.md`; la portada al día, en
[evidencia/T152.md](../evidencia/T152.md).

**Plan B:** si la portada no carga, empieza con la captura de la portada y pasa directo al bloque 2.

### Bloque 2 · Claude compra (0:40 a 2:10)

**Pantalla:** pestaña 2, claude.ai. Escribe:

> Using AgentPey, buy one Atacama copper magnet from agentcommerce. Show me the exact amount before you pay.
>
> *(en español: Con AgentPey, compra un imán de cobre Atacama en agentcommerce. Muéstrame el monto exacto antes de
> pagar.)*

**Voz, mientras Claude busca y cotiza:**

> Esta es una tienda en Shopify, de prueba y nuestra, que habla el estándar abierto para que los agentes compren.
> Claude busca el producto y le pide una cotización. Fíjense en algo: Claude no decide a quién pagarle ni cuánto. Eso viene de la
> cotización de la tienda, y el servidor la vuelve a revisar justo antes de pagar.

**Pantalla:** Claude muestra el monto (unos 0,52 USDC por 490 CLP; el exacto, en el ensayo). Escribe:

> Yes, pay it.
>
> *(en español: Sí, paga.)*

**Voz:**

> Yo digo que sí, sobre ese monto exacto. El pago sale de un contrato en Stellar que tiene un tope por compra y otro
> por día. Si se intenta pagar más que el tope, la red lo rechaza, diga lo que diga el agente.

**Pantalla:** Claude responde con la orden (`ord_…`). Selecciona el número de orden con doble clic y cópialo.

**Respaldo:**

- Claude busca, cotiza y paga después del sí de la persona: [evidencia/T150.md](../evidencia/T150.md) §5 y
  [evidencia/T151.md](../evidencia/T151.md) §6; `R-28` lo registra como observación, `R-11` sigue vigente.
- El agente no elige destinatario ni monto, y `pay` revisa la cotización otra vez: `SPEC.md` §8 (riesgos) y los tests
  de [evidencia/T128.md](../evidencia/T128.md) ("refuses a quote whose amount / payTo / asset the store changed").
- La red rechaza un pago sobre el tope (`PerTxExceeded`): [evidencia/T128.md](../evidencia/T128.md) §4.
- La tienda (`agentcommerce`, nuestra tienda de prueba en Shopify) crea un pedido real en Shopify y habla UCP:
  [evidencia/T128.md](../evidencia/T128.md) §6 y §7.

**Plan B:**

| Si pasa esto | Haz esto y di esto |
|---|---|
| Claude no cotiza en 60 s, o el conector pide iniciar sesión y no entra | Pestaña 6 (recibo de ayer). "Esta compra la hizo Claude ayer, con este mismo conector." Sigue en el bloque 3 con esa orden |
| Claude cotiza pero no quiere llamar `pay` | "Esto también es diseño: el agente no mueve dinero sin que una persona apriete el botón." Pestaña 6, y sigue con la orden de ayer (`R-11`) |
| `pay` falla con `RailInsufficientFunds` o un tope | "El contrato acaba de decir que no: así se ve un límite que pone la red." Pestaña 6 |
| No hay internet | Video del ensayo (§2.8), desde la compra |

### Bloque 3 · La compra aparece sola (2:10 a 2:40)

**Pantalla:** pestaña 3, `/en-vivo`, que estaba abierta desde antes. La compra nueva está arriba (o aparece en los
próximos segundos). Haz clic en **Payment**: se abre la transacción en stellar.expert.

**Voz:**

> Esta página lee la red cada 10 segundos. Nadie la actualizó: la compra que acabo de hacer apareció sola, con el
> producto, el monto y la hora. Y esta es la transacción en Stellar: salió del contrato con tope y llegó a la cuenta
> de la tienda.

**Respaldo:** [evidencia/T151.md](../evidencia/T151.md) §6 (una compra de Claude apareció sola); de dónde sale cada
dato, `R-30`; el pago va del rail a la cuenta de cobro: [evidencia/T128.md](../evidencia/T128.md) §7.

**Plan B:** si a los 20 s no aparece, sigue hablando y muestra la fila de ayer (`ord_mv079z…`, imán, 1.57 USDC):
"Así se ve la de ayer; la de hoy aparece en unos segundos más." Si `/en-vivo` no carga: pestañas 6 y 7.

### Bloque 4 · El recibo que cualquiera verifica (2:40 a 3:20)

**Pantalla:** pestaña 4, la terminal. Escribe `verificar ` y pega la orden de hoy:

```bash
verificar ord_<la de hoy>
```

Salen tres ✅. Después, la misma orden con el monto manipulado:

```bash
verificar ord_<la de hoy> --tamper
```

**Voz:**

> La tienda firma un recibo de cada venta y lo ancla en Stellar. Cualquiera lo puede revisar sin confiar en
> nosotros ni en la tienda: la firma, el ancla en la red y el pago. Ahora le cambio el monto, sin tocar nada más.
> Las tres pruebas fallan.

**Respaldo:** el verificador revisa firma, ancla y pago sin pasar por la tienda
(`apps/vitrinee-agent/src/verify-cli.ts`); corrida real sobre `ord_mv079z6634dbf7e9d1` el 8-oct, en verde y en
rojo con `--tamper` (salida en §2.6).

**Plan B:** si la terminal no llega a la red, `verificar ord_mv079z6634dbf7e9d1` ya está más arriba en la terminal
desde el chequeo; si no, la pestaña 6: "la página de la tienda muestra las mismas tres pruebas".

### Bloque 5 · Si algo sale mal, el dinero vuelve (3:20 a 4:00)

**Pantalla:** pestaña 3, `/en-vivo`. Baja hasta la fila de `ord_muq1gqhycf4961492c` (imán, 1 de octubre) con la
insignia **Refunded 1.57 USDC**. Señala el enlace **Verdict on-chain**.

**Voz:**

> Esta es otra compra, del 1 de octubre, que la tienda nunca preparó. El comprador firmó un reclamo. La tienda
> respondió con su propia firma y aceptó. Un árbitro de IA escribió un veredicto con sus razones, y una persona lo
> confirmó antes de mover el dinero. El contrato devolvió 1,57 USDC desde una garantía que la tienda dejó en Stellar.
> Lo hicimos de verdad, ayer.

**Respaldo:** [evidencia/T124-reembolso-real.md](../evidencia/T124-reembolso-real.md) (reclamo §2, respuesta de la
tienda §3, veredicto `refund_full` §4, confirmación de una persona y reembolso §5, la orden con la disputa resuelta
§6); el texto aprobado de la portada (tarjeta "Disputes that end in a refund").

**Plan B:** pestaña 8, el reembolso en stellar.expert.

### Bloque 6 · Un equipo pone el presupuesto (4:00 a 4:30)

**Pantalla:** pestaña 5, la página del presupuesto del equipo: el día de hoy, tres pagos y el rechazo destacado.

**Voz:**

> Lo mismo sirve para una empresa. Este equipo le da a su agente 0,30 USDC al día para comprar créditos de IA. Hace
> una hora, el agente intentó cuatro compras. Tres se pagaron en Stellar. La cuarta se rechazó antes de firmar nada.
> Y el contrato que paga tiene, además, sus propios topes en la red.

**Respaldo:** [evidencia/T146.md](../evidencia/T146.md) §6 (en producción) y [evidencia/T153.md](../evidencia/T153.md);
quién aplica cada tope, `R-27`: el 0,30 diario lo revisa PolicyRail antes de firmar, y la red aplica los topes del
rail.

**Plan B:** es un archivo local, no depende de la red. Si no se abrió, la captura.

### Bloque 7 · Cierre (4:30 a 5:00)

**Pantalla:** pestaña 1, la portada, en la sección *"What agents can do today"* (*"Lo que los agentes ya pueden
hacer"*).

**Voz:**

> Todo esto habla estándares abiertos: UCP, para que un agente compre en cualquier tienda, y los mandatos de AP2.
> ChatGPT también compra por el mismo conector. Y dejamos un paquete en npm para que cualquier agente pague así en
> Stellar. Hoy es testnet. Lo que sigue: una tienda que no es nuestra. AgentPey: agentes que compran, con límites
> que pone la red.

**Respaldo:** UCP en dos versiones ([evidencia/T133.md](../evidencia/T133.md)); AP2 verificado por la librería oficial
([evidencia/T134.md](../evidencia/T134.md)); ChatGPT llamó `pay` tras la confirmación
([evidencia/T129.md](../evidencia/T129.md) §2); `@agentpey/ucp-stellar` en npm
([evidencia/T136.md](../evidencia/T136.md)); la tienda de terceros es T130, pendiente (`SPEC.md`).

## 4. Preguntas probables

| Pregunta | Respuesta corta | Respaldo |
|---|---|---|
| ¿Es dinero real? | No: USDC de testnet. Mainnet está fuera de alcance por ahora | `CLAUDE.md`, regla 5 |
| ¿Puedo conectar mi Claude? | En el piloto solo entra la wallet dueña del rail; la guía para conectar está en el README del MCP | `R-11`, revisión de T152 |
| ¿Qué pasa si el agente intenta gastar más? | El contrato rechaza la transferencia: la red rechazó un pago sobre el tope, en simulación y sin enviar nada | [evidencia/T128.md](../evidencia/T128.md) §4 |
| ¿Quién decide una disputa? | Un árbitro de IA propone un veredicto con sus razones y una persona lo confirma antes de pagar | `E-18`, [evidencia/T124-reembolso-real.md](../evidencia/T124-reembolso-real.md) |
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
- **Que el reclamo lo firmó el agente.** Lo firmó el comprador (revisión de T152).
- **Que la compra de hoy y la disputa están conectadas.** Son compras distintas: la disputa es del 1-oct. Cada pieza
  se muestra funcionando por separado. Nada de que el chat abre disputas, que el pago queda retenido o que el
  despacho libera el pago.
- **Que la suite de UCP "pasa" sin su alcance** (49 de 77, local, tienda de prueba).
- **Que hay una tienda de terceros.** T130 sigue pendiente.
- **Números de la portada escritos a mano.** Los del hero se leen en vivo; si dicen "n/a", no los cites.
