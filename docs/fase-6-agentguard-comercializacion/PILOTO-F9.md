# F9 · Piloto externo público — propuesta de arquitectura y plan

> **Qué es este documento.** La respuesta de Claude Code al brief
> [`docs/fase-0-fundamentos/agentpey-f9-brief-para-claude.md`](../fase-0-fundamentos/agentpey-f9-brief-para-claude.md)
> (2026-09-12). Es una **propuesta**: no crea tickets aprobados, no cambia
> ninguna decisión ya registrada, y no autoriza código. Cierra el hito **T72**
> y nada más.
>
> **Qué NO es.** No es un reemplazo de
> [PLATAFORMA-PARTNERS.md](PLATAFORMA-PARTNERS.md) § F9 — lo desarrolla. Aquel
> describía F9 como "incorporar un partner real"; el brief cambió esa premisa:
> no hay partner externo, el proyecto construye la plataforma (**RealOps
> Agent**) y el comercio (**SignalDesk**) para probar una integración
> parecida a una real. Ese cambio de alcance es la decisión `C-74` propuesta
> en § 12.
>
> **Actualizado el 2026-09-12, al cerrar T73.** El usuario respondió las
> nueve decisiones de § 12; sus respuestas están registradas ahí mismo, y las
> que cambiaron el diseño están implementadas o registradas como decisión:
> el permiso por producto **sí** se firma (`C-75`, ya construido), Periplo
> **sí** existe y se validó contra el servicio vivo (`C-77`), y el cambio de
> alcance quedó confirmado (`C-74`).
>
> **Estado del repo al escribirlo.** `main` en `7a7baff`, F8 cerrada de punta
> a punta (T61–T71), 932 tests verdes. Todo lo que este documento afirma sobre
> capacidades existentes se verificó leyendo el código, no la documentación —
> y § 13 lista las cuatro veces en que el código y lo que se esperaba de él no
> coincidieron.

---

## 1. Arquitectura: tres servicios, tres dominios de confianza

### 1.1 El mapa

```
   navegador de la persona
   ┌──────────────────────────────────────────────────────────────┐
   │  1. realops.<dominio>        2. <agentpey>/consent/{id}       │
   │     (registro, agentes,         (grant, Freighter, firma)     │
   │      instrucción, entrega)                                    │
   └──────────────────────────────────────────────────────────────┘
          │                                   │
          │ HTTPS                             │ HTTPS + Freighter
          ▼                                   ▼
   ┌──────────────┐   API key /v1     ┌──────────────────────────┐
   │ RealOps      │──────────────────▶│ AgentPey (apps/web)      │
   │ (partner)    │◀──────────────────│ plataforma               │
   │              │   respuestas      │                          │
   │ · email      │                   │ · tenants/agentes        │
   │ · alias      │                   │ · credencial + Mandato   │
   │ · sesión     │                   │ · MandateVault           │
   │ · agentes    │                   │ · policy_rail por tenant │
   │ · intención  │                   │ · ejecución del pago     │
   └──────────────┘                   └──────────────────────────┘
                                              │  x402 (402 → pago → entrega)
                                              ▼
                                       ┌──────────────────────────┐
                                       │ SignalDesk (comercio)    │
                                       │ · catálogo humano        │
                                       │ · /api/discovery/search  │
                                       │ · 402 + verificación     │
                                       │ · entrega + recibo       │
                                       └──────────────────────────┘
                                              ▲
                                              │ lectura, sin autoridad
                                       ┌──────────────────────────┐
                                       │ Catálogo x402 público    │
                                       │ (descubrimiento)         │
                                       └──────────────────────────┘
```

### 1.2 La frontera que define todo lo demás

**RealOps pide; AgentPey decide.** Es la única regla de la que cuelga la
seguridad de F9, y merece estar escrita antes que cualquier diagrama de
secuencia:

- RealOps puede interpretar una instrucción, buscar en un catálogo público,
  y **pedir** una compra nombrando un venue y un producto.
- AgentPey **no le cree nada de eso**. Ante una solicitud de compra,
  re-resuelve el venue contra `venues.json` (la única tabla que convierte un
  slug en una identidad pagable), pide él mismo la factura 402 al comercio,
  y compara precio / activo / `payTo` contra el Mandato firmado antes de
  mover un centavo.
- Consecuencia concreta: **un RealOps comprometido no puede ampliar nada.**
  Puede pedir compras que serán rechazadas, y nada más. Es la misma postura
  que `B-25` dejó como cicatriz permanente del proyecto — ningún camino nuevo
  puede rodear `checkMandate`.

