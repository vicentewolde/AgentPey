# Hoja de marcas · grabación del martes 13-oct

Cómo se usa: grabas **sin voz**, clip por clip, a ritmo normal. Yo pongo tu voz clonada (en inglés, con subtítulos en español) y ajusto cada clip al largo
de su frase (acelero las esperas, recorto los silencios). Esta hoja dice **qué clip grabar, qué debe verse al final y
cuánto aguantar**. Los tiempos de la voz son exactos (los de la voz **en inglés**, no los de la primera versión); los de la pantalla los ajusto yo.

## Reglas para todos los clips

1. **La misma ventana que en la escena 0**: Chrome a pantalla completa, con la barra de marcadores visible, mismo zoom.
   Yo recorto la parte de arriba (pestañas y extensiones) con las mismas medidas; si cambia el tamaño, el recorte falla.
2. **Cmd+Shift+5, "Grabar pantalla completa"**, sin micrófono. Empieza a grabar, **espera 3 s quieto**, haz lo tuyo,
   y al final **espera 3 s quieto** antes de parar. Esos segundos me dan margen para cortar bien.
3. **El mouse, lento y con intención.** Que no tiemble ni cruce la pantalla sin motivo. Cuando no haga falta, déjalo
   en un borde, fuera del texto.
4. **Todo en inglés**: botón **EN** arriba a la derecha en las páginas de AgentPey y lo que escribes en Claude, en inglés.
5. **No muestres**: claves, `.env.local`, ni el token de Freighter. La barra de direcciones la recorto yo, así que la
   clave `?k=` de la pantalla del árbitro no se ve.
6. **Si algo sale mal, repite el clip entero.** No importa gastar tomas, salvo en la escena 2 (cada una es una compra real).
7. **Nombra cada archivo** con la clave de la tabla (`1A`, `2`, `3`…) y déjalos en el escritorio. Yo los muevo.
8. **No muevas las pestañas ni cambies de ventana** entre un clip y otro de la misma escena.

## El orden recomendado para el martes

| Paso | Qué | Gasta cupo |
|---|---|---|
| 0 | **Antes de grabar**: chequeo de `GUION-VIDEO.md` §2 (sin deploy nuevo, MCP arriba, saldo, imán a 490 CLP). La compra del reclamo **ya existe**: `ord_mv1j4adu5b738b5e01` (9-oct) | no |
| 1 | Clips de la escena **5** y de la **1** | no |
| 2 | Clip **2 y 3** (una sola grabación continua) | sí, 1 imán por toma |
| 3 | Clip **4** (el reclamo, una sola grabación continua, sobre `ord_mv1j4adu5b738b5e01`) | no |

## Textos que vas a pegar (inglés)

**Compra de la escena 2:**

```
Using AgentPey, buy one Atacama copper magnet at agentcommerce. Ship it to Vicente Wolde, Carmen 123, Ñuñoa, Región Metropolitana, Chile; quantity 1, no email. Show me the exact amount before paying. Reply in English.
```

**Confirmación de la escena 2:**

```
Yes, pay.
```

**Reclamo de la escena 4** (la orden ya está puesta):

```
Using AgentPey, open a refund claim for my order ord_mv1j4adu5b738b5e01 at agentcommerce. Reason: it never arrived; the store told me it is out of stock. Ask for the full amount. Reply in English.
```

**Después, para tener el reclamo completo:**

```
Show me the full claim_jws in a code block. Reply in English.
```

> Todos estos textos **se pegan, no se escriben**: el video muestra el texto apareciendo, no a ti tecleando. Tenlos en un
> bloc de notas fuera de pantalla.

---

## Escena 1 · El estándar (voz 14,2 s)

