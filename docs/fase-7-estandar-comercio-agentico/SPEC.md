# Spec Fase 7 · Estándar de comercio agéntico sobre Stellar

- **Estado:** Aprobado (2026-09-30)
- **Rama base:** `main`
- **Tareas:** T120 a T125
- **Referencias:** [`P-14`](../DECISIONES.md) (alcance), [`P-15`](../DECISIONES.md) (método),
  el traspaso del 29-sep (`docs/traspaso-estandar-comercio-agentico.md`, archivo local sin versionar),
  [INSTRUCCIONES de Vitrinee](../fase-6-agentguard-comercializacion/vitrinee/INSTRUCCIONES.md),
  spec de UCP `2026-04-08` (https://ucp.dev/2026-04-08/specification/overview/),
  mandatos AP2 en UCP (https://ucp.dev/specification/ap2-mandates/)

> "F7" ya es otra cosa en `PLATAFORMA-PARTNERS.md`. Esta fase se escribe
> siempre **Fase 7**.

## 1. Objetivo

Un agente cualquiera que hable UCP descubre una tienda real de Vitrinee, arma
un checkout y lo paga sobre Stellar testnet desde un `policy_rail`, y recibe
en la orden un recibo firmado y anclado que cualquiera puede verificar.
AgentPey pasa a ser la implementación de referencia de un futuro SEP
("Agentic Commerce on Stellar"), no un protocolo propio.

## 2. Alcance

- Cada comercio de Vitrinee publica su perfil UCP en `/.well-known/ucp`.
- Un payment handler de Stellar para UCP: x402, USDC testnet.
- Una compra UCP de punta a punta, pagada desde un `policy_rail`, con pedido
  real en la plataforma de la tienda y recibo anclado enlazado en la orden.
- Si alcanza: el Mandato exportado como mandatos AP2 (Verifiable Credentials).
- Si alcanza: disputas v0 sobre un recibo de Vitrinee.
- Un anexo técnico con los formatos exactos, para el SEP.

## 3. Fuera de alcance

- Mainnet y rieles fiat. Queda para después del Build Award.
- Reemplazar el enforcement existente: `checkMandate`, `scope.limits` y
  `perDay` no se tocan. AP2 es una representación adicional.
- Redesplegar `receipt-registry` o desplegar un contrato nuevo sin permiso
  explícito del usuario.
- Romper `agent-storefront.json` o `GET /api/discovery/search`: los clientes
  actuales siguen funcionando.
- Escribir el SEP: se hace en el chat de estrategia. Aquí solo el anexo (T125).
- `C-154` (dos comercios por cuenta) y `C-160` (más wallets): después de esta fase.
- AgentGuard.

## 4. Diseño

El diseño de T121 y T122 **sale de T120**. Esta sección se completa cuando
T120 cierre y el usuario elija una opción; hasta entonces T121 a T124 no se
empiezan.

### 4.1 Componentes que se espera tocar

- `packages/vitrinee-core/src/manifest.ts` y
  `packages/vitrinee-gateway/src/discovery.ts`: de donde sale hoy
  `agent-storefront.json`, y de donde saldría el perfil UCP.
- `packages/vitrinee-gateway`: checkout y orden.
- `packages/vitrinee-anchor`: el recibo anclado, sin cambios de contrato.
- `apps/agent` y `packages/mandate`: el lado comprador y el `policy_rail`.

### 4.2 Contratos

Por definir en T120: forma del perfil UCP, configuración del handler,
dónde viaja la autorización x402 y dónde viaja el recibo en la orden.

### 4.3 Decisiones

Las de esta fase van a [`DECISIONES.md`](DECISIONES.md) con prefijo `E-`.
Las que tocan Vitrinee por dentro siguen con `VT-`.

## 5. Tareas

Una tarea = una rama `cc/t<n>-<slug>` = un PR. Todas terminan con
`pnpm check` en verde (más `pnpm run vitrinee:check` si tocan Vitrinee),
bitácora, evidencia y `docs/ESTADO.md` al día.

### T120 · Prueba técnica: payment handler de Stellar en UCP
- **Prioridad:** imprescindible · **Estimación:** 4 h · **Delegable a Codex:** no
- **Depende de:** spec aprobado
- **Descripción:** investigación, sin código de producto. Leer de la spec de
  UCP: Payment Handlers, la capacidad checkout, la capacidad order y la
  extensión de mandatos AP2. Responder:
  1. ¿Un handler con namespace propio puede transportar un pago x402 de
     Stellar (la autorización Soroban firmada) desde la plataforma (el agente)
     hasta el negocio (Vitrinee)? La regla de UCP pide que el origen de la URL
     de la spec coincida con el namespace: `com.agentpey.*` exige alojar la
     spec en `agentpey.com`.
  2. ¿Dónde se liquida el pago y cómo encaja el facilitator?
  3. ¿Cómo viaja el recibo anclado dentro de la orden UCP?
  4. ¿Qué se reutiliza tal cual? `agent-storefront.json`,
     `GET /api/discovery/search`, el checkout por `GET`, `policy_rail` como pagador.
- **Archivos principales:** `docs/fase-7-estandar-comercio-agentico/T120-handler-stellar-ucp.md`
- **Hecho cuando:**
  - [ ] las cuatro preguntas están respondidas, cada una con la cita de la spec (URL y sección)
  - [ ] hay opciones con una recomendación, y el plan B evaluado (catálogo en UCP, checkout x402 aparte, brecha documentada para el SEP)
  - [ ] T121 y T122 tienen horas estimadas y la sección 4 de este spec queda completa
  - [ ] el usuario eligió una opción (**parar y mostrar antes de construir**)

### T121 · Vitrinee publica `/.well-known/ucp` por comercio
- **Prioridad:** imprescindible · **Estimación:** 15 h (se ajusta en T120) · **Delegable a Codex:** solo el mapeo mecánico de campos; diseño y revisión no
- **Depende de:** T120
- **Descripción:** cada subdominio de comercio (`*.vitrinee.agentpey.com`)
  publica su perfil UCP, generado desde lo que ya sirve
  `agent-storefront.json`, que se mantiene.
- **Hecho cuando:**
  - [ ] el perfil valida contra los esquemas de UCP (test sin red, con los esquemas versionados en el repo)
  - [ ] un cliente de prueba lee el perfil y lista los productos de una tienda real
  - [ ] `agent-storefront.json` responde igual que antes (test de no regresión)

### T122 · Compra UCP pagada sobre Stellar, de punta a punta
- **Prioridad:** imprescindible · **Estimación:** 25 h (se ajusta en T120) · **Delegable a Codex:** no (`P-10`)
- **Depende de:** T121
- **Descripción:** una sesión de checkout UCP termina pagando por x402 en
  USDC testnet desde un `policy_rail`. Se crea el pedido real en la plataforma
  de la tienda, y el recibo se ancla y queda enlazado en la orden UCP.
- **Hecho cuando:**
  - [ ] hash de la transacción de pago en testnet
  - [ ] pedido visible en el panel de la tienda
  - [ ] recibo con los tres checks en verde (`pnpm run vitrinee:verify`)
  - [ ] un intento que excede `per_tx` es rechazado por la red, no por el agente
  - [ ] todo en `evidencia/T122.md`

### T123 · Mandato exportable como mandatos AP2
- **Prioridad:** si alcanza (se corta segundo) · **Estimación:** 15 h · **Delegable a Codex:** no
- **Depende de:** T122
- **Descripción:** mapear el Mandato firmado a los mandatos AP2 (Intent, Cart
  y Payment) como Verifiable Credentials, y verificarlos.
- **Hecho cuando:**
  - [ ] un Mandato real se exporta a los tres mandatos AP2 y un verificador los acepta
  - [ ] un mandato AP2 alterado es rechazado, con un error tipado
  - [ ] el diff no toca `checkMandate` ni el enforcement de `scope.limits` o `perDay`

### T124 · Disputas v0
- **Prioridad:** si alcanza (se corta primero) · **Estimación:** 35 h · **Delegable a Codex:** no
- **Depende de:** T122, y dos decisiones del usuario (sección 9)
- **Descripción:** revivir Fallo (`~/fallo`: árbitro con IA, veredicto anclado
  con `manageData`) con otro nombre. Flujo: desde un recibo de Vitrinee se
  abre un reclamo con evidencia; el árbitro emite un veredicto razonado; el
  hash del veredicto se ancla, enlazado al recibo; el veredicto se ejecuta
  sobre la plata según la opción que elija el usuario.
- **Hecho cuando:** se define al planificarla, después de las decisiones del usuario.

### T125 · Anexo técnico para el SEP
- **Prioridad:** al final · **Estimación:** 3 h · **Delegable a Codex:** no (narrativa SCF)
- **Depende de:** T122 (y T123, T124 si se hicieron)
- **Descripción:** un documento en `docs/` con los formatos exactos: el
  esquema del recibo firmado, la configuración del payment handler, cómo se
  verifica un mandato y los contratos desplegados (ids de testnet).
- **Hecho cuando:**
  - [ ] cada formato del anexo coincide con el código (esquemas zod citados por ruta) y con `deployments/`

## 6. Criterios de aceptación de la fase

- [ ] Un cliente UCP lee el perfil de una tienda real de terceros y lista sus productos
- [ ] Una compra UCP se paga en USDC testnet desde un `policy_rail`, con pedido real y recibo verificable
- [ ] La red rechaza un pago que excede `per_tx`
- [ ] El anexo técnico está entregado al chat de estrategia

## 7. Plan de demo

Se escribe al cerrar T122: la compra de punta a punta en una tienda real de
terceros, que es también lo que se graba el 11-oct.

## 8. Orden, fechas y cortes

| Fechas | Qué |
|---|---|
| 1 al 3 de octubre | T120 |
| 4 al 7 de octubre | T121 y T122 |
| 8 al 10 de octubre | T123 y T124, si alcanzan |
| 11 de octubre | Congelar código, grabar la compra, T125 |

Si falta tiempo se corta primero T124 y después T123. T120 a T122 no se tocan.

| Riesgo | Mitigación |
|---|---|
| UCP no admite bien x402 | Plan B de T120: catálogo en UCP, checkout x402 aparte, la brecha documentada para el SEP |
| El namespace `com.agentpey.*` exige alojar la spec del handler en `agentpey.com` | Se resuelve en T120; alojar un archivo estático en el dominio es un deploy, con permiso del usuario |
| 35 h de disputas en tres días | T124 es la primera que se corta |

## 9. Preguntas abiertas

- [x] ¿Está confirmada la extensión de Find Your Way más allá del 30-sep? **Sí**, confirmado por el usuario el 2026-09-30: el calendario de la sección 8 vale
- [ ] T124, qué hace el veredicto con la plata: (a) garantía del comercio en un contrato, de donde salen los reembolsos (recomendada para v0: no toca el flujo de pago existente); (b) retención del pago antes de liberarlo al comercio (cambia el `payTo` de x402 y el recibo); (c) solo veredicto público, sin mover fondos. Se decide antes de T124, no ahora
- [ ] T124, el nombre: Veredicto, Dictamen o AgentPey Resolve. Se decide antes de T124

## 10. Registro de cambios del spec

| Fecha | Cambio |
|---|---|
| 2026-09-30 | Borrador, a partir del traspaso del chat de estrategia del 29-sep |
| 2026-09-30 | **Aprobado** por el usuario, sin cambios en las tareas. Extensión de Find Your Way confirmada por el usuario |
