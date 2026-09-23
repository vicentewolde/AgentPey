# Catálogo cargado en `vitrinee.jumpseller.com`

Estado al 2026-09-22. El hoodie se cargó a mano desde el panel; los otros
cinco se crearon con `POST /products.json` (mismos datos del CSV de esta
carpeta, que queda como respaldo del formato de import).

## IDs de producto

| SKU | ID | Precio CLP | Stock | Permalink |
|---|---|---|---|---|
| `HOOD-CORD-M` | 37282902 | 34990 | 12 | `hoodie-cordillera-talla-m` |
| `POL-VALPO-L` | 37282997 | 14990 | 20 | `polera-valpo-talla-l` |
| `GOR-ANDES` | 37282998 | 12990 | 8 | `gorro-andes-de-lana` |
| `CAF-NUN-250` | 37282999 | 8990 | 30 | `cafe-de-grano-nunoa-250-g` |
| `BOT-PAT-500` | 37283000 | 19990 | 2 | `botella-termica-patagonia-500-ml` |
| `STK-CORD-5` | 37283001 | 990 | 200 | `pack-de-stickers-cordillera` |

Los 6 cumplen: sin variantes, SKU único en mayúsculas, precio entero,
`stock_unlimited: false` con stock explícito, `status: available`, una imagen,
descripción en español y `shipping_required: true` con peso > 0.

Categoría: **Catálogo Vitrinee** (id 2815831).

## Los 5 productos demo

IDs 37280148 a 37280152, todos en `status: disabled`. Compartían el mismo
`sku` (`demo-product`), así que el adapter debe filtrar por
`status === "available"` de todas formas: `GET /products.json` los sigue
devolviendo.

## Hallazgos de la API

- **La categoría `Catálogo` (permalink `all`, id 2815491) no se puede asignar:**
  `PUT /products/{id}.json` con `categories: [{id: 2815491}]` devuelve 500.
  Es la categoría raíz del sistema. Con cualquier otra categoría el mismo
  payload funciona.
- **Las imágenes solo se cargan por URL pública** (`POST
  /products/{id}/images.json` con `{"image": {"url": ...}}`): no hay base64 ni
  multipart. Se usaron las URLs `raw.githubusercontent.com` de esta carpeta;
  Jumpseller las copió a su propio CDN, así que ya no dependen del repo.
- `product_type` vuelve `null` aunque se cree con `type: "physical"`. El campo
  a leer es `shipping_required`.

## Pendiente para Vinny

La tienda está en **modo privado con contraseña**: `https://vitrinee.jumpseller.com/`
responde 404 con la pantalla "Esta tienda no está disponible". Las tiendas en
trial vienen así por defecto. Se cambia en **Configuración → General**,
pasando el estado de la tienda de *Deshabilitada* a *Disponible*. La API
funciona igual, pero la vitrina pública y el video la necesitan abierta.
