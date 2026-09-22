# Bitácora

> Estado actual y qué entregó cada día. Salidas crudas: [evidencia/](evidencia/)
> Contexto: [CONTEXTO.md](CONTEXTO.md) · Decisiones: [DECISIONES.md](DECISIONES.md)

---

## Estado actual

**Fecha:** 2026-09-22 · **Último día cerrado:** 2 (adelantado al 22) · **Siguiente:** día 3, "tienda real" (Jumpseller)

| | |
|---|---|
| Tests TypeScript | **84** rápidos (core 31 · adapters 6 · anchor 10 · gateway 19 · agent 8 · scripts 10) |
| Tests de integración | **2** contra testnet real (402 real · compra real) |
| Tests Rust | **11** (`receipt-registry`) |
| Red | testnet, protocolo 28 |
| Contrato desplegado | `receipt-registry` [`CADILO6Q…ZTM5`](https://stellar.expert/explorer/testnet/contract/CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5) |

### Plan

| Día | Fecha | Qué queda demostrable | Estado |
|---|---|---|---|
| 0 | mar 22 | `pnpm test` verde; manifest servido desde el mock | ✅ cerrado |
| 1 | mié 23 | Compra x402 real con tx hash en stellar.expert | ✅ cerrado el 22 |
| 2 | jue 24 | Recibo firmado, hash anclado, verificación en verde y en rojo | ✅ cerrado el 22 |
| 3 | vie 25 | Pedido real en Jumpseller segundos después del pago | pendiente |
| 4 | sáb 26 | URL pública; dashboard; agente contra el deploy | pendiente |
| 5 | dom 27 | Walkthrough reproducible en máquina limpia | pendiente |
| 6 | lun 28 | README final, roadmap, guion, alcance congelado | pendiente |
| 7 | mar 29 | Video, QA, `v1.0.0`, `main` congelado 20:00 | pendiente |
| 8 | mié 30 | Entrega en Stellar Passport | pendiente |

---

## Día 2 · "Recibo y anclaje" — cerrado mar 22 (dos días antes del plan)

**Qué significa.** Cada compra deja una prueba que nadie puede falsificar
ni borrar. La tienda firma un recibo con su llave, y la huella de ese recibo
queda escrita en un contrato de Stellar. Cualquiera, sin pedirle permiso a la
tienda, puede comprobar tres cosas: que la tienda lo firmó, que lo registró
en la blockchain, y que el pago que dice existió de verdad. Si alguien cambia
un solo número del recibo, las tres comprobaciones fallan.

**Qué quedó demostrable.**

- Contrato `receipt-registry` desplegado en testnet
  ([`CADILO6Q…ZTM5`](https://stellar.expert/explorer/testnet/contract/CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5)),
  11 tests Rust, sin admin ni upgrade (V-3). `pnpm deploy:registry` es
  idempotente y exige `--redeploy` explícito.
- Compra real → recibo JWS firmado por la llave de firma del merchant →
  hash anclado en Soroban en ~5 s → verificación ✅✅✅, en 14,6 s de punta a
  punta ([evidencia](evidencia/DIA-2.md)).
- `pnpm demo:verify` verifica el recibo sin pasar por el gateway;
  `pnpm demo:verify -- --tamper` baja el monto sin re-firmar y da ❌❌❌.
- `Idempotency-Key`, una tx = una orden, reserva de stock mientras el pago
  está en vuelo (V-15). Reintentos de anclaje con estado visible en la orden.
- CI ahora corre también `cargo test`.

**Qué se construyó.** `contracts/receipt-registry`; `packages/anchor`
(cliente RPC, check contra Horizon, `verifyReceipt`); JWS EdDSA en
`packages/core`; en el gateway: firma de recibos, cola de anclaje, rutas de
verificación, idempotencia y reservas; en el agente: espera del anclaje,
reporte de verificación y el comando `demo:verify`.

**Qué se rompió / se aprendió.**

- `stellar-sdk` 17 cambió la representación XDR (uniones como objetos
  `{type, campo}`, enums como propiedades). El fallback que lee el pagador
  desde la transacción firmada usaba la API vieja y habría fallado en
  silencio; ahora tiene un test con el sobre real de la primera compra.
- El tiempo total varía entre 14 y 22 s según cuánto tarde el facilitator en
  liquidar (7–13 s). El guion debería decir "unos veinte segundos".
- Se agregó un sexto producto barato para las pruebas reales (V-14). Saldo
  del agente tras hoy: ~8,45 USDC.

---

## Día 1 · "El agente paga" — cerrado mar 22 (un día antes del plan)

**Qué significa.** Un cliente x402 estándar puede leer la tienda, pedir un
producto, recibir un 402 con el precio exacto en USDC, firmar la autorización
Soroban y pagar; la tienda solo crea el pedido cuando el facilitator ya
liquidó el dinero en la cuenta del merchant.

**Qué quedó demostrable.**

- **Compra real en testnet:** `cómprame un café de grano y envíalo a Ñuñoa` →
  9,4631579 USDC del agente al merchant, orden `mock-0001`, tx
  [`ef86ca2f…86080f`](https://stellar.expert/explorer/testnet/tx/ef86ca2fb6b3fbbe32e89b23c7159a4b13dc02e251bb83a7e75e0ac68f86080f)
  confirmada en Horizon, 24,1 s de punta a punta ([evidencia](evidencia/DIA-1.md)).

- `pnpm bootstrap`: tres cuentas testnet fondeadas por Friendbot, trustlines
  USDC abiertas, `.env.local` escrito sin imprimir secretos
  ([evidencia](evidencia/DIA-1.md)).
- Credenciales verificadas en vivo: el facilitator OpenZeppelin responde
  `/supported` con `areFeesSponsored: true`; la API de Jumpseller responde en
  plan trial (`vitrinee.jumpseller.com`, CLP, 5 productos demo).
- `POST /checkout/:productId` con `@x402/express`: precio dinámico por
  cantidad, `paymentFlow: "upfront"`, 409 por stock **antes** del 402, orden
  creada solo tras el settle, `GET /orders/:id`.
- Agente demo: `pnpm demo:buy -- "compra el hoodie talla M y envíalo a Ñuñoa"`
  con matcher determinista (producto, talla, cantidad, ciudad), tope de gasto
  explícito y salida en español. Contra el facilitator real, el `--dry-run`
  recibe el 402 correcto.
- 22 tests nuevos sin red: el flujo completo 402 → pago → orden corre en CI
  con un facilitator simulado; la integración real vive en `test:integration`.

**Qué se rompió / queda abierto.** Nada roto. El tiempo total (24 s) supera
la meta de 20 s del video: la mayor parte es simulación Soroban del lado
del cliente más el settle del facilitator; se mide por fase el día 5 (hardening).
Agregar `Idempotency-Key` y decodificar el pagador desde el XDR quedó
probado en código pero la idempotencia formal es del día 2.

**Qué se aprendió.** Con `upfront`, el SDK no llama a `verify`
([V-10](DECISIONES.md)); `pnpm` anidado agrega un `--` extra a los argumentos
(el CLI ahora corre desde la raíz con `tsx`); el faucet de Circle se pidió
sobre la cuenta del merchant en vez de la del agente, así que el primer
saldo (20 USDC) quedó en `GC5ZY7…VCII`.

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
