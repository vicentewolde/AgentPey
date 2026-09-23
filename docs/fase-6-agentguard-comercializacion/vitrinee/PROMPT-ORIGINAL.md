# PROMPT PARA CLAUDE CODE — Proyecto Vitrinee

> Pega este archivo completo como primer mensaje en una sesión nueva de Claude Code, dentro de un repo vacío recién creado. Lee todo antes de escribir una línea de código.

---

## 0. Tu rol

Eres el ingeniero principal de **Vitrinee**, un proyecto nuevo e independiente que se construye en 8 días para el hackathon **"Find Your Way"** (Tellus Cooperative, ecosistema Stellar). Trabajas con Vinny (ingeniero, Santiago de Chile), que dirige, revisa y ejecuta las tareas humanas listadas en la sección 12. Vinny ya construyó **AgentPey** (github.com/vicentewolde/AgentPey): identidad, mandatos y políticas de gasto para agentes de IA sobre Stellar testnet, con un merchant x402 funcionando (signaldesk.agentpey.com). Conoces ese repo como referencia de patrones, pero **Vitrinee no depende de él** (ver 2.3).

Idioma: **docs, README, commits de bitácora y mensajes a Vinny en español (registro latinoamericano); código, comentarios, nombres de variables y mensajes de commit en inglés.** Igual que en AgentPey.

---

## 1. Qué es Vitrinee (y qué no es)

**Vitrinee hace que cualquier tienda de e-commerce en Latinoamérica sea comprable por agentes de IA.** Un middleware que se conecta a la plataforma de la tienda (Jumpseller primero, WooCommerce después), publica el catálogo en un formato que un agente entiende, cobra vía **x402 en USDC sobre Stellar**, crea el pedido real en la plataforma y entrega un **recibo firmado cuyo hash queda anclado en Stellar**.

Frase para el pitch: *AgentPey le da al agente una billetera con reglas. Vitrinee le da a la tienda una puerta para recibirlo.*

**Vitrinee NO es:**
- Un wallet, un facilitator x402, un marketplace ni una "capa de pagos para agentes" (ese espacio ya está saturado: SpendGuard, AgentCard, AgentGuard, REAPP, etc.). Vitrinee está del **lado del vendedor**.
- Un plugin PHP/Liquid nativo. Es un gateway HTTP que habla con la plataforma por su API.
- Custodio de fondos. El pago x402 va directo a la cuenta Stellar del merchant (`payTo`). Vitrinee nunca tiene llaves del merchant ni del comprador.
- Un producto en mainnet. **100% Stellar testnet**, USDC de testnet, sin fiat, sin PSP. Esto es una restricción regulatoria deliberada (Ley Fintech 21.521, Chile), no una limitación técnica; documéntalo en CONTEXTO.md.

---

## 2. Restricciones duras

### 2.1 Del hackathon
- **Deadline de entrega: 30 de septiembre de 2026.** La entrega la hace Vinny en Stellar Passport. Todo lo que no esté en `main` y desplegado el 29 a las 20:00 (hora Chile) no existe.
- Repo GitHub **público, nuevo, creado después del 14 de septiembre de 2026**, licencia **Apache-2.0** (misma que AgentPey).
- Track: General. Criterios: ejecución técnica, uso significativo de Stellar, originalidad, impacto potencial, experiencia de usuario, calidad de presentación. Cada decisión de alcance se evalúa contra estos seis.
- Video pitch de máximo 3 minutos: el sistema debe demostrarse **en vivo contra testnet**, no con mocks, el día 29.

