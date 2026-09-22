# Decisiones

> Una entrada por decisión no trivial, con su motivo y la alternativa que se
> descartó. **No se borran entradas**: si una decisión se revierte, se marca
> como `Superada` y se agrega la nueva. Prefijo `V-`.
>
> Contexto: [CONTEXTO.md](CONTEXTO.md) · Estado: [BITACORA.md](BITACORA.md)

Estados: `Vigente` · `Superada` · `Pendiente` (tomada, aún no implementada)

---

### V-1 · Gateway HTTP externo, no plugin nativo de la plataforma · `Vigente`
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

### V-2 · Tasa de cambio fija de demo, sin oráculo · `Vigente`
**Fecha:** 2026-09-22

El catálogo está en CLP; el agente paga en USDC. La conversión usa una tasa
fija declarada en el manifest (`fx.rate`, `fx.source: "demo-fixed"`), leída
de `FX_RATE_CLP_USD`. Valor de demo confirmado por Vinny: **950 CLP/USD**.

**Motivo.** Un oráculo (Reflector u otro) agrega una dependencia externa, un
punto de fallo en el video y una discusión de "qué tasa es la correcta" que no
aporta al hackathon. Lo que importa demostrar es que la conversión es exacta
(enteros, sin floats, [V-7](#v-7)) y que el agente ve la tasa antes de pagar,
para que su política de gasto pueda evaluarla.

**Alternativa descartada:** oráculo on-chain, o pedir a la tienda que fije
precios en USDC. Ambas van al roadmap.

---

### V-3 · `receipt-registry` sin admin ni upgrade · `Vigente`
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

### V-4 · Sin custodia: `payTo` es la cuenta del merchant · `Vigente`
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

### V-5 · Anclaje asíncrono con reintentos · `Vigente`
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

### V-6 · Settlement con el SDK oficial `@x402/*` 2.26.0 y precio dinámico por request · `Vigente`
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

### V-7 · Dinero como enteros de punta a punta, un solo redondeo · `Vigente`
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

### V-8 · Dos llaves del merchant: `payTo` y firma · `Vigente`
**Fecha:** 2026-09-22 · **Confirmada por Vinny:** 2026-09-22

`MERCHANT_STELLAR_ACCOUNT` recibe los pagos y no tiene secreto en el gateway.
`MERCHANT_SIGNING_SECRET` es una llave distinta: firma los recibos JWS y paga
la transacción de anchor. El `did:stellar` del recibo se deriva de la llave de
firma; el manifest publica ambas cuentas.

**Motivo.** El brief pedía a la vez "Vitrinee nunca tiene llaves del merchant"
y "`MERCHANT_SECRET` firma y ancla". Con una sola llave, esas dos frases se
contradicen. Separarlas mantiene [V-4](#v-4) literal: la llave que el gateway
guarda no puede mover fondos del merchant, solo emitir recibos y pagar fees de
anchor con su propio XLM.

**Alternativa descartada:** una sola llave. Menos variables, pero el gateway
podría vaciar la cuenta del merchant. Vinny confirmó las dos llaves el mismo
día 0.

---

### V-9 · `soroban-sdk` 28.0.0, compilado solo con `stellar contract build` · `Vigente`
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

### V-10 · Flujo `upfront`: el facilitator liquida antes de que corra el handler · `Vigente`
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
buffering de respuesta del SDK ([V-6](#v-6)).

---

### V-11 · Jumpseller: orden creada pagada, tx hash en `additional_information` y en el historial · `Pendiente` (día 3)
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

### V-12 · El secreto de la cuenta `payTo` existe solo para `bootstrap` · `Vigente`
**Fecha:** 2026-09-22

`pnpm bootstrap` genera la cuenta `payTo` del merchant, abre su trustline USDC
(imposible sin firmar con ella) y guarda el secreto en
`MERCHANT_PAYOUT_SECRET` dentro de `.env.local`. **El gateway no lee esa
variable**; `loadConfig` tiene un test que lo asegura.

**Motivo.** [V-4](#v-4) y [V-8](#v-8) prometen que el gateway no puede mover
fondos del merchant. En la demo el merchant es Vinny, y Vinny necesita poder
mirar y mover su USDC de testnet después del video; una llave que nadie
guarda es una cuenta que nadie puede usar.

**Camino a producción:** el merchant trae su propia cuenta ya fondeada y con
trustline; `bootstrap` no la genera ni la conoce. Registrado en el roadmap.

---

### V-13 · Tres checks de verificación, cada uno independiente del gateway · `Vigente`
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

### V-14 · Un sexto producto barato en el mock, para las pruebas reales · `Vigente`
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

### V-15 · Idempotencia en tres capas y reserva de stock durante el settle · `Vigente`
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
