# Vitrinee

**Vitrinee makes any Latin American e-commerce store purchasable by AI agents.**
A gateway that connects to the store's platform (Jumpseller first, WooCommerce
next), publishes the catalogue as `/.well-known/agent-storefront.json`, charges
via **x402 in USDC on Stellar**, creates the real order on the platform, and
hands back a **signed receipt whose hash is anchored on Stellar**.

> *AgentPey gives the agent a wallet with rules. Vitrinee gives the store a door
> to receive it.*

Built in eight days (22–30 September 2026) for the **"Find Your Way"**
hackathon (Tellus Cooperative, Stellar ecosystem). **Stellar testnet only, by
design** — see [docs/CONTEXTO.md](docs/CONTEXTO.md).

**Estado: día 0 cerrado** (2026-09-22). El monorepo compila y prueba; el
manifest se sirve desde un adapter mock. El pago x402 llega el día 1. Bitácora
en [docs/BITACORA.md](docs/BITACORA.md).

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

## Estructura

| Carpeta | Qué es |
|---|---|
| `packages/core` | Esquemas del manifest y del recibo, conversión CLP→USDC con enteros, errores tipados, `did:stellar`. **Sin I/O.** |
| `packages/adapters` | Interfaz `StoreAdapter` e implementaciones: `mock` (día 0), `jumpseller` (día 3). |
| `packages/gateway` | Servidor Express: manifest, catálogo, checkout x402, órdenes, verificación de recibos. |
| `packages/anchor` | Cliente Soroban RPC del `receipt-registry` (día 2). |
| `apps/agent` | Agente demo: cliente x402 que recibe una instrucción en español y compra (día 1). |
| `apps/dashboard` | Panel del merchant (día 4). |
| `contracts/receipt-registry` | Contrato Soroban en Rust (día 2). |
| `deployments/testnet.json` | El único artefacto compartido entre TypeScript y Rust: red, USDC, facilitator, contrato desplegado. |
| `docs/` | [CONTEXTO](docs/CONTEXTO.md) · [DECISIONES](docs/DECISIONES.md) · [BITACORA](docs/BITACORA.md) · [evidencia/](docs/evidencia/) |

## Correr el día 0

Requisitos: Node ≥ 22, pnpm 11 (`corepack enable`).

```bash
pnpm install
pnpm check            # typecheck + lint + tests
```

Servir el manifest desde el adapter mock (cualquier cuenta Stellar válida
sirve como `payTo` por ahora; `pnpm bootstrap` la genera el día 1):

```bash
MERCHANT_STELLAR_ACCOUNT=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 pnpm gateway
curl -s localhost:4021/.well-known/agent-storefront.json | jq .
```

Variables de entorno: [.env.example](.env.example).

## Criterios del hackathon → evidencia

| Criterio | Evidencia en Vitrinee | Estado |
|---|---|---|
| Ejecución técnica | Monorepo con tests TS + Rust, CI, walkthrough reproducible, deploy público, integración contra plataforma real | día 0: tests TS + CI |
| Uso significativo de Stellar | Settlement x402/USDC con auth entries Soroban, contrato `receipt-registry`, `did:stellar` del merchant, verificación contra Horizon/RPC | día 1–2 |
| Originalidad | Único proyecto del lado vendedor para e-commerce LATAM; formato `agent-storefront.json`; discovery x402 (puente al RFP "x402 Facilitator with Bazaar Discovery" de SCF) | día 0: formato definido |
| Impacto | Cualquier tienda Jumpseller/Woo recibe agentes sin código propio; testimonio de merchant real | día 3 |
| Experiencia de usuario | Un comando para comprar, un panel para el merchant, recibos verificables con un clic, todo en español | día 1–4 |
| Presentación | Video de 3 min con demo en vivo, README bilingüe, diagrama, evidencia cruda | día 6–7 |

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).