### 2.2 Técnicas
- Node ≥ 22, pnpm, TypeScript estricto, monorepo pnpm workspaces (mismo esqueleto mental que AgentPey: `packages/`, `apps/`, `contracts/`).
- Settlement x402: **usar `@x402/stellar` + `@x402/express` + `@x402/core`. No reimplementar el esquema `exact` ni la verificación de auth entries.** Facilitator: el público "Built on Stellar" (OpenZeppelin Channels), testnet `https://channels.openzeppelin.com/x402/testnet`, con API key en `Authorization: Bearer`. Referencia oficial: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar y el repo https://github.com/stellar/x402-stellar (ejemplos `simple-paywall` y `facilitator`).
- USDC de testnet (SEP-41, 7 decimales). Manejo de decimales correcto en todo el camino: precios del catálogo en CLP/USD → cotización fija de demo → stroops de USDC. Nunca floats para dinero: usar enteros (stroops) o `bigint`.
- Contrato Soroban en Rust (`contracts/receipt-registry`), `wasm32v1-none`, `stellar` CLI 28, tests con `cargo test`. Deployment registrado en `deployments/testnet.json` (patrón AgentPey: un solo artefacto compartido entre TS y Rust; redeploy explícito con `--redeploy`, nunca silencioso).
- Secrets: `.env.example` versionado, `.env.local` gitignored (mode 600), nunca se imprimen llaves en logs ni en evidencia. Script `bootstrap` idempotente que genera/fondea cuentas por Friendbot.
- Tests: vitest para TS (suite rápida sin red + `test:integration` contra testnet real), cargo para Rust. CI con GitHub Actions corriendo typecheck + test rápido en cada push.

### 2.3 Relación con AgentPey
- Vitrinee **no importa paquetes `@agentpey/*` en el núcleo**. El comprador es "cualquier cliente x402 estándar". Eso es lo que la hace un proyecto independiente y también lo que la hace valiosa: funciona con AgentPey, con REAPP, con un script de 40 líneas.
- Sí puedes **copiar patrones** (bootstrap, deployments/testnet.json, estructura docs/, DECISIONES con prefijo, bitácora) y reutilizar la idea `did:stellar` para identificar al merchant en el recibo.
- El único punto de contacto es opcional y va al final (día 6, si sobra tiempo): un modo `--payer agentpey` en el agente demo, para mostrar en el video los dos proyectos juntos.

---

## 3. Arquitectura objetivo

```
vitrinee/
├── packages/
│   ├── core/          # Esquema del catálogo, recibo (JWS), conversión de precios, errores tipados. SIN I/O.
│   ├── adapters/      # Interface StoreAdapter + implementaciones: mock, jumpseller, (woocommerce stretch)
│   ├── gateway/       # Servidor Express: /.well-known, catálogo, checkout x402, órdenes, verificación de recibos
│   └── anchor/        # Cliente Soroban RPC del receipt-registry (anchor / get)
├── apps/
│   ├── agent/         # Agente demo: cliente x402 que recibe una instrucción en español y compra
│   └── dashboard/     # Panel del merchant: pedidos, recibos, links a stellar.expert (Vite + React, mínimo)
├── contracts/
│   └── receipt-registry/   # Soroban: anchor(hash, merchant, amount, order_ref) / get(hash) / count(merchant)
├── deployments/testnet.json
├── docs/
│   ├── CONTEXTO.md    # Qué es, tesis, qué NO es, marco regulatorio (testnet-only)
│   ├── BITACORA.md    # Estado actual + qué entregó cada día
│   ├── DECISIONES.md  # V-1, V-2, ... cada decisión con alternativa rechazada
│   ├── SPEC-agent-storefront.md   # Especificación del formato /.well-known/agent-storefront.json
│   └── evidencia/     # Salida cruda de comandos por hito (tx hashes, ids de contrato)
├── scripts/           # bootstrap, deploy:registry, demo, seed
├── README.md, ROADMAP.md, LICENSE, .env.example, render.yaml
```

