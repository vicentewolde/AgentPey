# Video del hackathon "Find Your Way" · guion del recorrido completo

> Se graba el **martes 2026-09-29**; el hackathon cierra el 30. Máximo **5
> minutos**, pantalla y voz, con **subtítulos en inglés**. Este documento sirve
> para dos cosas: **recorrer todo el producto una vez antes de grabar** (y
> encontrar fallas y mejoras mientras tanto) y **tener el texto que se dice**.
> No es el pitch del Demo Day del 25 ([demo-day/GUION.md](../demo-day/GUION.md)),
> que muestra solo la compra en 60 segundos.
>
> **Decidido con el usuario (2026-09-25):** la voz es en **español** y los
> subtítulos en **inglés**, para que lo entienda más gente. Cada escena tiene
> los dos textos, uno frente al otro: el español es lo que dices, el inglés es lo
> que se subtitula. Van frase por frase en el mismo orden, para que los
> subtítulos se sincronicen con la voz.

## 1. Cómo usarlo

1. **Recorrido de prueba, sin grabar (hoy o mañana).** Sigue las escenas 0 a 7 en
   orden. En cada una, el cuadro **Qué mirar** dice qué puede fallar. Anota lo
   que encuentres en la tabla del § 7.
2. **Arregla lo que valga la pena** (§ 6 dice qué conviene y qué no).
3. **Grabación (29).** Escena por escena, no de corrido: cada una se puede
   repetir y se corta al montar. Los tiempos de abajo son el objetivo final.

## 2. Las escenas

| # | Escena | Qué se ve | Tiempo |
|---|---|---|---|
| 0 | Gancho | Solo la voz sobre la portada | 0:00 a 0:20 |
| 1 | Una tienda se suma sola | Portal de Vitrinee, Freighter, las cuatro pruebas | 0:20 a 1:20 |
| 2 | Aparece sin deploy | La tienda en el directorio y en RealOps | 1:20 a 1:35 |
| 3 | Contratar y firmar | RealOps, permiso, Freighter | 1:35 a 2:25 |
| 4 | La compra | El agente compra, el pago en Stellar | 2:25 a 3:10 |
| 5 | La prueba | Panel del dueño, recibo con tres comprobaciones | 3:10 a 3:45 |
| 6 | El límite | El agente pide algo fuera de su permiso y se rechaza | 3:45 a 4:20 |
| 7 | Cierre | Una frase y la portada | 4:20 a 4:50 |

Quedan 10 segundos de margen. En español la voz total es de unas 560 palabras (a unas 2,8 por segundo son
unos 3:20 de habla repartidos en 4:50): no cabe más texto sin cortar pantalla. Los
subtítulos en inglés, de dos líneas como máximo por pantalla.

## 3. Lo que hace falta antes de empezar

- [ ] **Una tienda Jumpseller nueva, sin registrar en Vitrinee**, con 3 o 4
      productos con precio bajo 2.850 CLP (`C-133`) y **sin los productos de
      demostración** de Jumpseller (`SKU` repetido, T105). Es la escena 1: MycoKit
      y Bazar Cordillera ya están dadas de alta y no hay forma de deshacerlo, así
      que su dirección aparece como "ya está en uso". Registrar la misma tienda
      dos veces con otra dirección duplicaría sus productos, y RealOps esconde
      esos productos (`C-145`, punto 7).
- [ ] **Una wallet dueña con Freighter en testnet**, con XLM y con la línea de
      confianza de USDC (emisor `GBBD47…LFLA5`); si no, el alta se detiene en la
      segunda prueba. Puede ser la misma de otra tienda (`VT-31`).
- [ ] **Una cuenta nueva de RealOps para grabar**, con otro correo. Cada cuenta
      recibe **3 USDC de crédito** en su primera compra (`C-131`); con 1,04 por
      compra alcanzan dos.
- [ ] Freighter desbloqueado y en **Testnet**, datos de envío de prueba (se ven
      en pantalla), zoom del navegador en 125 %, "No molestar" activado.
- [ ] Un ensayo completo de la escena 4 con la cuenta de grabar, **antes** de
      grabar: la primera compra de una cuenta nueva despliega su propio contrato
      de pago y puede tardar más que las siguientes (T58).

## 4. Escena por escena

