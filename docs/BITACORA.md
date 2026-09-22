# Bitácora

> Estado actual y qué entregó cada día. Salidas crudas: [evidencia/](evidencia/)
> Contexto: [CONTEXTO.md](CONTEXTO.md) · Decisiones: [DECISIONES.md](DECISIONES.md)

---

## Estado actual

**Fecha:** 2026-09-22 · **Último día cerrado:** 0 · **Siguiente:** día 1, "el agente paga"

| | |
|---|---|
| Tests TypeScript | **35** rápidos (core 23 · adapters 6 · gateway 6) |
| Tests de integración | 0 (día 1) |
| Tests Rust | 0 (día 2) |
| Red | testnet, protocolo 28 |
| Contrato desplegado | ninguno aún |

### Plan

| Día | Fecha | Qué queda demostrable | Estado |
|---|---|---|---|
| 0 | mar 22 | `pnpm test` verde; manifest servido desde el mock | ✅ cerrado |
| 1 | mié 23 | Compra x402 real con tx hash en stellar.expert | pendiente |
| 2 | jue 24 | Recibo firmado, hash anclado, verificación en verde y en rojo | pendiente |
| 3 | vie 25 | Pedido real en Jumpseller segundos después del pago | pendiente |
| 4 | sáb 26 | URL pública; dashboard; agente contra el deploy | pendiente |
| 5 | dom 27 | Walkthrough reproducible en máquina limpia | pendiente |
| 6 | lun 28 | README final, roadmap, guion, alcance congelado | pendiente |
| 7 | mar 29 | Video, QA, `v1.0.0`, `main` congelado 20:00 | pendiente |
| 8 | mié 30 | Entrega en Stellar Passport | pendiente |

---

## Día 0 · mar 22 de septiembre · "Esqueleto" — cerrado

**Qué significa.** Existe el proyecto: un monorepo que compila, prueba y sirve
el catálogo de una tienda ficticia en el formato que un agente va a leer. No
hay pago todavía; hay el suelo sobre el que el pago se para mañana.

**Qué quedó demostrable.**

- `pnpm install && pnpm typecheck && pnpm test` en verde.
- `GET /.well-known/agent-storefront.json` sirviendo cinco productos del
  adapter mock, con precios en CLP y en USDC atómico, `did:stellar` del
  merchant y endpoints absolutos.
- `GET /catalog`, `GET /products/:id`, `GET /health`, errores tipados con
  status derivado del código.

**Qué se construyó.**

- `packages/core`: errores tipados, conversión CLP→USDC con `bigint` y un
  solo redondeo, `did:stellar`, esquemas zod del manifest y del recibo.
- `packages/adapters`: interfaz `StoreAdapter` y `MockStoreAdapter` con cinco
  productos, control de stock y persistencia opcional a archivo.
- `packages/gateway`: configuración por entorno, generador del manifest con
  caché de catálogo, app Express 5 con las rutas gratuitas.
- Docs: CONTEXTO, DECISIONES V-1 a V-9, esta bitácora, evidencia del día, `CLAUDE.md`.
- CI: GitHub Actions con typecheck, lint y tests en cada push.

**Versiones y por qué.**

| Pieza | Versión | Por qué |
|---|---|---|
| `@x402/core`, `@x402/express`, `@x402/stellar`, `@x402/fetch` | 2.26.0 (a instalar el día 1) | Última publicada, 15 de septiembre de 2026. Verificado en sus tipos: precio dinámico por request y patrones de ruta con `:param`. La guía oficial de Stellar y el ejemplo `simple-paywall` usan esta API. |
| `stellar` CLI | 28.0.0 | Instalada localmente; testnet corre protocolo 28. |
| `soroban-sdk` | 28.0.0 | Verificado hoy: compila para `wasm32v1-none` con `stellar contract build` (ver [evidencia](evidencia/DIA-0.md)). `stellar contract init` aún fija 27; `cargo build` directo ya no sirve ([V-9](DECISIONES.md)). |
| Node / pnpm / TypeScript | 26.5 local (`engines >=22`) / 11.24.0 / 5.9 | TS 7 ya existe; no se arriesga un compilador nuevo en 8 días. |
| Express / zod / `@stellar/stellar-base` | 5.x / 4.x / 14.x | `@x402/*` trae zod 3 y stellar-sdk 16 anidados; pnpm los aísla sin conflicto. |

**Qué se investigó y cambia el plan.**

- **Jumpseller** (OpenAPI oficial, repo `Jumpseller/api-docs`): `POST
  /orders.json` existe, con `status: "Paid"`, `customer` y `products[{id,
  qty, price}]`. `additional_information` y `additional_fields` solo se
  escriben con `PUT /orders/{id}` después de crear; `payment_method_name` es
  de solo lectura. El tx hash irá en `additional_information` más una entrada
  en `POST /orders/{id}/history`. Autenticación: Basic auth `login:authtoken`
  (los query params están deprecados). Límite: 20 req/s, 800 req/min.
- **Facilitator OpenZeppelin**: `/supported` responde 401 sin API key; la
  key es obligatoria incluso para leer. Timeout por defecto del cliente x402:
  90 s, configurable.
- **Cliente x402**: tope por defecto de 1 USD por pago (spend controls). El
  agente demo debe subirlo explícitamente para comprar un hoodie de 36,83
  USDC.
- **USDC testnet**: el faucet de Circle es un formulario web con captcha.
  `bootstrap` abre la trustline; el fondeo es manual.

**Qué se rompió.** Nada todavía. Lo pendiente de confirmar está en
[DECISIONES.md § V-8](DECISIONES.md).
