# Día 0 · mar 22 de septiembre de 2026 · "Esqueleto"

Salida cruda de los comandos clave. Sin secretos: la única cuenta que aparece
es el issuer público de USDC en testnet, usada como `payTo` de prueba.

## Entorno

```
node v26.5.0 · pnpm 11.24.0 · typescript 5.9.3 · vitest 3.2.7
stellar 28.0.0 (300aaf69ab100536678bdb641428b06f06b318ea) · stellar-xdr 28.0.0
cargo 1.98.0 · rustc 1.98.0 · targets: aarch64-apple-darwin, wasm32v1-none
```

## `pnpm typecheck && pnpm lint && pnpm test`

```
$ tsc -b
$ eslint .
$ pnpm -r --stream test
Scope: 3 of 4 workspace projects
packages/core test:  ✓ src/money.test.ts (14 tests) 11ms
packages/core test:  ✓ src/did.test.ts (3 tests) 4ms
packages/core test:  ✓ src/manifest.test.ts (3 tests) 12ms
packages/core test:  ✓ src/receipt.test.ts (3 tests) 8ms
packages/core test:  Test Files  4 passed (4)
packages/core test:       Tests  23 passed (23)
packages/adapters test:  ✓ src/mock/mock.test.ts (6 tests) 8ms
packages/adapters test:  Test Files  1 passed (1)
packages/adapters test:       Tests  6 passed (6)
packages/gateway test:  ✓ src/app.test.ts (6 tests) 40ms
packages/gateway test:  Test Files  1 passed (1)
packages/gateway test:       Tests  6 passed (6)
```

**35 tests, 0 fallos.** Typecheck y lint sin salida (sin errores).

## Gateway servido desde el adapter mock

```
$ MERCHANT_STELLAR_ACCOUNT=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 node packages/gateway/dist/index.js
{"at":"2026-09-22T13:23:12.382Z","message":"vitrinee gateway listening","port":4021,"adapter":"mock","merchant":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5","manifest":"/.well-known/agent-storefront.json"}
```

### `GET /health`

```
HTTP/1.1 200 OK
{"status":"ok","adapter":"mock","network":"stellar:testnet"}
```

### `GET /.well-known/agent-storefront.json`

```
HTTP/1.1 200 OK
Cache-Control: public, max-age=60
Content-Type: application/json; charset=utf-8
Content-Length: 2971
```

```json
{
  "version": "0.1",
  "generatedAt": "2026-09-22T13:23:14.017Z",
  "merchant": {
    "name": "Bazar Cordillera",
    "did": "did:stellar:testnet:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "stellarAccount": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "country": "CL",
    "currency": "CLP"
  },
  "network": "stellar:testnet",
  "settlement": {
    "scheme": "exact",
    "asset": "USDC",
    "assetContract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "decimals": 7,
    "facilitator": "https://channels.openzeppelin.com/x402/testnet"
  },
  "fx": { "base": "USD", "quote": "CLP", "rate": "950", "source": "demo-fixed", "asOf": "2026-09-22T13:23:14.017Z" },
  "policies": { "refundWindowSeconds": 864000, "shippingCountries": ["CL"] },
  "products": [
    {
      "id": "hoodie-cordillera-m",
      "sku": "HOOD-CORD-M",
      "name": "Hoodie Cordillera talla M",
      "description": "Polerón con capucha de algodón orgánico, bordado de la cordillera al frente. Talla M.",
      "priceLocal": "34990",
      "currency": "CLP",
      "priceUSDC": "36.8315789",
      "priceUSDCAtomic": "368315789",
      "stock": 12,
      "images": ["https://static.example.com/vitrinee/hoodie-cordillera-m.jpg"],
      "checkoutRoute": "/checkout/hoodie-cordillera-m"
    },
    "… (4 productos más, mismo formato)"
  ],
  "endpoints": {
    "catalog": "http://localhost:4021/catalog",
    "product": "http://localhost:4021/products/{id}",
    "checkout": "http://localhost:4021/checkout/{productId}",
    "orders": "http://localhost:4021/orders/{orderId}",
    "verifyReceipt": "http://localhost:4021/receipts/{hash}/verify",
    "discovery": "http://localhost:4021/discovery/resources"
  }
}
```

### `GET /catalog` — conversión CLP → USDC a tasa fija 950

```
hoodie-cordillera-m         34990 CLP →  36.8315789 USDC (atomic 368315789)
polera-valpo-l              14990 CLP →  15.7789474 USDC (atomic 157789474)
gorro-andes                 12990 CLP →  13.6736842 USDC (atomic 136736842)
cafe-nunoa-250               8990 CLP →   9.4631579 USDC (atomic 94631579)
botella-patagonia-500       19990 CLP →  21.0421053 USDC (atomic 210421053)
```

### `GET /products/nope` — error tipado

```
HTTP/1.1 404 Not Found
{"error":"ProductNotFound","message":"no product with id \"nope\"","details":{"productId":"nope"}}
```

## Verificaciones de dependencias (fuera del repo, en scratch)

- `npm view @x402/{core,express,stellar,fetch,extensions} version` → `2.26.0`
  en los cinco, publicados el 2026-09-15.
- Tipos de `@x402/core` 2.26.0: `PaymentOption.price: Price | DynamicPrice`,
  `payTo: string | DynamicPayTo`; el compilador de rutas convierte `:param`
  en `[^/]+` y `*` en `.*?`.
- `curl https://channels.openzeppelin.com/x402/testnet/supported` → `401
  Unauthorized` sin API key.
- OpenAPI de Jumpseller (`github.com/Jumpseller/api-docs`, `openapi.json`):
  `POST /orders.json` presente con `OrderCreateFields`; `PUT /orders/{id}.json`
  solo admite `status`, `shipment_status`, `tracking_*`,
  `additional_information`, `additional_fields`.
- `soroban-sdk` 28.0.0: ver la sección siguiente.

## `soroban-sdk` 28.0.0 con `stellar contract build` (scratch, fuera del repo)

Contrato de plantilla (`stellar contract init`), `soroban-sdk = "28"` en vez del
`"27"` que la CLI escribe por defecto:

```
$ cargo build --target wasm32v1-none --release
error: soroban-sdk requires stellar-cli v25.2.0+ to build a contract
  To fix, build with `stellar contract build` using stellar-cli v25.2.0+.

$ cargo test
test test::test ... ok
test result: ok. 1 passed; 0 failed

$ stellar contract build
    Wasm Hash: 13dc6be2a501b17010677a7156665bda3ef88c543ac2aa62bb7ac34b67b5790a
    Wasm Size: 633 bytes optimized (original size was 694 bytes)
    Exported Functions: 1 found
      • hello
✅ Build Complete
```

Conclusión: 28.0.0 es estable y compila para `wasm32v1-none`, pero **solo** a
través de `stellar contract build` (la CLI inyecta metadatos que el SDK exige).
`cargo build` directo ya no es un camino válido. Ver [DECISIONES.md § V-9](../DECISIONES.md).