### 3.1 `packages/core`
- `StorefrontManifest` (zod): `version`, `merchant { name, did, stellarAccount, country, currency }`, `network: "stellar:testnet"`, `settlement { scheme: "exact", asset: "USDC", facilitator }`, `policies { refundWindowSeconds, shippingCountries[] }`, `products[] { id, sku, name, description, priceLocal, priceUSDC (string en unidades), stock, images[], checkoutRoute }`, `endpoints { catalog, checkout, orders, verifyReceipt }`.
- `Receipt`: VC-JWT/JWS firmado con la llave Ed25519 del merchant (`did:stellar:testnet:G...`), payload: `orderId`, `platformOrderId`, `merchantDid`, `payerAccount`, `amountUSDC`, `settlementTxHash`, `items[]`, `issuedAt`, `refundWindowEndsAt`. `sha256(compactJws)` es lo que se ancla. Verificar = (1) firma contra la llave derivada del DID, (2) hash presente en el registry con estado `Anchored`, (3) `settlementTxHash` existe en Horizon/RPC.
- Conversión de precio: `priceLocal` (CLP) → USDC con una tasa fija de demo declarada en el manifest (`fxRate`, con `fxSource: "demo-fixed"`). Nada de oráculos en esta versión; anótalo como V-decisión.

### 3.2 `packages/adapters`
```ts
interface StoreAdapter {
  listProducts(): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  createOrder(input: { productId; quantity; buyer: { stellarAccount; email?; shipping? }; paymentRef }): Promise<PlatformOrder>;
  getOrder(platformOrderId: string): Promise<PlatformOrder | null>;
}
```
- `mock`: catálogo JSON en disco (5 productos con nombres reales de una tienda chilena ficticia), órdenes en memoria + archivo. Se usa en tests y como fallback si Jumpseller falla en el video.
- `jumpseller`: REST API de Jumpseller (login + authtoken por query, endpoints `products`, `orders`). Mapeo mínimo: producto → Product; crear orden con `status: paid`, `payment_method: "Stellar USDC (x402)"`, y guardar `settlementTxHash` en `additional_information`/notas del pedido. Investiga la API real en https://jumpseller.com/support/api antes de implementar; si un campo no existe, degrada a notas de texto, nunca inventes campos.
- `woocommerce` (stretch, solo si el día 5 va adelantado): REST API v3 con consumer key/secret.

### 3.3 `packages/gateway` (Express)
Rutas:
- `GET /.well-known/agent-storefront.json` → manifest (generado desde el adapter, cacheado 60 s).
- `GET /catalog` y `GET /products/:id` → gratis.
- `POST /checkout/:productId` → **protegida por `paymentMiddleware` de `@x402/express`** con `ExactStellarScheme`, `network: "stellar:testnet"`, `payTo: MERCHANT_STELLAR_ACCOUNT`, precio **dinámico por producto** (resolver el precio en el momento de la request desde el adapter; verifica cómo `@x402/express` admite precio por ruta dinámica, si no lo admite, monta una ruta por producto al arrancar o usa un resolver custom sobre `x402ResourceServer`). Body: `{ quantity, buyer }`. Al pasar el pago: crea la orden en el adapter, emite recibo, ancla hash (asíncrono con reintentos, la respuesta no espera al anchor pero devuelve `anchorStatus: "pending" | "anchored"` y un `orderId` para consultar), responde `{ orderId, platformOrderId, receiptJws, settlementTxHash, anchor }`.
- `GET /orders/:orderId` → estado, incluida la confirmación del anchor.
- `GET /receipts/:hash/verify` → corre las tres verificaciones y responde `{ valid, checks: {...}, receipt }`.
- Idempotencia: `Idempotency-Key` en checkout; el mismo pago no crea dos órdenes.
- Stock: decrementa en el adapter tras el pago; si no hay stock, responde 409 **antes** del 402 (no cobres lo que no puedes vender).
- Descubrimiento x402: expón también el catálogo como recursos de la **extensión de discovery de x402** (`/discovery/resources` con `routeTemplate` por producto), para que un Bazaar futuro lo catalogue sin registro aparte. Es un puente directo al RFP abierto de SCF "x402 Facilitator with Bazaar Discovery"; menciónalo en README.

