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
>
> **Actualizado 2026-09-28.** El recorrido de prueba de § 7 ya se hizo — dos
> sesiones completas, mucho más a fondo de lo que pide este guion (llegó hasta
> la API de partners y el panel de estado). Los hallazgos que importan para
> filmar están en § 7; lo que se arregló en el camino, en § 6. La escena 6
> (el rechazo) ya está **verificada en vivo**, no solo en tests.

## 1. Cómo usarlo

1. **El recorrido de prueba ya está hecho** (§ 7). Lo que falta antes de grabar
   es § 3: la tienda nueva y la cuenta de grabar.
2. **Arregla lo que valga la pena** (§ 6 dice qué conviene y qué no — ya está
   decidido).
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

- [ ] **Una tienda Shopify de desarrollo nueva, sin registrar en Vitrinee**
      (decidido 2026-09-26, `VT-33`; gratis, y el pedido sí llega a la tienda,
      confirmado en vivo el 27 — ver § 7). Creada desde el Dev Dashboard, con
      su app (`read_products` y `write_orders`) instalada, moneda CLP y 3 o 4
      productos con SKU propio y precio bajo 2.850 CLP (`C-133`); sirve
      `demo-hackathon/shopify-productos.csv` con otros SKU. **La tienda de
      prueba (`agentcommerce`, `agenticom.myshopify.com`) ya está dada de alta
      y no hay forma de deshacerlo**, igual que MycoKit y Bazar Cordillera:
      hace falta una tienda **distinta** para la escena 1. Registrar la misma
      tienda dos veces con otra dirección duplicaría sus productos, y RealOps
      esconde esos productos (`C-145`, punto 7).
- [ ] **La dirección de la tienda en el formulario del portal se escribe
      completa**, `<nombre>.myshopify.com` (el portal ya acepta variantes —
      solo el nombre, con `https://`, la URL del admin — desde el 27,
      `C-154`/nota; si pega algo raro y sale "Completa todos los campos",
      revisa que sea una de esas formas).
- [ ] **Un solo comprador de tienda en la cuenta de grabar.** Con dos tiendas en
      una cuenta, el primer comprador pierde su permiso de comprar (`C-154`, aún
      sin arreglar — la opción elegida se hace después del video).
- [ ] **Una wallet dueña con Freighter en testnet**, con XLM y con la línea de
      confianza de USDC (emisor `GBBD47…LFLA5`); si no, el alta se detiene en la
      segunda prueba. Puede ser la misma de otra tienda (`VT-31`).
- [ ] **La wallet que va a firmar el Mandato también necesita XLM de testnet**,
      aparte de la del punto anterior si es otra: anclar el Mandato es una
      transacción de Soroban (~0,18 XLM de fee) que paga la wallet conectada,
      no AgentPey. Sin XLM, Freighter deja firmar las dos aprobaciones pero el
      anclaje falla al final con "the wallet-signed transaction was rejected
      by the network" (hallado y confirmado el 27, `C-157`). Fondéala antes con
      el botón "Fund with Friendbot" de Freighter, o
      `https://friendbot.stellar.org?addr=<clave pública>`.
- [ ] **Una cuenta de RealOps para grabar, con saldo ya cargado — no una
      recién creada justo antes.** El cupo de cuentas nuevas con crédito
      automático se agotó durante las pruebas (20 de 20) y se subió a 40 el
      28 (`C-159`), así que una cuenta nueva sí recibe sus 3 USDC de crédito;
      aun así, usar una que ya compró antes evita el primer-compra-despliega-
      el-contrato de más abajo.
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
2. Formulario **Connect your store**: nombre, dirección
   (`<tienda>.vitrinee.agentpey.com`, se propone sola y dice **Available**),
   **Shopify** en "¿Dónde está tu tienda?", y la dirección `.myshopify.com`, el
   client id y el client secret de la app. **Pega el token fuera de cámara** (o
   pausa la grabación): no puede verse.
3. **Check and publish my store** → las cuatro pruebas se ponen en verde →
   mensaje **Your store is live for agents at …**.

**Voz (español, la que dices):**

> Primero, el vendedor. El dueño de una tienda entra con la wallet donde recibe
> sus pagos. Sin contraseña ni correo: una firma en Freighter. Pega las
> credenciales de su tienda y publica. Antes de guardar
> nada, Vitrinee revisa cuatro cosas: que la dirección esté libre, que la wallet
> pueda recibir USDC, que las credenciales lean el catálogo y que la llave de
> firma de la tienda tenga fondos. Las cuatro pasan. Sin código y sin deploy. La
> tienda ya está publicada para agentes.

