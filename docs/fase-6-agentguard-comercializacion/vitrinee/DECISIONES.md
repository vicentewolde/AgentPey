# Decisiones

> Una entrada por decisión no trivial, con su motivo y la alternativa que se
> descartó. **No se borran entradas**: si una decisión se revierte, se marca
> como `Superada` y se agrega la nueva. Prefijo `VT-`.
>
> Contexto: [CONTEXTO.md](CONTEXTO.md) · Estado: [BITACORA.md](BITACORA.md)

Estados: `Vigente` · `Superada` · `Pendiente` (tomada, aún no implementada)

---

### VT-1 · Gateway HTTP externo, no plugin nativo de la plataforma · `Vigente`
**Fecha:** 2026-09-22

Vitrinee es un servidor propio que habla con la tienda por su API REST
(Jumpseller: `products`, `orders`). La tienda no instala nada.

**Motivo.** Un plugin Liquid/PHP viviría dentro de cada plataforma, con su
ciclo de revisión, su lenguaje y sus límites (Jumpseller no ejecuta código de
servidor de terceros en la tienda). Un gateway se conecta a Jumpseller hoy y a
WooCommerce mañana cambiando un adapter, y la capa x402 se escribe una sola
vez. Además, el manifest `/.well-known/agent-storefront.json` necesita un
origen HTTP que la plataforma no da.

**Alternativa descartada:** app oficial de Jumpseller (OAuth) o plugin de
WooCommerce. Mejor distribución a largo plazo, imposible en 8 días, y no
resuelve el caso multi-plataforma.

---

### VT-2 · Tasa de cambio fija de demo, sin oráculo · `Vigente`
**Fecha:** 2026-09-22

El catálogo está en CLP; el agente paga en USDC. La conversión usa una tasa
fija declarada en el manifest (`fx.rate`, `fx.source: "demo-fixed"`), leída
de `FX_RATE_CLP_USD`. Valor de demo confirmado por Vinny: **950 CLP/USD**.

