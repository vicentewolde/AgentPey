# Guion de prueba completo · todo el producto, de punta a punta

> Sirve para **probar todo antes de grabar el video del 29** y ver que nada esté
> roto. No es el guion del video ([GUION-VIDEO.md](GUION-VIDEO.md)): aquí se
> recorre **más** que lo que se graba, incluidos los caminos de fallo, la tienda
> Shopify nueva (T112) y el rechazo de la escena 6.
>
> Todo es **Stellar testnet**. Nada de esto mueve dinero real.

## Cómo usarlo

- Sigue las partes en orden: **A** prepara, **B** a **F** son el flujo feliz,
  **G** son los rechazos, **H** a **K** son las demás funciones, **L** cierra.
- Cada paso tiene **Haz**, **Espera** y, si aplica, **Si falla**. Marca ✅ / ❌ y
  anota en la tabla del final (la misma del § 7 de `GUION-VIDEO.md`).
- **Quién corre qué.** 🧑 = lo haces tú en el navegador (algunos con Freighter).
  🔑 = un comando que lee secretos: **lo corres tú en tu terminal** y me pegas la
  salida (ninguno imprime secretos, salvo que se diga). 🤖 = lo hago yo.
- Lo que sigue sin verificar en vivo está marcado con **(sin verificar)**.
- Tiempo estimado: 2,5 a 3 horas la primera vez.

---

## A · Preparación

### A1 · La tienda Shopify gratuita 🧑

Requisito de Shopify: la tienda **tiene que crearse desde el Dev Dashboard** y
estar en la misma organización que la app; si no, el token no se emite (`VT-33`).

1. Cuenta gratuita en el **Shopify Partner Program**; abre el **Dev Dashboard**.
2. Crea una **tienda de desarrollo** desde ahí. Nómbrala como quieras; anota su
   dirección `<nombre>.myshopify.com`.
3. En la tienda: **Settings → Store details → Currency = Chilean Peso (CLP)**.
4. Crea **4 productos**, todos **Active**, cada uno con **SKU propio** y precio
   en pesos enteros **bajo 2.850 CLP** (por ejemplo 1.990, 2.490, 2.690 y 2.850).
   Con inventario controlado y stock: pon **8** en uno, y **1** en otro (sirve
   para la prueba de "sin stock", G8). Borra cualquier producto de ejemplo.
5. En el Dev Dashboard, crea una **app** con los permisos **`read_products`** y
   **`write_orders`**, publica su versión e **instálala en esa tienda**.
6. Copia el **Client ID** y el **Client secret** de la app.

**Espera:** los tres datos en mano: dirección `.myshopify.com`, client id, client
secret. **Si falla:** si Shopify dice `shop_not_permitted`, la app y la tienda no
son de la misma organización: crea la tienda de nuevo desde el Dev Dashboard.

### A2 · Sondear la tienda sin registrarla 🔑

Agrega a `.env.vitrinee.local` (a mano, tú): `SHOPIFY_SHOP`,
`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`. Después:

```bash
pnpm run vitrinee:shopify:probe
```

**Espera:** `✓ token exchanged and catalogue read: 4 product(s) on sale` y la lista
con id, SKU, precio, stock y nombre. Ninguna línea con secretos.

```bash
pnpm run vitrinee:shopify:probe -- --order
```

**Espera:** `✓ order created: #… ` con un enlace al admin de Shopify y
`✓ read back: status paid …`. Abre el enlace: el pedido está **Paid**, con el
hash de Stellar en los atributos y el stock bajó en 1. **Cancela ese pedido de
prueba en Shopify (restock)** para dejar el stock como estaba.

**Si falla (lo más probable, es la primera vez que corre contra Shopify de
verdad):** pégame el mensaje exacto. Pueden faltar campos de la consulta o la
versión de API `2026-07`; lo arreglo en la rama antes de seguir. **No sigas a B
si A2 falla.**

### A3 · Lo demás 🧑

- [ ] Wallet dueña con Freighter en **Testnet**, con XLM y la línea de confianza
      de USDC (emisor `GBBD47…LFLA5`). Zoom 125 %, "No molestar".