**Subtítulos (inglés):**

> First, the seller. A store owner signs in with the wallet they get paid in. No
> password, no email: one signature in Freighter. They paste the credentials of
> their store and press publish. Before saving anything, Vitrinee
> checks four things: the address is free, the wallet can receive USDC, the
> credentials can read the catalogue, and the store's signing key is funded. All
> four pass. No code, no deploy. The store is live for agents.

**Qué mirar:**
- Que las cuatro pruebas se vean claramente una por una. El servidor las corre
  en una sola llamada y, mientras trabaja, las cuatro salen "pendientes": si
  tarda más de ~15 s, la escena se siente rota. Cronométralo.
- Que el client secret no quede a la vista en ningún momento (campo, historial del
  navegador, captura del portapapeles).
- Que el mensaje de éxito muestre la dirección completa, legible.
- Escribe la dirección de la tienda **completa** (`<nombre>.myshopify.com`):
  el 26 fallaba con solo el nombre; ya está arreglado, pero no lo pruebes por
  primera vez en cámara.

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
- **La wallet que firma necesita XLM** (ver § 3): sin fondos, el anclaje falla
  después de las dos aprobaciones, no antes. Ensáyalo con la cuenta de grabar.

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
- Que el enlace a Stellar Expert abra la transacción correcta y que el monto sea
  el del producto.
- Con la tienda Shopify de esta escena, el pedido llega de verdad a la tienda
  (confirmado en vivo el 27) — la duda de la tarjeta "delivered" que tenía
  Jumpseller ya no aplica a lo que se filma; no hace falta mencionarla.

### 5 · La prueba (3:10 a 3:45)

**Pantalla:** portal de Vitrinee (`https://vitrinee.agentpey.com`, entra con la
wallet dueña) → **What agents bought from you** → el pedido nuevo → enlace
**Receipt** → la página **Sale receipt**: "Valid receipt: all three checks
pass", las tres comprobaciones en verde, el producto y el total (`C-149`).
Enlace **Payment** de paso.

**Voz (español, la que dices):**

> Volvamos al lado del vendedor. El panel del dueño muestra la venta, con
> enlaces al pago y al recibo. El recibo está firmado por la tienda, anclado en
> un contrato de Stellar y coincide con el pago en el ledger: tres
> comprobaciones independientes, todas en verde. Y aquí está el mismo pedido,
> ya pagado y con el stock descontado, en el administrador de la tienda.

**Subtítulos (inglés):**

> Back on the seller's side. The owner's panel shows the sale, with links to the
> payment and the receipt. The receipt is signed by the store, anchored in a
> Stellar contract, and matches the payment on the ledger: three independent
> checks, all green. And here is the same order, already paid and with the stock
> taken off, in the store's own admin.

**Pantalla del final:** el administrador de la tienda (Shopify, `Orders`), sin
credenciales a la vista: el pedido **Paid**, el producto, el total en CLP y el
hash del pago en los atributos.

**Qué mirar:**
- Que la página del recibo salga en inglés (lo decide el navegador; si sale en
  español, agrega `?lang=en` a la dirección).
- Que el pedido nuevo salga arriba y diga **"Paid, order in your store"**
  (confirmado en vivo el 27: el pedido llegó a Shopify como Paid y el stock
  bajó).
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

**Qué mirar — verificada en vivo el 27, dos veces (una por tope de compra, una
por tope diario); en las dos el rechazo salió, no se cobró nada y el límite del
día no se movió:**
- Que el rechazo aparezca con un texto claro. 20 unidades de un producto de ~1,5
  USDC pasan el tope de 25,00 por compra fácilmente; si tu tope es más bajo,
  ajusta la cantidad para pasarlo.
- Que el rechazo **no cuente contra el límite del día**. Mira **Daily limit**
  en **My services** antes y después del intento; debe quedar igual.
- Que ningún dinero se mueva (el saldo del contrato no cambia).

### 7 · Cierre (4:20 a 4:50)

**Pantalla:** portada de `agentpey.com` o un cuadro con las tres direcciones.

**Voz (español, la que dices):**

> Ese es el ciclo. Una tienda se suma sin código. Una persona firma exactamente
> lo que un agente puede gastar. El agente compra, y los dos lados guardan
> prueba en Stellar. Hoy funciona en Stellar testnet, con tiendas en línea
> reales. Lo que sigue: el primer partner externo comprando solo, y auditorías
> antes de tocar mainnet. AgentPey: agentes con una wallet que tiene reglas.

**Subtítulos (inglés):**