**Motivo.** Un oráculo (Reflector u otro) agrega una dependencia externa, un
punto de fallo en el video y una discusión de "qué tasa es la correcta" que no
aporta al hackathon. Lo que importa demostrar es que la conversión es exacta
(enteros, sin floats, [VT-7](#vt-7)) y que el agente ve la tasa antes de pagar,
para que su política de gasto pueda evaluarla.

**Alternativa descartada:** oráculo on-chain, o pedir a la tienda que fije
precios en USDC. Ambas van al roadmap.

---

### VT-3 · `receipt-registry` sin admin ni upgrade · `Vigente`
**Fecha:** 2026-09-22

El contrato Soroban expone `anchor(hash, merchant, amount, order_ref)`,
`get(hash)` y `count(merchant)`. No hay admin, no hay upgrade, no hay
`initialize`.

**Motivo.** El registro solo guarda hashes de recibos, firmados por el
merchant que ancla (`merchant.require_auth()`). Un admin podría borrar o
alterar la prueba, que es exactamente lo que el registro existe para impedir.
Sin upgrade, el código que un revisor lee es el que corre.

**Alternativa descartada:** contrato upgradeable con admin (patrón
OpenZeppelin). Da mantenibilidad a costa de la garantía que vende el producto.
Si hay que cambiar el contrato, se despliega uno nuevo y el manifest apunta al
nuevo id.

**Implementado el 22 de septiembre:** `CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5`,
wasm `e0a87150…ac13f`, 11 tests Rust. `anchor` también rechaza montos ≤ 0 y
`order_ref` vacío o de más de 64 bytes; un hash ya anclado no se puede
reanclar ni por otro merchant. Entradas persistentes con TTL extendido a
120 días en cada escritura.

---

### VT-4 · Sin custodia: `payTo` es la cuenta del merchant · `Vigente`
**Fecha:** 2026-09-22

El `payTo` del challenge x402 es `MERCHANT_STELLAR_ACCOUNT`. El USDC va del
comprador al merchant en la misma transacción que el facilitator somete.
Vitrinee nunca tiene el secreto de esa cuenta.

**Motivo.** Es lo que hace defendible el proyecto frente a la Ley Fintech
([CONTEXTO.md](CONTEXTO.md)) y lo que hace que un merchant pueda confiar en un
gateway operado por un tercero: no hay nada que robar.

**Alternativa descartada:** cuenta escrow de Vitrinee que reciba y reenvíe.
Habilitaría reembolsos automáticos y ventanas de retracto hoy, pero convierte a
Vitrinee en custodio. La ventana de retracto se explora con claimable balances
en el roadmap, sin custodia.

---

### VT-5 · Anclaje asíncrono con reintentos · `Vigente`
**Fecha:** 2026-09-22

Tras el pago, el gateway crea la orden, emite el recibo y **responde** con
`anchorStatus: "pending"`. El anchor en Soroban corre aparte, con reintentos;
`GET /orders/:id` refleja `anchored` cuando confirma.

**Motivo.** Esperar el ledger (~5 s) dentro de la respuesta del checkout
duplica la latencia que el agente ya pagó en el settlement, y un RPC lento
haría fallar compras que ya se cobraron. El recibo firmado es válido desde que
se emite; el anchor lo hace verificable por terceros.

**Alternativa descartada:** anchor síncrono. Más simple de explicar, peor
experiencia y más frágil en vivo.

**Implementado el 22 de septiembre:** una cola serializada (todas las anclas
las firma la misma cuenta; dos en vuelo chocarían por número de secuencia),
reintentos a 2, 5 y 15 s, estado `pending → anchored | failed` con
`lastError` en la orden, y reanudación al arrancar. Si el contrato responde
`AlreadyAnchored` (un intento anterior sí llegó), se trata como éxito. En la
práctica el anclaje confirma 4–5 s después de responder el checkout.

---

### VT-6 · Settlement con el SDK oficial `@x402/*` 2.26.0 y precio dinámico por request · `Vigente`
**Fecha:** 2026-09-22

El gateway usa `paymentMiddleware` de `@x402/express` con `ExactStellarScheme`
de `@x402/stellar` y `HTTPFacilitatorClient` contra el facilitator "Built on
Stellar" (OpenZeppelin). El precio de `POST /checkout/:productId` se resuelve
en cada request desde el adapter.

**Motivo.** Verificado en los tipos de `@x402/core` 2.26.0: `PaymentOption.price`
acepta `(context) => Price`, y los patrones de ruta soportan `:param`. No hace
falta ni reimplementar el esquema `exact` ni registrar una ruta por producto.
Se usa 2.26.0 porque es la última publicada (15 de septiembre de 2026), es la
que documenta la guía oficial de Stellar, y el ejemplo `simple-paywall` del
repo `stellar/x402-stellar` usa la misma API con `^2.23`.

**Alternativa descartada:** el plan B del brief (una ruta por producto,
recargada cada 60 s) y la implementación manual del esquema. Ambas son más
código para el mismo resultado.

---

### VT-7 · Dinero como enteros de punta a punta, un solo redondeo · `Vigente`
**Fecha:** 2026-09-22

Todo monto es un `bigint` en unidades atómicas: CLP sin decimales, USDC con
7. La conversión CLP→USDC hace una sola división entera con redondeo
half-up. Ningún `number` representa dinero.

**Motivo.** Un float en la ruta del precio produce montos que no cuadran
entre el manifest, el challenge x402 y el recibo, y el facilitator rechaza
un `amount` que no coincida exactamente. Con enteros el mismo producto da el
mismo `priceUSDCAtomic` en los tres lugares, siempre.

**Alternativa descartada:** `Number` con `toFixed(7)`. Funciona hasta que no.

---

### VT-8 · Dos llaves del merchant: `payTo` y firma · `Vigente`
**Fecha:** 2026-09-22 · **Confirmada por Vinny:** 2026-09-22

`MERCHANT_STELLAR_ACCOUNT` recibe los pagos y no tiene secreto en el gateway.
`MERCHANT_SIGNING_SECRET` es una llave distinta: firma los recibos JWS y paga
la transacción de anchor. El `did:stellar` del recibo se deriva de la llave de
firma; el manifest publica ambas cuentas.

**Motivo.** El brief pedía a la vez "Vitrinee nunca tiene llaves del merchant"
y "`MERCHANT_SECRET` firma y ancla". Con una sola llave, esas dos frases se
contradicen. Separarlas mantiene [VT-4](#vt-4) literal: la llave que el gateway
guarda no puede mover fondos del merchant, solo emitir recibos y pagar fees de
anchor con su propio XLM.

**Alternativa descartada:** una sola llave. Menos variables, pero el gateway
podría vaciar la cuenta del merchant. Vinny confirmó las dos llaves el mismo
día 0.

---

### VT-9 · `soroban-sdk` 28.0.0, compilado solo con `stellar contract build` · `Vigente`
**Fecha:** 2026-09-22

`contracts/` fija `soroban-sdk = "28.0.0"`. El wasm se produce con `stellar
contract build` (CLI 28.0.0); `cargo build --target wasm32v1-none` directo
queda fuera de los scripts y del README.

**Motivo.** Testnet corre protocolo 28 y 28.0.0 ya es estable en crates.io
(AgentPey, tres semanas antes, solo tenía el rc). Se verificó en un contrato
de plantilla: `cargo build` directo falla con "soroban-sdk requires stellar-cli
v25.2.0+", `stellar contract build` produce el wasm y `cargo test` pasa.
Alinear SDK y protocolo evita explicar un desfase en el video.

**Alternativa descartada:** 27.0.6 como AgentPey, que sigue siendo lo que
`stellar contract init` escribe. Funciona en protocolo 28, pero no hay razón
para arrancar un proyecto nuevo un major atrás.

---

### VT-10 · Flujo `upfront`: el facilitator liquida antes de que corra el handler · `Vigente`
**Fecha:** 2026-09-22

`POST /checkout/:productId` declara `extra.paymentFlow: "upfront"`. El SDK
llama a `settle` del facilitator **antes** de ejecutar el handler; el handler
recupera el resultado (tx hash, pagador) desde un libro en memoria que llena
el hook `onAfterSettle`, correlacionado por la transacción firmada que viaja
en `PAYMENT-SIGNATURE`. Solo entonces se crea la orden en la plataforma.

**Motivo.** El flujo por defecto (`authorization`) es verify → handler →
settle: la orden se crearía antes de que el dinero se mueva, y si el settle
falla habría que cancelarla en Jumpseller; además el cuerpo de la respuesta
se genera antes del settle, así que no podría incluir el tx hash. Con
`upfront`, ninguna orden existe sin pago liquidado, y la respuesta lleva todo
en una sola vuelta. Verificado en los tipos y en el código de `@x402/express`
2.26.0: el middleware no expone `beforeHandlerSettlement` al handler, de ahí
el libro de settlements. Nota: en `upfront` el SDK no llama a `verify`; la
validez la establece `settle`.

**Consecuencia asumida.** Si la plataforma falla *después* del pago, el
gateway responde 200 con `status: "paid_unfulfilled"` y guarda el registro
para cumplimiento manual. Responder ≥ 400 haría creer al agente que no pagó.

**El pagador se lee de la transacción firmada** (`from` del `transfer`
SEP-41), o del `payer` que informa el facilitator; el `buyer.stellarAccount`
del body es solo un último recurso. El recibo no puede fiarse de lo que el
cliente declara.

**Alternativa descartada:** escribir el middleware Express a mano para leer
`beforeHandlerSettlement` directo. Menos indirección, pero reimplementa el
buffering de respuesta del SDK ([VT-6](#vt-6)).

---

### VT-11 · Jumpseller: orden creada pagada, tx hash en `additional_information` y en el historial · `Pendiente` (día 3)
**Fecha:** 2026-09-22

El adapter crea la orden con `POST /orders.json` (`status: "Paid"`,
`customer`, `products[{id, qty, price}]`) y a continuación `PUT
/orders/{id}.json` con el tx hash y el pagador en `additional_information`,
más una entrada en `POST /orders/{id}/history.json`.

**Motivo.** Verificado en el OpenAPI oficial (`Jumpseller/api-docs`):
`OrderCreateFields` no admite `additional_information` ni `payment_method_name`
(solo lectura), y `PUT` solo permite `status`, `shipment_status`,
`tracking_*`, `additional_information` y `additional_fields`. Dos llamadas
son el camino que la API ofrece; no se inventan campos. El plan trial expone
la API completa (tienda `vitrinee.jumpseller.com`, plan pro en trial).

**Alternativa descartada:** `additional_fields` con etiqueta propia. Sirve
igual, pero `additional_information` se ve en el panel sin configurar nada.

---

### VT-12 · El secreto de la cuenta `payTo` existe solo para `bootstrap` · `Vigente`
**Fecha:** 2026-09-22

`pnpm bootstrap` genera la cuenta `payTo` del merchant, abre su trustline USDC
(imposible sin firmar con ella) y guarda el secreto en
`MERCHANT_PAYOUT_SECRET` dentro de `.env.local`. **El gateway no lee esa
variable**; `loadConfig` tiene un test que lo asegura.

**Motivo.** [VT-4](#vt-4) y [VT-8](#vt-8) prometen que el gateway no puede mover
fondos del merchant. En la demo el merchant es Vinny, y Vinny necesita poder
mirar y mover su USDC de testnet después del video; una llave que nadie
guarda es una cuenta que nadie puede usar.

**Camino a producción:** el merchant trae su propia cuenta ya fondeada y con
trustline; `bootstrap` no la genera ni la conoce. Registrado en el roadmap.

---

### VT-13 · Tres checks de verificación, cada uno independiente del gateway · `Vigente`
**Fecha:** 2026-09-22

Un recibo es válido solo si pasa los tres:

1. **Firma**: EdDSA sobre Ed25519 con la llave que está dentro del
   `did:stellar` del `kid`, y ese DID debe ser el `merchantDid` del recibo
   (si no, cualquiera podría firmar con su propia llave). Puro, sin red.
2. **Anclaje**: `sha256(jws compacto)` está en `receipt-registry`, anclado
   por la cuenta del DID, con el mismo monto y `order_ref = orderId`.
3. **Pago**: la tx de settlement que cita el recibo existe en Horizon, fue
   exitosa, y sus efectos muestran al pagador debitado y al merchant
   acreditado exactamente ese USDC.

El registro se lee con `getLedgerEntries` sobre la clave de storage
(`DataKey::Receipt(hash)`), no simulando `get`: así un verificador no
necesita cuenta fuente ni llave alguna. La contrapartida es que el cliente
conoce el layout del storage; queda amarrado a `STORAGE_SCHEMA_VERSION = 1`.

`GET /receipts/:hash/verify` verifica un recibo que el gateway emitió;
`POST /receipts/verify` verifica **cualquier** recibo, incluido uno editado,
y `pnpm demo:verify` corre los mismos tres checks localmente sin tocar el
gateway. Lo último es el argumento del pitch: el principal del agente no
tiene que confiar en la tienda.

**Alternativa descartada:** VC-JWT completo (`vc`, `@context`,
`credentialSubject`). Se mantiene un JWS con claims propios y `typ`
explícito; la envoltura VC no agrega verificabilidad y sí peso. Un paso a VC
queda en el roadmap si un wallet lo pide.

---

### VT-14 · Un sexto producto barato en el mock, para las pruebas reales · `Vigente`
**Fecha:** 2026-09-22

El brief pedía 5 productos en el adapter mock. Se agregó un sexto: "Pack de
stickers Cordillera", 990 CLP = 1,0421053 USDC. `pnpm test:integration`
compra ese producto.

**Motivo.** Cada corrida de integración mueve USDC real de testnet, y el
faucet de Circle da 20 USDC por solicitud con captcha. Con el café (9,46 USDC)
alcanzaban dos corridas; con los stickers, unas diecinueve. El producto del
video sigue siendo el hoodie.

**Alternativa descartada:** comprar el café y pedirle a Vinny que rellene
el faucet cada dos pruebas.

---

### VT-15 · Idempotencia en tres capas y reserva de stock durante el settle · `Vigente`
**Fecha:** 2026-09-22

1. **`Idempotency-Key`** (opcional, 1–255 ASCII imprimible): si ya produjo
   una orden, el checkout responde esa misma orden con
   `Idempotent-Replayed: true` **antes** del 402, sin volver a cobrar; si se
   reusa para otra compra, 409 `IdempotencyConflict`; si hay un pago en vuelo
   con esa clave, 409.
2. **Una transacción de settlement, una orden**: si el tx hash ya tiene
   orden, se devuelve esa. Defensa ante un facilitator que devuelva el mismo
   settle dos veces.
3. **Una firma, un settle**: el libro de settlements entrega cada resultado
   una sola vez; y el facilitator rechaza una auth entry ya usada.

Además, mientras un pago está en vuelo sus unidades quedan reservadas: un
segundo comprador del último stock recibe 409 antes de pagar, en vez de pagar
y quedar `paid_unfulfilled`. La reserva vive en memoria de un solo proceso,
que es lo que hay en la demo.

**Alternativa descartada:** reservar en la plataforma (Jumpseller no tiene
reservas en su API) o bloquear stock al emitir el 402 (un agente que nunca
paga dejaría productos bloqueados).

---

### VT-16 · El envío del storefront se configura a mano; el pedido por API no lo usa · `Vigente` (día 3)
**Fecha:** 2026-09-22

**Los métodos de envío de la tienda no se pueden configurar por la API.** El
checkout manual del storefront fallaba ("Falta el método de envío", después
"Este método de envío no está disponible para esta ubicación") porque el
"Correo Ordinario" que trae Jumpseller por defecto no tiene tarifa y
Bluexpress es la integración real con el courier, que sin cuenta conectada no
cotiza. Ninguno se arregla desde `/shipping_methods.json`:

- `POST` solo acepta `type: "external"` y `"tables"`. `"free"`, `"flat"` y
  `"correos_chile"` devuelven `400 "Tipo de método de envío no válido"`.
- `PUT` sobre un método creado en el panel como `type: "free"` devuelve `400
  "El tipo de método de envío seleccionado no es editable en este momento"`,
  incluso para cambiar solo `enabled`. `DELETE` sí funciona.
- Un `tables` **con `locations` poblado devuelve `500`** en las cuatro formas
  que admite el schema oficial (`{country}`, `{country, region}` con región
  entero o string, y nombre de país). Sin `locations` el `POST` pasa, pero la
  tabla queda sin ubicaciones y no aplica a ningún destino, que es
  exactamente el error que ve el comprador.
- No hay endpoint de zonas de envío.

Un `POST` que devuelve `500` acá **igual deja un registro roto a medio
crear**. Si el adapter alguna vez toca este endpoint, verificar con un `GET`
después de cualquier `500` en vez de asumir que no pasó nada.

**Consecuencia para el adapter: ninguna.** `OrderCreateFields` acepta
`shipping_method_name` y `shipping_price` como texto y número libres (sin
`shipping_method_id`), así que la orden que crea el gateway declara su propio
envío y nunca consulta la configuración de la tienda. El flujo del agente es
independiente de esto; solo el checkout manual del storefront lo necesita, y
eso es para grabar el video.

**Alternativa descartada:** montar un método `type: "external"` apuntando a
un `callback_url` del gateway. Funcionaría y es tentador (Vitrinee cotizando
el envío), pero exige el gateway desplegado y público para algo que en la
demo son cuatro clics en el panel.

---

### VT-17 · `/discovery/resources` es un espejo local, no el bazaar de x402 · `Vigente` (día 3)
**Fecha:** 2026-09-22

El brief asume que la "discovery extension" es un endpoint del gateway. Leído
`@x402/extensions` 2.26.0, el modelo real es otro: **el catálogo vive en el
facilitator**. Un resource server se declara dentro de sus respuestas 402
(`declareDiscoveryExtension` + `bazaarResourceServerExtension`) y el cliente
consulta al facilitator con
`withBazaar(client).extensions.bazaar.listResources()`, que devuelve
`DiscoveryResourcesResponse`. No hay en la especificación ningún endpoint para
que una tienda liste sus propios recursos.

`GET /discovery/resources` se sirve igual, con la forma exacta de
`DiscoveryResourcesResponse` (`x402Version`, `items[]`, `pagination`) y cada
producto como un `DiscoveryResource` con sus `PaymentRequirements` reales.
Queda claro en el código y acá que es un espejo local, no un estándar
inventado. Responde la pregunta que un agente con el manifest en la mano sí
hace —"qué puedo comprar y cuánto cuesta cada cosa"— en un formato que ya
parsea.

Dos detalles: solo aparece lo que el checkout aceptaría vender (un producto
con `stock: 0` sigue en el manifest, donde el cero es información, pero no
acá, donde sería una oferta que el checkout va a rechazar); y el precio
publicado es **unitario**, marcado con `extra.unitPrice`, porque el checkout
recotiza por `quantity`.

**Alternativa descartada:** declarar la extensión en las rutas de checkout
para aparecer en el bazaar del facilitator de OpenZeppelin. Es lo
espec-correcto y queda como stretch, pero depende de que ese facilitator
implemente el bazaar, y la discovery extension es lo primero que el brief
manda a cortar (regla 8).

---

### VT-18 · Un solo servicio: el gateway sirve el dashboard · `Vigente` (día 4)
**Fecha:** 2026-09-22

`apps/dashboard` son tres archivos estáticos (HTML, CSS, JS de navegador, sin
framework ni paso de build) que el gateway sirve en `/dashboard` con
`express.static`. `render.yaml` declara **un** servicio web, no dos.

**Motivo.** Dos servicios significan dos despliegues que se pueden
desincronizar, una variable con la URL del otro, y CORS que configurar — tres
cosas que se rompen en vivo, y el video se graba una sola vez. Sirviéndolo
desde el mismo origen, cada `fetch` del dashboard es relativo (`/orders`,
`/receipts/:hash/verify`) y no hay nada que configurar. Sin build step, la
página que se despliega es exactamente la que está en el repo: no hay un
bundler entre lo que se lee y lo que corre.

La ruta se resuelve con `new URL("../../../apps/dashboard/public",
import.meta.url)`, que apunta al mismo lugar desde `src/` y desde `dist/`
porque están a la misma profundidad. Si el directorio no existe, el gateway
lo dice en el log y sigue sirviendo la API: un dashboard ausente no tumba la
tienda.

**Alternativa descartada:** un static site aparte en Render (gratis, y separa
responsabilidades) o una SPA con Vite. Mejor arquitectura para un producto que
crece; peor apuesta para una demo de 3 minutos que se graba el día 29.

---

### VT-19 · El merchant trae su propia cuenta Stellar; Vitrinee no la genera · `Pendiente`
**Fecha:** 2026-09-22 · **Confirmada por Vinny:** 2026-09-22

La tienda recibe **USDC en una cuenta Stellar propia**, creada por el merchant
en Freighter y custodiada por él. `MERCHANT_STELLAR_ACCOUNT` pasa a ser un dato
de entrada del despliegue, no una salida de `pnpm bootstrap`. La conversión a
CLP, si la tienda la quiere, es asunto de la tienda con un tercero licenciado:
Vitrinee no la ofrece, no la intermedia y no la documenta como propia.

**Motivo.** Es la única forma de sostener [VT-4](#vt-4) sin excepciones. En el
momento en que Vitrinee recibiera USDC para entregar pesos, sería custodio e
intermediario y entraría de lleno en la Ley 21.521, que
[CONTEXTO.md](CONTEXTO.md) promete evitar por diseño. Con la llave en Freighter,
el gateway no sólo *no usa* el secreto del merchant: no lo conoce.

Activa el "camino a producción" que [VT-12](#vt-12) dejaba en el roadmap.
`MERCHANT_PAYOUT_SECRET` y la generación en `bootstrap` siguen existiendo como
modo de conveniencia para una máquina limpia sin cuenta previa, pero dejan de
ser el camino por defecto de la demo.

**Consecuencia.** `bootstrap` debe aceptar una `payTo` externa y, en ese modo,
no generar ni escribir secreto alguno. Debe además **verificar** que la cuenta
existe, está fondeada y tiene trustline USDC, y fallar con un mensaje accionable
si no — un `payTo` sin trustline hace fallar el settlement después de que el
agente ya firmó.

**Costo asumido.** El onboarding de una tienda real incluye "abre Freighter,
fondea, agrega el activo USDC". No es cero, y es la fricción número uno para la
tienda número dos. Se asume a cambio de no ser custodio.

**Alternativa descartada:** que Vitrinee reciba USDC y liquide CLP al merchant.
Resuelve la fricción de golpe y es lo que la tienda quiere; convierte a Vitrinee
en un sujeto regulado por la CMF y mata la tesis de "no hay nada que robar".

---

### VT-20 · El usuario del MVP es el developer con un agente, no el consumidor final · `Vigente`
**Fecha:** 2026-09-22 · **Confirmada por Vinny:** 2026-09-22

Vitrinee se construye para **quien ya tiene un agente** y necesita que compre
algo real: un equipo de producto con un agente en operación (Exponential es el
caso identificable), o un developer que hoy prueba su agente contra endpoints de
juguete. El agente de consumidor genérico que descubre tiendas y recomienda
dónde comprar es **roadmap**, no MVP.

**Motivo.** Es el único usuario al que Vitrinee llega sin permiso de nadie: no
depende de que una plataforma de consumidor acepte a la tienda en su índice. Es
también el único para quien el recibo firmado y el anclaje son el argumento de
compra y no un extra — un agente que compra por cuenta de una empresa tiene que
rendirle cuentas a su principal, y ése es exactamente el documento que Vitrinee
emite. Para un consumidor comprando un hoodie, esa mitad del producto sobra.

**Lo que esto descarta explícitamente.** Vitrinee **no resuelve la demanda** de
la tienda. No promete compradores, no rankea, no recomienda y no cobra comisión
sobre venta referida. Prometer eso convertiría el gateway en un marketplace, que
[CONTEXTO.md](CONTEXTO.md) declara que Vitrinee no es.

**El hedge, que es barato.** El manifest ya es un feed legible por máquina. Si
una plataforma de comercio agéntico publica su spec de comerciantes, Vitrinee la
sirve como **otro formato de salida del mismo catálogo**, sin tocar el checkout
ni el recibo. Junto con tratar el esquema de pago como reemplazable, es todo el seguro contra haber apostado al riel equivocado.

**Hipótesis sin verificar.** Vinny menciona un agente "Muse" de Meta llegando a
Chile. No se pudo confirmar que ese producto exista. Queda anotado como
hipótesis de distribución, no como plan, y nada del MVP depende de él.

**Alternativa descartada:** vender a la tienda la promesa de que los compradores
van a llegar. Es lo que la tienda quiere oír, es falso hoy, y lo descubriría en
dos semanas.

---

### VT-21 · Se paga un mes de Jumpseller; no se cambia de plataforma · `Vigente`
**Fecha:** 2026-09-22 · **Confirmada por Vinny:** 2026-09-22

"Pedido real en una tienda real" queda **dentro del MVP**. Para desbloquearlo se
suscribe un plan pagado de Jumpseller por un mes, que resuelve a la vez el `403`
en `POST /orders.json` y el vencimiento del trial cerca del 29 — el día del
video. Antes de pagar hay que preguntarle a soporte si un plan pagado
efectivamente habilita la creación de pedidos por API: el mensaje del 403 lo
sugiere, no lo confirma. Si la respuesta tarda más de un día, se paga igual.

**Motivo.** Se evaluó cambiar a una plataforma más usada (Tiendanube/Nuvemshop y
Shopify son mayores en LatAm; WooCommerce tiene la base instalada más grande).
Se descartó: lo que llevan tres días de trabajo en Jumpseller no es el adapter
sino el conocimiento de sus límites reales ([VT-11](#vt-11), [VT-16](#vt-16)), que
sólo se aprende chocando. En una plataforma nueva se empieza a chocar de cero
con cuatro días restantes. El recurso escaso es el tiempo, no la plata. Además
la tienda chilena en Jumpseller es la historia del pitch.

Que la pregunta se pueda hacer sin rehacer el producto es la evidencia de que
[VT-1](#vt-1) estaba bien: la plataforma es una decisión de adapter, no una
apuesta fundacional. WooCommerce sigue siendo el segundo adapter del roadmap,
justamente para probar esa portabilidad.

**Implementado el 2026-09-23.** El usuario pagó; la tienda quedó en plan
`basic`, `subscription_status: subscribed`. Verificado sin crear nada real: un
`POST /orders.json` con un producto inexistente responde `400` ("No se encontró
el producto") en vez del `403` del trial, y el conteo de pedidos sigue en 0.

**Alternativa descartada:** correr la demo con `ADAPTER=mock`. Gratis, y obliga
a explicar en el video por qué la "tienda real" es un mock — el único criterio
que el proyecto entero existe para demostrar.

---

### VT-22 · El pagador puede ser una cuenta contrato (`C…`), de punta a punta · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T99 (`C-130`)

`payerAccount` del recibo, `buyer.stellarAccount` del checkout, la lectura del
pagador desde la transacción firmada (`payer.ts`) y el check de settlement de
la verificación aceptan una cuenta clásica (`G…`) **o** una cuenta contrato
(`C…`). La tienda sigue cobrando (`payTo`) y firmando recibos (`merchantDid`)
con cuentas clásicas: `did:stellar` es una llave Ed25519 y una cuenta contrato
no la tiene.

**Motivo, probado antes de escribir código.** AgentPey paga desde un
`policy_rail`, que es una cuenta contrato. La pregunta que decidía si T99
servía era si el facilitator de Vitrinee (OpenZeppelin) liquida un pago `exact`
desde un `C…`. Se probó con el código real de los dos lados: requisitos armados
por el propio servidor x402 de Vitrinee, pago firmado por
`PolicyRailStellarScheme` de AgentPey, `verify` y `settle` contra ese
facilitator. Liquidó: tx
`42d738d476613d5dc1de14d7eb3032837ae9ffd02b0e1d6e424dd96e8c4ba761`, 0,001 USDC
del rail `CANSQ…` al `payTo` `GC5ZY…`. Antes de este cambio el pago se habría
liquidado y **después** habría fallado la firma del recibo, con la plata ya
movida.

**Lo que `C-130` no listaba.** Además del recibo, se rompía el check 3 de la
verificación: Horizon registra el débito de una cuenta contrato como
`contract_debited`, con el `C…` en el campo `contract`, y pone en `account` a
quien envió la transacción, que es el canal del facilitator. Comparar contra
`account`, como se hacía para `G…`, habría dado el recibo por inválido, y
aceptar ese `account` habría atribuido el pago al facilitator. El check
compara contra `contract` para un pagador `C…`, y hay un test que prueba que el
canal nunca cuenta como pagador.

**La especificación sigue en `0.1`.** Es un cambio compatible hacia adelante:
todo recibo emitido antes sigue siendo válido. Queda anotado en el propio
`SPEC-agent-storefront.md` que un verificador escrito antes rechazaría un
recibo con pagador `C…`.

**Alternativa descartada:** que AgentPey pague a Vitrinee desde la cuenta
clásica del agente, sin `policy_rail`. Resolvía el recibo sin tocar Vitrinee,
pero sacaba de la compra justamente el límite que se hace cumplir en la red
(`M-21`, `M-22`), que es la mitad de la historia de AgentPey.

---

### VT-23 · El checkout acepta también `GET`, con los datos en la query · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T99 (`C-130`)

`/checkout/:productId` responde por `GET` además de por `POST`. `GET` lee la
query (`quantity`, `name`, `address`, `city`, `region`, `country`, `email`,
`notes`), la traduce a la forma del cuerpo del `POST` y la valida con **el
mismo esquema zod**, así las dos puertas no pueden aceptar cosas distintas.
Cada puerta lee solo su fuente. Las respuestas del checkout llevan
`Cache-Control: no-store`. `HEAD` responde `405`.

**Motivo.** `requestPaymentChallenge` de AgentPey pide el 402 con un `GET` sin
cuerpo, y `executeBazaarPayment` reintenta la misma URL con la firma. Es lo que
hacen casi todos los clientes x402, así que la puerta le sirve a cualquiera, no
solo a AgentPey.

**Por qué `HEAD` es `405` y no se deja pasar.** Express atiende `HEAD` con los
handlers de `GET`, pero el middleware x402 solo protege los métodos que tiene
configurados. Un `HEAD` se habría saltado el cobro y habría llegado al paso que
crea el pedido. No se creaba nada (ese paso exige un settlement registrado),
pero respondía un `500` con un mensaje que decía que el pago se había liquidado.

**Por qué no es un riesgo de CSRF.** Un `GET` que cambia estado suele serlo.
Acá el cambio de estado exige la cabecera `PAYMENT-SIGNATURE`, que un link o
una imagen de otro sitio no pueden poner.

**Costo abierto, sin decidir:** con `GET`, nombre y dirección de despacho van
en la URL. El middleware x402 usa esa URL como `resource.url` del 402 y el
cliente la copia al payload que manda al facilitator. Confirmado en la prueba
de T99: la URL con la dirección llegó al facilitator. Además, AgentPey guarda
esa URL como `delivery.resource_url` en el registro de la compra. **Resuelto
en parte por [VT-25](#vt-25)**: el facilitator ya no la recibe.

**Alternativa descartada:** que AgentPey haga el checkout por `POST` cuando el
comercio lo pida. Obligaba a un camino de pago nuevo en AgentPey solo para este
comercio, que es exactamente lo que `F7` y `C-130` quieren evitar.

---

### VT-24 · Discovery también en formato `ServiceCard`, con los datos de despacho como `input` · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T99 (`C-130`)

`GET /api/discovery/search` responde los productos que se pueden vender ahora
en el formato `ServiceCard` que lee el catálogo de AgentPey para cualquier
comercio x402. Cada tarjeta trae el precio **unitario** en USDC decimal, el
`payTo` como `destination`, un `routeTemplate` a la puerta `GET` del checkout y
cinco `input` obligatorios: `quantity` (`number`), `name`, `address`, `city` y
`region`. `/discovery/resources` ([VT-17](#vt-17)) se queda, para los clientes
que hablan `@x402/extensions`.

**Motivo.** Con este formato, agregar una tienda Vitrinee a AgentPey es una
fila en `venues.json`, sin código de ningún lado (`F7`). RealOps ya arma un
formulario por producto con los `input` y los manda como `route_params` (T96).

**Por qué todos obligatorios.** `fillRouteTemplate` de AgentPey rechaza un
marcador que el que llama no llenó, así que un `input` opcional dentro del
`routeTemplate` fallaría siempre que falte. `country` no se declara: la tienda
despacha solo a Chile y el checkout pone `CL` por defecto. `email` tampoco: el
adaptador de Jumpseller ya inventa uno de prueba a partir del pagador.

**Por qué recortar nombre y descripción.** AgentPey valida el feed entero o
nada: un nombre de más de 200 caracteres o con un carácter de control sacaría
todos los productos de la tienda de su catálogo. La tarjeta es un resumen; el
manifest conserva el texto completo.

**Acoplamiento anotado para T100.** `quantity` viaja dos veces: como la
cantidad de la compra (la que firma el intent) y como `route_param`. Si no
coinciden, el 402 cotiza otro total y `reconcileTerms` rechaza **antes de
firmar**: falla cerrado, pero con un error poco claro para quien compra.

**Alternativa descartada:** un adaptador de catálogo propio para Vitrinee en
AgentPey, leyendo el manifest. Funcionaba, y rompía la promesa de `F7` para
este comercio.

---

### VT-25 · El `resource.url` del 402 nunca lleva la query · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** T99, después del cierre · Recomendación de Claude Code, aprobada por el usuario

El 402 del checkout anuncia como `resource.url` la dirección del checkout sin
query: `…/checkout/37282902`, no `…/checkout/37282902?name=…&address=…`. Se
hace dándole a x402 cada request con un adaptador cuyo `getUrl()` corta la
query (`QueryFreeResourceServer` en `packages/vitrinee-gateway/src/x402.ts`),
montado con `paymentMiddlewareFromHTTPServer`, que es API pública de
`@x402/express`. Todo lo demás que x402 lee del request queda igual, incluida
la query de la que sale el precio.

**Motivo.** Con el checkout por `GET` ([VT-23](#vt-23)) el nombre y la
dirección de despacho van en la query. x402 usaba la URL completa como
`resource.url`, y el cliente copia ese objeto tal cual al payload que le manda
al facilitator. En la prueba de T99 la dirección le llegó a OpenZeppelin, un
tercero que solo necesita mover USDC. Con este cambio, la misma compra en
testnet le mandó `…/checkout/stickers-cordillera` y liquidó igual (tx
`db37c9e7cbaf7f7b3dea8e2dc9372dfb5e9e68ceaa3ce31ffb17a4b1d4f82ede`).

**Qué no cubre.** AgentPey guarda la URL completa como
`delivery.resource_url` en el registro de la compra, que es del partner que
mandó esos datos. Y la URL completa sigue pasando por cualquier log de acceso
entre el agente y la tienda. Para el video del 29 se usan direcciones de
prueba igual.

**Alternativas descartadas.** `RouteConfig.resource`: es un texto fijo por
ruta, así que sería el mismo para todos los productos, y sin `PUBLIC_BASE_URL`
(en local) no habría valor y la query volvería a filtrarse. Reescribir
`req.originalUrl` antes del middleware: funcionaba, pero dependía de un
detalle interno del adaptador de Express. Pedir la dirección después de pagar:
lo más limpio, pero cambia `C-130` y el formulario de RealOps, y no entra antes
del 29.

---

## VT-26 · Un pedido pagado y sin cumplir se reintenta sin volver a cobrar, y su recibo no se toca · `Vigente`

**Fecha:** 2026-09-23 · **Hito:** T101 · Pedido por el usuario tras la primera compra real

**Qué pasó.** La primera compra real (café, 9,4631579 USDC) se pagó y el recibo
salió con las tres comprobaciones en verde, pero Jumpseller respondió
`404 Account not found` al crear el pedido (`platformError`). `VT-10` ya
preveía eso: la plata no se pierde y el pedido queda `paid_unfulfilled`. Lo que
no existía era cómo cumplirlo después: había que hacerlo a mano.

**Qué se decide.** `POST /orders/:orderId/fulfil`. Solo actúa sobre un pedido
`paid_unfulfilled`; lo que le manda a la plataforma sale del registro del
pedido, nunca de quien llama; no cobra ni toca el pago. Si la plataforma acepta,
el pedido pasa a `paid` con su `platformOrderId`; si vuelve a rechazar, queda
igual con el motivo nuevo y responde `200`. Un pedido que no existe responde
`404`; uno que no está esperando, o que ya se está cumpliendo, `400`. Dos
llamadas a la vez no pueden crear dos pedidos.

**El recibo no se vuelve a firmar.** Sigue diciendo `platformOrderId: null`. Es
lo que se firmó y se ancló en Soroban al pagar: prueba el pago y la venta, y
volver a firmarlo cambiaría el hash ya anclado. Lo que cambia es el registro del
pedido. Quien quiera saber si además hay pedido en la plataforma mira
`/orders/:id`, no el recibo.

**Sin autenticación, a propósito.** No recibe datos y solo puede hacer lo que el
comprador ya pagó. El peor caso de llamarla de más es que se cree el pedido que
ya estaba pagado. Si algún día acepta parámetros, deja de ser aceptable.

**Alternativa descartada: un comando local.** Los pedidos viven en un archivo
del disco efímero de Render, así que un script en otra máquina no los ve.
**Otra: volver a firmar el recibo con el pedido.** Rompe la relación entre el
hash anclado y lo que se le entregó al comprador.

### VT-27 · Cada comercio tiene su propia llave de firma, que Vitrinee genera y guarda cifrada con una llave maestra · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** planificación de T103 en adelante (`C-140`) · **Decidido por el usuario**; la recomendación, de Claude Code

> Numeración: se tomó el 27 porque `VT-26` vivía en la rama de T101 (PR #29),
> todavía sin mergear al decidir; se mergeó el 2026-09-24.

**Qué se decide.** Con Vitrinee atendiendo a muchos comercios (`C-140`):

1. **La plata no cambia.** Cada comercio cobra en su propia cuenta Stellar, que
   crea en su wallet (`VT-4`, `VT-19`). Vitrinee nunca tiene una llave que mueva
   sus fondos.
2. **Una llave de firma por comercio**, generada por Vitrinee al darlo de alta.
   Firma sus recibos y paga el anclaje con su propio XLM, igual que hoy
   (`VT-8`). Sigue siendo distinta de la cuenta de cobro.
3. **Las llaves de firma y las credenciales de la tienda se guardan cifradas**
   con una sola llave maestra que vive en Render con prefijo `VITRINEE_` y que
   carga el usuario (`P-10`, `C-136`). Ningún secreto de un comercio queda en
   claro en disco ni en la base.
4. **Las credenciales de la tienda no se vuelven a mostrar** después de
   guardarlas. El comercio las revoca desde su plataforma cuando quiera.

**Lo que esto prueba y lo que no, dicho en la documentación.** El recibo se
certifica solo: la verificación comprueba la firma contra la llave que el mismo
recibo nombra (`packages/vitrinee-anchor/src/verify.ts`), y lo que ata esa llave
al comercio es el manifest que sirve Vitrinee. La firma prueba "Vitrinee lo
emitió en nombre del comercio", no "el comercio lo firmó". La evidencia que no
depende del operador es la comprobación 3: el USDC llegó en la red a la cuenta
del comercio. Es el mismo punto que `C-140` dejaba abierto sobre `C-88`, y se
acepta así para un piloto en testnet.

**Alternativa descartada: una sola llave de Vitrinee para todos.** Un solo
secreto, como hoy, pero `merchantDid` sería el mismo en todos los recibos:
obligaba a cambiar la especificación del recibo a `0.2` y la verificación antes
del 29.

**Otra alternativa descartada: que el comercio pegue su propia llave secreta.**
Le pide manejar un secreto de Stellar y Vitrinee lo termina guardando igual.
Queda anotado para después que un comercio pueda traer su propia llave de firma.

---

### VT-28 · El alta de un comercio usa credenciales pegadas hasta el 29; la app de Jumpseller con OAuth viene después · `Vigente`
**Fecha:** 2026-09-23 · **Hito:** planificación de T103 en adelante (`C-140`) · **Decidido por el usuario**; la recomendación, de Claude Code

**Qué se decide.**

1. **Hasta el video del 29, el comercio pega su login y su token de API** de
   Jumpseller en el formulario de alta. Vitrinee los prueba en el momento
   leyendo el catálogo; si no leen, el alta se rechaza con un motivo claro. Si
   leen, se guardan cifrados (`VT-27`).
2. **El usuario hace el trámite de la app de Jumpseller**: registrarla en el
   portal de partners, pedir su publicación y aceptar la oferta de soporte de
   marcar una tienda como "tienda de desarrollo". Es trabajo suyo, no de código.
3. **Después del 29, el alta pasa a OAuth.** El conector de Jumpseller recibe
   "las credenciales de la tienda" sin asumir su forma, para que el cambio no
   toque el resto.

**Motivo.** Según la documentación de Jumpseller
(`https://jumpseller.com/support/apps/`, leída el 2026-09-23), una app usa
OAuth2 con permisos por recurso (`read_orders`, `write_orders`,
`read_products`…), y mientras no está publicada solo se instala en la tienda
asociada a ella. Instalarla en la tienda de otro dueño exige la revisión de
Jumpseller, sin plazo conocido. Las credenciales pegadas ya funcionan: así está
conectada la tienda de hoy.

**Lo que se cede.** El token de API de Jumpseller da acceso amplio a la tienda,
no solo a pedidos y productos. Una app con permisos acotados es lo correcto a
largo plazo.

**Hipótesis sin verificar, para soporte.** Si el `404 Account not found` al
crear pedidos (T101) tiene que ver con usar el token de API en vez de una app
OAuth, la misma respuesta resolvería T101 y esto.

**Alternativa descartada: esperar a la app para dar de alta la segunda tienda.**
Deja el video del 29 dependiendo de una revisión que no controlamos.

---

### VT-29 · El dueño de un comercio entra firmando con la wallet de su cuenta de cobro · `Vigente`
**Fecha:** 2026-09-24 · **Hito:** planificación de T103 en adelante (`C-140`) · **Decidido por el usuario**; la recomendación, de Claude Code

**Qué se decide.** En el alta, el dueño conecta Freighter y la cuenta conectada
pasa a ser la cuenta de cobro del comercio: prueba que es suya y evita un error
de tipeo que mandaría las ventas a otra cuenta. Para volver a entrar al panel,
firma un mensaje (SEP-0053, `verifyStellarMessage` de `@agentpass/core`, la
pieza neutral que `C-88` permite importar). Sin contraseñas ni emails.

1. **Al dar de alta, Vitrinee revisa que la cuenta pueda recibir USDC** de
   testnet. Si le falta la línea de confianza, el alta se detiene con un
   mensaje que explica cómo agregarla: sin ella, el primer pago fallaría.
2. **La sesión vale solo en el portal** (`vitrinee.agentpey.com`, `C-142`),
   nunca en los subdominios de las tiendas, que son públicos para los agentes.

**Motivo.** El panel guarda las credenciales de la tienda (`VT-27`) y muestra
sus ventas. RealOps entra por email, pero en el piloto corre en modo "en
pantalla" por falta de proveedor de correo: escribir un email deja adentro. Y el
comercio ya tiene una wallet, porque `VT-19` le pide crear su cuenta de cobro
en Freighter.

**Alternativa descartada: email con enlace mágico, como RealOps.** Sin proveedor
de correo no autentica nada.

**Otra alternativa descartada: un enlace secreto mostrado una vez.** Si se
pierde, el comercio queda afuera; si se filtra, cualquiera entra.

---

### VT-30 · Dos modos, una transición: Vitrinee es plataforma solo con sus dos variables, y la raíz sigue sirviendo a Bazar Cordillera hasta T104 · `Vigente`
**Fecha:** 2026-09-24 · **Hito:** T103 · La forma, de Claude Code, dentro de `C-140` a `C-143`

**Qué se decide.**

1. **Modo plataforma solo con `DATABASE_URL` y `MASTER_KEY`** (en Render,
   `VITRINEE_DATABASE_URL` y `VITRINEE_MASTER_KEY`). Sin ninguna de las dos,
   Vitrinee arranca como la tienda única de siempre. Con una sola, no arranca:
   es un error de configuración, y así se dice.
2. **El comercio de antes se siembra una vez** desde las mismas variables
   (`MERCHANT_*`, `JUMPSELLER_*`), con la misma cuenta de cobro y la misma llave
   de firma: todo recibo ya emitido sigue verificando. El sembrado no pisa un
   comercio existente.
3. **Cada comercio es una instancia de la tienda de siempre** (`createApp`),
   armada con su configuración. No se reescribió el checkout, ni x402, ni el
   recibo, ni el anclaje: cada tienda sigue con un `payTo` fijo, que es lo que
   el middleware x402 espera. Las URLs salen del `Host` del pedido.
4. **La raíz sigue sirviendo a Bazar Cordillera** (`ROOT_COMERCIO`) mientras
   AgentPey y RealOps apunten a `vitrinee.agentpey.com`. Se quita en T104,
   cuando lean el directorio (`C-141`). **Cumplido en T104** (`C-145`): sale de
   `render.yaml` y el usuario la borra del panel de Render.
5. **El pedido pendiente de T101 se reconstruye**, no se copia de un disco: su
   vista pública (respaldada en
   [`evidencia/T103-ord_muektgpgee1ebc73e5.json`](../evidencia/T103-ord_muektgpgee1ebc73e5.json))
   más la URL de checkout que AgentPey guardó para el mismo pago
   (`delivery.resource_url`, `VT-25`), que trae los datos de despacho. El recibo
   y el ancla se copian tal cual (`VT-26`).

**Motivo.** El punto 1 deja mergear T103 antes de que exista el rol: el deploy
no cambia nada hasta que el usuario carga las dos variables. El punto 3 evita
reescribir el camino que ya cobró en testnet. El punto 5 destraba PR #29: el
pedido pendiente ya no depende del disco efímero.

**Alternativa descartada: un checkout con `payTo` dinámico por pedido.** Un
solo `createApp` para todos, pero obligaba a meterse en cómo el middleware x402
arma sus requisitos, y cualquier error ahí cobra a la cuenta equivocada.

**Otra alternativa descartada: apagar la raíz ya.** Rompía el catálogo en vivo
de RealOps y la fila de `venues.json` hasta T104.

---

### VT-31 · Cómo entra el dueño y cómo se da de alta: una wallet puede tener varias tiendas, sesión firmada con una llave derivada, y cuatro pruebas con un rechazo cada una · `Vigente`
**Fecha:** 2026-09-24 · **Hito:** T105 · La forma, de Claude Code, dentro de `VT-27`, `VT-28`, `VT-29` y `C-142`

**Qué se decide.**

1. **El dueño de un comercio es su cuenta de cobro** (`VT-29`), y una misma
   wallet puede dar de alta más de una tienda. El panel muestra todas las
   tiendas que cobran en la cuenta con la que se entró, y ninguna otra. No hay
   otra tabla de dueños: no hay nada más que revisar ni nada que falsificar.
   Para el video, la tienda de prueba se puede dar de alta con la misma wallet
   de Bazar Cordillera, y el panel muestra las dos.
2. **La sesión es una cookie firmada, sin tabla.** HMAC sobre la cuenta y el
   vencimiento (12 horas), con una llave derivada de `VITRINEE_MASTER_KEY` con
   HKDF: el usuario no carga ningún secreto nuevo, y la llave maestra nunca
   firma otra cosa. Sin atributo `Domain`, `HttpOnly`, `SameSite=Strict`,
   `Secure` en https: el navegador no la manda a ningún subdominio de tienda.
   Además, toda llamada que cambia algo se rechaza si su `Origin` no es el del
   portal, porque un navegador cuenta a un subdominio hermano como el mismo
   sitio.
3. **El desafío de la firma vive en memoria** del proceso de Vitrinee, dura
   5 minutos, nombra la cuenta y el host, y se consume antes de mirar la firma:
   ni una firma válida ni una inválida lo pueden reusar. Un reinicio solo le
   cuesta al dueño un segundo clic.
4. **Las cuatro pruebas corren de la más barata a la más cara**: slug (sin
   red), cuenta de cobro (Horizon), credenciales (Jumpseller), llave fondeada
   (friendbot). Cada una rechaza con su propio código (`SlugUnavailable`,
   `PayoutAccountNotReady`, `StoreCredentialsRejected`, `SigningKeyNotFunded`),
   y el portal traduce cada código a un mensaje que dice qué arreglar. Se fondea
   una llave solo si las otras tres pasaron. Un Jumpseller caído no se confunde
   con credenciales malas: responde `AdapterError` y se puede reintentar.
5. **Algunos slugs quedan reservados** (`www`, `api`, `portal`, `admin`,
   `realops`, `agentpey` y otros), porque en `<slug>.vitrinee.agentpey.com`
   se leerían como parte de la plataforma.

**Lo que no cambia.** Las credenciales llegan como "credenciales de tienda"
(`storeCredentialsSchema`, con `kind`): la app OAuth de después del 29 es un
miembro más de esa unión y una rama más en `storeCatalogueReader` (`VT-28`).

**Lo que se cede, dicho en voz alta.** Cualquiera con una wallet con línea de
confianza de USDC y una tienda Jumpseller que responda puede aparecer en el
directorio. Para cobrar, igual necesita que una persona le firme un permiso que
la nombre (`C-141`). No hay límite de tiendas por wallet; si hace falta, se
agrega después.

**Alternativa descartada: una tienda por wallet.** Obligaba a crear otra cuenta
en Freighter, con su línea de confianza, solo para la tienda de prueba del
video, y no protege nada: el dueño es la cuenta de cobro de todos modos.

**Otra alternativa descartada: sesiones en una tabla de Postgres.** Permite
cerrar una sesión desde el servidor, pero es una tabla y una limpieza más para
una sesión de 12 horas en un piloto.

**Otra alternativa descartada: un secreto propio para las sesiones**
(`VITRINEE_SESSION_KEY`). Otro valor que el usuario tendría que generar y cargar
en Render, sin ventaja sobre derivarlo de la llave maestra.

### VT-32 · Un SKU repetido no se publica: ninguno de los productos que lo comparten · `Vigente`
**Fecha:** 2026-09-25 · **Hito:** T110 · Deuda anotada en T105

`isSellable` pedía que un producto estuviera a la venta y tuviera SKU, pero no que
el SKU fuera suyo. Los cinco productos de demostración que Jumpseller crea en una
tienda nueva están a la venta y comparten `demo-product`, y así llegaron al
directorio en T105 (el usuario los borró a mano). Ahora `listProducts` deja fuera
**todos** los productos a la venta cuyo SKU se repite (entre los que están a la
venta), y avisa por `onWarning` con los SKU. Un duplicado deshabilitado no cuenta.

**Alternativa descartada: publicar el primero de cada SKU.** Cuál es "el primero"
depende del orden de la API, y un agente no tendría cómo saber a cuál se refiere
el SKU. **Otra descartada: filtrar solo `demo-product`.** Resuelve el caso de hoy y
no el siguiente.

Alcance: el listado, que es lo que se publica. `getProduct` de un producto
individual no se cambió; sin estar en el listado, ningún permiso lo nombra.
