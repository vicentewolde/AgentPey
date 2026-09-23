# Vitrinee

> **Vitrinee es una funcionalidad de [AgentPey](../../../README.md): la forma en
> que un comercio real se suma sin escribir código.** Este recorrido se corre
> desde la raíz de AgentPey. Reglas de trabajo:
> [INSTRUCCIONES.md](INSTRUCCIONES.md). Hasta el 2026-09-23 fue un repo propio;
> se fusionó conservando su historia ([P-12](../../DECISIONES.md)).

**Vitrinee makes any Latin American e-commerce store purchasable by AI agents.**
A gateway that connects to the store's platform (Jumpseller first, WooCommerce
next), publishes the catalogue as `/.well-known/agent-storefront.json`, charges
via **x402 in USDC on Stellar**, creates the real order on the platform, and
hands back a **signed receipt whose hash is anchored on Stellar**.

> *AgentPey gives the agent a wallet with rules. Vitrinee gives the store a door
> to receive it.*

Built in eight days (22–30 September 2026) for the **"Find Your Way"**
hackathon (Tellus Cooperative, Stellar ecosystem). **Stellar testnet only, by
design** — see [docs/fase-6-agentguard-comercializacion/vitrinee/CONTEXTO.md](CONTEXTO.md).

**Estado: día 4** (2026-09-22). Un agente x402 estándar compra pagando USDC de
testnet, la tienda firma un recibo, su hash queda anclado en el contrato
[`receipt-registry`](https://stellar.expert/explorer/testnet/contract/CADILO6QYG3CT2PXEWIKOYLUACPXEP4P645L5HF6WVI2K7BSVN23ZTM5)
y cualquiera puede verificarlo sin confiar en la tienda. El catálogo sale de
una tienda Jumpseller real. Hay un panel de pedidos y verificación, y una
consola de compra para el lado comprador.

⚠️ **Un bloqueo abierto:** el plan *trial* de Jumpseller no permite crear
pedidos por API (`403` en `POST /orders.json`). Todo lo demás de la integración
funciona —catálogo, manifest, precios, stock— y el gateway corre con
`ADAPTER=mock` mientras tanto. Detalle en
[BITACORA](BITACORA.md) y [VT-16](DECISIONES.md).

---

## Cómo funciona

```
┌──────────────────┐   1. GET /.well-known/agent-storefront.json   ┌──────────────────┐
│  Agente de IA    │ ─────────────────────────────────────────────▶ │                  │
│  (cualquier      │   2. POST /checkout/:id  → 402 + challenge     │    Vitrinee      │
│   cliente x402)  │ ◀───────────────────────────────────────────── │    gateway       │
│                  │   3. POST /checkout/:id + PAYMENT-SIGNATURE    │                  │
│                  │ ─────────────────────────────────────────────▶ │  ┌────────────┐  │      ┌────────────┐
│                  │                                                │  │ adapter    │──┼─────▶│ Jumpseller │
│                  │   4. { orderId, receiptJws, txHash, anchor }   │  └────────────┘  │      │ (pedido)   │
│                  │ ◀───────────────────────────────────────────── │        │         │      └────────────┘
└──────────────────┘                                                └────────┼─────────┘
         │                    facilitator x402 (OpenZeppelin)                │ anchor(sha256(recibo))
         │                    verifica y somete la tx:                       ▼
         └──────────────────▶ USDC agente → cuenta del merchant     ┌──────────────────┐
                                        (Stellar testnet)           │ receipt-registry │
                                                                    │ (Soroban)        │
                                                                    └──────────────────┘
```

- **El agente** lee el manifest, elige un producto y hace `POST /checkout/:id`.
  Recibe un `402` con el precio en USDC, firma una auth entry de Soroban con
  `@x402/stellar` y reintenta.
- **El facilitator** ("Built on Stellar", OpenZeppelin) verifica la firma y
  somete la transferencia USDC directo a la cuenta del merchant. Vitrinee
  nunca custodia fondos.
- **Vitrinee** crea el pedido pagado en la plataforma, emite un recibo JWS
  firmado, y ancla su SHA-256 en el contrato `receipt-registry`. Cualquiera
  puede verificar el recibo con `GET /receipts/:hash/verify`.

El formato del manifest y del recibo está especificado en
[docs/fase-6-agentguard-comercializacion/vitrinee/SPEC-agent-storefront.md](SPEC-agent-storefront.md).

## Estructura

| Carpeta | Qué es |
|---|---|
| `packages/core` | Esquemas del manifest y del recibo, conversión CLP→USDC con enteros, errores tipados, `did:stellar`. **Sin I/O.** |
| `packages/adapters` | Interfaz `StoreAdapter` e implementaciones: `mock` y `jumpseller`. |
| `packages/gateway` | Servidor Express: manifest, catálogo, checkout x402, órdenes, verificación, discovery y el panel estático. |
| `packages/anchor` | Cliente Soroban RPC del `receipt-registry` y verificación de recibos (firma, anclaje, pago). |
| `apps/agent` | Agente demo: cliente x402 que recibe una instrucción en español y compra. |
| `apps/dashboard` | Panel de pedidos y verificación: recibo decodificado, anclaje, los tres checks en un clic. Para quien presenta la demo y para quien audita al agente, no para operar la tienda. Estático; lo sirve el gateway ([VT-18](DECISIONES.md)). |
| `apps/console` | Consola del comprador: el **lado comprador**, un cliente x402 estándar en el navegador que lee el bazaar de la tienda y compra con el mismo `buy()` del agente. |
| `contracts/receipt-registry` | Contrato Soroban en Rust: `anchor`, `get`, `count`. Sin admin. |
| `deployments/vitrinee-testnet.json` | El único artefacto compartido entre TypeScript y Rust: red, USDC, facilitator, contrato desplegado. |
| `docs/` | [CONTEXTO](CONTEXTO.md) · [SPEC](SPEC-agent-storefront.md) · [DECISIONES](DECISIONES.md) · [BITACORA](BITACORA.md) · [evidencia/](evidencia/) |

## Correr, desde cero

Requisitos: Node ≥ 22, pnpm 11 (`corepack enable`), y una API key de testnet
del facilitator ([generar](https://channels.openzeppelin.com/testnet/gen) —
no se puede recuperar después de crearla).

**1. Instalar y comprobar que todo compila.** Sin red, sin cuentas, sin nada.

```bash
pnpm install
pnpm run vitrinee:check
```

**2. Configurar.** Copia el ejemplo y pega tu API key del facilitator; el resto
lo rellena `bootstrap`.

```bash
cp .env.vitrinee.example .env.vitrinee.local && chmod 600 .env.vitrinee.local
```

**3. Crear y fondear las cuentas de testnet.** Idempotente: si ya existen, no
hace nada.

```bash
pnpm vitrinee:bootstrap
```

Crea tres cuentas —la del merchant que cobra, la que firma recibos y la del
agente comprador—, las fondea con friendbot y abre sus trustlines de USDC.
Son tres a propósito: la llave que el gateway guarda **no puede mover los
fondos del merchant** ([VT-8](DECISIONES.md), [VT-12](DECISIONES.md)).

**4. Fondear al agente con USDC.** Es el único paso manual: el faucet de
Circle es un formulario web con captcha. `bootstrap` imprime la cuenta del
agente al terminar; pégala en <https://faucet.circle.com>.

**5. Levantar el gateway.**

```bash
pnpm vitrinee                    # http://localhost:4021
```

Usa el adapter que diga `ADAPTER` en tu `.env.vitrinee.local`, que llega como `mock`:
seis productos en disco, sin red. Para servir el catálogo de una tienda
Jumpseller real, pon `JUMPSELLER_LOGIN` y `JUMPSELLER_AUTHTOKEN` en
`.env.vitrinee.local` y:

```bash
ADAPTER=jumpseller pnpm vitrinee
```

Las variables de la línea de comandos ganan sobre `.env.vitrinee.local`.

**6. Comprar.** En otra terminal:

```bash
pnpm vitrinee:buy -- "compra el hoodie talla M y envíalo a Ñuñoa"
```

El agente imprime el pago, el recibo, el anclaje y los tres checks de
verificación, y guarda el recibo en `.vitrinee/last-receipt.jws`.

**7. Verificar sin confiar en la tienda.**

```bash
pnpm vitrinee:verify                # firma, Soroban y Horizon, sin pasar por el gateway
pnpm vitrinee:verify -- --tamper    # baja el monto sin re-firmar: los tres checks en rojo
```

Flags del agente: `--dry-run` (se detiene en el 402, sin firmar), `--max-usdc 100`
(tope por pago; el SDK trae 1 USD por defecto), `--no-verify`, `--gateway URL`,
`--json`.

### Quién mira qué

Cada actor tiene su pantalla, y el dueño de la tienda **no** necesita una
nueva:

| Actor | Dónde mira | Qué ve |
|---|---|---|
| **El dueño de la tienda** | El panel de Jumpseller de siempre | Un pedido pagado, igual al de un cliente humano: producto, stock descontado, dirección. El hash de la transacción queda en las notas del pedido para conciliar ([VT-11](DECISIONES.md)). No instala nada ni aprende nada nuevo. |
| **Quien le dio la plata al agente** (su *principal*) | El recibo, y `pnpm vitrinee:verify` o `POST /receipts/verify` | La prueba de qué compró su agente, a quién y por cuánto, verificable **sin confiar** en la tienda ni en Vitrinee. Jumpseller no tiene dónde mostrar esto: no conoce firmas, anclajes ni Stellar. |
| **Quien presenta la demo** | <http://localhost:4021/dashboard/> | El circuito entero en una pantalla y sin terminal. |

**Panel de pedidos y verificación** — <http://localhost:4021/dashboard/>, ya
corriendo con el gateway. Pedidos, monto en USDC, link a la transacción,
estado del anclaje; al abrir un pedido, el recibo decodificado y un botón que
corre las tres verificaciones contra la cadena. Se refresca solo, así que un
anclaje se ve pasar de *pendiente* a *anclado* en vivo. Muestra lo que un
panel de e-commerce no tiene campos para mostrar; no reemplaza al de
Jumpseller.

En el deploy gratuito de Render el disco es efímero: si el servicio se duerme
o se reinicia, esta lista vuelve a cero. Los pagos y los anclajes siguen en
Stellar; lo que se pierde es la copia local que el panel lista.

**Consola de compra (lado comprador)** — lee el bazaar de la tienda y compra
desde el navegador con el mismo `buy()` del agente:

```bash
pnpm vitrinee:console                    # http://localhost:4022
```

⚠️ Esa consola guarda `AGENT_SECRET_KEY` en su propio proceso para poder
firmar. Es la llave del comprador de demo: **no la expongas en una URL
pública** o cualquiera podría gastar su USDC de testnet.

### Tests

```bash
pnpm run vitrinee:check        # typecheck + lint + tests de Vitrinee, sin red
pnpm vitrinee:test:integration           # compra + anclaje + verificación reales (~1 USDC en stickers)
pnpm vitrinee:test:contracts             # cargo test en contracts/
```

### Rutas del gateway

| Ruta | Qué hace |
|---|---|
| `GET /.well-known/agent-storefront.json` | Manifest: merchant, `did:stellar` de firma, settlement x402, tasa, productos, registro de recibos |
| `GET /catalog`, `GET /products/:id` | Catálogo con precios en CLP y USDC atómico |
| `GET /discovery/resources` | Recursos pagables en el formato bazaar de x402 ([VT-17](DECISIONES.md)) |
| `POST /checkout/:productId` | 402 x402 → pago → orden + recibo firmado. Acepta `Idempotency-Key` |
| `GET /orders`, `GET /orders/:orderId` | Estado de la orden, del settlement y del anclaje |
| `GET /receipts/:hash/verify` | Tres checks sobre un recibo emitido por esta tienda |
| `POST /receipts/verify` | Tres checks sobre cualquier recibo (`{ "receiptJws": "..." }`) |
| `GET /dashboard/` | Panel de pedidos y verificación |

Variables de entorno: [.env.vitrinee.example](../../../.env.vitrinee.example).

## Desplegar

[`render.vitrinee.yaml`](render.vitrinee.yaml) declara **un** servicio: el gateway sirve la API,
el manifest y el panel desde el mismo origen, así no hay dos despliegues que
se desincronicen ni CORS que configurar ([VT-18](DECISIONES.md)).

⚠️ El deploy vivo (`vitrinee-gateway.onrender.com`) **todavía sale del repo
viejo** `vicentewolde/Vitrinee`, rama `day-3-jumpseller-catalog`. Moverlo al
`render.yaml` de AgentPey es un hito pendiente.

En Render: **New → Blueprint**, conecta el repo, elige la rama. Render pide
los valores marcados `sync: false` (ninguno vive en el repo). Después del
primer deploy, pon la URL pública en `PUBLIC_BASE_URL` — sin eso el manifest
publica las URLs internas del contenedor.

El plan free tiene disco efímero: los pedidos sobreviven un reinicio solo
mientras viva la instancia. Suficiente para una demo en testnet.

## Criterios del hackathon → evidencia

| Criterio | Evidencia en Vitrinee | Estado |
|---|---|---|
| Ejecución técnica | Monorepo con 109 tests TS + 11 Rust, CI, este walkthrough, `render.yaml`, adapter contra plataforma real | ✅ días 0–4 |
| Uso significativo de Stellar | Settlement x402/USDC con auth entries Soroban, contrato `receipt-registry`, `did:stellar` del merchant, verificación contra Horizon/RPC | ✅ días 1–2 |
| Originalidad | Único proyecto del lado vendedor para e-commerce LATAM; formato `agent-storefront.json` especificado; discovery en el formato bazaar de x402 | ✅ día 3 |
| Impacto | Cualquier tienda Jumpseller recibe agentes sin escribir código; catálogo real cargado y servido | ⚠️ día 3 — pedido bloqueado por el plan trial |
| Experiencia de usuario | Un comando para comprar, la tienda sigue en su panel de siempre, un panel de verificación, una consola para el comprador, recibos verificables con un clic, todo en español | ✅ día 4 |
| Presentación | Video de 3 min con demo en vivo, README, diagrama, evidencia cruda por día | días 6–7 |

## Licencia

Apache-2.0. Ver [LICENSE](../../../LICENSE).
