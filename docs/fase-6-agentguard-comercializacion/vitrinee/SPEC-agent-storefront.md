# Agent Storefront · especificación v0.1

> Formato del documento que una tienda publica para que un agente de IA pueda
> comprarle: qué vende, cómo se le paga y cómo se verifica el comprobante.
>
> Estado: **borrador**, versión `0.1`, 22 de septiembre de 2026.
> Implementación de referencia: este repositorio.
> Contexto: [CONTEXTO.md](CONTEXTO.md) · Decisiones: [DECISIONES.md](DECISIONES.md)

Las palabras **debe**, **no debe** y **puede** se usan en el sentido de
RFC 2119.

---

## 1. Por qué existe

Un agente que quiere comprar en una tienda se encuentra hoy con HTML pensado
para ojos humanos, un carro con estado de sesión y un checkout que pide una
tarjeta. Las tres cosas le sobran. Lo que necesita es más corto: qué hay, qué
cuesta en una moneda que puede mover, dónde paga y cómo prueba después que
pagó.

Este formato describe eso y nada más. **No** es un protocolo de pago: el pago
es [x402](https://x402.org) y la especificación no lo redefine. **No** es un
formato de catálogo genérico: no compite con Schema.org ni con Google Merchant
Center, que describen productos para buscadores, no para compradores
autónomos. Lo que agrega es la unión de las dos mitades —un catálogo que ya
trae el precio en el activo que se va a liquidar, y la ruta exacta donde ese
pago se cobra— más la promesa verificable de que la compra ocurrió.

## 2. Descubrimiento

La tienda **debe** servir el manifest en:

```
GET /.well-known/agent-storefront.json
```

sobre HTTPS, con `Content-Type: application/json`. Un agente que conoce el
dominio no necesita nada más para empezar.

La respuesta **puede** llevar `Cache-Control: public, max-age=<n>`. La
implementación de referencia usa 60 s.

## 3. El manifest

Documento JSON. Todos los campos listados son obligatorios salvo donde se
indique. Un consumidor **no debe** fallar por campos desconocidos en versiones
futuras, pero en `0.1` el esquema de referencia es estricto: rechaza
propiedades que no estén aquí, para que un error de tipeo no pase silencioso.

### 3.1 Raíz

| Campo | Tipo | Significado |
|---|---|---|
| `version` | `"0.1"` | Versión de este formato. |
| `generatedAt` | ISO 8601 | Cuándo se generó. Un agente **puede** usarlo para decidir si recarga. |
| `merchant` | objeto | § 3.2 |
| `network` | `"stellar:testnet"` | Red donde se liquida, en CAIP-2. |
| `settlement` | objeto | § 3.3 |
| `fx` | objeto | § 3.4 |
| `policies` | objeto | § 3.5 |
| `receipts` | objeto | § 3.6 |
| `products` | array | § 3.7 |
| `endpoints` | objeto | § 3.8 |

### 3.2 `merchant`

| Campo | Tipo | Significado |
|---|---|---|
| `name` | string | Nombre comercial, para mostrarle a una persona. |
| `did` | `did:stellar:<red>:G…` | Identidad del merchant. **La llave que firma los recibos**, no la que cobra. |
| `stellarAccount` | `G…` | Cuenta que recibe el pago (`payTo` del challenge x402). |
| `country` | ISO 3166-1 alpha-2 | Dónde opera la tienda. |
| `currency` | ISO 4217 | Moneda en que lista sus precios. |

`did` y `stellarAccount` **deben** ser cuentas distintas. La razón es el
corazón del modelo de confianza: la llave que el gateway guarda para firmar
recibos **no puede mover los fondos del merchant**
([VT-8](DECISIONES.md), [VT-4](DECISIONES.md)). Un agente que verifica un recibo
usa `did`; un agente que decide si confía en dónde aterriza su dinero mira
`stellarAccount`. Confundirlas rompe las dos garantías a la vez.

### 3.3 `settlement`

| Campo | Tipo | Significado |
|---|---|---|
| `scheme` | `"exact"` | Esquema x402. |
| `asset` | `"USDC"` | Código del activo. |
| `assetContract` | `C…` | Contrato SEP-41 del activo. Es lo que el agente verifica, no el código. |
| `decimals` | `7` | Decimales del activo. |
| `facilitator` | URL | Facilitator x402 que la tienda usa para verificar y liquidar. |

El agente **no debe** confiar en `asset` como identificador: dos activos
pueden llamarse "USDC". El identificador es `assetContract`.

### 3.4 `fx`

| Campo | Tipo | Significado |
|---|---|---|
| `base` | `"USD"` | |
| `quote` | ISO 4217 | Moneda de la tienda. |
| `rate` | decimal string | Cuántas unidades de `quote` por una de `base`. |
| `source` | `"demo-fixed"` | Origen de la tasa. |
| `asOf` | ISO 8601 | Momento de la tasa. |

`source: "demo-fixed"` dice la verdad: en esta versión la tasa es un valor de
configuración, no un oráculo ([VT-2](DECISIONES.md)). Se publica para que la
política de gasto del agente pueda evaluarla **antes** de pagar, en vez de
descubrir la conversión al llegar la factura. Versiones futuras **pueden**
agregar otros valores de `source`; un agente que no reconozca el valor
**debería** tratar la tasa como no auditada.

### 3.5 `policies`

| Campo | Tipo | Significado |
|---|---|---|
| `refundWindowSeconds` | entero ≥ 0 | Ventana de retracto que el merchant declara. |
| `shippingCountries` | array ISO 3166-1 | Países a los que despacha. |

`refundWindowSeconds` es una **declaración del merchant**, no una garantía
ejecutable en cadena: no hay escrow ([VT-4](DECISIONES.md)). El recibo repite
la fecha de término calculada, para que quede firmada.

### 3.6 `receipts`

| Campo | Tipo | Significado |
|---|---|---|
| `format` | `"jws"` | El recibo es un JWS compacto. |
| `alg` | `"EdDSA"` | Firmado con la llave Ed25519 de `merchant.did`. |
| `anchoredValue` | `"sha256(compact-jws)"` | Qué valor exacto se ancló en cadena. |
| `registry` | `C…` | Contrato Soroban donde vive el ancla. |

`anchoredValue` existe porque "el hash del recibo" es ambiguo: ¿del JSON de
claims, del JWS, con o sin espacios? Se ancla el SHA-256 **del JWS compacto
tal cual viaja**, en hex minúscula. Cualquier otra interpretación da un hash
distinto y una verificación que falla sin explicar por qué.

### 3.7 `products`

| Campo | Tipo | Significado |
|---|---|---|
| `id` | string | Identificador estable en la plataforma. Es lo que va en la ruta de checkout. |
| `sku` | string | SKU del comercio. Único dentro de la tienda. |
| `name` | string | |
| `description` | string | **Texto plano.** Sin HTML. |
| `priceLocal` | decimal string | Precio en `currency`. |
| `currency` | ISO 4217 | |
| `priceUSDC` | decimal string | El mismo precio en USDC, unidades humanas. |
| `priceUSDCAtomic` | entero string | El mismo precio en unidades atómicas (7 decimales). **Esto es lo que se liquida.** |
| `stock` | entero ≥ 0 o `null` | `null` = la plataforma no lleva stock de este producto. |
| `images` | array de URL | |
| `checkoutRoute` | string que empieza con `/` | Ruta relativa a la que se hace POST. |

Todos los montos son **strings**, nunca números JSON. Un `number` de JSON es
un float de doble precisión y los montos que no sobreviven a un float son
exactamente los que importan ([VT-7](DECISIONES.md)). `priceUSDCAtomic` es la
cifra autoritativa: `priceLocal` y `priceUSDC` son para mostrar y para
auditar la conversión.

`stock: 0` es información legítima y **debe** publicarse: le dice al agente
que el producto existe y está agotado, que no es lo mismo que no existir.

### 3.8 `endpoints`

| Campo | Significado |
|---|---|
| `catalog` | URL absoluta. Los mismos productos, sin el resto del manifest. |
| `product` | Plantilla, `{id}`. |
| `checkout` | Plantilla, `{productId}`. Responde 402 hasta que se pague. |
| `orders` | Plantilla, `{orderId}`. Estado de una orden, incluido el anclaje. |
| `verifyReceipt` | Plantilla, `{hash}`. Verificación de un recibo. |
| `discovery` | URL absoluta. § 6. |

Las plantillas usan `{nombre}` entre llaves. Un consumidor **debe** sustituir
y codificar el valor, no concatenar a ciegas.

## 4. Comprar

El pago es x402 `exact` sobre Stellar; esta especificación solo fija lo que la
tienda agrega encima.

```
POST {checkout}          → 402 Payment Required  (+ challenge x402)
POST {checkout} + firma  → 200 OK                (+ orden y recibo)

GET  {checkout}?…        → 402 Payment Required  (+ challenge x402)
GET  {checkout}?… + firma→ 200 OK                (+ orden y recibo)
```

Dos puertas para la misma compra ([VT-23](DECISIONES.md)). `POST` lee un
cuerpo JSON; `GET` lee la query, que es lo que hacen casi todos los clientes
x402: piden el 402 sin cuerpo y reintentan **la misma URL** con la firma. Las
dos pasan por el mismo esquema, así que aceptan exactamente lo mismo. Cada
puerta lee solo su fuente: un `POST` ignora la query. `HEAD` responde `405`.
Las respuestas del checkout llevan `Cache-Control: no-store`.

Cuerpo de la petición `POST`, JSON:

| Campo | Tipo | Por defecto |
|---|---|---|
| `quantity` | entero 1–100 | `1` |
| `buyer.stellarAccount` | `G…` o `C…` | la cuenta que firmó el pago |
| `buyer.email` | email | — |
| `buyer.shipping` | objeto con `name`, `address`, `city`, `region`, `country`, `notes` | `country: "CL"` |

Query de la petición `GET`, plana: `quantity`, `email`, `name`, `address`,
`city`, `region`, `country` y `notes`, con los mismos tipos y valores por
defecto que arriba. Un valor vacío cuenta como ausente; un parámetro repetido
es `400`, en vez de elegir uno de sus valores.

**El pagador puede ser una cuenta contrato** (`C…`), como el `policy_rail` de
AgentPey: el `transfer` SEP-41 acepta cualquiera de las dos como `from`, y el
facilitator liquida las dos ([VT-22](DECISIONES.md)). La tienda, en cambio,
cobra y firma siempre con cuentas clásicas (`G…`).

El precio del manifest es **por unidad**. La tienda recotiza con `quantity` al
emitir el challenge, y el agente paga lo que dice el challenge, no lo que
calculó del manifest.

### 4.1 Idempotencia

El agente **puede** enviar `Idempotency-Key` (ASCII imprimible, 1–255 bytes).
Si esa clave ya produjo una orden, la tienda responde esa misma orden con
`Idempotent-Replayed: true` **antes** de cobrar de nuevo. Reusarla para otra
compra distinta es `409` ([VT-15](DECISIONES.md)).

Con o sin esa cabecera, la tienda **no debe** crear dos órdenes para una misma
transacción de settlement.

### 4.2 Respuesta

```jsonc
{
  "orderId": "ord_m1x9…",        // id propio de la tienda, opaco para el agente
  "status": "paid",
  "createdAt": "2026-09-22T19:17:56.178Z",
  "product": { "id": "…", "sku": "…", "name": "…" },
  "quantity": 1,
  "amountUSDC": "36.8315789",
  "amountUSDCAtomic": "368315789",
  "totalLocal": "34990",
  "currency": "CLP",
  "platform": "jumpseller",
  "platformOrderId": "5001",     // null si la plataforma rechazó la orden
  "platformError": null,
  "settlement": { "txHash": "…", "network": "stellar:testnet", "payer": "G… o C…" },
  "receipt": { "jws": "eyJ…", "hash": "…", "verifyPath": "/receipts/…/verify" },
  "anchor": { "status": "pending" }   // pending | anchored | failed
}
```

Dos campos merecen atención porque describen fallas, no éxitos:

`platformOrderId: null` con `platformError` poblado significa que **el pago se
liquidó y la tienda no pudo crear la orden**. El recibo se emite igual: prueba
que el dinero se movió, y el merchant cumple a mano
([VT-10](DECISIONES.md)). Un agente **no debe** interpretar ese caso como
"no pagué".

`anchor.status: "pending"` es lo normal en la respuesta. El anclaje ocurre
después, con reintentos ([VT-5](DECISIONES.md)); el recibo ya es válido y
verificable por firma desde que se emite. `GET {orders}` refleja el cambio.

## 5. Verificar

```
GET  {verifyReceipt}              → verifica por hash el recibo que la tienda guarda
POST /receipts/verify {"jws":"…"} → verifica un JWS que trae el que pregunta
```

La segunda forma existe para que un tercero verifique un recibo que recibió
por fuera, sin que la tienda tenga que reconocerlo primero.

La verificación son **tres comprobaciones independientes**, y la respuesta
dice el resultado de cada una por separado ([VT-13](DECISIONES.md)):

1. **Firma.** El JWS valida contra la llave derivada de `merchant.did`.
2. **Ancla.** `sha256(jws)` está en el contrato `receipts.registry`, con
   estado anclado.
3. **Settlement.** `settlementTxHash` existe en la red y corresponde: debitó
   al pagador y acreditó al merchant exactamente el monto del recibo. Un
   pagador `C…` aparece en Horizon como `contract_debited`, con el contrato en
   `contract`; el campo `account` de ese efecto es quien envió la transacción
   (el facilitator), y no cuenta como pagador ([VT-22](DECISIONES.md)).

Las tres se pueden correr **sin la tienda**: el DID da la llave, el contrato
es público y la transacción está en Stellar. Una tienda que desaparece no
invalida un recibo emitido, y ese es el punto. Un verificador **debería**
correr las tres por su cuenta y no confiar en el veredicto agregado de quien
emitió el recibo.

### 5.1 Claims del recibo

```jsonc
{
  "typ": "vitrinee-receipt/0.1",
  "orderId": "…", "platformOrderId": "…" | null, "platform": "jumpseller",
  "merchantDid": "did:stellar:testnet:G…", "merchantAccount": "G…",
  "payerAccount": "G…" | "C…",
  "network": "stellar:testnet", "asset": "C…",
  "amountUSDC": "36.8315789", "amountUSDCAtomic": "368315789",
  "settlementTxHash": "…",
  "items": [{ "productId": "…", "sku": "…", "name": "…", "quantity": 1,
              "unitPriceUSDC": "…", "unitPriceUSDCAtomic": "…" }],
  "issuedAt": "…", "refundWindowEndsAt": "…"
}
```

## 6. Discovery

`endpoints.discovery` responde la lista de recursos pagables de la tienda, en
la forma `DiscoveryResourcesResponse` de `@x402/extensions`: `x402Version`,
`items[]` con los `PaymentRequirements` de cada uno, y `pagination`.

**Esto no es el bazaar de x402.** En x402 el catálogo de recursos vive en el
*facilitator*: el servidor se declara en sus respuestas 402 y el cliente le
pregunta al facilitator. No hay en esa especificación un endpoint para que una
tienda liste lo suyo. Este lo es, deliberadamente, y se documenta como espejo
local para no aparentar un estándar que no existe ([VT-17](DECISIONES.md)).

Dos reglas propias: solo se listan productos que el checkout **aceptaría
vender ahora** (un agotado sigue en el manifest, donde el cero informa, pero
no acá, donde sería una oferta condenada), y el precio publicado es unitario,
marcado con `extra.unitPrice`.

### 6.1 El feed de `ServiceCard`

`GET /api/discovery/search?query=…` responde los mismos productos en el formato
`ServiceCard` (`bazaar.service-card/v0`), el que lee el catálogo de AgentPey
para cualquier comercio x402 ([VT-24](DECISIONES.md), `C-130`):

```jsonc
{
  "ok": true,
  "results": [{ "resource": {
    "id": "37282902",
    "name": "Hoodie Cordillera talla M",          // hasta 200 caracteres, sin controles
    "description": "…",                            // hasta 2000
    "payment": { "asset": "USDC", "amount": "36.8315789", "destination": "G…" },
    "routeTemplate": "/checkout/37282902?quantity={quantity}&name={name}&address={address}&city={city}&region={region}",
    "input": [
      { "name": "quantity", "type": "number", "required": true },
      { "name": "name",     "type": "string", "required": true },
      { "name": "address",  "type": "string", "required": true },
      { "name": "city",     "type": "string", "required": true },
      { "name": "region",   "type": "string", "required": true }
    ]
  } }]
}
```

`payment.amount` es el precio **unitario** en USDC decimal. `routeTemplate`
lleva un marcador por cada `input` y nada más, y apunta a la puerta `GET` del
checkout. `quantity` tiene que coincidir con la cantidad que el comprador firma:
si no, el 402 cotiza otro total. `query=*` o vacío lista todo; otro valor filtra
por nombre y descripción, sin distinguir mayúsculas. Mismas reglas que § 6:
solo lo que se puede vender ahora.

## 7. Seguridad y límites

- **Todo por HTTPS.** Un manifest servido por HTTP es un manifest que alguien
  puede reescribir en el camino, y lo primero que reescribiría es `payTo`.
- **`payTo` se verifica contra el manifest**, no solo contra el challenge. El
  agente **debería** comparar el `payTo` del 402 con `merchant.stellarAccount`
  antes de firmar.
- **La tienda no custodia.** El pago va directo del comprador al merchant. Una
  implementación que interponga una cuenta propia **no** cumple esta
  especificación.
- **El agente fija su tope.** `priceUSDCAtomic` es una afirmación de la
  tienda; la política de gasto es del comprador.
- **La puerta `GET` pone los datos de despacho en la URL.** El middleware x402
  usa la URL completa como `resource.url` del 402, y el cliente la copia al
  payload que manda al facilitator: nombre y dirección le llegan a él, y a
  cualquier log de acceso en el camino. Con `POST` no pasa, porque la dirección
  va en el cuerpo. Pendiente de decidir (T99).

Fuera de alcance en `0.1`: carros de varios productos, descuentos y cupones,
suscripciones, devoluciones automatizadas, autenticación del comprador más
allá de la cuenta que paga, y monedas que no sean USDC.

## 8. Versionado

`version` es la versión de este documento. Un cambio incompatible sube el
número. Un agente **debería** rechazar un `version` mayor al que entiende, en
vez de adivinar.

## 9. Estado de esta versión

`0.1` es un borrador escrito junto a su primera implementación, contra una
tienda Jumpseller real, en 8 días. Revisado en T99 (2026-09-23) con cambios
compatibles hacia adelante: la puerta `GET`, el pagador `C…` y el feed de
`ServiceCard`. Un recibo emitido antes sigue siendo válido; un verificador
escrito para la versión anterior rechazaría un recibo con pagador `C…`. Lo que está acá funciona; lo que no está
probablemente falta. Las partes con más probabilidad de cambiar: `fx` cuando
haya oráculos, `policies` cuando las devoluciones dejen de ser una promesa, y
§ 6 si x402 publica un endpoint de discovery del lado del servidor.
