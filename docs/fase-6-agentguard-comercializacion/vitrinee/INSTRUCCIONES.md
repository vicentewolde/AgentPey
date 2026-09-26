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
| `scripts/vitrinee/` | `bootstrap`, `deploy-registry` y sus librerías, y el test de contrato con el comprador de AgentPey (`agentpey-contract.test.ts`, T99) |
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

## Shopify (T112)

Un comercio Shopify se da de alta igual que uno Jumpseller (portal, cuatro
pruebas), con otro juego de credenciales (`VT-33`). Para el dueño de la tienda:

1. Cuenta gratuita en el **Shopify Partner Program** y, desde el **Dev
   Dashboard**, una **tienda de desarrollo**. Tiene que crearse ahí, no desde el
   admin de Shopify, para que quede en la misma organización que la app.
2. En el mismo Dev Dashboard, una **app** con los permisos `read_products` y
   `write_orders`, instalada en esa tienda.
3. La moneda de la tienda en **CLP** (Settings → Store details) y cada producto
   **Active**, con **SKU propio** y precio en pesos enteros.
4. El `client id`, el `client secret` y la dirección `<nombre>.myshopify.com` van
   al portal (elige "Shopify"). Para probar sin registrar: agregarlos a
   `.env.vitrinee.local` como `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID` y
   `SHOPIFY_CLIENT_SECRET` y correr `pnpm run vitrinee:shopify:probe` (con
   `-- --order` crea además un pedido de prueba, que hay que cancelar en Shopify).

## Estado al 2026-09-24 (T105 en PR)

- **Portal de dueños (T105, `VT-31`).** `vitrinee.agentpey.com/` es el portal:
  el dueño entra firmando con Freighter (SEP-0053) y da de alta su tienda
  Jumpseller, con cuatro pruebas antes de guardar nada, y ve sus pedidos. Rutas
  en `/api/portal/*` (`packages/vitrinee-gateway/src/platform/portal.ts`),
  página en `apps/vitrinee-portal/public/`. Solo existe en modo plataforma. La
  sesión se firma con una llave derivada de `MASTER_KEY`: no hay variable nueva.

## Estado al 2026-09-24 (T103 en PR)

- **Multi-comercio (T103, `C-140` a `C-144`, `VT-27` a `VT-30`).** Con
  `DATABASE_URL` y `MASTER_KEY` (en Render, `VITRINEE_DATABASE_URL` y
  `VITRINEE_MASTER_KEY`) Vitrinee es una plataforma: comercios y pedidos en el
  esquema `vitrinee` de la base del piloto (Supabase), con un rol que no ve
  las tablas de AgentPey; llave de firma y credenciales de cada comercio
  cifradas con la llave maestra; una tienda por subdominio
  (`<slug>.vitrinee.agentpey.com`). Sin esas dos variables sigue siendo la
  tienda única de abajo. Código en `packages/vitrinee-gateway/src/platform/`.
  **Nunca** apuntes un `DATABASE_URL` local a la base del piloto: el comercio
  de `.env.vitrinee.local` se siembra en ella. Para probar en local, un
  Postgres local o PGlite (`evidencia/T103.md` § 4).
- `pnpm run vitrinee:platform-setup` prepara la base e imprime los dos valores
  para Render. Lo corre el usuario: imprime secretos. `--check` no cambia nada.

## Estado al 2026-09-23 (T102 en vivo)

- **Deploy desde AgentPey (T102, `C-134`, `C-136`):** Vitrinee corre como
  cuarto proceso del servicio único de Render (`apps/gateway`), en
  `https://vitrinee.agentpey.com`, con `ADAPTER=jumpseller`. Está descrito en el
  `render.yaml` raíz. **En Render sus variables llevan prefijo `VITRINEE_`**
  (`VITRINEE_MERCHANT_SIGNING_SECRET`, `VITRINEE_FACILITATOR_API_KEY`,
  `VITRINEE_JUMPSELLER_LOGIN`, `VITRINEE_JUMPSELLER_AUTHTOKEN` como secretos, y
  las públicas con valor en el blueprint); el gateway se las pasa a Vitrinee con
  el nombre sin prefijo que lee (`envAliases` en `apps/gateway/src/hosts.ts`), y
  a ninguna otra app. Localmente nada cambia: sigue leyendo
  `.env.vitrinee.local`. **Está en vivo** desde el 2026-09-23. El servicio de
  Render se subió a 1 CPU y 2 GB (`C-138`): con 512 MB no cabían las cuatro apps.
  Ojo: el servicio no lee `render.yaml`, así que las variables `VITRINEE_` hay
  que cargarlas también en el panel. Si faltan sus secretos, el gateway no la arranca y su
  dominio responde 503; si se cae, responde 503 y el resto del piloto sigue.
  Los pedidos viven en un archivo en el disco efímero de Render: un redeploy
  los borra.