### 3.4 `contracts/receipt-registry`
- `anchor(hash: BytesN<32>, merchant: Address, amount: i128, order_ref: Bytes)` requiere `merchant.require_auth()`; guarda `{merchant, amount, order_ref, ledger, ts}`; falla si el hash ya existe.
- `get(hash) -> Option<ReceiptRecord>`, `count(merchant) -> u32`.
- Eventos `receipt_anchored`. 8–12 tests Rust (duplicado, auth faltante, lectura).
- Sin admin ni upgrade. Es deliberadamente pequeño; registra la decisión.

### 3.5 `apps/agent`
- CLI: `pnpm demo:buy -- "compra el hoodie talla M y envíalo a Ñuñoa"`.
- Flujo: lee `/.well-known/agent-storefront.json` → resuelve el producto (matching simple por nombre/sku con un LLM opcional detrás de flag `--llm`, y un matcher determinista por defecto para que el demo no dependa de una API externa) → `POST /checkout` → recibe 402 → firma auth entry con `createEd25519Signer` de `@x402/stellar` → reintenta con el header de pago → imprime recibo, tx hash con link a `https://stellar.expert/explorer/testnet/tx/<hash>` y resultado de `/receipts/:hash/verify`.
- Todo el output en español, legible, pensado para grabarse en pantalla. Tiempo objetivo del demo completo: < 20 segundos.

### 3.6 `apps/dashboard`
- Una sola página: lista de pedidos (estado, monto USDC, tx, anchor), detalle con recibo decodificado y botón "Verificar recibo" que llama al endpoint. Link "Ver en stellar.expert". Sin login (testnet, demo). Estilo sobrio, en español.

### 3.7 Deploy
- `render.yaml` como en AgentPey: gateway + dashboard + agente-web (opcional). Dominio: Vinny decide (sección 12). Variables: `FACILITATOR_URL`, `FACILITATOR_API_KEY`, `MERCHANT_STELLAR_ACCOUNT`, `MERCHANT_SECRET` (solo para firmar recibos y anclar), `RECEIPT_REGISTRY_ID`, `JUMPSELLER_LOGIN`, `JUMPSELLER_AUTHTOKEN`, `ADAPTER=mock|jumpseller`, `FX_RATE_CLP_USD`.

---

## 4. Cómo trabajas

1. **Primero lee**: este archivo, el README y `apps/gateway` de AgentPey (para el patrón de merchant x402 que ya funciona), la doc oficial de x402 en Stellar y el `examples/simple-paywall` de `stellar/x402-stellar`. Anota en BITACORA.md qué versión de `@x402/*` instalaste y por qué.
2. **Bitácora diaria**: al terminar cada día actualiza `docs/BITACORA.md` (estado, qué quedó demostrable, qué se rompió) y `docs/evidencia/DIA-N.md` con la salida cruda de los comandos clave (tx hashes, contract id).
3. **Decisiones**: cada trade-off no trivial va a `docs/DECISIONES.md` como `V-N` con alternativa rechazada. Ejemplos que ya sabemos: V-1 gateway vs plugin nativo; V-2 tasa de cambio fija; V-3 registry sin admin; V-4 sin custodia; V-5 anchor asíncrono.
4. **Git**: rama por día (`day-1-checkout`, `day-2-receipts`…), PR a `main` con squash al final del día, tag `v0.N`. `main` siempre despliega y siempre pasa CI. Commits convencionales en inglés.
5. **Antes de acciones irreversibles** (redeploy de contrato, borrar cuentas, cambiar `deployments/testnet.json`) pregunta a Vinny.
6. **No inventes**: si la API de Jumpseller o `@x402/express` no hace lo que este prompt asume, dilo, propón la alternativa más simple y regístrala como V-decisión. Este documento es una hipótesis, la doc oficial manda.
7. **Alcance**: si el día va atrasado, corta por este orden: WooCommerce → modo `--payer agentpey` → LLM en el agente → dashboard bonito → discovery extension. **Nunca cortes**: checkout x402 real, orden creada en plataforma, recibo firmado, anchor en Soroban, verificación, README, video.
8. Al final de cada día, dime en 5 líneas qué hago yo mañana (sección 12) y qué necesitas de mí.

---

