# Vitrinee — instrucciones de trabajo dentro de AgentPey

> **Manda el [`CLAUDE.md`](../../../CLAUDE.md) raíz de AgentPey.** Este archivo
> solo agrega lo específico de Vitrinee. Si algo de acá choca con una regla de
> AgentPey, gana AgentPey y este archivo está desactualizado: corrígelo.
>
> Hasta el 2026-09-23 Vitrinee fue un repo propio
> (`github.com/vicentewolde/Vitrinee`). Se fusionó en AgentPey conservando su
> historia completa, igual que AgentPass en `P-1`. Ver
> [`docs/DECISIONES.md` § P-12](../../DECISIONES.md).

## Qué es, en una frase

**Vitrinee es la forma en que un comercio real se suma a AgentPey sin escribir
código.** Un gateway que se conecta a la plataforma de la tienda (Jumpseller hoy)
por su API, publica el catálogo como `/.well-known/agent-storefront.json`, cobra
por x402 en USDC sobre Stellar testnet, crea el pedido real en la plataforma y
entrega un recibo firmado cuyo hash queda anclado en Soroban.

AgentPey es el **comprador** con reglas: identidad, mandato, `policy_rail`,
vault. Vitrinee es la **puerta del vendedor**. Para AgentPey, una tienda
Vitrinee es un comercio x402 más, que se agrega por configuración (`F7`).

## Lee esto antes de tocar Vitrinee

| | |
|---|---|
| [BITACORA.md](BITACORA.md) | Días 0–4 de Vitrinee como repo propio, antes de la fusión. Desde T98 la bitácora viva es la de la [Fase 6](../BITACORA.md) |
| [DECISIONES.md](DECISIONES.md) | Decisiones de Vitrinee, prefijo **`VT-`** |
| [CONTEXTO.md](CONTEXTO.md) | La tesis, qué **no** es, por qué testnet-only (Ley 21.521) |
| [SPEC-agent-storefront.md](SPEC-agent-storefront.md) | Formato del manifest, el checkout y el recibo, v0.1 |
| [PRD.md](PRD.md) · [CONTEXT.md](CONTEXT.md) | Usuario objetivo e historias; glosario |
| [README.md](README.md) | Recorrido completo desde cero, en español |
| [evidencia/](evidencia/) | Salida cruda de los días 0–4 |
| [PROMPT-ORIGINAL.md](PROMPT-ORIGINAL.md) | El brief con que nació el proyecto. **Histórico**: sus reglas de repo nuevo, ramas por día y README en español ya no aplican |

## Dónde vive cada cosa

| Ruta | Qué es |
|---|---|
| `packages/vitrinee-core` | Esquemas del manifest y del recibo, dinero en enteros, `VitrineeError`, `did:stellar`. Sin I/O |
| `packages/vitrinee-adapters` | `StoreAdapter`: `mock` y `jumpseller` |
| `packages/vitrinee-anchor` | Cliente Soroban del `receipt-registry` y verificación de tres checks |
| `packages/vitrinee-gateway` | Express: manifest, checkout x402, órdenes, verificación, discovery, y sirve el panel |
| `apps/vitrinee-agent` | Cliente x402 de prueba (`pnpm vitrinee:buy`). No es el agente de AgentPey |
| `apps/vitrinee-dashboard` | Panel de pedidos y verificación, HTML/JS estático |
| `apps/vitrinee-console` | Consola de compra en el navegador. Hace el papel que en AgentPey hace RealOps; su futuro está pendiente (ver abajo) |
| `contracts/receipt-registry` | Contrato Soroban. **Su propio workspace de Cargo**, excluido de `contracts/Cargo.toml` |
| `scripts/vitrinee/` | `bootstrap`, `deploy-registry` y sus librerías |
| `deployments/vitrinee-testnet.json` | Id del `receipt-registry` desplegado. Archivo propio: el script que lo escribe reemplaza el archivo entero y pisaría el de AgentPey |

Los paquetes siguen llamándose `@vitrinee/*`. Renombrarlos a `@agentpey/*` es
opcional y está anotado como pendiente; no cambia nada funcional.

## Reglas propias de Vitrinee

1. **Su propio archivo de secretos: `.env.vitrinee.local`**, nunca el
   `.env.local` de AgentPey. Los dos usan `AGENT_SECRET_KEY` para cuentas
   distintas: si Vitrinee leyera el de AgentPey, su agente de prueba firmaría
   con la llave del agente de AgentPey. Plantilla:
   [`.env.vitrinee.example`](../../../.env.vitrinee.example).
