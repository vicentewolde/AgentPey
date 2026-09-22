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
de `FX_RATE_CLP_USD`.

**Motivo.** Un oráculo (Reflector u otro) agrega una dependencia externa, un
punto de fallo en el video y una discusión de "qué tasa es la correcta" que no
aporta al hackathon. Lo que importa demostrar es que la conversión es exacta
(enteros, sin floats, [V-7](#v-7)) y que el agente ve la tasa antes de pagar,
para que su política de gasto pueda evaluarla.

**Alternativa descartada:** oráculo on-chain, o pedir a la tienda que fije
precios en USDC. Ambas van al roadmap.

---

### V-3 · `receipt-registry` sin admin ni upgrade · `Pendiente` (día 2)
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

### V-5 · Anclaje asíncrono con reintentos · `Pendiente` (día 2)
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

### V-8 · Dos llaves del merchant: `payTo` y firma · `Pendiente` (confirmar con Vinny, día 1)
**Fecha:** 2026-09-22

`MERCHANT_STELLAR_ACCOUNT` recibe los pagos y no tiene secreto en el gateway.
`MERCHANT_SIGNING_SECRET` es una llave distinta: firma los recibos JWS y paga
la transacción de anchor. El `did:stellar` del recibo se deriva de la llave de
firma; el manifest publica ambas cuentas.

**Motivo.** El brief pedía a la vez "Vitrinee nunca tiene llaves del merchant"
y "`MERCHANT_SECRET` firma y ancla". Con una sola llave, esas dos frases se
contradicen. Separarlas mantiene [V-4](#v-4) literal: la llave que el gateway
guarda no puede mover fondos del merchant, solo emitir recibos y pagar fees de
anchor con su propio XLM.

**Alternativa:** una sola llave. Menos variables, pero el gateway podría
vaciar la cuenta del merchant. Se registra como decisión abierta hasta que
Vinny confirme.

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