## 5. Plan día a día (22 → 30 de septiembre de 2026)

> Vinny tiene Claude Max con Fable 5.1 y el límite semanal se reinicia el 23. Los días 23–29 son de máxima intensidad. El 22 es corto.

### Día 0 — Mar 22 (tarde/noche) · "Esqueleto"
- Scaffold del monorepo, tsconfig base, vitest, ESLint mínimo, CI, LICENSE, `.env.example`, README con una sección "Estado: día 0".
- `packages/core`: esquemas zod del manifest y del recibo, conversión CLP→USDC con tests, errores tipados.
- `packages/adapters/mock` con 5 productos y tests.
- `docs/CONTEXTO.md`, `DECISIONES.md` (V-1..V-4), `BITACORA.md`.
- **Demostrable al cierre**: `pnpm test` verde; `GET /.well-known/agent-storefront.json` sirviendo el mock.

### Día 1 — Mié 23 · "El agente paga" (hito crítico)
- `scripts/bootstrap`: genera y fondea merchant + agente por Friendbot, trustline USDC testnet, `.env.local`.
- Gateway con `@x402/express` + `ExactStellarScheme` + facilitator OpenZeppelin testnet. `POST /checkout/:productId` protegida, precio dinámico.
- `apps/agent` mínimo: 402 → firma → pago → orden en mock.
- `test:integration`: una compra real contra testnet.
- **Demostrable**: una compra de punta a punta con tx hash real en stellar.expert. Si esto no funciona el 23, todo lo demás se posterga hasta que funcione.

### Día 2 — Jue 24 · "Recibo y anclaje"
- `contracts/receipt-registry` + tests Rust + `deploy:registry` + `deployments/testnet.json`.
- `packages/anchor` (cliente RPC), recibo JWS firmado por el merchant, anchor asíncrono con reintentos, `GET /receipts/:hash/verify`, `GET /orders/:id`.
- Idempotencia y control de stock.
- **Demostrable**: compra → recibo → hash anclado → verificación en verde; manipular un byte del recibo → verificación en rojo.

### Día 3 — Vie 25 · "Tienda real"
- `adapters/jumpseller`: productos reales de la tienda de prueba de Vinny, orden creada al pagar, tx hash en el pedido.
- Manifest generado desde Jumpseller; discovery extension (`/discovery/resources`).
- `docs/SPEC-agent-storefront.md` v0.1.
- **Demostrable**: el pedido aparece en el panel de Jumpseller segundos después de que el agente paga.

### Día 4 — Sáb 26 · "Panel y deploy"
- `apps/dashboard`: pedidos, recibo decodificado, botón verificar, links a stellar.expert.
- `render.yaml`, deploy del gateway + dashboard, dominio configurado, manifest público accesible.
- Agente demo apuntando al deploy público (no a localhost).
- **Demostrable**: URL pública; alguien externo puede leer el manifest y comprar con un cliente x402 propio.

### Día 5 — Dom 27 · "Que no se caiga en el video"
- Hardening: errores legibles en español, timeouts del facilitator, reintentos, fallback a `ADAPTER=mock` con un flag si Jumpseller falla en vivo, logs limpios.
- Suite de integración completa; CI verde; README completo con walkthrough reproducible desde cero (patrón AgentPey: "siguiendo nada más que el README").
- Stretch por orden: modo `--payer agentpey`; LLM en el matcher; WooCommerce.
- **Demostrable**: el walkthrough del README lo corre Vinny en una máquina limpia y funciona.

### Día 6 — Lun 28 · "Narrativa"
- README final (español + resumen en inglés arriba), ROADMAP.md (qué sigue: WooCommerce, Shopify, ventana de retracto con claimable balances, Bazaar), `docs/evidencia` completo, diagrama de arquitectura (Mermaid).
- Guion del video (sección 6) y ensayo cronometrado del demo. Ajustes de UX detectados en el ensayo.
- Congelar alcance. A partir de aquí solo bugs.