Formato: **Pantalla** es lo que haces; **Voz** es el texto en español que
dices y **Subtítulos** el mismo texto en inglés, tal cual; **Qué mirar** es lo que quiero que revises en el recorrido de prueba.

### 0 · Gancho (0:00 a 0:20)

**Pantalla:** portada de `agentpey.com` (o un título simple). Sin movimiento.

**Voz (español, la que dices):**

> Los agentes de IA ya pueden comprar en internet. El problema es la confianza.
> Si le das tu tarjeta, puede gastar lo que quiera, y las reglas escritas en su
> prompt las puede reescribir una sola línea inyectada. AgentPey pone las reglas
> en Stellar, donde el agente no puede tocarlas. Les muestro el ciclo completo.

**Subtítulos (inglés):**

> AI agents can already shop online. The problem is trust. Give one your card and
> it can spend anything, and rules written in its prompt can be rewritten by a
> single injected line. AgentPey puts the rules on Stellar, where the agent can't
> touch them. Here is the whole loop.

**Qué mirar:** que la portada cargue bien y en inglés (botón EN).

### 1 · Una tienda se suma sola (0:20 a 1:20)

**Pantalla:**
1. `https://vitrinee.agentpey.com` → **Connect Freighter** → firmar el mensaje.
2. Formulario **Connect your Jumpseller store**: nombre, dirección
   (`<tienda>.vitrinee.agentpey.com`, se propone sola y dice **Available**),
   login y token de la API de Jumpseller. **Pega el token fuera de cámara** (o
   pausa la grabación): no puede verse.
3. **Check and publish my store** → las cuatro pruebas se ponen en verde →
   mensaje **Your store is live for agents at …**.

**Voz (español, la que dices):**

> Primero, el vendedor. El dueño de una tienda entra con la wallet donde recibe
> sus pagos. Sin contraseña ni correo: una firma en Freighter. Pega las
> credenciales de la API de su tienda Jumpseller y publica. Antes de guardar
> nada, Vitrinee revisa cuatro cosas: que la dirección esté libre, que la wallet
> pueda recibir USDC, que las credenciales lean el catálogo y que la llave de
> firma de la tienda tenga fondos. Las cuatro pasan. Sin código y sin deploy. La
> tienda ya está publicada para agentes.

**Subtítulos (inglés):**

> First, the seller. A store owner signs in with the wallet they get paid in. No
> password, no email: one signature in Freighter. They paste the API credentials
> of their Jumpseller store and press publish. Before saving anything, Vitrinee
> checks four things: the address is free, the wallet can receive USDC, the
> credentials can read the catalogue, and the store's signing key is funded. All
> four pass. No code, no deploy. The store is live for agents.

**Qué mirar:**
- Que las cuatro pruebas se vean claramente una por una. El servidor las corre
  en una sola llamada y, mientras trabaja, las cuatro salen "pendientes": si
  tarda más de ~15 s, la escena se siente rota. Cronométralo.
- Que el token no quede a la vista en ningún momento (campo, historial del
  navegador, captura del portapapeles).
- Que el mensaje de éxito muestre la dirección completa, legible.

### 2 · Aparece sin deploy (1:20 a 1:35)

**Pantalla:** `https://vitrinee.agentpey.com/api/comercios` un segundo (la
tienda nueva en la lista) → `https://realops.agentpey.com/catalogo` → sección
**Stores on Vitrinee** con la tienda nueva y sus productos.

**Voz (español, la que dices):**

> En menos de un minuto aparece en el directorio y en RealOps, nuestra app de
> ejemplo para contratar agentes que compran. Nadie hizo un deploy.

**Subtítulos (inglés):**

> Within a minute it shows up in the directory, and in RealOps, our example app
> for hiring buying agents. Nobody deployed anything.

