# Vitrinee — instrucciones de trabajo

Gateway que hace comprable por agentes de IA a cualquier tienda de e-commerce
en Latinoamérica: manifest `/.well-known/agent-storefront.json`, cobro x402 en
USDC sobre **Stellar testnet**, pedido real en la plataforma (Jumpseller),
recibo firmado con hash anclado en Soroban. Se construye en 8 días para el
hackathon "Find Your Way" (Tellus, Stellar), entrega el 30 de septiembre de 2026.

## Lee esto antes de tocar nada

| | |
|---|---|
| [PROMPT-VITRINEE-claude-code.md](PROMPT-VITRINEE-claude-code.md) | **El brief original.** Rol, restricciones duras, arquitectura objetivo, plan día a día, guion del video. Es una hipótesis: la doc oficial manda. |
| [docs/BITACORA.md](docs/BITACORA.md) | **Estado actual y qué entregó cada día.** Empieza aquí para saber en qué día estamos. |
| [docs/DECISIONES.md](docs/DECISIONES.md) | Cada trade-off no trivial, prefijo `V-`, con la alternativa descartada. No se cambian unilateralmente. |
| [docs/CONTEXTO.md](docs/CONTEXTO.md) | Qué es, la tesis, qué **no** es, por qué testnet-only (Ley Fintech 21.521). |
| [docs/evidencia/](docs/evidencia/) | Salida cruda por día: tests, tx hashes, ids de contrato. |
| [deployments/testnet.json](deployments/testnet.json) | Único artefacto compartido TS↔Rust: red, USDC, facilitator, contrato desplegado. |
| [README.md](README.md) | Cómo correr el proyecto y el mapa criterio → evidencia. |

## Reglas de trabajo

1. **Idioma.** `docs/`, README, bitácora y mensajes a Vinny en español
   (registro latinoamericano). Código, comentarios, nombres y mensajes de
   commit en inglés.
2. **Al cerrar cada día:** actualizar `docs/BITACORA.md` y
   `docs/evidencia/DIA-N.md`, y decirle a Vinny en 5 líneas qué hace él mañana
   (sección 12 del brief) y qué necesitas de él.
3. **Antes de acciones irreversibles** (redeploy de contrato, borrar cuentas,
   cambiar `deployments/testnet.json`, crear o pushear a un repo remoto):
   preguntar.
4. **No inventar.** Si `@x402/*`, Jumpseller o Soroban no hacen lo que el
   brief asume, decirlo, proponer lo más simple y registrarlo como `V-N`.
5. **Dinero = enteros** (`bigint`, unidades atómicas). Nunca `number` para un
   monto ([V-7](docs/DECISIONES.md)).
6. **Secretos.** `.env.local` (gitignored, modo 600) y variables del host.
   Nunca en logs, evidencia ni mensajes de error. Al cerrar un día:
   `git grep -nE 'S[A-Z2-7]{55}'` debe estar vacío.
7. **Git.** Rama por día (`day-N-<tema>`), squash a `main` al cierre, tag
   `v0.N`. `main` siempre pasa CI. Commits convencionales en inglés.
8. **Alcance.** Si el día va atrasado, cortar en este orden: WooCommerce →
   `--payer agentpey` → LLM en el agente → dashboard bonito → discovery
   extension. Nunca cortar: checkout x402 real, orden en plataforma, recibo
   firmado, anchor, verificación, README, video.

## Comandos

```bash
pnpm install
pnpm check                # typecheck + lint + tests rápidos (sin red)
pnpm bootstrap            # cuentas testnet + trustlines → .env.local (idempotente)
pnpm gateway              # gateway en dev (tsx watch), lee .env.local
pnpm demo:buy -- "compra el hoodie talla M y envíalo a Ñuñoa" [--dry-run]
pnpm test:integration     # compra real contra testnet (RUN_INTEGRATION=1)
pnpm build && pnpm start:gateway
```

Cuentas de la demo (públicas, en `.env.local`): `MERCHANT_STELLAR_ACCOUNT`
(payTo), `MERCHANT_SIGNING_ACCOUNT` (firma recibos), `AGENT_ACCOUNT`
(comprador). El gateway nunca lee `MERCHANT_PAYOUT_SECRET` (V-12).

## Convenciones de código

- Monorepo pnpm: `packages/*` (librerías), `apps/*` (agente, dashboard),
  `contracts/` (Cargo workspace aparte, sin package.json).
- `packages/core` no hace I/O. Los adapters sí. El gateway orquesta.
- Errores: `VitrineeError` con `code` estable; el status HTTP se deriva del
  código, nunca se elige en la ruta.
- Tests: vitest por paquete, sin red. `test:integration` (día 1) corre contra
  testnet real y no entra en CI.
