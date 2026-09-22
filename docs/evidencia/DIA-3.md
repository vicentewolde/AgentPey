# Día 3 · "La tienda real" (mar 22 de septiembre de 2026)

Salida cruda. Sin secretos: solo ids públicos de la tienda y de productos.

## Catálogo cargado en `vitrinee.jumpseller.com`

Seis productos, cinco creados por API y el hoodie a mano desde el panel para
validar el formato. Los cinco productos demo de Jumpseller quedaron en
`disabled`. Detalle e ids en
[`jumpseller-import/CATALOGO.md`](jumpseller-import/CATALOGO.md).

## `adapters/jumpseller` contra la tienda real (solo lectura)

```
listProducts -> 6 productos

  HOOD-CORD-M    34990 CLP  stock= 12  imgs=1
    Hoodie Cordillera talla M
    Polerón con capucha de algodón orgánico, bordado de la cordillera al frente. Talla M.
  POL-VALPO-L    14990 CLP  stock= 20  imgs=1
    Polera Valpo talla L
    Polera de algodón peinado con serigrafía de los cerros de Valparaíso. Talla L.
  GOR-ANDES      12990 CLP  stock=  8  imgs=1
    Gorro Andes de lana
    Gorro tejido a mano en lana de oveja, talla única.
  CAF-NUN-250     8990 CLP  stock= 30  imgs=1
    Café de grano Ñuñoa 250 g
    Tueste medio, origen Colombia, notas a chocolate y frutos rojos.
  BOT-PAT-500    19990 CLP  stock=  2  imgs=1
    Botella térmica Patagonia 500 ml
    Acero inoxidable de doble pared, mantiene frío 24 h y calor 12 h.
  STK-CORD-5       990 CLP  stock=200  imgs=1
    Pack de stickers Cordillera
    Cinco stickers de vinilo mate con paisajes de la cordillera, resistentes al agua.

getProduct(37282902) -> HOOD-CORD-M
getProduct("999") -> null
```

Los cinco demo no aparecen: el adapter filtra por `status === "available"` y
exige SKU propio. Las descripciones llegan sin el HTML con que Jumpseller las
devuelve (`…Talla M.<br>`). Los precios son enteros en string, nunca floats.

## `pnpm check`

```
Test Files  2 passed (2)     packages/adapters   (23 tests)
Test Files  6 passed (6)     packages/core
Test Files  5 passed (5)     packages/gateway    (19 tests)
Test Files  2 passed (2)     apps/agent          (8 tests)
Test Files  3 passed (3)     scripts             (10 tests)
```

Typecheck y lint sin errores ni warnings.

## Bloqueo abierto: el plan trial no deja crear pedidos

```
POST /orders.json -> 403
{"message":"No puedes crear pedidos durante el período de prueba.
  Ponte en contacto con nuestro servicio de asistencia si quieres
  probar la creación de pedidos."}
```

`GET /store/info.json` confirma `subscription_plan: "pro"`,
`subscription_status: "trial"`, `0` pedidos.

Todo lo demás de la API funciona con el trial: leer y crear productos, leer la
tienda, leer métodos de envío. Lo único bloqueado es crear pedidos, que es
justo el hito del día. El adapter traduce ese 403 a un `AdapterError` con
`details.trialBlocked` y un mensaje que dice qué hacer, en vez de filtrar un
error crudo al agente. Decisión pendiente de Vinny; ver
[DECISIONES.md § V-16](../DECISIONES.md) para lo que sí se resolvió del envío.

## Manifest y discovery servidos desde Jumpseller

Gateway con `ADAPTER=jumpseller`, catálogo real:

```
{"message":"vitrinee gateway listening","adapter":"jumpseller",
 "manifest":"/.well-known/agent-storefront.json"}
```

`GET /.well-known/agent-storefront.json` → los 6 productos con precio en CLP
y en USDC a la tasa de demo (950 CLP/USD):

```
  "id": "37282902", "sku": "HOOD-CORD-M",
  "priceLocal": "34990", "priceUSDC": "36.8315789",
  "priceUSDCAtomic": "368315789", "stock": 12,
  "images": ["https://images.jumpseller.com/store/vitrinee/37282902/HOOD-CORD-M.jpg?1790098207"],
  "checkoutRoute": "/checkout/37282902"
```

`GET /discovery/resources?limit=2` → forma `DiscoveryResourcesResponse` de
`@x402/extensions`, con los `PaymentRequirements` reales por producto:

```
{"x402Version": 2,
 "items": [{"resource": ".../checkout/37282902", "type": "http",
   "accepts": [{"scheme": "exact", "network": "stellar:testnet",
     "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
     "amount": "368315789", "payTo": "GC5ZY7UJ...VCII",
     "maxTimeoutSeconds": 300,
     "extra": {"paymentFlow": "upfront", "unitPrice": true, "quantityParam": "quantity"}}],
   "serviceName": "Bazar Cordillera", "tags": ["ecommerce","retail","cl"]}],
 "pagination": {"limit": 2, "offset": 0, "total": 6}}
```

Por qué ese endpoint existe y por qué no es el bazaar oficial:
[DECISIONES.md § V-17](../DECISIONES.md).