- [ ] Una **cuenta nueva de RealOps** con otro correo (3 USDC de crédito; con
      compras de ~1 USDC alcanzan dos o tres).
- [ ] Cierra sesión en `realops.agentpey.com` de cuentas viejas.
- [ ] Rama `cc/t112-shopify` **mergeada y desplegada** (yo lo hago, con tu OK,
      después de A2). Sin el deploy, `vitrinee.agentpey.com` no conoce Shopify.

---

## B · Página de entrada y directorio (sin wallet)

| # | Haz | Espera |
|---|---|---|
| B1 | Abre `https://agentpey.com`, botón **EN** | La portada carga en inglés; la sección Activity es una sesión congelada, no en vivo |
| B2 | `https://vitrinee.agentpey.com/api/comercios` | JSON con Bazar Cordillera y MycoKit (aún no la tienda Shopify) |
| B3 | `https://realops.agentpey.com/catalogo` | Sección **Stores on Vitrinee** con las dos tiendas y sus productos, sin tarjetas repetidas |
| B4 | `https://agentpey.com/discovery/search?query=stickers` | JSON público de ServiceCards |
| B5 | `https://bazar-cordillera.vitrinee.agentpey.com/.well-known/agent-storefront.json` | El manifiesto de la tienda: catálogo, precios, condiciones |

---

## C · El vendedor: el alta de la tienda Shopify (escena 1) 🧑

1. `https://vitrinee.agentpey.com` → **Connect Freighter** → firma el mensaje.
2. En **Add a store**: nombre, dirección (`<tienda>.vitrinee.agentpey.com`, debe
   decir **Available**), y **"¿Dónde está tu tienda?" = Shopify**.
3. Deben aparecer los campos **Store address / Client id / Client secret**, y
   desaparecer los de Jumpseller. Cambia a Jumpseller y vuelve: se alternan bien.
4. Pega los tres datos (**fuera de cámara** cuando grabes) → **Check and publish
   my store**.

**Espera:** las cuatro pruebas en verde, una por una, y **Your store is live for
agents at …** con la dirección completa. **Cronométralo** (objetivo < 15 s).
Tras publicar, el secreto ya no está en el campo.

**Casos de fallo a probar (cada uno debe dejar la prueba correcta en rojo y
no guardar nada):**

| # | Cambio | Espera |
|---|---|---|
| C1 | Dirección `evil.example.com` en Store address | Rechazo por validación, sin enviar el secreto a ningún lado |
| C2 | Client secret con una letra cambiada | Prueba 3 en rojo: "Shopify no aceptó ese client id y secret…" |
| C3 | Dirección de otra tienda (no la de la app) | Prueba 3 en rojo (misma organización) |
| C4 | Una dirección ya usada (por ejemplo `bazar-cordillera`) | Prueba 1 en rojo: "ya está en uso" |
| C5 | Con una wallet sin USDC (o sin fondos) | Prueba 2 en rojo, con el texto de qué agregar |
| C6 | Deja un campo vacío | "Completa todos los campos" |

**Si falla:** anota cuál prueba y el texto. Para C3 y C5 basta con probarlas si
tienes a mano otra tienda u otra wallet; si no, márcalas "no probado".

---

## D · Aparece sin deploy (escena 2)

| # | Haz | Espera |
|---|---|---|
| D1 | `https://vitrinee.agentpey.com/api/comercios` | Ahora incluye la tienda Shopify |
| D2 | `https://<tienda>.vitrinee.agentpey.com/.well-known/agent-storefront.json` | Su catálogo: **cada variante con SKU es un producto**, precios en CLP enteros, moneda CLP |
| D3 | `https://realops.agentpey.com/catalogo` (recarga; el directorio se guarda 30 s) | La tienda nueva con sus productos. Anota **cuánto tardó** en aparecer |
| D4 | En Shopify, pon un producto en **Draft** y deja otro sin SKU; espera 1 minuto y recarga el manifiesto | Los dos desaparecen del catálogo |
| D5 | Duplica un SKU en dos productos Active | **Ninguno** de los dos se publica (`VT-32`) |
| D6 | Deshaz D4 y D5 | Vuelven |

---

## E · El comprador: contratar y firmar (escena 3) 🧑