> That's the loop. A store joins without code. A person signs exactly what an
> agent may spend. The agent buys, and both sides keep proof on Stellar. It runs
> today on Stellar testnet, with real online stores. Next: the first outside
> partner buying on its own, and audits before anything touches mainnet. AgentPey:
> agents with a wallet that has rules.

**Qué mirar:** que la frase "real online stores" siga siendo cierta el día
de grabar (hoy son tres, más una cuarta para el video).

## 5. Plan B por escena

| Si falla… | Haz esto |
|---|---|
| Freighter no abre o se desconecta | Recarga la página, desbloquea Freighter, repite solo esa escena |
| El alta falla en una prueba | El mensaje dice cuál. La 2ª es la línea de USDC de la wallet; la 4ª es el faucet de testnet (`friendbot`), reintenta en un minuto |
| El anclaje falla tras las dos firmas, "rejected by the network" | La wallet que firma no tiene XLM de testnet (`C-157`). Fondéala con Friendbot y repite solo esa parte de la escena 3 |
| La compra tarda o da error | Repite la escena; si el contrato de la cuenta está sin saldo, avísame y lo reviso antes de grabar de nuevo |
| El rechazo no aparece | No lo inventes: revisa el § 6 y avísame; sin esa escena el video dura 4:15 |
| El pedido no aparece en Shopify | Repite la compra; si el saldo del contrato es bajo, `rail:topup`. Si sigue sin aparecer, pega el mensaje y lo reviso antes de grabar |

## 6. Fallas ya conocidas y mejoras candidatas

Ordenadas por lo mucho que se notan en el video. Los puntos 1 y 3 se dejan como
están por decisión del usuario; el resto ya está cerrado o resuelto.

| # | Qué | Dónde se ve | Costo | Recomendación |
|---|---|---|---|---|
| 1 | **El portal dice "the order reaches your store"** en su portada — ya es cierto con la tienda Shopify, así que esto dejó de ser un problema para el video, aunque la frase sigue sin corregirse en general | Portada de `vitrinee.agentpey.com`, escena 1 | — | **Decidido 2026-09-25: no se corrige.** Sin urgencia: ya no afecta lo que se filma |
| 2 | ~~El recibo es JSON crudo~~ **Resuelto en T108** (`C-149`): página legible | Escena 5 | — | Cerrado |
| 3 | **En parte resuelto en T107/T108**: el aviso dice "Bought" y el recibo tiene página. La tarjeta de "delivered" en RealOps sigue sin verificar para el caso general (Vitrinee lo manda anidado y RealOps busca otro campo), pero con Shopify el pedido sí llega, así que no es algo que se note al grabar | Escena 4 | Cambio pequeño en RealOps | **Decidido 2026-09-25: no se corrige.** Ya no hace falta ni mencionarlo en el guion — ver escena 4 |
| 4 | **Tres ventanas de Freighter seguidas** | Escena 3 | Montaje | Acortar al montar; no tocar el flujo |
| 5 | **La primera compra de una cuenta nueva** despliega su contrato y puede tardar | Escena 4 | Ensayo previo | Cortar al montar o hacer una compra previa fuera de cámara |
| 6 | **La tienda de la escena 1 no se puede repetir** con ninguna ya registrada; no hay forma de darla de baja | Escena 1 | Crear una tienda Shopify nueva | Necesaria; ver § 3 |
| 7 | **SKU repetido**: los productos de demostración de una plataforma también se publican | Escena 2 | Filtro ya existe (`VT-32`) | Cerrado desde T110; solo evitar SKU repetidos en la tienda nueva |
| 8 | ~~Jumpseller 404 al crear pedidos (T101)~~ **Resuelto con Shopify** (T112): el pedido llega a la tienda | Escena 5 | — | Cerrado; T101 sigue bloqueado solo para Jumpseller (`C-151`) |
| 9 | **La dirección de la tienda en el alta del portal** solo aceptaba `<nombre>.myshopify.com` exacto | Escena 1 | — | **Resuelto el 26** (`shopHostFrom`): acepta el nombre solo, con `https://`, o la URL del admin |
| 10 | **El anclaje del Mandato falla con "rejected by the network"** si la wallet no tiene XLM de testnet | Escena 3 | — | **No es un fallo del producto**: es un requisito (fondear la wallet). Anotado en § 3 y en el plan B |
| 11 | **Revocar un permiso y volver a firmarlo no funcionaba de verdad** (la clave que evita duplicados nunca cambiaba); tampoco el botón "Volver" al revocar | No es una escena del video | — | **Resuelto el 27** (`C-155`, `C-154` nota). No afecta la grabación, solo se prueba fuera de cámara si se quiere mostrar revocación |

