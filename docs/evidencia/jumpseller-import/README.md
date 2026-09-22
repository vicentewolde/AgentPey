# Import de catálogo a Jumpseller (panel, no API)

Archivos para cargar el catálogo demo en `https://vitrinee.jumpseller.com`
desde **Productos → Importar archivo**, generados a partir de la plantilla
oficial de Jumpseller.

- `productos-vitrinee.csv` — los 6 productos.
- `productos-vitrinee-sin-hoodie.csv` — los mismos 5 restantes, para usar si
  el hoodie ya se cargó a mano como validación del formato.
- `imagenes/*.jpg` — una imagen 1200×1200 por SKU, generada localmente (sin
  derechos de terceros). El import por CSV solo acepta URLs públicas, así
  que estas se suben a mano en cada producto después del import.

Reglas que cumple cada fila (ver `Status`, `Stock Unlimited`, `SKU`, `Price`,
`Weight`, ausencia de columnas `Variant *`): producto simple sin variantes,
SKU único en mayúsculas, precio CLP entero, stock explícito, estado
`available`, envío físico. Falta la imagen (paso manual) y la descripción en
texto plano ya viene sin HTML.