1. `https://realops.agentpey.com/entrar` con la cuenta nueva (email + alias). Sin
   `RESEND_API_KEY` el enlace mágico sale **en pantalla** y avisa que el correo no
   está verificado: es normal.
2. **My agents → Hire an agent → What should it do? = Buy at <tienda Shopify>
   (store)**. Los límites se ponen solos en **25.00 por compra y por día**.
   **Hire and sign →**.
3. En AgentPey: **Connect wallet** (firma de verificación) → se lee lo que
   autorizas → **Sign Mandate** → dos aprobaciones de Freighter → **Mandate
   anchored** con su hash → **Continue on realops.agentpey.com →**.
4. Llegas a **What <agente> can buy**, con los productos "in the grant".

**Espera:** tres ventanas de Freighter seguidas (verificar, firmar, anclar); la
pantalla "Lo que autorizas" se lee entera al 125 %; el botón te devuelve al
catálogo del agente. **Cronometra el anclaje.**

---

## F · La compra real, ahora con pedido en la tienda (escenas 4 y 5)

### F1 · Comprar 🧑

En la tarjeta de un producto (dice **in the grant**): **Quantity 1** + datos de
envío de prueba → **Ask the agent to buy it**.

**Espera:** en **My services**, aviso verde **Bought: <producto>** con **See the
payment on Stellar ↗**; Stellar Expert muestra **Successful** y la transferencia
de USDC por el monto del producto. **Cronómetro** del clic al pago: objetivo <
20 s (la primera compra de una cuenta nueva despliega su contrato de pago y
tarda más: hazla fuera de cámara).

### F2 · El pedido llegó de verdad a la tienda 🧑 (esto es lo nuevo)

1. Abre el admin de Shopify → **Orders**.
2. **Espera:** un pedido **Paid**, con el producto, la cantidad, el total en CLP,
   el envío "Vitrinee x402", el cliente "Agente Vitrinee", el hash del pago de
   Stellar en los atributos (`x402_tx`) y el **stock bajó** en la cantidad
   comprada. **No** llegó correo a ningún comprador.

### F3 · El recibo y el panel del dueño (escena 5) 🧑

1. `https://vitrinee.agentpey.com` (wallet dueña) → **What agents bought from
   you** → el pedido nuevo.
2. **Espera:** estado **"Paid, order in your store"** (no el "aún no llega" de
   Jumpseller), con enlaces **Payment** y **Receipt**.
3. **Receipt** abre **Sale receipt**: **Valid receipt: all three checks pass**,
   tres comprobaciones en verde, producto y total. Agrega `?lang=en` si sale en
   español.

### F4 · Verificar por línea de comandos (sin secretos para verificar) 🔑

```bash
pnpm run vitrinee:buy -- "compra un pack de stickers" --gateway https://vitrinee.agentpey.com --max-usdc 5
```

*(cambia el texto por un producto real de la tienda que corresponda; `--dry-run`
solo muestra qué haría)*. Guarda el recibo en `.vitrinee/last-receipt.jws`.

```bash
pnpm run vitrinee:verify
```

**Espera:** las tres comprobaciones en verde (firma, ancla en Soroban, pago en
Horizon), salida 0.

```bash
pnpm run vitrinee:verify -- --tamper
```

**Espera:** **rojo**: baja el monto y conserva la firma; tiene que fallar.

### F5 · Un pedido que no llega a la tienda: reintentar sin cobrar

Solo si alguna vez el pedido queda `paid_unfulfilled`: `POST /orders/<id>/fulfil`
lo reintenta **sin volver a cobrar**. Con Shopify no debería hacer falta;
anótalo como "no aplicó".

---

## G · Los rechazos (escena 6 y sus hermanas) 🧑

**Regla de oro de toda esta parte:** en cada intento fallido, mira tres cosas:
(1) aviso rojo **Refused: <producto>** con el motivo en lenguaje llano y **"Nothing
was paid"**; (2) el **Daily limit** de **My services** **no cambia**; (3) el saldo
del contrato de pago **no cambia** (`pnpm run check:rail-balances` 🔑, o
Stellar Expert del contrato). Los textos vienen de
`apps/realops/src/refusals.ts` (tabla en `CODIGOS-DE-RECHAZO.md`).