Esto responde a la pregunta implícita del brief § 3.4 ("el catálogo público
no es una fuente de permiso"): tampoco lo es el partner. Ni el catálogo, ni
RealOps, ni el comercio son fuentes de permiso. Solo lo es el Mandato firmado,
más `venues.json` como tabla de identidades conocidas.

### 1.3 Quién ve qué dato (frontera de PII)

| Dato | RealOps | AgentPey | SignalDesk |
|---|---|---|---|
| Email | **sí** (único lugar) | nunca | nunca |
| Alias | sí | nunca | nunca |
| Cookie de sesión de RealOps | sí | nunca | nunca |
| `externalRef` opaco (`rop_<ulid>`) | sí | sí | nunca |
| `tenantId` (`ptn_…:…`) | sí | sí | nunca |
| Dirección Stellar del principal | sí (para mostrar) | sí | sí (solo como pagador on-chain) |
| Mandato firmado, grant, límites | referencia por id | **sí** (dueño) | nunca |
| Registros del vault, rechazos | vía `/v1` | **sí** (dueño) | nunca |
| Artefacto entregado / recibo | referencia + link | referencia | **sí** (dueño) |

**El email nunca cruza a AgentPey, y eso ya está defendido en el código.**
`packages/directory/src/external-ref.ts` rechaza con `InvalidExternalRef`
cualquier `external_ref` con forma de email, RUT o teléfono — y
deliberadamente no repite el valor en el error para no filtrarlo al log. F9
no necesita construir esa defensa: necesita **usarla bien**, mandando un id
aleatorio (`rop_<ulid>`) y no un hash del email. Un hash de email sigue siendo
un identificador de la persona, y con un diccionario de correos se revierte
en segundos; un ULID aleatorio no.

**Qué propongo sobre retención y borrado** (decisión del usuario, § 12):

- Aviso de piloto en el pie de toda página de RealOps: testnet, sin dinero
  real, datos de prueba, el proyecto puede borrarlos.
- Sesión de RealOps: 7 días, cookie `HttpOnly` + `Secure` + `SameSite=Lax`.
- Enlace mágico: un solo uso, 15 minutos, invalidado al usarse.
- Borrado de cuenta: un botón en el perfil que borra la fila de RealOps
  (email, alias, sesiones) y suspende el tenant en AgentPey vía `/v1`.
  **No borra el Mandato ni el vault**, y la página lo dice con todas las
  letras: son evidencia firmada y anclada en una cadena pública, no se pueden
  borrar sin romper la cadena de hashes que es el producto entero. Esta
  tensión es real y hay que exhibirla, no esconderla.
- Retención automática: los emails de cuentas sin actividad por 90 días se
  borran con el mismo barrido que T70 ya corre dentro del proceso.

---

## 2. El recorrido, como máquina de estados

### 2.1 Estados de una cuenta de RealOps

```
  (visitante)
      │ escribe email + alias
      ▼
  pending_email ──(link mágico, 15 min, un uso)──▶ active
      │ no lo abre                                    │
      ▼                                               │
   expirado                                           │
                                                      ▼
                                            contrata un agente
                                                      │
                                                      ▼
                                            agent_configured
                                       (permisos elegidos, sin firmar)
                                                      │ POST /v1/consent_sessions
                                                      ▼
                                            consent_pending ──(expira)──▶ consent_expired
                                                      │ firma con Freighter
                                                      ▼
                                              mandate_active ◀────────┐
                                                      │               │ renovación
                                       ┌──────────────┼───────────────┘
                                       │              │
                                  revocado        vencido
```

Los tres estados terminales (`revocado`, `vencido`, `consent_expired`) no son
errores: son casos de aceptación obligatorios (§ 7 del brief, casos 6 y 10).

### 2.2 Una compra, paso por paso, con quién decide en cada uno

| # | Paso | Quién lo hace | Qué pasa si falla |
|---|---|---|---|
| 1 | Instrucción en lenguaje natural → solicitud estructurada | RealOps (determinista) | No se reconoce → se le pide a la persona que elija de una lista. Sin pago. |
| 2 | Buscar candidatos en el catálogo público | RealOps | Catálogo caído o sin resultados → mensaje claro, **sin intento de pago** (caso 9). |
| 3 | `POST /v1/purchases` con venue + producto + cantidad + `Idempotency-Key` | RealOps → AgentPey | — |
| 4 | Resolver el venue contra `venues.json` | **AgentPey** | Venue desconocido → `VenueNotRegistered`, sin pago. |
| 5 | Pedir catálogo/producto al comercio | **AgentPey** | Producto ausente → `ProductNotFound`, sin pago (caso 9). |
| 6 | Firmar el `PurchaseIntent` y correr `checkScope` | **AgentPey** | `ScopeVenueNotAllowed` / `ScopeAssetNotAllowed` / `ScopeAmountExceeded` (casos 3 y 4). |
| 7 | Pedir la factura 402 al comercio | **AgentPey** | — |
| 8 | `reconcileTerms`: precio, activo y `payTo` de la factura contra el Mandato | **AgentPey** | `TermsMismatch` (casos 3 y 5). |
| 9 | `PolicyRail.authorise()` → `checkMandate` + `perDay` contra el vault | **AgentPey** | `MandateExpired`, `MandateRevoked`, `CredentialRevoked`, `DailyLimitExceeded` (casos 4 y 6). |
| 10 | Pago x402 desde el `policy_rail` del tenant | **AgentPey** + red Stellar | El contrato revalida `perTx`/`perDay`; sin saldo → `SponsoredCreditExhausted` (caso 8). |
| 11 | Entrega, recibo, `delivery_id` | SignalDesk | Pagó y no entregó → queda registrado como incidencia, con el tx como prueba. |
| 12 | Anclar el link de pago en el registry | AgentPey | Best-effort, ya es así hoy: no deshace el pago, se reporta. |

Los pasos 4 a 10 son exactamente los que hoy corren dentro de `buy()` en
`apps/web/src/server.ts`. F9 no inventa capas de autorización nuevas: las
saca de una sesión-cookie y las pone detrás de una ruta con tenant.

---

## 3. Entidades, propiedad del dato y superficie de API

### 3.1 Lo que ya existe y no se toca

`@agentpey/directory` ya modela `Partner`, `ApiKey`, `Tenant`, `Principal`,
`PrincipalBinding`, `AgentInstance`, `CredentialRecord`, `MandateRecord`,
`ConsentSessionRecord` e `IdempotencyRecord`, todos validados con zod contra
Postgres. **RealOps es un `Partner` más.** No hace falta una entidad nueva
del lado de AgentPey para que exista la plataforma del piloto: hace falta
una API key y un `externalRef` por visitante.

### 3.2 Lo que RealOps guarda (y AgentPey nunca ve)

```
realops_account   id, email (único), alias, created_at, last_seen_at
realops_session   id, account_id, expires_at
realops_magic_link token_hash, account_id, expires_at, used_at
realops_agent     id, account_id, kind ('market_brief' | 'ai_credits'),
                  label, permissions_json, tenant_id, agent_status,
                  consent_session_id, mandate_id
realops_purchase  id, account_id, agent_id, instruction, request_json,
                  purchase_id (de AgentPey), outcome, delivery_json
```

`permissions_json` es lo que la persona ajusta en la UI. Se traduce a un
`MandateGrant` así:

| Control en RealOps | Campo del grant | Quién lo hace cumplir |
|---|---|---|
| Comercio permitido | `venues: ["signaldesk:C…"]` | `checkScope` paso 2 — **firmado** |
| Activo | `assets: ["USDC:C…"]` | `checkScope` paso 3 — **firmado** |
| Máximo por compra | `limits.perTx` | `checkScope` paso 5 + el contrato `policy_rail` — **firmado y on-chain** |
| Máximo por día | `limits.perDay` | `PolicyRail.authorise()` + el contrato — **firmado y on-chain** |
| Cuenta que cobra | `payTo: ["G…"]` | `reconcileTerms` — **firmado** |
| Estado activo | revocación del Mandato | registry on-chain — **firmado** |
| **Producto / servicio** | **no existe** | ver § 13.1 — **hoy no es firmable** |

Esa última fila es el hallazgo incómodo de este documento y está desarrollado
en § 13.1. Resumido: `scopeSchema` es un `z.strictObject` con exactamente
cuatro campos, y ninguno es el producto. Un permiso "solo puede comprar el
informe XLM/USDC" **hoy no puede ir en el Mandato**. Proponer una UI que
sugiera lo contrario sería mentir sobre qué está firmado.

### 3.3 Rutas nuevas: las mínimas, y por qué no alcanzan las existentes

`/v1` hoy tiene siete rutas: crear/leer tenant, listar agentes, crear/leer
consent session, leer mandato, listar mandatos. Con eso RealOps puede llevar
a alguien hasta el Mandato firmado **y ahí se queda**: no hay ninguna ruta
capaz de ejecutar una compra ni de leer qué pasó. El brief pide explícitamente
no inventar rutas si se puede reutilizar; verifiqué y no se puede. Propongo
tres, y ninguna más:

```
POST /v1/purchases              scope: payments:authorize   Idempotency-Key obligatorio
GET  /v1/purchases/{id}         scope: payments:read
GET  /v1/tenants/{id}/activity  scope: vault:read
```

- `POST /v1/purchases` — cuerpo: `{ tenant_id, venue, product_id, quantity,
  intent_note? }`. Devuelve `201` con la decisión completa: `outcome`
  (`settled` | `refused`), `code` tipado, `refusal_reason` legible,
  `intent_id`, `total`, `asset`, `pay_to`, `transaction_hash`,
  `explorer_url`, `delivery` (`{ delivery_id, artifact_url, receipt_hash }`).
  **Un rechazo es `201`, no `4xx`**: que el Mandato diga que no es el sistema
  funcionando, no la petición estando mal formada. Un `4xx` se reserva para
  el partner que pidió mal (falta scope, tenant ajeno, cuerpo inválido).
  **Enmienda T90 (`C-121`):** el cuerpo acepta `mandate_id` opcional, que elige
  cuál de los Mandatos del tenant usa la compra y no autoriza nada; uno que no es
  de ese tenant es `404 MandateNotFound`. La respuesta gana `mandate_id`.
- `GET /v1/tenants/{id}/activity` — lo que § 6 del brief pide mostrar:
  mandato activo, permisos, compras, rechazos con razón, gasto del día contra
  `perDay`, saldo del rail. **Todo esto ya existe calculado**: es lo mismo que
  `apps/status-dashboard` (T71) lee con `readPerDayUsage()`,
  `recentRefusals()` y `readRailBalances()`. La ruta las expone por tenant,
  con la API key del partner, sin duplicar ningún cálculo — la regla de `C-73`
  aplicada otra vez.
- Dos scopes nuevos (`payments:authorize`, `payments:read`) y uno ya previsto
  (`vault:read`). `packages/partner-api/src/scopes.ts` los anticipó por nombre
  y los dejó fuera a propósito, con la regla correcta escrita en el comentario:
  "extender esta lista, aditivamente, el día que un ticket implemente la ruta
  que guardaría". Ese día es este.

### 3.4 Lo que el visitante **no** puede hacer

El brief es explícito: nada de elegir `tenantId` desde el navegador. La
regla de implementación: **el navegador nunca manda un `tenant_id`**. RealOps
lo resuelve desde su cookie de sesión → `realops_agent.tenant_id`. Una
petición del navegador que traiga un `tenant_id` se ignora, no se valida.

---

## 4. El agente determinista: interpretar, descubrir, decidir, ejecutar

### 4.1 Las cuatro capas, y dónde está el corte

```
  interpretar   →   descubrir   →   DECIDIR   →   ejecutar
  (RealOps)        (RealOps)       (AgentPey)     (AgentPey)
  ───────────────────────────────  ────────────────────────────
       puede equivocarse sin           no puede equivocarse
       consecuencia de pago            sin que alguien firme
```

La línea vertical es la frontera de confianza de § 1.2. Todo lo que está a su
izquierda puede ser reemplazado mañana por un LLM sin cambiar ni una garantía;
todo lo que está a su derecha no puede tocarse sin firma. Es la respuesta al
brief § 5: **un LLM futuro entra en "interpretar" y en "descubrir", nunca en
"decidir" ni en "ejecutar".** Concretamente, un LLM podría producir un
`{ product_kind, quantity }`, y nada más: no elige `payTo`, no elige venue
fuera de `venues.json`, no ordena un pago.

### 4.2 Las instrucciones admitidas en la primera versión

Propongo cerrar la v1 a dos **familias** de instrucción, no a una lista de
frases. El proyecto ya tiene el mecanismo: `apps/agent/src/interpret.ts`
normaliza (minúsculas, sin acentos, sin puntuación), saca stopwords, y hace
coincidir el resto contra los nombres del catálogo. Funciona, es
determinista, corre offline y ya está testeado.

- **Market Brief Agent** → `{ kind: "market_report", pair: "XLM/USDC", quantity: n }`
  Reconoce: "compra el reporte XLM/USDC", "comprame el informe de mercado
  XLM USDC", "quiero el reporte de XLM/USDC". El par se extrae de un
  diccionario cerrado de pares conocidos (v1: solo `XLM/USDC`).
- **AI Token Sandbox Agent** → `{ kind: "ai_credits", pack: "small"|"medium", quantity: n }`
  Reconoce: "compra 1000 créditos de IA", "comprame el paquete chico de
  créditos".

Lo que no se reconoce **no se adivina**: devuelve `InstructionNotRecognised`
y la UI ofrece los dos botones. Adivinar es exactamente lo que no queremos
que haga un agente con permiso de gastar.

### 4.3 Descubrimiento: un catálogo público que no es una fuente de permiso

El diseño en una frase: **el catálogo elige a quién preguntarle el precio;
`venues.json` elige a quién se le puede pagar.** Un candidato que el catálogo
devuelve y `venues.json` no conoce se rechaza con `VenueNotRegistered` antes
de pedir siquiera la factura. Un catálogo comprometido, caído, o que devuelva
un comercio malicioso con un `payTo` atacante, produce como máximo un rechazo.

Concretamente:

```
CatalogSource (interfaz)
  search(query) → ServiceCandidate[]      // slug, nombre, url, precio declarado
       │
       ├─ PublicX402Catalog   (el catálogo público que se elija)
       └─ AgentPeyDiscovery   (fallback: índice propio sobre venues.json)

ServiceCandidate ──▶ resolveVenue(slug) contra venues.json
                       │ no está  → VenueNotRegistered (sin pago)
                       │ está     → sigue, y el precio declarado por el
                                    catálogo se DESCARTA: el precio que vale
                                    es el de la factura 402 del comercio
```

Ese descarte es deliberado y cubre el caso de aceptación 5: el precio del
catálogo nunca entra en la decisión, así que un catálogo que miente sobre el
precio no puede provocar un pago de más — y un comercio que cotiza distinto a
lo que la intención dice se rechaza en `reconcileTerms`.

**Sobre Periplo.** Lo busqué y **no pude verificar que exista** como catálogo
x402 público del ecosistema Stellar: no aparece en búsqueda web abierta, ni
en el repositorio `stellar/x402-stellar`, ni en la documentación oficial de
x402 en Stellar. Lo que sí existe y es verificable son nodos de descubrimiento
x402 de terceros y catálogos agregadores fuera de Stellar. Mi recomendación,
en orden:

1. **Preguntarle al usuario la URL exacta de Periplo.** Si la tiene, se valida
   técnicamente en media hora: ¿responde una lista?, ¿con qué forma?, ¿sobre
   HTTPS?, ¿tiene testnet?
2. **No hacerlo dependencia dura del piloto, exista o no.** Un servicio de un
   tercero que se cae el día de la prueba externa convierte un piloto en un
   incidente.
3. **Construir `AgentPeyDiscovery` igual**: un `GET /discovery/search` público
   servido por `apps/web` sobre `venues.json`, con la misma forma
   `ServiceCard` que el bazaar ya usa y que `createX402Catalog` ya sabe leer.
   Es pequeño (una ruta de lectura), hace que el descubrimiento sea real y
   compartible por URL, y es el fallback cuando el catálogo de terceros no
   está. **Y hay que decir en voz alta su límite**: un índice propio no prueba
   descubrimiento *abierto*, prueba el mecanismo. La honestidad sobre eso
   vale más que la apariencia.

---

## 5. SignalDesk

### 5.1 De dónde sale

De `examples/reference-merchant/` (T54), que ya implementa exactamente lo
necesario y fue verificado contra testnet real: `GET /api/discovery/search`
con la forma `ServiceCard`, un `402` x402 v2 (`exact`, `stellar:testnet`,
SAC de USDC testnet real), verificación de `PAYMENT-SIGNATURE`, liquidación
por facilitador, y entrega del recurso **solo después** de que la red liquide.
No hay que inventar el comercio: hay que promoverlo de ejemplo a servicio
desplegado, con dos productos y una cara humana.

**No es una máscara del bazaar** (el brief lo prohíbe explícitamente): es un
proceso propio, con claves propias, en su propio dominio, y su propia fila en
`venues.json`.

### 5.2 Los dos productos

| | Informe de mercado | Créditos de IA |
|---|---|---|
| `product_id` | `signaldesk:market-brief-xlm-usdc` | `signaldesk:ai-credits-1000` |
| Qué es | Un informe XLM/USDC de demostración | 1000 créditos de producto |
| Contenido | **Sintético, generado por SignalDesk**, marcado "datos de demostración" en el propio artefacto | Un entitlement, no un activo |
| Entrega | PDF/HTML firmado + `delivery_id` | Un saldo en la cuenta de SignalDesk, consultable |
| Transferible | no aplica | **no** — no es un token Stellar, no se puede mover |
| Precio | USDC testnet | USDC testnet |

Sobre el informe: **nada de Bloomberg**, ni nombre, ni apariencia, ni
contenido. El brief lo prohíbe y estoy de acuerdo por razones que van más
allá del piloto. El informe se genera de datos sintéticos propios y lo dice
en la primera línea del artefacto, no en un pie de página gris.

Sobre los créditos: el riesgo real no es técnico, es de encuadre. Un "crédito
de IA" que se pudiera transferir sería, de hecho, una emisión — y eso cruza
la línea que `CLAUDE.md` y la ventana de la Ley Fintech 21.521 mantienen
cerrada. El diseño lo hace imposible por construcción, no por política: el
saldo es una fila en la base de SignalDesk ligada a una dirección Stellar, sin
ninguna operación de transferencia expuesta.

### 5.3 Integridad del recibo

Cada entrega produce:

```
delivery_id      ULID, único
artifact_hash    sha256 del artefacto entregado
receipt          { delivery_id, product_id, buyer, amount, asset, payTo,
                   payment_tx, artifact_hash, delivered_at }
receipt_hash     sha256 del recibo canonicalizado
```

`receipt_hash` se firma con la clave de SignalDesk. Es verificable por
cualquiera con la clave pública del comercio, sin AgentPey de por medio.
Esto importa: si el recibo solo fuera creíble porque AgentPey lo repite, no
sería evidencia, sería un dicho.

Retención de artefactos: 90 días, dicho en la página. Después queda el recibo
y el hash, no el archivo.

---

## 6. Crédito patrocinado de prueba

### 6.1 Lo que ya funciona

`apps/web/src/tenant-rail.ts` (T58) ya hace lo que el brief § 4 describe: en
la primera compra con wallet, crea perezosamente el `policy_rail` del tenant,
lo fondea con Friendbot (XLM) y con `0.0500000` USDC desde la cuenta de
reserva (`AGENT_SECRET_KEY`), con `per_tx` y `per_day` grabados en el
contrato. F9 no tiene que construir el crédito patrocinado. Tiene que
**controlarlo**, y ahí sí hay trabajo real.

### 6.2 Los controles que faltan

| Control | Hoy | Propuesta |
|---|---|---|
| Saldo de la reserva antes de patrocinar | no se mira | precheck: si la reserva no cubre `INITIAL_FUNDING` + margen, refusal tipado `SponsoredCreditExhausted`, **antes** de desplegar nada |
| Tope de rails patrocinados | ninguno | tope por día y tope total, en configuración; al llegar, mismo refusal |
| Doble fondeo | **posible** — ver § 13.2 | persistir el contrato antes de fondearlo, y fondear con clave de idempotencia |
| Visibilidad | `check:rail-balances` (T60) y el panel (T71) | la reserva misma entra al panel, no solo los rails |
| Agotamiento visible a la persona | no aplica todavía | "crédito patrocinado de prueba: X de Y USDC" en RealOps, con el texto explícito de que no es dinero real |

### 6.3 Los números que propongo (decisión del usuario)

- `INITIAL_FUNDING` por tenant: `0.05` USDC (el actual, sin cambio).
- Tope de tenants patrocinados en el piloto: **20**. Es 1 USDC testnet total,
  y 20 personas externas ya es un piloto que dice algo.
- Umbral de alerta de la reserva: cuando quede para menos de 5 tenants.
- Al agotarse: RealOps muestra "el crédito de prueba del piloto se agotó" y
  ofrece contacto. **No** ofrece fondeo propio del visitante: el brief lo dejó
  como decisión futura separada y estoy de acuerdo en no abrirla acá.

---

## 7. Interfaz pública y entrega visible

### 7.1 RealOps, cinco pantallas

1. **Portada** — qué es, que es testnet, que no hay dinero real, y el enlace
   para entrar. Los dos servicios (RealOps y SignalDesk) se enlazan entre sí,
   para que cualquiera compruebe que ambos existen sin correr nada.
2. **Entrar** — email + alias → "te mandamos un enlace". Sin contraseña.
3. **Agentes** — los dos agentes, qué hace cada uno, y el formulario de
   permisos. Antes de firmar, una pantalla de revisión que muestra
   **literalmente el grant** que se va a firmar, con una marca visible de
   qué hace cumplir cada permiso (firmado / on-chain / RealOps).
4. **Mi agente** — estado del Mandato, permisos vigentes, gasto del día
   contra el límite, crédito patrocinado, botón de revocar, y el campo de
   instrucción.
5. **Mis servicios** — la fuente canónica de la entrega: artefacto o acceso,
   recibo, `delivery_id`, enlace a la transacción en Stellar Expert, y la
   lista de intentos rechazados con su razón en castellano.

El email de aviso, si se hace, lleva **solo un enlace** a "Mis servicios".
Nunca el artefacto, nunca el recibo, nunca nada que valga la pena interceptar.

### 7.2 La guía pública

Un documento público (no el README del repo) con: qué vas a probar, que
necesitás Freighter en escritorio con red testnet, que no necesitás fondos,
el camino feliz en cinco pasos con capturas, y los casos de rechazo guiados —
cada uno con qué hacer y qué deberías ver. Esa guía es un entregable del
piloto tanto como el código: sin ella, "una persona externa lo prueba sola"
no ocurre.

---

## 8. Modelo de seguridad y amenazas

| # | Amenaza | Mitigación | ¿Existe hoy? |
|---|---|---|---|
| 1 | RealOps comprometido pide compras fuera del grant | AgentPey re-resuelve venue, factura y `payTo`; decide contra el Mandato firmado (§ 1.2) | el enforcement sí; la ruta no |
| 2 | Catálogo público manipulado devuelve un comercio atacante | `venues.json` fail-closed; el precio del catálogo se descarta | sí (`registry.ts`) |
| 3 | Comercio cotiza distinto a la intención | `reconcileTerms` compara precio, activo y `payTo` | sí |
| 4 | `payTo` fuera del Mandato | `grant.payTo` + `reconcileTerms` (`M-14`) | sí |
| 5 | Ver datos de otro tenant | `/v1` responde `404`, nunca `403`, ante recurso de otro partner; el navegador nunca manda `tenant_id` | sí en `/v1`; falta en las rutas nuevas |
| 6 | Enlace mágico interceptado o reusado | un solo uso, 15 min, hash en base, invalidación al usar | no (construir) |
| 7 | Phishing con un falso "firmá tu Mandato" | la firma ocurre **siempre** en el dominio de AgentPey, dicho en la guía; el grant se muestra completo antes de firmar | el flujo sí; el aviso no |
| 8 | Redirección abierta al volver de la firma | lista blanca de URLs de retorno por partner, no un parámetro libre | **no — hay que construirlo** |
| 9 | Doble pago / doble entrega | `Idempotency-Key` obligatorio en `/v1/purchases`, ya implementado en `partner-api`; `delivery_id` idempotente en SignalDesk | la mitad |
| 10 | Agotamiento de la reserva como denegación de servicio | topes y precheck (§ 6.2) | no |
| 11 | Wallet firmante distinta del principal esperado | `checkMandate` compara el principal; el binding se probó al conectar | sí |
| 12 | Prompt injection desde el texto del comercio | la descripción del producto nunca entra a la decisión — `ScopeRequest` son cuatro escalares, por diseño (B-5) | sí, y es una de las garantías más fuertes que tiene el proyecto |
| 13 | Email como identificador en AgentPey | `external-ref.ts` lo rechaza | sí |

Las filas 6, 8 y 10 son lo único genuinamente nuevo que F9 tiene que
construir en materia de seguridad. Las demás ya están y hay que no romperlas.

---

## 9. Hitos, orden y delegación

**Regla de delegación para toda la fase:** nada va a Codex antes de que el
contrato de `/v1/purchases` esté congelado y mergeado (T73). Después, Codex
recibe UI, fixtures y tests, nunca un punto de autorización — la regla de
`CLAUDE.md` § 6 más el precedente de `B-25`.

| Hito | Qué | Dueño | Depende de | Riesgo |
|---|---|---|---|---|
| **T72** | Esta propuesta + PR de documentación | Claude | — | ninguno (solo docs) |
| **T73** | Congelar el contrato: scopes nuevos, esquemas zod, OpenAPI, rutas devolviendo `NotImplemented` tipado | Claude | decisiones de § 12 | **alto** — toca autorización |
| **T74** | Sacar el runner de compra de la sesión-cookie: módulo por tenant, sin producto hardcodeado | Claude | T73 | **alto** — enforcement |
| **T75** | Cablear `POST /v1/purchases` al runner, con idempotencia y registro en el vault | Claude | T74 | **alto** |
| **T76** | Controles del crédito patrocinado (§ 6.2), incluido el arreglo de § 13.2 | Claude | T75 | **alto** — fondos |
| **T77** | SignalDesk: `apps/signaldesk/**`, dos productos, catálogo humano, 402, entrega, recibo firmado | **Codex** | T73 | bajo — servicio aparte, sin tocar autorización |
| **T78** | `GET /discovery/search` sobre `venues.json` + adaptador con fallback | Claude | T73 | medio — borde de autorización |
| **T79** | RealOps: auth por enlace mágico, perfil, dos agentes, permisos, UI | **Codex** | T73 | bajo — app nueva, sin claves de AgentPey |
| **T80** | RealOps ↔ `/v1`: consent, retorno, compra, "Mis servicios", revocación | Claude | T75, T79 | medio |
| **T81** | Despliegue público de los tres servicios + guía externa | Claude | T77, T80 | medio |
| **T82** | Suite de aceptación de los 10 casos, automatizada | Claude + Codex (fixtures) | T81 | medio |
| **T83** | Prueba externa real con una persona + informe de cierre | Claude | T82 | — |

Archivos de riesgo, prohibidos para Codex en toda la fase:
`apps/agent/src/mandate/**`, `apps/agent/src/scope/**`,
`apps/agent/src/policy/**`, `apps/agent/src/ledger/**`, `packages/vault/**`,
`packages/mandate/**`, `apps/web/src/tenant-rail.ts`, `contracts/**`,
`apps/agent/src/catalog/venues.json`.

---

## 10. Pruebas

Cuatro niveles, el mismo patrón que el proyecto viene usando desde T61:

1. **Unitarias** — interpretación de instrucciones, traducción
   permisos → grant, cada refusal con su código, integridad del recibo.
2. **Integración contra Postgres real** — aislamiento entre tenants,
   idempotencia de `/v1/purchases`, el barrido de retención de RealOps.
3. **Testnet real** — el camino feliz completo de los dos productos, más los
   casos 3 a 8, con transacciones reales y hashes guardados en
   `evidencia/T<n>.md`.
4. **Aceptación de punta a punta en navegador** — los diez casos del brief § 7,
   guionados sobre el navegador contra los servicios desplegados de verdad.

Y un quinto que no es automatizable y es el que decide la fase: **una persona
externa, sin ayuda, con la guía pública y nada más.** Protocolo: se le da solo
la URL, se observa sin intervenir, se anota cada punto donde duda o se traba,
y se cierra con tres preguntas (¿entendiste qué autorizabas?, ¿entendiste por
qué te rechazó?, ¿confiarías en esto con dinero real?).

---

## 11. Criterio de salida

Propongo el criterio de `C-24` trasladado al piloto externo, porque en testnet
sin usuarios reales el volumen se puede inflar sin probar nada:

> **F9 cierra cuando una persona ajena al desarrollo completó sola, desde su
> navegador, el camino feliz de los dos productos y al menos cinco de los
> casos de rechazo guiados, sin que nadie del proyecto tocara una terminal
> durante la prueba, y cada uno de esos recorridos dejó evidencia durable
> consultable después.**

Métricas que se registran pero **no deciden**: cuántas personas lo probaron,
cuánto tardó cada una, cuántos rechazos fueron entendidos sin explicación
extra, cuántas incidencias operativas hubo. Un registro de incidencias por
fecha, con causa y si se arregló, va en `evidencia/`.

Lo que **no** es criterio de salida: cantidad de compras, monto movido,
cualquier número que se pueda subir corriendo un script.

---

## 12. Decisiones que necesito del usuario

Ninguna de estas la tomo solo, y siete vienen pedidas por el brief § 10.

> **Respondidas por el usuario el 2026-09-12.** Se conservan las preguntas
> tal como se hicieron, con la respuesta al lado, siguiendo el mismo formato
> que `PLATAFORMA-PARTNERS.md` § 7 usó para las suyas.

| # | Decisión | Mi recomendación | **Respuesta del usuario** |
|---|---|---|---|
| **D1** | Proveedor de email mágico | Resend con dominio propio verificado | **Compra `agentpey.com` hoy.** Queda Resend sobre ese dominio; la wallet como respaldo deja de hacer falta |
| **D2** | Hosting y dominios | Render, con la advertencia del plan free | **Va a pagar la instancia.** Ver § 12.1 para la comparación pedida |
| **D3** | Catálogo x402 público | No pude verificar Periplo; pedí la URL | **`github.com/Eras256/Periplo`.** Verificado contra el servicio vivo — ver `C-77` |
| **D4** | Permiso por producto | v1 sin producto firmado, con la UI diciendo qué capa hace cumplir qué | **"Quiero que sí incluya permiso por producto".** Implementado en T73 — ver `C-75`. § 13.1 queda resuelto |
| **D5** | Formato del artefacto | HTML autocontenido con su hash impreso | **HTML** |
| **D6** | Límites del crédito patrocinado | 0.05 USDC por tenant, 20 tenants | **1 USDC por tenant, 20 tenants, alerta a los 5 restantes**, y los límites del rail y precios que § 12.2 proponía. Cerrado en `C-80` |
| **D7** | Retención | Email 90 días, artefactos 90 días, Mandato y vault nunca | **De acuerdo** |
| **D8** | Alcance de F9 sin partner externo | Confirmar el cambio | **Confirmado** — `C-74` |
| **D9** | Segunda wallet móvil | Fuera de F9 | **Anotado como mejora, no necesario por ahora** |

### 12.1 Hosting: qué conviene pagar

La pregunta era si Render sigue siendo lo mejor o hay algo más barato.

| Opción | Costo mensual | A favor | En contra |
|---|---|---|---|
| **Render, 3 × Starter** | **~21 USD** | Un solo `render.yaml`, un solo panel, cero aprendizaje nuevo, ya está probado con este repo | El más caro de los tres |
| Render Starter solo para los dos que deben estar despiertos | ~14 USD | SignalDesk gratis, precalentado por RealOps al cargar la página | Un arranque en frío de ~50 s justo dentro de una compra, si el precalentamiento falla |
| Fly.io, 3 máquinas `shared-cpu-1x` 256 MB | ~6–9 USD | Lo más barato; es donde corre Periplo | Segunda plataforma que aprender y operar, en la fase donde lo que se prueba es el producto y no la infraestructura |

**Recomiendo Render con las tres en Starter, ~21 USD/mes, y darlas de baja al
cerrar el piloto.** La diferencia con Fly son unos 12 dólares al mes; el costo
real de Fly no es el precio sino tener dos plataformas que fallan de maneras
distintas justo cuando una persona externa está mirando. Si el objetivo fuera
correr esto un año, la respuesta cambiaría.

Los dominios: `realops.agentpey.com` y `signaldesk.agentpey.com`, con
`agentpey.com` apuntando a AgentPey. Tres nombres bajo un dominio propio
cuestan lo mismo que uno y hacen visible que son tres servicios distintos —
que es exactamente lo que el brief § 2 pide que la persona pueda comprobar.

### 12.2 La cuenta de reserva, y lo que 1 USDC por tenant cambia

**La dirección desde la que fondear es `GAK6E5E7L63ZYFZZZFXDTYVG6MVAKILSHI5FITGH5U4ORACEZQ4GFP2K`**
— la cuenta de `AGENT_SECRET_KEY`, que es la que `ensureTenantPolicyRail` ya
usa hoy como reserva. Al escribir esto tiene **19.484 USDC** testnet y 9999.9
XLM, así que para 20 tenants a 1 USDC falta poco más de medio USDC más un
margen.

**Dos advertencias antes de transferir nada:**

1. **Confirmá que la `AGENT_SECRET_KEY` del panel de Render es esta misma.**
   La dirección de arriba se derivó del `.env.local` de tu máquina. La
   variable de Render es `sync: false` — se cargó a mano y podría ser otra
   llave. Si son distintas, fondear la local no le sirve de nada al piloto.
   Se verifica comparando la clave pública en Render con esta.
2. **1 USDC por tenant no sirve de nada con los límites actuales del rail.**
   `tenant-rail.ts` despliega cada rail con `per_tx = 0.002` y
   `per_day = 0.01` USDC — grabados en el contrato, no en la base. Un tenant
   con 1 USDC adentro y un tope diario de 0.01 tarda cien días en gastarlo, y
   los productos de SignalDesk tendrían que costar menos de 0.002 para poder
   comprarse. Los tres números tienen que decidirse juntos. Propongo, para
   que los diez casos de aceptación sean realizables en una sesión:
   informe 0.25 USDC, paquete de créditos 0.10 USDC, `per_tx` del rail 0.30 y
   `per_day` 0.60 — así una segunda compra del informe supera el tope diario
   (caso 4) sin que haga falta esperar ni inventar nada.

**Confirmado el 2026-09-12** — ver `C-80`, que además registra la
restricción operativa que el usuario aportó (puede fondear la reserva con 20
USDC testnet una vez por día) y por qué no aprieta: un recorrido completo
gasta 0.35 USDC que van a SignalDesk, que también es nuestro y se puede
barrer de vuelta; lo que se va de verdad son los ~0.65 que quedan sin gastar
en el rail del visitante, y eso se va **por diseño**, porque desde `C-61`
solo su wallet puede retirarlos. Veinte tenants son 13 USDC de drenaje real;
el saldo actual cubre unos sesenta. El tope de 20 tenants se agota mucho
antes que los fondos. Las constantes se cambian en T77.

## 13. Lo que encontré en el código y no estaba previsto

Cuatro cosas que salieron de leer `main`, no de leer la documentación.

### 13.1 El producto no es firmable hoy — **resuelto en T73**

> Resuelto. El usuario eligió tener el permiso de verdad, y T73 lo construyó:
> `grant.products`, opcional, verificado en `checkMandate`. Ver `C-75`. Lo que
> sigue se conserva sin editar porque es el razonamiento que llevó a la
> decisión.


`scopeSchema` (`packages/core/src/credential.ts:46`) es un `z.strictObject`
con `actions`, `venues`, `assets` y `limits`. `checkScope`
(`apps/agent/src/scope/scope.ts:91`) comprueba una única acción fija,
`intent:create`. No hay ningún campo, firmado o no, que diga qué producto.

Es decir: hoy un Mandato dice "puede gastar hasta X en SignalDesk en USDC",
no "puede comprar el informe XLM/USDC". Si la persona configura "solo el
informe" y la UI se lo muestra como un permiso firmado, la UI está mintiendo:
ese permiso lo haría cumplir RealOps, y RealOps es justamente la parte en la
que el diseño decidió no confiar.

Tres salidas, en orden de honestidad:

1. **v1 sin permiso de producto firmado**, y la UI marca cada permiso con
   quién lo hace cumplir. Recomendada. Cuesta cero y no miente.
2. Un `action` por producto (`purchase:market-report`) — usa un campo que ya
   está firmado, pero cambia `checkScope`, que es un punto de enforcement.
3. Un campo `products` en `mandateGrantSchema`. El más correcto a largo
   plazo, el más caro ahora: toca documentos firmados y su comparación
   credencial↔mandato (`M-4`).

**No elijo entre las tres.** Es exactamente el tipo de decisión que
`CLAUDE.md` § 2 dice que no cambie por mi cuenta.

### 13.2 El crédito patrocinado puede fondear dos veces

En `ensureTenantPolicyRail` (`apps/web/src/tenant-rail.ts:180-200`) el orden
es: desplegar → fondear → persistir. Si el proceso muere o la escritura falla
entre fondear y persistir, la próxima compra no encuentra rail, despliega uno
nuevo y **lo vuelve a fondear**: la reserva pagó dos veces y el primer
contrato queda huérfano con saldo irrecuperable por esa vía. Lo mismo, sin
ninguna caída, con dos primeras compras concurrentes: el comentario del código
dice que la carrera "se resuelve en `setAgentPolicyRail`, primero gana" — y
es cierto para la fila, pero el rail perdedor ya fue fondeado.

Con `0.05` USDC testnet es simbólico. Con fondos reales sería un incidente.
Arreglo propuesto en T76: persistir el contrato desplegado **antes** de
fondearlo, y que el fondeo sea un paso aparte, idempotente y reintentable,
con su propio estado.

### 13.3 `buy()` solo sabe comprar una cosa

`apps/web/src/server.ts:789` está atado a `PAYABLE_PRODUCT_ID` (un único
producto del bazaar) y a `ROUTE_PARAMS` fijos, y toma todo su contexto de una
`DemoSession` de cookie. Es correcto para lo que era — una demo — y es
inservible tal cual para F9. T74 existe por esto, y es el hito de más riesgo
de toda la fase: mover enforcement de sitio sin aflojarlo.

### 13.4 No hay lista blanca de retorno

El flujo de consentimiento hospedado devuelve a la persona al partner, y hoy
no hay una lista blanca de URLs de retorno por partner. Con un solo partner de
confianza no se notó. Con un flujo público que invita a desconocidos a firmar
con su wallet, una redirección abierta después de la firma es exactamente el
paso que un phishing necesita. Fila 8 de § 8; se construye en T73.

---

## 14. Lo que esta propuesta deja sin construir a propósito

- Mainnet, fondos reales, cobro. Fuera por `CLAUDE.md` y por la ventana de la
  Ley Fintech 21.521.
- Publicar paquetes a npm.
- AgentGuard (monitoreo en tiempo de ejecución, kill-switch): sigue sin
  alcance definido.
- Fondeo por el visitante: decisión futura separada, por decisión del brief.
- Soporte móvil: no se promete sin una prueba end-to-end real.
- Créditos de IA transferibles: imposible por construcción, no por política.