### Día 7 — Mar 29 · "Video y QA"
- Vinny graba el video (sección 6). Tú: corre la suite completa, verifica deploy, prepara `v1.0.0`, revisa que no haya secretos en el repo, que el manifest público esté vivo y que los tx hashes del README existan.
- 20:00 Chile: `main` congelado.

### Día 8 — Mié 30 · "Entrega"
- Solo buffer. Vinny entrega en Stellar Passport temprano (no esperar al cierre). Verificación final de links del formulario.

---

## 6. Guion del video (3 minutos, graba Vinny)

| Tiempo | Qué se ve | Qué se dice |
|---|---|---|
| 0:00–0:25 | Vinny a cámara + logo | El problema: los agentes ya saben comprar, pero ninguna tienda latinoamericana sabe recibirlos. Hoy un agente no puede pagarle a una pyme de Ñuñoa. |
| 0:25–0:45 | Diagrama de 3 cajas: Agente (AgentPey / cualquier x402) → Vitrinee → Jumpseller | Qué es Vitrinee en una frase. Qué NO es (sin custodia, sin plugin, cualquier cliente x402). |
| 0:45–1:45 | Terminal: `pnpm demo:buy "compra el hoodie talla M"` → 402 → pago → tx hash → recibo → verify ✅ | Narrar cada paso: x402 en USDC sobre Stellar, la tienda recibe directo, el recibo se ancla en Soroban. |
| 1:45–2:15 | Panel de Jumpseller con el pedido nuevo; dashboard de Vitrinee; stellar.expert con la tx y el contrato | "Esto no es un mock: pedido real en una tienda real, tx real en testnet." Idealmente clip de 10 s de un merchant real de Vinny diciendo por qué lo activaría. |
| 2:15–2:40 | Recibo alterado → verify ❌ | Por qué importa el anclaje: el merchant y el principal del agente tienen la misma prueba. |
| 2:40–3:00 | Roadmap: WooCommerce, ventana de retracto (claimable balances), Bazaar; link al repo | Cierre: testnet hoy por decisión regulatoria, mainnet cuando Ley Fintech lo permita. |

---

## 7. Mapa criterio → evidencia (para que el README lo haga explícito)

| Criterio | Evidencia en Vitrinee |
|---|---|
| Ejecución técnica | Monorepo con tests TS + Rust, CI, walkthrough reproducible, deploy público, integración contra plataforma real |
| Uso significativo de Stellar | Settlement x402/USDC con auth entries Soroban, contrato `receipt-registry` desplegado, `did:stellar` del merchant, verificación contra Horizon/RPC |
| Originalidad | Único proyecto del lado vendedor para e-commerce LATAM; formato `agent-storefront.json`; discovery x402 |
| Impacto | Cualquier tienda Jumpseller/Woo puede recibir agentes sin código propio; testimonio de merchant real; camino a SCF (RFP Bazaar) |
| UX | Un comando para comprar, un panel para el merchant, recibos verificables con un clic, todo en español |
| Presentación | Video 3 min con demo en vivo, README bilingüe, diagrama, evidencia cruda |

---

## 8. Definition of Done (30 de septiembre)

- [ ] Repo público Apache-2.0, creado después del 14/09, CI verde en `main`, tag `v1.0.0`.
- [ ] `pnpm install && pnpm bootstrap && pnpm deploy:registry && pnpm build && pnpm demo:buy "..."` funciona desde cero siguiendo solo el README.
- [ ] Compra x402 real en testnet con USDC, tx hash verificable en stellar.expert.
- [ ] Orden creada en Jumpseller (o mock si Jumpseller no está disponible, con el fallback documentado y justificado).
- [ ] Recibo JWS firmado, hash anclado en `receipt-registry`, endpoint de verificación con tres checks.
- [ ] Manifest público en `/.well-known/agent-storefront.json` + `/discovery/resources`.
- [ ] Dashboard desplegado.
- [ ] `docs/` completo: CONTEXTO, BITACORA, DECISIONES (≥ 8 entradas), SPEC, evidencia por día.
- [ ] Video ≤ 3 min subido; link en el README.
- [ ] Cero secretos en el repo (revisar con `git log -p | grep -i secret` y `gitleaks` si está disponible).