| Voz | De | A | Qué se ve |
|---|---|---|---|
| "This is a Shopify store, a test store of ours, priced in Chilean pesos." | 0,0 | 4,5 | La tienda en Shopify |
| "A person sees it like this." | 4,5 | 6,3 | Igual |
| "An agent sees it through UCP, the open standard for agentic commerce: each store publishes its profile and its Stellar payment method." | 6,3 | 14,2 | `agentpey.com/stores` |

| Clip | Qué grabar | Mínimo a grabar |
|---|---|---|
| **1A** | `agenticom.myshopify.com/products/iman-de-cobre-atacama`: el imán con su foto, nombre y **$490**, **quieto** | 12 s |
| **1B** | `agentpey.com/stores` (EN): las tres tiendas con su perfil y su último recibo. 3 s quieto; **baja muy lento** hasta ver la tercera tienda, y aguanta 3 s | 18 s |

Para 1B, el recorrido de scroll tiene que durar unos 9 s de principio a fin.

## Escena 5 · El SEP y el cierre (voz 18,9 s)

| Voz | De | A | Qué se ve |
|---|---|---|---|
| "All of this speaks open standards: UCP in two versions, AP2 mandates verified by the official library, and an npm package so other agents can pay on Stellar." | 0,0 | 9,5 | La portada, bajando hasta la sección "Real agents, real stores, every step on Stellar." |
| "And we're proposing it as an SEP: this is its technical annex, taken from the code." | 9,5 | 14,5 | El anexo técnico en GitHub (en español, como el resto del repo) |
| "AgentPey: agents that shop, with limits the network sets." | 14,5 | 18,9 | De vuelta a la portada, arriba |

| Clip | Qué grabar | Mínimo a grabar |
|---|---|---|
| **5A** | `agentpey.com` (EN), arriba. 2 s quieto; **baja muy lento** (unos 9 s) hasta la sección cuyo título es **"Real agents, real stores, every step on Stellar."** (encima lleva la etiqueta chica "WHAT AGENTS CAN DO TODAY"; el atajo es `agentpey.com/#today`, pero graba el recorrido bajando desde arriba) y aguanta 3 s con sus seis tarjetas a la vista | 16 s |
| **5B** | `github.com/vicentewolde/AgentPey/blob/main/docs/fase-7-estandar-comercio-agentico/ANEXO-SEP.md` (en **español**, decidido el 13-oct). 2 s quieto con el título "Anexo técnico · Agentic Commerce on Stellar"; **baja lento** unos 4 s por la tabla "El recorrido completo" y aguanta 2 s. **Antes de grabar, descarta el aviso de Chrome "¿Traducir esta página?"** (elige "Nunca traducir español"): si aparece, queda dentro de la imagen | 10 s |
| **5C** | `agentpey.com` (EN), arriba, con el titular, **quieto** | 8 s |

## Escenas 2 y 3 · Claude compra, y aparece sola (una sola grabación)

Se graban **seguidas, en un solo clip**, para gastar una sola compra. Yo lo corto por escena.

**Antes de grabar:** `agentpey.com/live` abierta en una pestaña, **ya cargada**, con el cupo y el saldo revisados. Claude, en un chat nuevo,
con el conector AgentPey activo, **sin modo Auto**.

### Escena 2A · Voz 11,2 s

| Voz | De | A | Qué se ve |
|---|---|---|---|
| "I ask Claude to buy a magnet." | 0,0 | 1,9 | El texto en el chat |
| "Claude finds the product and asks the store for a quote." | 1,9 | 4,8 | Claude trabajando |
| "Claude doesn't choose who gets paid or how much: that comes from the quote, and the server checks it again right before paying." | 4,8 | 11,2 | Claude muestra la cotización con el monto |

### Escena 2B · Voz 12,6 s

| Voz | De | A | Qué se ve |
|---|---|---|---|
| "I say yes to that exact amount: about fifty cents, in USDC." | 0,0 | 4,3 | La cotización con el monto; pegas "Yes, pay." |
| "The payment comes from a contract on Stellar with a cap per purchase and a cap per day." | 4,3 | 8,7 | Claude pagando |
| "Go over the cap and the network refuses it, whatever the agent says." | 8,7 | 12,6 | Claude responde con la orden `ord_…` |