**Qué mirar:** cuánto tarda de verdad en aparecer en RealOps (dice "menos de un
minuto"; el directorio se guarda 30 s, `C-145`). Si tarda más, recarga y dilo en
el montaje. Que las tarjetas no salgan duplicadas ni con SKU repetido.

### 3 · Contratar y firmar (1:35 a 2:25)

**Pantalla:**
1. RealOps con la **cuenta nueva** → **My agents** → **Hire an agent** → **What
   should it do?**: *Buy at <tienda> (store)*. Los límites se ponen solos en
   25.00 por compra y por día → **Hire and sign →** (`C-150`).
2. En AgentPey: arriba a la derecha **Connect wallet** (firma de verificación)
   → abajo se lee lo que autorizas → **Sign Mandate** → las dos aprobaciones de
   Freighter → **Mandate anchored** → **Continue on realops.agentpey.com →**.
3. Vuelves a RealOps en **What <agente> can buy**, con los productos de la
   tienda "in the grant" (`C-149`).

**Voz (español, la que dices):**

> Ahora, el comprador. En RealOps contrato un comprador para esta tienda y voy
> directo a firmar su permiso con mi wallet. AgentPey me muestra exactamente qué
> firmo: solo esta tienda, solo estos productos, solo USDC, un máximo por compra
> y por día, y una fecha de vencimiento. Freighter me pide firmar y luego
> anclarlo en Stellar. Las reglas ya viven fuera del agente, y vuelvo a lo que
> este agente puede comprar.

**Subtítulos (inglés):**

> Now the buyer. In RealOps I hire a shopper for this store and go straight to
> signing its permission with my wallet. AgentPey shows exactly what I'm
> signing: this store only, these products only, USDC only, a maximum per
> purchase and per day, and an expiry. Freighter asks me to sign, then to anchor
> it on Stellar. The rules now live outside the agent, and I'm back at what this
> agent can buy.

**Qué mirar:**
- Son **tres** ventanas de Freighter seguidas (verificar, firmar, anclar). Frente
  a cámara se siente largo; decide si se acorta al montar.
- Que "Lo que autorizas" en AgentPey se lea al zoom 125 % sin cortarse.
- El aviso de "Mandate anchored" con su hash. Anota cuánto tarda el anclaje.
- Que el botón grande lleve de verdad a **What <agente> can buy**.

### 4 · La compra (2:25 a 3:10)

**Pantalla:** en **What <agente> can buy**, tarjeta de un producto (que diga
**in the grant**) → **Quantity 1** + datos de envío → **Ask the agent to buy it**
→ **My services** abre con el aviso verde **Bought: <producto>** (`C-148`) → en
el aviso, **See the payment on Stellar ↗** → Stellar Expert: **Successful**,
transferencia de USDC.

**Voz (español, la que dices):**

> Ahora le pido que compre un producto. RealOps no decide nada: le pregunta a
> AgentPey, que revisa el pedido contra el permiso que firmé y paga desde un
> contrato Soroban en Stellar. Ahí está: cerca de un dólar en USDC, liquidado en
> la red en segundos.

**Subtítulos (inglés):**

> Now I ask it to buy a product. RealOps decides nothing: it asks AgentPey, which
> checks the request against the permission I signed and pays from a Soroban
> contract on Stellar. There it is: about a dollar in USDC, settled on the
> network in seconds.

Si la primera compra de la cuenta despliega su contrato (tarda), agrega:

> La primera compra también despliega el contrato de pago de esta cuenta.

Subtítulo:

> The first purchase also deploys this account's own payment contract.

**Qué mirar:**
- **Cuánto tarda de verdad**, del clic al pago. Si pasa de ~20 s, o se corta al
  montar o se hace una compra previa fuera de cámara.
- La tarjeta de **Deliveries** sigue diciendo "delivered" aunque el pedido no
  llegó a Jumpseller (T101). El aviso verde dice "Bought", que sí es cierto:
  muestra el aviso, no la tarjeta.
- Que el enlace a Stellar Expert abra la transacción correcta y que el monto sea
  el del producto.

### 5 · La prueba (3:10 a 3:45)

**Pantalla:** portal de Vitrinee (`https://vitrinee.agentpey.com`, entra con la
wallet dueña) → **What agents bought from you** → el pedido nuevo → enlace
**Receipt** → la página **Sale receipt**: "Valid receipt: all three checks
pass", las tres comprobaciones en verde, el producto y el total (`C-149`).
Enlace **Payment** de paso.

**Voz (español, la que dices), versión B, mientras Jumpseller siga en 404:**

> Volvamos al lado del vendedor. El panel del dueño muestra la venta, con
> enlaces al pago y al recibo. El recibo está firmado por la tienda, anclado en
> un contrato de Stellar y coincide con el pago en el ledger: tres
> comprobaciones independientes, todas en verde. El panel dice que el pedido aún
> no llega al administrador de la tienda, porque Jumpseller todavía no habilita
> la creación de pedidos en nuestra cuenta. El pago y la prueba son reales, y el
> pedido se crea sin volver a cobrar apenas lo habiliten.

**Subtítulos (inglés), versión B:**

> Back on the seller's side. The owner's panel shows the sale, with links to the
> payment and the receipt. The receipt is signed by the store, anchored in a
> Stellar contract, and matches the payment on the ledger: three independent
> checks, all green. The panel says the order hasn't reached the store's admin
> yet, because Jumpseller hasn't enabled order creation on our account. The
> payment and the proof are real, and the order is created without charging
> again as soon as it does.

**Versión A, si Jumpseller ya lo habilitó:** igual, pero cambia las dos últimas
frases por esta, y muestra el panel de Jumpseller (sin credenciales a la vista):

> Voz: Y aquí está el mismo pedido en el administrador de Jumpseller de la tienda.
> Subtítulo: And here is the same order in the store's own Jumpseller admin.

**Qué mirar:**
- Que la página del recibo salga en inglés (lo decide el navegador; si sale en
  español, agrega `?lang=en` a la dirección).
- Que el pedido nuevo salga arriba y con el estado correcto: **"Paid, order not
  yet in your store"** si sigue el 404, **"Paid, order in your store"** si no.
- Que la sesión del portal siga abierta (dura 12 horas).

### 6 · El límite (3:45 a 4:20)

**Pantalla:** en RealOps, la misma tarjeta, **Quantity 20** (o el tope que
quede sobre lo firmado) → **Ask the agent to buy it** → **My services** abre con el aviso
rojo **Refused: <producto>**, el motivo en lenguaje llano y "Nothing was paid"
(`C-148`).

**Voz (español, la que dices):**

> Ahora, lo importante. Le pido al mismo agente mucho más de lo que permití.
> Superaría el máximo que firmé, así que AgentPey lo rechaza antes de que se
> mueva un solo centavo, y explica por qué. Ese límite no está en el prompt del
> agente, así que no hay nada que inyectar.

**Subtítulos (inglés):**

> Now the part that matters. I ask the same agent for far more than I allowed. It
> would go over the maximum I signed, so AgentPey refuses before any money moves,
> and says why. That limit isn't in the agent's prompt, so there is nothing to
> inject.

**Qué mirar (esta escena no está verificada en vivo, solo en tests):**
- Que el rechazo aparezca de verdad con un texto claro (el esperado es "The price
  is above the maximum per purchase you signed", o el del tope diario). 20 unidades de un producto de ~3 USDC son
  60 USDC, sobre los 25,00 por compra. Si los productos son tan baratos que
  20 no alcanzan, contrata con un tope más bajo (el formulario nuevo deja
  editarlo, por ejemplo 3,00) y pide 5.
- Que el rechazo **no cuente contra el límite del día**. Mira **Daily limit**
  en **My services** antes y después del intento; debe quedar igual.
- Que ningún dinero se mueva (el saldo del contrato no cambia).

### 7 · Cierre (4:20 a 4:50)

**Pantalla:** portada de `agentpey.com` o un cuadro con las tres direcciones.

**Voz (español, la que dices):**

> Ese es el ciclo. Una tienda se suma sin código. Una persona firma exactamente
> lo que un agente puede gastar. El agente compra, y los dos lados guardan
> prueba en Stellar. Hoy funciona en Stellar testnet, con tiendas Jumpseller
> reales. Lo que sigue: el primer partner externo comprando solo, y auditorías
> antes de tocar mainnet. AgentPey: agentes con una wallet que tiene reglas.

**Subtítulos (inglés):**

> That's the loop. A store joins without code. A person signs exactly what an
> agent may spend. The agent buys, and both sides keep proof on Stellar. It runs
> today on Stellar testnet, with real Jumpseller stores. Next: the first outside
> partner buying on its own, and audits before anything touches mainnet. AgentPey:
> agents with a wallet that has rules.

**Qué mirar:** que la frase "real Jumpseller stores" siga siendo cierta el día
de grabar (hoy son dos y una tercera para el video).

## 5. Plan B por escena

| Si falla… | Haz esto |
|---|---|
| Freighter no abre o se desconecta | Recarga la página, desbloquea Freighter, repite solo esa escena |
| El alta falla en una prueba | El mensaje dice cuál. La 2ª es la línea de USDC de la wallet; la 4ª es el faucet de testnet (`friendbot`), reintenta en un minuto |
| La compra tarda o da error | Repite la escena; si el contrato de la cuenta está sin saldo, avísame y lo reviso antes de grabar de nuevo |
| El rechazo no aparece | No lo inventes: revisa el § 6 y avísame; sin esa escena el video dura 4:15 |
| Jumpseller sigue en 404 | Usa la versión B de la escena 5. No muestres el admin de Jumpseller |

## 6. Fallas ya conocidas y mejoras candidatas

Ordenadas por lo mucho que se notan en el video. Los puntos 1 y 3 se dejan como
están por decisión del usuario; el 2 sigue abierto.

| # | Qué | Dónde se ve | Costo | Recomendación |
|---|---|---|---|---|
| 1 | **El portal dice "the order reaches your store"** en su portada, y hoy no es cierto mientras Jumpseller responda 404 | Portada de `vitrinee.agentpey.com`, escena 1 | Cambiar una frase | **Decidido 2026-09-25: no se corrige** (el usuario considera que nadie lo va a preguntar). La voz de la escena 5 sí dice la verdad |
| 2 | ~~El recibo es JSON crudo~~ **Resuelto en T108** (`C-149`): página legible | Escena 5 | Una página nueva de Vitrinee | Lo más valioso para el espectador. Si no alcanza, Chrome con "Dar formato" lo hace pasable |
| 3 | **En parte resuelto en T107/T108**: el aviso dice "Bought" y el recibo tiene página; la tarjeta todavía dice **"delivered"** en una compra que no llegó a Jumpseller, y no muestra el enlace al recibo (Vitrinee lo manda anidado y RealOps busca otro campo) | Escena 4 | Cambio pequeño en RealOps | **Decidido 2026-09-25: no se corrige.** No leas "entregado" en voz alta; queda anotado como deuda |
| 4 | **Tres ventanas de Freighter seguidas** | Escena 3 | Montaje | Acortar al montar; no tocar el flujo |
| 5 | **La primera compra de una cuenta nueva** despliega su contrato y puede tardar | Escena 4 | Ensayo previo | Cortar al montar o hacer una compra previa fuera de cámara |
| 6 | **La tienda de la escena 1 no se puede repetir** con ninguna ya registrada; no hay forma de darla de baja | Escena 1 | Crear una tienda Jumpseller nueva | Necesaria; ver § 3 |
| 7 | **SKU repetido**: los productos de demostración de Jumpseller también se publican | Escena 2 | Filtro en `isSellable`, ya hay tarea sugerida | Alcanza con borrarlos a mano de la tienda nueva |
| 8 | **Jumpseller 404** al crear pedidos (T101) | Escena 5 | Depende de su soporte | Versión B del guion. Preguntar a soporte hoy |

## 7. Hallazgos del recorrido de prueba

Llénalo tú (o me pasas lo que viste y lo lleno yo).

| Escena | Qué pasó | Segundos | ¿Falla o mejora? | Qué hago |
|---|---|---|---|---|
| | | | | |

## 8. Lo que se puede decir con cifras verificadas

- Dos tiendas Jumpseller reales ya venden a agentes (Bazar Cordillera, 6
  productos; MycoKit, 4), más la del video.
- Dos compras reales de un agente en esas tiendas, con recibo verificado (T101 y
  T104, `evidencia/`).
- Tres contratos Soroban en testnet: `agent_registry`, `policy_rail`,
  `receipt-registry`.
- Todo en **testnet**. No digas mainnet, dinero real, usuarios ni ingresos.

## 9. Día de grabar (29)

- [ ] Recorrido de prueba hecho y § 7 llenado; § 6 puntos 1 y 3 decididos.
- [ ] Tienda Jumpseller nueva lista y **sin dar de alta** (§ 3).
- [ ] Cuenta nueva de RealOps con el correo de grabar; primera compra de ensayo
      hecha.
- [ ] Freighter en Testnet, "No molestar", zoom 125 %, pestañas cerradas.
- [ ] Cada escena grabada por separado; voz grabada aparte para sincronizar mejor.
- [ ] Subtítulos en inglés tomados del texto de cada escena, sincronizados frase
      por frase con la voz en español y revisados uno por uno; nada de tokens ni
      claves en pantalla.
- [ ] Duración final **bajo 5:00**.