- **Deploy viejo:** `https://vitrinee-gateway.onrender.com`, desde el repo
  viejo `vicentewolde/Vitrinee`, rama `day-3-jumpseller-catalog`, con
  `ADAPTER=mock` y **sin la compatibilidad de T99**. **No archivar ni borrar
  el repo viejo** hasta que la compra real de T101 pase por el deploy nuevo:
  es el ticket "Archivar el repo viejo", bloqueado por T101. El blueprint del
  servicio viejo queda de referencia en [render.vitrinee.yaml](render.vitrinee.yaml).
- **Vitrinee es un venue de AgentPey desde T100:** fila `vitrinee` en
  `apps/agent/src/catalog/venues.json`, con `address` = la cuenta de cobro del
  comercio (`MERCHANT_STELLAR_ACCOUNT`, el `payTo` de todo 402), `baseUrl`
  `https://vitrinee.agentpey.com` y USDC de testnet. Agregada con
  `scripts/register-venue.ts`, que estaba roto desde T79 y se arregló en T100.
  `scripts/vitrinee/agentpey-contract.test.ts` fija esa fila: si cambias la
  cuenta de cobro o la URL del deploy, ese test avisa. Y RealOps la muestra
  como tercera sección del catálogo, leída en vivo de
  `GET /api/discovery/search`, con un `agentKind` propio (`vitrinee_shopper`,
  `C-135`).
- **Tienda real:** `vitrinee.jumpseller.com`, 6 productos cargados. Plan
  `basic` pagado el 2026-09-23 ([VT-21](DECISIONES.md)): `POST /orders.json` ya
  no responde `403`. Todavía no se creó ningún pedido real por API.
- **Integración con el comprador de AgentPey: compatible desde T99**
  (2026-09-23, en `main`). Vitrinee sirve su catálogo como
  `ServiceCard` en `GET /api/discovery/search`, con `quantity`, `name`,
  `address`, `city` y `region` como `input` ([VT-24](DECISIONES.md)); el
  checkout acepta `GET` con esos datos en la query ([VT-23](DECISIONES.md)); y
  un pagador `C…` pasa de punta a punta: recibo, lectura del pagador y el check
  de settlement, que busca `contract_debited` ([VT-22](DECISIONES.md)). Probado
  en testnet contra el adaptador `mock`, y cubierto sin red por
  `scripts/vitrinee/agentpey-contract.test.ts`, que corre el código real de
  AgentPey contra la app real de Vitrinee. **Si cambias el discovery o el
  checkout, ese test es el que avisa que rompiste a AgentPey.**
- **Los puntos abiertos de T99 quedaron resueltos el mismo día:** la dirección
  de despacho ya no le llega al facilitator ([VT-25](DECISIONES.md)); cada rail
  de tenant nuevo nace con 3 USDC y límites de 3,00/3,00, así que el producto
  más barato de la tienda (1,0421 USDC) se puede pagar (`C-131`, `C-133` de la
  Fase 6); y AgentPey pone la `quantity` de la compra en la ruta (`C-132`).
  Un tenant creado antes de eso tiene un rail que no alcanza. Detalle en la
  [bitácora de la Fase 6](../BITACORA.md), bloque T99.
- **Pendiente de decidir:** qué pasa con `apps/vitrinee-console` y
  `apps/vitrinee-agent` cuando RealOps y el agente de AgentPey compren en
  Vitrinee. Se mantienen: prueban que Vitrinee funciona con cualquier cliente
  x402, no solo con AgentPey.