### Escena 3 · Voz 16,9 s

| Voz | De | A | Qué se ve |
|---|---|---|---|
| "This page reads the network every ten seconds, and the purchase showed up on its own." | 0,0 | 4,3 | `/live`, con la compra nueva arriba |
| "The store signs a receipt for every sale and anchors it on Stellar." | 4,3 | 8,0 | Clic en el recibo y la página que carga |
| "This page checks it against the network: the signature, the anchor and the payment." | 8,0 | 12,7 | El recibo, con las tres pruebas |
| "All three green." | 12,7 | 13,7 | Las tres en verde |
| "And anyone can repeat this check without trusting us." | 13,7 | 16,9 | Igual |

### Un solo clip, con estos pasos

| # | Acción | Qué debe verse al terminar | Aguanta |
|---|---|---|---|
| 1 | Chat nuevo y vacío. **Pega** el texto de la compra y Enter | Claude trabajando y buscando | — |
| 2 | **No toques nada** mientras Claude busca y cotiza (puede tardar un minuto) | La cotización con el monto exacto (0,5157895 USDC por 490 CLP) | **5 s** |
| 3 | **Pega** "Yes, pay." y Enter | Claude pagando | — |
| 4 | **No toques nada** hasta que Claude responda | La respuesta con la orden `ord_…` | **5 s** |
| 5 | Cambia a la pestaña `/live`. **No la recargues** | La lista **sin** la compra nueva, y luego **la compra nueva apareciendo sola** arriba (hasta 10 s) | **4 s** |
| 6 | Mueve el mouse **despacio** hasta el enlace **receipt** de esa fila y haz clic | Se abre la página del recibo | — |
| 7 | **No toques nada**. Si sale en español, pulsa **EN** arriba a la derecha | "Valid receipt: all three checks pass" con las tres pruebas en verde | **8 s** |

Largo total: de 2 a 4 minutos. Si Claude no cotiza en 60 s, corta el clip y repite en un chat nuevo.

## Escena 4 · Si sale mal (voz 32,1 s) · UN SOLO CLIP

Se graba **de corrido, en una sola grabación**, en el orden de abajo. Todo sobre **`ord_mv1j4adu5b738b5e01`** (la compra del 9-oct: sin reclamo
previo, recibo válido, ventana abierta hasta el 19-oct). **Una vez abierta la disputa (paso 2), ese recibo no admite otro reclamo**: si algo falla
después, sigues desde ese paso, no desde el principio. Yo corto los errores, las esperas y las repeticiones.

**Antes de empezar, en una sola ventana de Chrome, estas pestañas:**
1. `claude.ai`, chat nuevo, conector AgentPey activo, **sin modo Auto**.
2. La **pantalla del árbitro** (doble clic en `Árbitro AgentPey` del escritorio; se abre en `127.0.0.1:4747`). **Tradúcela al inglés:** clic derecho en la
   página, "Traducir al inglés". Prueba antes que se traduzcan también los resultados, y **cierra el globo de traducción** antes de grabar.
3. `agentpey.com/live` (EN).
4. `agentpey.com/resolve/responder` (EN).
Freighter desbloqueado, en Testnet, con la cuenta `GD2MCESI…K5GN` (la de cobro de la tienda).

**Qué se mueve entre pantallas.** El reclamo es un texto firmado: lo hace Claude, lo abre el árbitro y lo responde la tienda. La tienda no puede entrar
al chat de Claude, así que **tú llevas el reclamo de una pantalla a otra copiando y pegando**. La respuesta de la tienda viaja como **un archivo que se descarga**.