## 7. Hallazgos del recorrido de prueba

Hecho en dos sesiones (26 y 27 de septiembre), mucho más a fondo de lo que pide
este guion — llegó hasta la API de partners y el panel de estado interno, que no
se filman. Lo que sigue es lo relevante para las escenas 0 a 7; el detalle
completo de cada hallazgo está en `docs/fase-6-agentguard-comercializacion/DECISIONES.md`
(`C-151` a `C-159`) y `BITACORA.md` (T112 a T119).

| Escena | Qué pasó | Segundos | ¿Falla o mejora? | Qué hago |
|---|---|---|---|---|
| 1 | Alta con "Shopify" y una dirección sin `.myshopify.com` (solo el nombre) daba "Completa todos los campos" y borraba el secret | — | Falla | **Arreglado** (`shopHostFrom`, 26/09). Escribe la dirección completa la primera vez igual, por las dudas |
| 1 | Las cuatro pruebas del alta, con la dirección correcta | ~15 s | Como se esperaba | Nada |
| 3 | Firmar el Mandato con una wallet sin XLM: las dos aprobaciones de Freighter se completan, y el anclaje falla al final con "the wallet-signed transaction was rejected by the network" | — | No es una falla del producto — es un requisito no documentado antes de hoy | Fondear la wallet con Friendbot antes de grabar (ya en § 3) |
| 4 | Compra real de un agente contra la tienda Shopify | — | Como se esperaba | Nada |
| 4/5 | El pedido llega a la tienda Shopify como **Paid**, con el stock descontado y el hash del pago en los atributos | — | Como se esperaba (esto es lo nuevo de T112, antes bloqueado por Jumpseller) | Nada |
| 6 | Pedir más del tope por compra: rechazo correcto, nada cobrado, límite del día sin cambios | — | Como se esperaba | Nada — **verificada en vivo, ya no solo en tests** |
| 6 | Pedir lo suficiente para pasar el tope diario (sumado a lo ya gastado ese día en la cuenta): rechazo correcto con "supera tu tope de gasto del día" | — | Como se esperaba. El tope diario se cuenta **por toda la cuenta**, no por cada agente por separado — tenerlo presente al ensayar con una cuenta que ya compró algo ese día | Nada |
| — | Pedir más del stock de un producto: rechazo del comercio, nada cobrado | — | El texto decía "problema entre esta plataforma y el comercio, no tuyo", que sonaba a que la plataforma tenía la culpa | **Arreglado** (27/09): ahora nombra el stock como razón habitual |
| — | Revocar un permiso y volver a firmarlo | — | No dejaba — la clave que evita duplicados nunca cambiaba, y "Ver y firmar" seguía diciendo "Firmado" tras revocar | **Arreglado** (27/09, `C-155`) |
| — | El botón "Volver" al revocar, en la página de AgentPey | — | No llevaba a ningún lado (RealOps mandaba una ruta relativa que no existe en `agentpey.com`) | **Arreglado y confirmado en vivo** (27/09) |

## 8. Lo que se puede decir con cifras verificadas

- Tres tiendas reales ya venden a agentes: Bazar Cordillera (6 productos) y
  MycoKit (4) en Jumpseller, y una tienda de desarrollo en Shopify (4 productos,
  con el pedido real en su administrador, confirmado en vivo el 27), más la del
  video.
- Dos compras reales de un agente en esas tiendas, con recibo verificado (T101 y
  T104, `evidencia/`), más varias compras reales más en la tienda Shopify
  durante las pruebas del 26 y 27.
- Tres contratos Soroban en testnet: `agent_registry`, `policy_rail`,
  `receipt-registry`.
- Todo en **testnet**. No digas mainnet, dinero real, usuarios ni ingresos.

## 9. Día de grabar (29)

- [x] Recorrido de prueba hecho (§ 7); § 6 decidido.
- [ ] Tienda Shopify nueva lista y **sin dar de alta** (§ 3).
- [ ] Cuenta de RealOps con saldo para grabar; la wallet que firma, fondeada
      con XLM de testnet; primera compra de ensayo hecha.
- [ ] Freighter en Testnet, "No molestar", zoom 125 %, pestañas cerradas.
- [ ] Cada escena grabada por separado; voz grabada aparte para sincronizar mejor.
- [ ] Subtítulos en inglés tomados del texto de cada escena, sincronizados frase
      por frase con la voz en español y revisados uno por uno; nada de tokens ni
      claves en pantalla.
- [ ] Duración final **bajo 5:00**.