| # | Cómo provocarlo | Código | Texto esperado (EN/ES en el archivo) |
|---|---|---|---|
| **G1 · Escena 6** | En la tarjeta del producto, **Quantity 20** (o lo que pase 25,00) | `MandateAmountExceeded` | "El precio supera el máximo por compra que firmaste." Siguiente: firmar un permiso con tope más alto |
| G2 | Con un permiso de tope **por compra** alto y **diario** bajo, comprar dos veces | `MandateDailyLimitExceeded` | "Esta compra haría que superes el tope diario que firmaste." Se reinicia mañana |
| G3 | Un producto de la tienda que **no** está "in the grant" (si el catálogo ofrece alguno) | `MandateProductNotAllowed` | "Tu permiso cubre este comercio, pero no ese producto en particular." |
| G4 | En `/agentes/<id>` → **Revoke this permission** → wallet que firmó → **Revoke the permission** → intentar comprar | `MandateRevoked` | "Revocaste este permiso." Siguiente: firmar uno nuevo |
| G5 | Agotar el saldo del contrato (compras seguidas) y pedir otra | `RailInsufficientFunds` | "La cuenta de pago de tu agente no tiene suficiente USDC de testnet, así que no se pagó nada." |
| G6 | Comprar más unidades que el stock del producto con 1 (A1.4) | `OutOfStock` (409, de la tienda) | **Sin texto propio en RealOps (sin verificar)**: caería al mensaje genérico "AgentPey refused the purchase for a reason this page cannot explain yet". Anótalo como mejora si sale |
| G7 | Permiso vencido | `MandateExpired` | **No hay forma de firmar un permiso corto desde la interfaz**: márcalo "solo en tests" |

**Para G1, si los productos son muy baratos** y 20 unidades no alcanzan 25,00:
contrata otro comprador con tope **más bajo** (el formulario deja editarlo, por
ejemplo 3,00) y pide 5.

**Para G4, después de revocar:** revisa que el agente **ya no aparece como
activo** y que ninguna compra pasa. Firma uno nuevo si quieres seguir probando.

**Para G5, arreglo:** 🔑 `pnpm run rail:topup -- <contrato C…> 3` (sin `--yes`
solo muestra lo que haría) y luego con `--yes`. Vuelve a comprar: debe pasar.

**Espera al terminar G:** ningún rechazo movió dinero, ninguno contó contra el
límite del día. **Este es el resultado que más importa de toda la prueba.**

---

## H · RealOps: las demás funciones 🧑

| # | Haz | Espera |
|---|---|---|
| H1 | En **My services**, escribe una instrucción libre: "quiero un kit de hongos" (en un agente de MycoKit) | Se entiende y propone la compra |
| H2 | Escribe algo sin sentido: "lo que sea" | `InstructionNotUnderstood` con dos botones de producto |
| H3 | `/agentes/<id>` | La pantalla de revisión con el JSON literal del permiso y sus etiquetas *firmado / on-chain / RealOps* |
| H4 | Contrata un agente de **SignalDesk** (informe de mercado 0,25; 1000 créditos 0,10) y cómpralos | Compra correcta; recibo |
| H5 | **My services** | Deliveries, recibos y rechazos en un solo lugar. La tarjeta puede seguir diciendo "delivered" en un pedido pagado sin entregar: deuda conocida (no se lee en voz alta) |
| H6 | `/salir` y vuelve a entrar con el enlace mágico | Sesión nueva sin perder los agentes |
| H7 | **No borres la cuenta** (`/cuenta/borrar`) hasta después de grabar: el mandato y los registros de la bóveda **no** se borran | — |

---

## I · AgentPass: credencial y revocación 🔑

Requiere `pnpm build` y `.env.local` con el contrato. Estos comandos leen
secretos: los corres tú.

```bash
node packages/cli/dist/bin.js issue --subject <G…del agente> --scope examples/scope.json --out /tmp/cred.jws
```
**Espera:** imprime el hash de la credencial y el de la transacción.

```bash
node packages/cli/dist/bin.js verify /tmp/cred.jws
```
**Espera:** `Active`, con emisor, sujeto, agente y `validUntil`.