| # | Dónde | Qué haces | Qué debe verse | Aguanta |
|---|---|---|---|---|
| 1 | **Claude** | **Pega** el pedido de reclamo (con la orden). Cuando firme, **pega** `Show me the full claim_jws in a code block. Reply in English.` y **copia** el bloque con su botón | El texto largo `claim_jws` | 4 s |
| 2 | **Árbitro** | Paso 1: **pega** el reclamo y pulsa **Abrir la disputa** (~20 s) | Tres ✅ y el monto bloqueado | 4 s |
| 3 | **`/live`** | Cambia de pestaña (se actualiza sola, hasta 10 s) | *Dispute open · 0.52 USDC locked* en la fila de esa orden | 4 s |
| 4 | **Tienda** (`/resolve/responder`) | **Pega** el mismo reclamo, **Read the claim**, conecta Freighter, elige aceptar el reembolso completo, escribe el descargo, firma. **Se descarga un archivo** | El reclamo leído y tu respuesta firmada | 3 s |
| 5 | **Árbitro** | Paso 2: **Usar la última descarga** (toma ese archivo) | ✅ la firma de la tienda | 3 s |
| 6 | **Árbitro** | Paso 3: **Pedir el veredicto** (30 a 90 s) | "Reembolso completo" y sus razones | 4 s |
| 7 | **Árbitro** | **Copiar el hash**, pégalo en el paso 4 y **Confirmar y pagar el reembolso** (~20 s) | "Reembolso pagado" | 4 s |
| 8 | **`/live`** | Cambia de pestaña | *Refunded 0.52 USDC* en esa fila | 4 s |

Texto del descargo del paso 4: `I confirm I am out of stock of the magnet and the order was not shipped. I accept to refund the full amount.`

**Cómo se reparte la voz sobre esos pasos** (yo ajusto la velocidad de cada tramo):

| Voz | De | A | Pasos |
|---|---|---|---|
| "What if a purchase goes wrong?" | 0,0 | 1,5 | 1 |
| "This is another purchase by Claude, from a few days ago, and the store is out of stock." | 1,5 | 6,3 | 1 |
| "Claude signs the claim with the key of the agent that paid." | 6,3 | 9,5 | 1 |
| "The arbiter, today me with this screen, checks the claim and opens the dispute on Stellar: the amount is locked in a guarantee the store left in the contract." | 9,5 | 18,2 | 2 y 3 |
| "The store answers with its own signature." | 18,2 | 20,6 | 4 |
| "Today the claim and the answer are handed over by hand." | 20,6 | 23,9 | 5 |
| "An AI arbiter proposes a verdict with its reasons, a person confirms it by its hash, and only then does the contract pay the money back." | 23,9 | 32,1 | 6, 7 y 8 |

Los pasos exactos de cada pantalla, con sus botones, están en `docs/fase-8-agentes-reales/demo-day/ESCALETA.md`, bloque 6. Los pasos 2, 6 y 7 son los largos
(abrir la disputa ~20 s, el veredicto de 30 a 90 s, pagar ~20 s): yo corto las esperas.

## Resumen: todos los clips

| Clip | Qué | Mínimo a grabar | Voz que le toca |
|---|---|---|---|
| 0 | Portada | ya grabado | 12,4 s |
| **1A** | Tienda en Shopify | 12 s | 14,2 s con 1B |
| **1B** | `/stores` | 18 s | |
| **2 y 3** | Compra, `/live`, recibo (una grabación) | 2 a 4 min | 11,2 + 12,6 + 16,9 s |
| **4** | El reclamo, de corrido (8 pasos) | 5 a 10 min | 32,1 s |
| **5A** | Portada bajando | 16 s | 18,9 s con 5B y 5C |
| **5B** | Anexo en GitHub | 10 s | |
| **5C** | Portada, arriba | 8 s | |

Cuando termines, dime y yo monto todo: pongo la voz, los subtítulos en español, junto las escenas y reviso que dure menos de 3:00.