---

## 9. Riesgos conocidos y plan B

| Riesgo | Señal | Plan B |
|---|---|---|
| `@x402/express` no soporta precio dinámico por ruta | Día 1 | Registrar una ruta por producto al arrancar desde el catálogo; recargar cada 60 s |
| API de Jumpseller limitada en trial o sin campo para tx hash | Día 3 | Guardar tx hash en notas del pedido; si no hay API en trial, usar WooCommerce local (docker) o mock con captura del panel |
| Facilitator OpenZeppelin caído en el video | Día 7 | Grabar demo el 28 como respaldo; alternativa: facilitator de Coinbase con `stellar:testnet` |
| USDC testnet sin trustline/fondos | Día 1 | Script `bootstrap` con Friendbot + faucet de Circle documentado |
| Scope creep | Cualquier día | Orden de corte de la sección 4.7 |

---

## 10. Primer mensaje que debes responderme

Cuando termines de leer, responde con: (1) las 5 dudas más importantes que tienes sobre este prompt, (2) qué versión de `@x402/*` y de `stellar-cli` vas a usar y por qué, (3) tu propuesta de estructura de commits para el día 0, y (4) qué necesitas de mí hoy (API keys, cuentas, decisiones). Después empieza el día 0.

---

## 11. Nombre y marca

Nombre definitivo: **Vitrinee** (juego con "vitrina", la vidriera de una tienda). Sin colisiones detectadas en el directorio Stellar al 22/09/2026. Escribirlo siempre así, con doble "e". Paquetes npm con scope `@vitrinee/*` (no publicar en npm durante el hackathon).

---

## 12. Tareas humanas de Vinny (no las hace Claude Code)

**Hoy, 22 de septiembre**
1. Confirmar en Stellar Passport la regla del repo nuevo (posterior al 14/09). Si AgentPey califica, decidir cuál se entrega; Vitrinee se construye igual.
2. Crear el repo público `vicentewolde/vitrinee` (o el nombre final), vacío, Apache-2.0, y abrir Claude Code ahí con este prompt.
3. Generar API key de testnet del facilitator: https://channels.openzeppelin.com/testnet/gen (guardarla; no se puede recuperar).
4. Abrir tienda de prueba en Jumpseller y verificar que el plan trial expone la API (login + authtoken en Configuración → Aplicaciones). Si no, avisarme para mover el plan B a WooCommerce.
5. Enviar el mensaje de validación a 3–5 clientes de e-commerce: *"Si un agente de IA pudiera comprarte hoy pagando en dólares digitales, ¿lo activarías? ¿Me darías 15 segundos en video diciendo por qué?"*. Un clip vale más que cualquier slide.
6. Verificar que el nombre "Vitrinee" no choca con nada en stellarlight.xyz ni en npm, y reservar subdominio (por ejemplo `vitrinee.agentpey.com` o dominio propio).

**Durante la semana**
7. Día 1: revisar y aprobar la primera compra real; guardar el tx hash en el chat de estrategia.
8. Día 3: cargar 5 productos reales en la tienda Jumpseller (fotos, precios en CLP).
9. Día 4: configurar DNS y variables en Render.
10. Día 5: correr el walkthrough del README en una máquina limpia (o contenedor) y reportar cada fallo.
11. Día 6: preparar cámara, micrófono y guion; ensayar el demo 3 veces cronometrado.
12. Día 7: grabar y editar el video (≤ 3 min), subirlo, pegar el link en el README.
13. Día 8: entregar en Stellar Passport temprano; avisar al contacto de Tellus que la entrega está hecha.

**Fuera del hackathon (no bloquea)**
- Anotar en el tracker de AgentPey que Vitrinee es el candidato natural para el RFP "x402 Facilitator with Bazaar Discovery" (SCF #46, cierre 8 de noviembre) y para el Build Award posterior al Instaward.