```bash
node packages/cli/dist/bin.js revoke <hash>
```
```bash
node packages/cli/dist/bin.js verify /tmp/cred.jws
```
**Espera:** `CredentialRevoked: the registry reports this credential as
revoked`, salida 1. **Este es el "interruptor" de la Fase 1**: se corta desde
fuera del agente. (No existe un "kill switch" con ese nombre; este es su
equivalente. Ver `ROADMAP.md`.)

Recorrido automático de todo el ciclo en ~12 s: `pnpm demo`.

---

## J · PolicyRail y pago por el contrato 🔑

```bash
pnpm run demo:pay-real -- --payer=policy-rail
```
(necesita `pnpm run deploy:policy-rail -- --principal G…` antes). **Espera:** el pago
sale del contrato de pago, con sus límites por compra y por día aplicados
**dentro del contrato**. Opcional: `pnpm run loadtest:perday` para ver el tope
diario bajo carga. Los errores del contrato (`PerTxExceeded`, `PerDayExceeded`)
**no tienen texto de interfaz**: los rechazos que se ven en G ocurren antes, en
AgentPey (sin verificar que el contrato los aplique como último recurso: solo
tests).

---

## K · La API para partners 🔑

Con la clave de un partner (`pnpm run partner:key`; la corres tú). Usa `curl`
con `Authorization: Bearer <clave>`; **no me pegues la clave**.

| # | Llamada | Espera |
|---|---|---|
| K1 | `GET /v1/agents` | Lista de agentes |
| K2 | `POST /v1/purchases/preview` | Dice si pasaría o no, **sin gastar ni reservar nada** |
| K3 | `POST /v1/purchases` con `Idempotency-Key` | Compra; repetir la misma clave devuelve **la misma** compra, no cobra dos veces |
| K4 | `POST /v1/purchases` por encima del permiso | **HTTP 201** con `outcome: "refused"` (no un 4xx) |
| K5 | `GET /v1/purchases/<id>` | El estado y su recibo |
| K6 | Una clave equivocada | `InvalidApiKey` |
| K7 | Una clave sin el permiso (scope) | 403 |
| K8 | 11 llamadas costosas en un minuto | `RateLimited` con `retry-after` (límite: 10/min para las costosas, 120/min el resto) |
| K9 | `POST /v1/webhook_endpoints` con una URL local (`http://127.0.0.1/...`) | Rechazada (protección SSRF) |

La referencia completa: `docs/api/openapi.yaml` y
`examples/cloudops-partner-integration.md`.

---

## L · Estado y bóveda 🔑

```bash
pnpm --filter @agentpey/status-dashboard run dev
```
Abre `http://localhost:8790` (solo local, necesita `DATABASE_URL`). Escribe el
tenant: mandatos, la **bóveda con la verificación de su cadena de hashes** y las
métricas. Es de solo lectura: cualquier POST devuelve 405. **Espera:** la cadena
de la bóveda verifica; los rechazos de G aparecen como eventos.

---

## Al terminar

1. **Cancela** los pedidos de prueba de Shopify (restock).
2. Anota en la tabla los hallazgos. Lo que falle y valga la pena, me lo pasas y
   lo arreglo en una rama aparte.
3. Decide con el resultado: versión final de la escena 1 (Shopify o Jumpseller
   para el video) y si la frase "real Jumpseller stores" del cierre pasa a "real
   stores".

### Tabla de hallazgos

| Parte | Qué pasó | Segundos | ¿Falla o mejora? | Qué hago |
|---|---|---|---|---|
| | | | | |

## Qué no cubre este guion

- **Mainnet, dinero real, monedas distintas a CLP/USDC:** fuera de alcance.
- **Permiso vencido y las dos causas de contrato (`PerTxExceeded`,
  `PerDayExceeded`):** solo se prueban en tests, no en vivo.
- **Registro de la tienda Jumpseller** (sigue funcionando, pero sin pedido en la
  tienda por `C-151`): el alta se puede repetir con Jumpseller en el paso C si
  hay interés.
- **App OAuth de Shopify o Jumpseller:** se descartó (`VT-33`, `C-151`).