2. **Prefijo `VT-`.** Antes de la fusión las decisiones de Vitrinee usaban `V-`,
   que en AgentPey ya es el prefijo de la Fase 5 (MandateVault). Se renumeró
   uno a uno: `V-7` de Vitrinee es hoy `VT-7`. Los mensajes de commit
   anteriores al 2026-09-23 siguen diciendo `V-n`; no se reescriben.
3. **Dinero en enteros de punta a punta** (`bigint`, unidades atómicas). Nunca
   `number` para un monto ([VT-7](DECISIONES.md)). Los precios que llegan como
   número de la API de Jumpseller se convierten a string exacto en la frontera
   (`packages/vitrinee-adapters/src/jumpseller/map.ts`).
4. **Errores: `VitrineeError`**, con `code` estable; el status HTTP se deriva
   del código. AgentPey usa `AgentPassError`. Unificarlos sería una decisión
   nueva; no se hace sin proponerla primero (regla 2 de AgentPey).
5. **`stellar-sdk` 17 usa XDR nuevo:** uniones como objetos `{ type, <campo> }`,
   enums como propiedades estáticas. Para decodificar, preferir `scValToNative`.
6. **El layout de storage de `receipt-registry`** se lee directo desde
   `packages/vitrinee-anchor/src/scval.ts`. Si cambia el contrato, subir
   `STORAGE_SCHEMA_VERSION` en ambos lados.
7. **El contrato no se redespliega** sin permiso explícito del usuario. El id
   vivo está en `deployments/vitrinee-testnet.json`.

## Comandos

Todo desde la raíz de AgentPey.

```bash
pnpm install
```

```bash
pnpm run vitrinee:check
```

```bash
pnpm run vitrinee:bootstrap
```

```bash
pnpm run vitrinee
```

```bash
pnpm run vitrinee:buy -- "compra un pack de stickers"
```

```bash
pnpm run vitrinee:verify
```

```bash
pnpm run vitrinee:console
```

```bash
pnpm run vitrinee:test:integration
```

```bash
pnpm run vitrinee:test:contracts
```

`vitrinee:check` es typecheck + lint + tests de Vitrinee, sin red.
`vitrinee:test:integration` compra de verdad contra testnet (~1 USDC en
stickers). `pnpm check` de AgentPey también corre los tests de Vitrinee, porque
sus paquetes están en el mismo workspace.

## Estado al 2026-09-23 (T98 mergeado)

- **Deploy vivo:** `https://vitrinee-gateway.onrender.com`, con `ADAPTER=mock`.
  **Todavía se despliega desde el repo viejo** `vicentewolde/Vitrinee`, rama
  `day-3-jumpseller-catalog`. Pasarlo al `render.yaml` de AgentPey es un hito
  pendiente. Hasta entonces, **no archivar ni borrar ese repo**: el deploy
  depende de él. El blueprint de referencia está en
  [render.vitrinee.yaml](render.vitrinee.yaml).
- **Tienda real:** `vitrinee.jumpseller.com`, 6 productos cargados. Plan
  `basic` pagado el 2026-09-23 ([VT-21](DECISIONES.md)): `POST /orders.json` ya
  no responde `403`. Todavía no se creó ningún pedido real por API.
- **Integración con el comprador de AgentPey: no existe todavía.** Hay tres
  incompatibilidades verificadas en código, todas del lado de Vitrinee:
  1. *Discovery.* AgentPey lee `GET /api/discovery/search` en formato
     `ServiceCard` del stellar-bazaar (`apps/agent/src/catalog/x402-catalog.ts`).
     Vitrinee expone `/discovery/resources` en el formato de `@x402/extensions`.
  2. *Método.* AgentPey pide el 402 con `GET` sin body
     (`requestPaymentChallenge` en `apps/agent/src/payment/x402.ts`). El
     checkout de Vitrinee es `POST` con JSON.
  3. *Pagador `C…`.* AgentPey paga desde un `policy_rail`, que es una cuenta
     contrato. El recibo de Vitrinee valida `payerAccount` solo como `G…`: el
     pago se liquidaría y **después** fallaría la firma del recibo.

  La dirección de despacho de un pedido físico puede llegar por los `input` del
  `ServiceCard`: RealOps ya arma un formulario por producto con ellos y los
  manda como `route_params` (T96).
- **Pendiente de decidir:** qué pasa con `apps/vitrinee-console` y
  `apps/vitrinee-agent` cuando RealOps y el agente de AgentPey compren en
  Vitrinee. Se mantienen: prueban que Vitrinee funciona con cualquier cliente
  x402, no solo con AgentPey.
